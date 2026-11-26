import { WebSocket } from 'ws';
import { BrowserSessionBroker } from '../browser-control/session-broker.js';
import { startBrowserEndpoint } from '../browser-control/local-endpoint.js';
import { CodexAppServer } from './codex-app-server.js';
import { CodexDesktopClient } from './codex-desktop.js';
import { readImageAttachment, saveImageAttachment, resolveNativeImageAttachment } from './attachments.js';
import { desktopSummary } from './desktop-controls.js';
import { FileUploadManager, UPLOAD_DIRECTORY } from './file-uploads.js';
import { loadConnectorConfig } from './config.js';
import { DownloadManager } from './file-downloads.js';
import { generatedImagesDirectory } from './generated-images.js';
import { readVisualization, visualizationsDirectory } from './visualizations.js';
import { acquireConnectorInstanceLock } from './instance-lock.js';
import { loadOrCreateConnectorDeviceIdentity } from './device-identity.js';
import { createRequestHandler } from './request-handler.js';
import { monitorConnectorSocket, scheduleReferencedRetry } from './reconnect.js';
import { ConnectorSecureChannels } from './secure-channels.js';
import { connectorSessionModelSettingsPath, connectorDesktopMessageModelSettingsPath } from './session-model-settings.js';
import { createConnectorAuthProof } from '../shared/auth.js';
import { createDeviceAuthProof } from '../shared/device-auth.js';
import {
  requireCurrentProtocol,
} from '../shared/protocol-contract.js';
import {
  MAX_FRAME_BYTES, parseFrame, safeSend,
} from '../shared/protocol.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startOwnerControl } from './owner-control.js';

const {
  token,
  url,
  deviceId,
  deviceLabel,
  mode,
  codexBin,
  allowedRoots,
  networkAccess,
  allowFullAccess,
  allowAnyFileDownload,
} = loadConnectorConfig();
const deviceIdentity = loadOrCreateConnectorDeviceIdentity();
delete process.env.BRIDGE_DEVICE_PRIVATE_KEY;
delete process.env.BRIDGE_CONNECTOR_TOKEN;
const instanceLock = await acquireConnectorInstanceLock();
if (!instanceLock) {
  console.log('Codex Anywhere connector is already running.');
  process.exit(0);
}
const connectorLock = instanceLock;
const codex = new CodexAppServer({
  releaseRuntimeAfterTurn: mode === 'desktop',
  bin: codexBin,
  allowedRoots,
  networkAccess,
  allowFullAccess,
  modelSettingsPath: connectorSessionModelSettingsPath(deviceId),
});
const desktop = mode === 'desktop' ? new CodexDesktopClient({
  messageModelSettingsPath: connectorDesktopMessageModelSettingsPath(deviceId),
}) : null;
const downloads = new DownloadManager({
  allowedRoots: [...allowedRoots, generatedImagesDirectory(), visualizationsDirectory(), UPLOAD_DIRECTORY],
  allowAnyFileDownload,
});
// Opt in per environment; no MCP listener or configuration change on stable installs.
const browser = process.env.BRIDGE_BROWSER_ENDPOINT_FILE
  ? new BrowserSessionBroker(deviceId, (frame) => secureChannels.sendEvent(frame)) : undefined;
const browserEndpoint = browser
  ? await startBrowserEndpoint(browser, process.env.BRIDGE_BROWSER_ENDPOINT_FILE!) : undefined;
