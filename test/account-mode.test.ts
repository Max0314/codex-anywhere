import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WebSocket } from 'ws';
import { createBridgeServer } from '../src/server/server.js';
import { migrateAccounts } from '../src/server/migrate-accounts.js';
import { createDeviceAuthProof, createDeviceIdentity } from '../src/shared/device-auth.js';
import { DEVICE_KEY_AUTH_CONTEXT } from '../src/shared/pairing-auth.js';
import { createProtocolOffer } from '../src/shared/protocol-contract.js';

const first = '11111111-1111-4111-8111-111111111111';
const second = '22222222-2222-4222-8222-222222222222';
const origin = 'https://test.invalid';

test('account mode scopes inventory, PC operations and both WebSocket directions', { timeout: 10_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anywhere-accounts-'));
  const provider = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/internal/desktop/account-state') {
      response.end(JSON.stringify({ active: true, security_version: 'current' }));
      return;
    }
    const token = request.headers.cookie?.split('=').at(-1);
    const sub = token === 'one' ? first : token === 'two' ? second : null;
    response.end(JSON.stringify(sub ? { authenticated: true, sub, name: token } : { authenticated: false }));
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address();
  assert.ok(address && typeof address !== 'string');
  const saved = { ...process.env };
  Object.assign(process.env, {
    ACCESS_MODE: 'account', ACCOUNT_ADMISSION: 'all', PUBLIC_ORIGIN: origin,
    OWNER_SUB: first, IDENTITY_BASE_URL: 'http://127.0.0.1:' + address.port,
    FRIBENCH_CLIENT_SECRET: 'a'.repeat(48), SESSION_BINDING_KEY: 'b'.repeat(48),
  });
  const pcA = createDeviceIdentity();
  const pcB = createDeviceIdentity();
  const differentB = createDeviceIdentity();
  const browserA = createDeviceIdentity();
  const browserB = createDeviceIdentity();
  const device = (sub: string, pc: typeof pcA, routeId: string, label: string) => ({
    role: 'connector', id: pc.id, publicKey: pc.publicKey,
    sub, routeId, label, revision: 1, revoked: false, securityVersion: 'current',
  });
  writeFileSync(join(directory, 'accounts.v2.json'), JSON.stringify({
    version: 2, ownerSub: first, sessions: {},
    devices: [device(first, pcA, 'shared-name', 'Private A'), device(second, pcB, 'shared-name', 'Private B'),
      device(second, differentB, 'only-b', 'Second B')],
  }));
  const relay = createBridgeServer({ deviceRegistryPath: join(directory, 'devices.json') });
  const sockets: WebSocket[] = [];
  try {
    await relay.listen(0, '127.0.0.1');
    const relayAddress = relay.httpServer.address();
    assert.ok(relayAddress && typeof relayAddress !== 'string');
    const base = 'http://127.0.0.1:' + relayAddress.port;
    assert.match(await fetch(base + '/config.js').then(response => response.text()), /"multiAccount":true/);
    const headers = (token: string) => ({ cookie: '__Host-fribench_codex_anywhere=' + token });
    const access = (token: string) => fetch(base + '/api/access', { headers: headers(token) }).then(r => r.json()) as Promise<{
      accountKey: string; csrf: string; migrateLegacyBrowser: boolean;
    }>;
    const a = await access('one');
    const b = await access('two');
    assert.notEqual(a.accountKey, b.accountKey);
    assert.equal(a.migrateLegacyBrowser, true);
    assert.equal(b.migrateLegacyBrowser, false);

    async function connect(role: 'client' | 'connector', identity: typeof pcA, token = '', key = '', route = '') {
      const socket = new WebSocket(base.replace(/^http/, 'ws') + (role === 'client' ? '/ws/browser' : '/ws/connector'), {
        origin, headers: { ...headers(token), host: new URL(origin).host },
      });
      sockets.push(socket);
      const events: Record<string, any>[] = [];
      let wake: (() => void) | undefined;
      socket.on('message', raw => { events.push(JSON.parse(raw.toString())); wake?.(); });
      async function take(type: string) {
        while (!events.some(event => event.type === type)) {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(Error('missing ' + type)), 1500);
            wake = () => { clearTimeout(timer); resolve(); };
          });
        }
        return events.splice(events.findIndex(event => event.type === type), 1)[0];
      }
      const challenge = await take('auth.challenge');
      const send = (frame: object) => socket.send(JSON.stringify(frame));
      send({ type: 'auth.device', role, ...(route && { deviceId: route }), protocol: createProtocolOffer(undefined, true),
        ...(role === 'client' && { clientAccountVersion: 1, accountKey: key }),
        device: createDeviceAuthProof(identity, { role, challenge: challenge.challenge, routeDeviceId: route, authProof: DEVICE_KEY_AUTH_CONTEXT }) });
      return { admitted: await take('auth.ok'), events, send, take };
    }

    const leftPc = await connect('connector', pcA, '', '', 'shared-name');
    const rightPc = await connect('connector', pcB, '', '', 'shared-name');
    const left = await connect('client', browserA, 'one', a.accountKey);
    const right = await connect('client', browserB, 'two', b.accountKey);
    assert.deepEqual(left.admitted.environments.map((pc: { label: string }) => pc.label), ['Private A']);
    assert.deepEqual(right.admitted.environments.map((pc: { label: string }) => pc.label), ['Second B', 'Private B']);
    assert.deepEqual((await left.take('presence')).environments.map((pc: { label: string }) => pc.label), ['Private A']);

    const leftHeaders = { ...headers('one'), 'x-codex-account': a.accountKey };
    const list = await fetch(base + '/api/devices', { headers: leftHeaders }).then(r => r.json()) as { label: string }[];
    assert.ok(list.some(d => d.label === 'Private A'));
    assert.ok(list.every(d => d.label !== 'Private B'));
    assert.equal((await fetch(base + '/api/devices', { headers: { ...headers('two'), 'x-codex-account': a.accountKey } })).status, 409);
    assert.equal((await fetch(base + '/api/devices/connector/' + pcB.id + '/revoke', {
      method: 'POST', headers: { ...leftHeaders, origin, 'content-type': 'application/json' }, body: JSON.stringify({ csrf: a.csrf }),
    })).status, 404);

    left.send({ type: 'relay.request', requestId: 'rename', action: 'device.rename', payload: { deviceId: 'only-b', label: 'Denied' } });
    assert.equal((await left.take('relay.response')).ok, false);
    left.send({ type: 'channel.confirm', deviceId: 'shared-name', channelId: 'same-account', signature: '' });
    assert.equal((await leftPc.take('channel.confirm')).clientId, left.admitted.clientId);
    rightPc.send({ type: 'channel.ready', clientId: left.admitted.clientId, channelId: 'foreign' });
    rightPc.send({ type: 'channel.ready', clientId: right.admitted.clientId, channelId: 'own' });
    assert.equal((await right.take('channel.ready')).channelId, 'own');
    assert.ok(!left.events.some(event => event.type === 'channel.ready'));
  } finally {
    for (const socket of sockets) socket.terminate();
    await relay.close();
    await new Promise<void>(resolve => provider.close(() => resolve()));
    process.env = saved;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('offline migration is repeatable and never overwrites new account data', () => {
  const directory = mkdtempSync(join(tmpdir(), 'anywhere-migrate-'));
  try {
    const registry = join(directory, 'devices.json');
    const v1 = join(directory, 'owner-devices.v1.json');
    const v2 = join(directory, 'accounts.v2.json');
    const pc = createDeviceIdentity();
    writeFileSync(v1, JSON.stringify({ version: 1, ownerSub: first, sessions: {}, devices: [
      { role: 'connector', id: pc.id, publicKey: pc.publicKey, routeId: 'existing', label: 'PC',
        revision: 4, securityVersion: 'current', revoked: false },
    ] }));
    assert.equal(migrateAccounts(registry, first).migrated, true);
    const snapshot = JSON.parse(readFileSync(v2, 'utf8'));
    assert.equal(snapshot.devices[0].sub, first);
    assert.equal(snapshot.devices[0].revision, 4);
    snapshot.devices[0].revoked = true;
    writeFileSync(v2, JSON.stringify(snapshot));
    assert.equal(migrateAccounts(registry, first).migrated, false);
    assert.equal(JSON.parse(readFileSync(v2, 'utf8')).devices[0].revoked, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