const fileUploads = new FileUploadManager();
let requestsInFlight = 0;
const handleRequest = createRequestHandler({
  onSessionStatuses: snapshot => secureChannels.broadcastEvent({ type: 'event', event: 'sessions.status', payload: snapshot }),
  browser,
  codex,
  desktop,
  fileUploads,
  attachments: {
    save: saveImageAttachment,
    nativeInput: resolveNativeImageAttachment,
    read: (payload) => readImageAttachment(payload),
  },
  visualizations: { read: readVisualization },
  downloads,
  deviceId,
  deviceLabel,
  mode,
  networkAccess,
  allowFullAccess,
});
const secureChannels = new ConnectorSecureChannels({
  identity: deviceIdentity,
  deviceId,
  send: (frame) => safeSend(socket, frame),
  handleRequest: async request => {
    if (maintenance && /^(turn\.(start|steer|edit)|file\.(upload\.begin|download\.open))$/.test(request.action)) {
      return { type: 'response', clientId: request.clientId, requestId: request.requestId, ok: false, error: 'connector_update_waiting' };
    }
    if (request.action === 'session.subscribe') {
      const accepted = secureChannels.select(request.clientId || '', String(request.payload?.threadId || ''), Number(request.payload?.selectionEpoch || 0));
      return { type: 'response', clientId: request.clientId, requestId: request.requestId, ok: true, data: { accepted } };
    }
    requestsInFlight++;
    try { return await handleRequest(request); } finally { requestsInFlight--; }
  },
});
let policyText = '';
secureChannels.beforeRequest = () => {
  if (!process.env.BRIDGE_CONFIG_FILE) return;
  const text = readFileSync(process.env.BRIDGE_CONFIG_FILE, 'utf8').replace(/^\uFEFF/, '');
  if (text === policyText) return;
  const config = JSON.parse(text);
  if (!Array.isArray(config.allowedRoots) || !config.allowedRoots.every((root: unknown) => typeof root === 'string')) throw Error('invalid_directory_policy');
  const roots = config.allowedRoots.map((root: string) => resolve(root));
  codex.allowedRoots = roots;
  downloads.allowedRoots = [...roots, generatedImagesDirectory(), visualizationsDirectory(), UPLOAD_DIRECTORY];
  secureChannels.invalidateResults();
  policyText = text;
};

let socket: WebSocket | undefined;
let reconnectAttempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let stopped = false;
let connectorAuthenticated = false;
let maintenance = false;
let releaseRequest: { id: string; resolve: (value: unknown) => void; reject: (error: Error) => void } | null = null;
const ownerControl = process.env.BRIDGE_OWNER_MODE === '1' ? startOwnerControl(async command => {
  // Native Desktop tasks own a separate process and continue across observer
  // updates. Connector-owned turns and file transfers must drain first.
  const busy = codex.activeTurns.size > 0 || requestsInFlight > 0 || fileUploads.hasActiveTransfers() || [...downloads.sessions.values()].some(session => !session.completed || session.busy);
  if (command === 'status') {
    const version = process.env.BRIDGE_INSTALL_VERSION || 'source';
    return { busy, connected: connectorAuthenticated, maintenance, version };
  }
  if (command === 'resume') { maintenance = false; return { maintenance }; }
  if (command === 'prepare') { maintenance = true; if (busy) throw Error('任务正在运行，请稍后更新。'); return { ready: true }; }
  if (command === 'stop') { if (!maintenance || busy) throw Error('任务正在运行，请稍后更新。'); setTimeout(() => void shutdown(), 100); return { stopping: true }; }
  if (command === 'release') {
    if (releaseRequest || socket?.readyState !== WebSocket.OPEN) throw Error('请先连接 Fribench');
    return new Promise((resolveResult, reject) => { const id = String(Date.now()); releaseRequest = { id, resolve: resolveResult, reject }; safeSend(socket, { type: 'relay.release.grant', requestId: id }); setTimeout(() => { if (releaseRequest?.id === id) { releaseRequest = null; reject(Error('更新查询超时')); } }, 10000).unref(); });
  }
  throw Error('unsupported_control');
}) : null;
codex.on('turn-event', (message) => {
  const frame = { type: 'event', ...message };
  secureChannels.sendEvent(frame);
  secureChannels.sendThreadEvent(frame);
});
// Project only operational state; raw Desktop snapshots can contain private context.
const desktopUpdates = new Map<string, NodeJS.Timeout>();
const desktopSummaries = new Map<string, ReturnType<typeof desktopSummary>>();
const desktopPending = new Map<string, { state: Record<string, any>; owner: string }>();
desktop?.userInput.state.on('changed', (threadId: string, state: Record<string, any>, owner: string) => {
  desktopPending.set(threadId, { state, owner });
  if (desktopUpdates.has(threadId)) return;
  const timer = setTimeout(() => {
    desktopUpdates.delete(threadId);
    const latest = desktopPending.get(threadId);
    desktopPending.delete(threadId);
    if (!latest) return;
    const summary = desktopSummary(latest.state, latest.owner);
    if (JSON.stringify(summary) === JSON.stringify(desktopSummaries.get(threadId))) return;
    desktopSummaries.set(threadId, summary);
    secureChannels.broadcastEvent({ type: 'event', event: 'desktop.state', payload: summary });
  }, 100);
  timer.unref(); desktopUpdates.set(threadId, timer);
});
desktop?.userInput.state.on('invalidated', (threadId: string) => {
  clearTimeout(desktopUpdates.get(threadId)); desktopUpdates.delete(threadId);
  desktopSummaries.delete(threadId);
  desktopPending.delete(threadId);
  secureChannels.broadcastEvent({ type: 'event', event: 'desktop.state', payload: { threadId, status: 'unknown', canStop: false, turnId: null } });
});

function connect() {
  if (stopped) return;
  const current = new WebSocket(url, {
    maxPayload: MAX_FRAME_BYTES, perMessageDeflate: false, handshakeTimeout: 15_000,
  });
  socket = current;
  monitorConnectorSocket(current, {
    onTimeout: () => console.log('Connector relay connection became stale; reconnecting.'),
  });
  current.on('message', async (data) => {
    if (socket !== current || stopped) return;
    let message;
    try { message = parseFrame(data); } catch { return; }
    const pendingRelease = releaseRequest;
    if (message.type === 'relay.release.result' && pendingRelease && pendingRelease.id === message.requestId) { releaseRequest = null; pendingRelease.resolve(message.data); return; }
    if (message.type === 'auth.challenge') {
      try {
        const protocol = requireCurrentProtocol(message.protocol, process.env.BRIDGE_OWNER_MODE === '1');
        const proof = process.env.BRIDGE_OWNER_MODE === '1' ? 'codex-anywhere-approved-device-v1' : createConnectorAuthProof(token, String(message.challenge || ''), deviceId);
        const device = createDeviceAuthProof(deviceIdentity, {
          challenge: String(message.challenge || ''),
          role: 'connector',
          routeDeviceId: deviceId,
          authProof: proof,
        }, deviceLabel);
        safeSend(current, {
          type: process.env.BRIDGE_OWNER_MODE === '1' ? 'auth.device' : 'auth.connector', role: 'connector', proof, deviceId, device, protocol,
        });
      } catch {
        current.close(4003, 'invalid authentication challenge');
      }
      return;
    }
    if (message.type === 'auth.pairing') {
      console.log('Connector device approval required. Approve the pending connector from the relay host.');
      return;
    }
    if (message.type === 'auth.ok') {
      connectorAuthenticated = true;
      reconnectAttempt = 0;
      return;
    }
    if (await secureChannels.handle(message)) return;
  });
  current.on('close', (code, reason) => {
    if (socket !== current) return;
    if (code === 4409) console.error(`Connector route rejected (${deviceId}): ${reason.toString()}. Use a unique device ID and approve its registration.`);
    socket = undefined;
    connectorAuthenticated = false;
    scheduleReconnect();
  });
  current.on('error', () => { current.terminate(); });
}

function scheduleReconnect() {
  if (stopped || reconnectTimer) return;
  browser?.clear();
  secureChannels.clear();
  const delay = Math.min(30_000, 1_000 * (2 ** reconnectAttempt)) + Math.floor(Math.random() * 500);
  reconnectAttempt += 1;
  reconnectTimer = scheduleReferencedRetry(() => {
    reconnectTimer = undefined;
    connect();
  }, delay);
}

async function shutdown() {
  ownerControl?.close();
  stopped = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  await browserEndpoint?.close();
  secureChannels.clear();
  socket?.close(1000, 'connector shutdown');
  desktop?.close();
  await downloads.closeAll();
  await codex.close();
  await connectorLock.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
console.log(`Connecting ${deviceLabel} (${deviceId}, ${mode}) to ${new URL(url).origin}`);
connect();
