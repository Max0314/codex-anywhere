import { createHash, createHmac, randomBytes } from "node:crypto";
import {
  existsSync,
  readFileSync,
  mkdirSync,
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  renameSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import {
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  verifyDeviceAuthProof,
  verifyDevicePayload,
  type DeviceAuthProof,
} from "../shared/device-auth.js";
import { DEVICE_KEY_AUTH_CONTEXT } from "../shared/pairing-auth.js";
import { DeviceRegistry } from "./device-registry.js";

export function ownerAuthorizationCloseCode(error: unknown) {
  const value = error as { status?: number; message?: string };
  if (value.status === 401) return 4401;
  if (value.message === 'device_proof_invalid' || value.message === 'browser_identity_changed') return 4407;
  return value.status === 403 || value.status === 409 ? 4403 : 1013;
}

type Device = {
  role: "client" | "connector";
  id: string;
  publicKey: string;
  label: string;
  routeId?: string;
  revision: number;
  revoked: boolean;
  securityVersion?: string;
};
type State = {
  version: 1;
  ownerSub: string;
  devices: Device[];
  sessions: Record<string, { keyId?: string; revoked: boolean }>;
};
type Intent = {
  id: string;
  nonce: string;
  routeId: string;
  publicKey: string;
  idKey: string;
  label: string;
  state: string;
  challenge: string;
  redirectUri: string;
  revision: number;
  expiry: number;
  approved: boolean;
  approvalSession?: string;
  pending?: Promise<unknown>;
};
export type OwnerLease = {
  device: Device;
  request: IncomingMessage;
  sessionHash?: string;
  expires: number;
  revision: number;
  legacy?: boolean;
};
const cookieName = "__Host-fribench_codex_anywhere";
const random = () => randomBytes(32).toString("base64url");
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
function fail(status: number, message: string): never {
  throw Object.assign(new Error(message), { status });
}

export class OwnerAccess {
  readonly origin = process.env.PUBLIC_ORIGIN || "";
  readonly owner = process.env.OWNER_SUB || "";
  readonly base = process.env.IDENTITY_BASE_URL || "";
  readonly app = "codex-anywhere";
  readonly secret = process.env.FRIBENCH_CLIENT_SECRET || "";
  readonly bindingKey = process.env.SESSION_BINDING_KEY || "";
  readonly file: string;
  private state: State;
  private intents = new Map<string, Intent>();
  private counts = new Map<string, { start: number; count: number }>();
  private checks = new Map<string, Promise<any>>();
  private downloadGrants = new Map<
    string,
    { keyId: string; revision: number; path: string; expires: number }
  >();
  onRevoke: (role: string, id: string) => void = () => {};
  constructor(private registry: DeviceRegistry) {
    if (
      !/^https:\/\/[^/]+$/.test(this.origin) ||
      !/^[a-f0-9-]{36}$/i.test(this.owner) ||
      !this.base ||
      this.secret.length < 32 ||
      this.bindingKey.length < 32
    )
      throw Error("owner_configuration_invalid");
    this.file = resolve(
      dirname(registry.filePath || "/data/devices.json"),
      "owner-devices.v1.json",
    );
    this.state = existsSync(this.file)
      ? JSON.parse(readFileSync(this.file, "utf8"))
      : { version: 1, ownerSub: this.owner, devices: [], sessions: {} };
    if (this.state.ownerSub !== this.owner)
      throw Error("owner_registry_identity_changed");
    if (
      this.state.version !== 1 ||
      !Array.isArray(this.state.devices) ||
      !this.state.sessions ||
      new Set(this.state.devices.map((d) => d.role + ":" + d.id)).size !==
        this.state.devices.length
    )
      throw Error("owner_registry_invalid");
  }
  private persist(next: State) {
    mkdirSync(dirname(this.file), { recursive: true });
    const temp = this.file + ".tmp";
    const fd = openSync(temp, "w", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(next));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, this.file);
    this.state = next;
  }
  private session(request: IncomingMessage) {
    const entries = String(request.headers.cookie || "")
      .split(";")
      .map((part) => part.trim());
    const cookie =
      entries.find((part) => part.startsWith(cookieName + "=")) || "";
    const value = cookie.slice(cookieName.length + 1);
    return {
      cookie,
      key: createHmac("sha256", this.bindingKey).update(value).digest("hex"),
    };
  }
  private csrf(key: string) {
    return createHmac("sha256", this.bindingKey)
      .update("csrf:" + key)
      .digest("hex");
  }
  async internal(path: string, body: unknown, cookie = ""): Promise<any> {
    return this.call(path, body, {
      authorization:
        "Basic " +
        Buffer.from("fribench-" + this.app + ":" + this.secret).toString(
          "base64",
        ),
      cookie,
    });
  }
  private call(
    path: string,
    body: unknown,
    extra: Record<string, string>,
  ): Promise<any> {
    const bytes = body === undefined ? "" : JSON.stringify(body);
    return new Promise((resolveCall, reject) => {
      const req = httpRequest(
        new URL(path, this.base),
        {
          method: body === undefined ? "GET" : "POST",
          headers: {
            host: new URL(this.origin).host,
            "x-fribench-app": this.app,
            "content-type": "application/json",
            "content-length": Buffer.byteLength(bytes),
            ...extra,
          },
          timeout: 5000,
        },
        (res) => {
          let data = "";
          res.on('error', reject);
          res.on('aborted', () => reject(Object.assign(Error('identity_unavailable'), { status: 503 })));
          res.on('close', () => { if (!res.complete) reject(Object.assign(Error('identity_unavailable'), { status: 503 })); });
          res.on("data", (chunk) => {
            data += chunk;
            if (data.length > 65536)
              req.destroy(Error("identity_response_limit"));
          });
          res.on("end", () => {
            try {
              if (res.statusCode !== 200)
                return reject(
                  Object.assign(Error("identity_unavailable"), { status: 503 }),
                );
              resolveCall(JSON.parse(data));
            } catch {
              reject(Error("identity_invalid"));
            }
          });
        },
      );
      req.on("timeout", () => req.destroy(Error("identity_timeout")));
      req.on("error", reject);
      req.end(bytes);
    });
  }
  async guard(request: IncomingMessage) {
    const session = this.session(request);
    if (this.state.sessions[session.key]?.revoked) fail(403, "device_revoked");
    let check = this.checks.get(session.key);
    if (!check) {
      check = this.internal("/internal/identity", {}, session.cookie);
      this.checks.set(session.key, check);
    }
    let value;
    try {
      value = await check;
    } finally {
      if (this.checks.get(session.key) === check)
        this.checks.delete(session.key);
    }
    if (!value.authenticated) fail(401, "login_required");
    if (value.sub !== this.owner) fail(403, "owner_required");
    if (this.state.sessions[session.key]?.revoked) fail(403, "device_revoked");
    return session;
  }
  async authorize(
    request: IncomingMessage,
    frame: any,
    challenge: string,
  ): Promise<OwnerLease> {
    if (request.url === "/ws") {
      const proof = frame.device;
      const until = Date.parse(process.env.LEGACY_PC_UNTIL || "");
      if (
        frame.type !== "auth.connector" ||
        frame.role !== "connector" ||
        proof?.id !== process.env.LEGACY_PC_KEY_ID ||
        frame.deviceId !== process.env.LEGACY_PC_ROUTE_ID ||
        !Number.isFinite(until) ||
        Date.now() >= until ||
        this.state.devices.some(
          (d) => d.role === "connector" && d.id === proof?.id,
        ) ||
        !this.registry.isApproved("connector", proof)
      )
        fail(403, "upgrade_connector");
      return {
        device: {
          role: "connector",
          id: proof.id,
          publicKey: proof.publicKey,
          routeId: frame.deviceId,
          label: "升级连接器",
          revision: 0,
          revoked: false,
        },
        request,
        expires: until,
        revision: 0,
        legacy: true,
      };
    }
    const browser = request.url === "/ws/browser";
    if (!browser && request.url !== "/ws/connector")
      fail(403, "upgrade_connector");
    if (
      frame.type !== "auth.device" ||
      frame.role !== (browser ? "client" : "connector") ||
      frame.protocol?.version !== 5
    )
      fail(403, "owner_auth_required");
    const proof = frame.device as DeviceAuthProof;
    if (
      !proof ||
      !verifyDeviceAuthProof(proof, {
        challenge,
        role: browser ? "client" : "connector",
        routeDeviceId: browser ? "" : frame.deviceId,
        authProof: DEVICE_KEY_AUTH_CONTEXT,
      })
    )
      fail(403, "device_proof_invalid");
    let record = this.state.devices.find(
      (d) => d.id === proof.id && d.role === frame.role,
    );
    if (record?.revoked) fail(403, "device_revoked");
    let sessionHash: string | undefined;
    if (browser) {
      if (request.headers.origin !== this.origin) fail(403, "origin_invalid");
      const session = await this.guard(request);
      sessionHash = session.key;
      record = this.state.devices.find(
        (d) => d.id === proof.id && d.role === "client",
      );
      if (record?.revoked) fail(403, "device_revoked");
      const previous = this.state.sessions[sessionHash];
      if (previous?.keyId && previous.keyId !== proof.id)
        fail(403, "browser_identity_changed");
      const next = structuredClone(this.state);
      if (!record) {
        record = {
          role: "client",
          id: proof.id,
          publicKey: proof.publicKey,
          label: proof.label?.slice(0, 80) || "浏览器",
          revision: 1,
          revoked: false,
        };
        next.devices.push(record);
      }
      next.sessions[sessionHash] = { keyId: proof.id, revoked: false };
      this.persist(next);
    } else {
      if (!record || record.routeId !== frame.deviceId)
        fail(403, "connector_binding_required");
      const current = await this.internal("/internal/desktop/account-state", {
        sub: this.owner,
      });
      if (
        !current.active ||
        current.security_version !== record.securityVersion
      )
        fail(403, "connector_authorization_expired");
    }
    const current = this.state.devices.find(
      (d) => d.id === proof.id && d.role === frame.role,
    );
    if (
      !current ||
      current.revoked ||
      current.revision !== record?.revision ||
      current.routeId !== record?.routeId
    )
      fail(403, "authorization_changed");
    record = current;
    if (!record || record.publicKey !== proof.publicKey || record.revoked)
      fail(403, "device_identity_conflict");
    if (!this.registry.isApproved(record.role, proof)) {
      const pending = this.registry.requestPairing({
        role: record.role,
        device: proof,
        routeDeviceId: record.routeId,
        address: "owner",
      });
      this.registry.approve(pending.requestId);
    }
    return {
      device: record,
      request,
      sessionHash,
      expires: Date.now() + (browser ? 5000 : 30000),
      revision: record.revision,
    };
  }
  valid(lease: OwnerLease) {
    if (lease.legacy)
      return (
        Date.now() < lease.expires &&
        !this.state.devices.some(
          (d) => d.role === "connector" && d.id === lease.device.id,
        )
      );
    const current = this.state.devices.find(
      (d) => d.id === lease.device.id && d.role === lease.device.role,
    );
    return (
      Boolean(
        current && !current.revoked && current.revision === lease.revision,
      ) &&
      !lease.device.revoked &&
      lease.device.revision === lease.revision &&
      (!lease.sessionHash ||
        !this.state.sessions[lease.sessionHash]?.revoked) &&
      Date.now() < lease.expires
    );
  }
  async renew(lease: OwnerLease) {
    if (lease.legacy) {
      if (!this.valid(lease)) fail(403, "upgrade_connector");
      return;
    }
    if (lease.device.revoked || lease.device.revision !== lease.revision)
      fail(403, "device_revoked");
    if (lease.sessionHash) await this.guard(lease.request);
    else {
      const state = await this.internal("/internal/desktop/account-state", {
        sub: this.owner,
      });
      if (
        !state.active ||
        state.security_version !== lease.device.securityVersion
      )
        fail(403, "connector_authorization_expired");
    }
    lease.expires = Date.now() + (lease.sessionHash ? 5000 : 30000);
  }
  releaseGrant(lease: OwnerLease) {
    if (!this.valid(lease) || lease.device.role !== "connector")
      fail(403, "device_revoked");
    const directory = process.env.RELEASE_DIRECTORY || "";
    const release = JSON.parse(
      readFileSync(resolve(directory, "stable.json"), "utf8"),
    );
    const token = random();
    for (const [key, value] of this.downloadGrants)
      if (value.expires < Date.now()) this.downloadGrants.delete(key);
    this.downloadGrants.set(token, {
      keyId: lease.device.id,
      revision: lease.revision,
      path: release.path,
      expires: Date.now() + 120000,
    });
    return { release, token };
  }
  private async jsonBody(request: IncomingMessage): Promise<any> {
    let data = "";
    for await (const chunk of request) {
      data += chunk;
      if (data.length > 8192) fail(413, "request_too_large");
    }
    try {
      return JSON.parse(data);
    } catch {
      return fail(400, "invalid_json");
    }
  }
  private originGuard(request: IncomingMessage) {
    if (
      request.headers.origin !== this.origin ||
      !String(request.headers["content-type"]).startsWith("application/json")
    )
      fail(403, "origin_invalid");
  }
  async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<boolean> {
    if (!request.url?.startsWith("/") || request.url.startsWith("//")) {
      response.writeHead(400);
      response.end();
      return true;
    }
    const url = new URL(request.url, this.origin);
    const path = url.pathname;
    if (path.startsWith("/_fribench/")) {
      this.proxy(request, response, path);
      return true;
    }
    if (
      !path.startsWith("/api/") &&
      path !== "/desktop-connect" &&
      path !== "/download" &&
      !path.startsWith("/downloads/")
    )
      return false;
    const json = (status: number, body: unknown) => {
      response.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(JSON.stringify(body));
    };
    try {
      response.setHeader("referrer-policy", "no-referrer");
      if (path === "/download") {
        this.downloadPage(response);
        return true;
      }
      if (path === "/api/pc/intents" && request.method === "POST") {
        const address = request.socket.remoteAddress || "";
        const bucket = this.counts.get(address) || {
          start: Date.now(),
          count: 0,
        };
        if (Date.now() - bucket.start > 60000) {
          bucket.start = Date.now();
          bucket.count = 0;
        }
        bucket.count++;
        this.counts.set(address, bucket);
        for (const [id, intent] of this.intents)
          if (intent.expiry < Date.now()) this.intents.delete(id);
        if (bucket.count > 10 || this.intents.size >= 128)
          fail(429, "try_later");
        const body = await this.jsonBody(request);
        if (
          !/^[\w.-]{1,128}$/.test(body.routeId) ||
          !/^[\w-]{43}$/.test(body.state) ||
          !/^[\w-]{43}$/.test(body.challenge) ||
          typeof body.label !== "string" ||
          !body.label.trim() ||
          body.label.length > 80
        )
          fail(400, "intent_invalid");
        const redirect = new URL(body.redirectUri);
        if (
          redirect.hostname !== "127.0.0.1" ||
          redirect.protocol !== "http:" ||
          +redirect.port < 1024 ||
          redirect.pathname !== "/fribench/callback" ||
          redirect.search ||
          redirect.hash ||
          redirect.username ||
          redirect.password
        )
          fail(400, "callback_invalid");
        const identity = { id: body.keyId, publicKey: body.publicKey };
        const payload = JSON.stringify([
          "pc-intent-v1",
          this.origin,
          body.routeId,
          body.publicKey,
          body.label,
          body.state,
          body.challenge,
          body.redirectUri,
        ]);
        if (!verifyDevicePayload(identity, body.signature, payload))
          fail(403, "device_proof_invalid");
        const old = this.state.devices.find(
          (d) => d.id === body.keyId && d.role === "connector",
        );
        const intent: Intent = {
          ...body,
          idKey: body.keyId,
          id: random(),
          nonce: random(),
          revision: old?.revision || 0,
          expiry: Date.now() + 300000,
          approved: false,
        };
        this.intents.set(intent.id, intent);
        json(200, {
          intentId: intent.id,
          nonce: intent.nonce,
          url: this.origin + "/desktop-connect?intent=" + intent.id,
        });
        return true;
      }
      if (path.startsWith("/api/pc/intents/") && path.endsWith("/finish")) {
        const intent = this.intents.get(path.split("/")[4]);
        if (!intent || intent.expiry < Date.now() || !intent.approved)
          fail(400, "intent_expired");
        const body = await this.jsonBody(request);
        const payload = JSON.stringify([
          "pc-finish-v1",
          intent.id,
          intent.nonce,
          intent.routeId,
          hash(String(body.code)),
        ]);
        if (
          !verifyDevicePayload(
            { id: intent.idKey, publicKey: intent.publicKey },
            body.signature,
            payload,
          ) ||
          hashBase64(body.verifier) !== intent.challenge
        )
          fail(403, "device_proof_invalid");
        if (!intent.pending) intent.pending = this.finish(intent, body);
        const value = await intent.pending;
        const record = this.state.devices.find(
          (d) => d.id === intent.idKey && d.role === "connector",
        );
        if (
          !record ||
          record.revoked ||
          record.revision !== intent.revision + 1
        )
          fail(409, "authorization_changed");
        json(200, value);
        return true;
      }
      let session: { cookie: string; key: string };
      const token = String(request.headers.authorization || "").replace(
        /^Bearer /,
        "",
      );
      const grant = this.downloadGrants.get(token);
      if (path.startsWith("/downloads/") && grant) {
        const device = this.state.devices.find(
          (d) => d.role === "connector" && d.id === grant.keyId,
        );
        if (
          !device ||
          device.revoked ||
          device.revision !== grant.revision ||
          grant.path !== path ||
          grant.expires < Date.now()
        )
          fail(403, "download_authorization_expired");
        const state = await this.internal("/internal/desktop/account-state", {
          sub: this.owner,
        });
        if (!state.active || state.security_version !== device.securityVersion)
          fail(403, "download_authorization_expired");
        const current = this.state.devices.find(
          (d) => d.role === "connector" && d.id === grant.keyId,
        );
        if (
          !current ||
          current.revoked ||
          current.revision !== grant.revision ||
          grant.expires < Date.now()
        )
          fail(403, "download_authorization_expired");
        session = { cookie: "", key: "" };
      } else session = await this.guard(request);
      if (request.method === "POST") {
        this.originGuard(request);
      }
      if (path === "/api/access") {
        json(200, { owner: true, csrf: this.csrf(session.key) });
        return true;
      }
      if (path === "/api/devices") {
        json(
          200,
          this.state.devices.map(({ role, id, label, routeId, revoked }) => ({
            role,
            id,
            label,
            routeId,
            revoked,
          })),
        );
        return true;
      }
      if (path === "/desktop-connect") {
        const intent = this.intents.get(url.searchParams.get("intent") || "");
        if (!intent || intent.expiry < Date.now()) fail(400, "intent_expired");
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "content-security-policy":
            "default-src 'self'; frame-ancestors 'none'",
        });
        response.end(
          page(
            "连接电脑",
            `<h1>连接 ${escapeHtml(intent.label)}</h1><p>设备指纹 ${intent.idKey.slice(-12)}</p><p>确认允许此电脑接入你的 Codex。</p><button id="approve" data-intent="${intent.id}">确认连接这台电脑</button><p id="status"></p><script src="/owner-connect.js"></script>`,
          ),
        );
        return true;
      }
      if (request.method === "POST") {
        const body = await this.jsonBody(request);
        await this.guard(request);
        if (body.csrf !== this.csrf(session.key)) fail(403, "csrf_invalid");
        if (this.state.sessions[session.key]?.revoked)
          fail(403, "device_revoked");
        if (path.startsWith("/api/pc/intents/") && path.endsWith("/approve")) {
          const intent = this.intents.get(path.split("/")[4]);
          if (!intent || intent.expiry < Date.now())
            fail(400, "intent_expired");
          if (intent.approved || intent.pending)
            fail(409, "intent_already_approved");
          intent.approvalSession = session.key;
          intent.approved = true;
          const publicSession = await this.call(
            "/_fribench/auth/session",
            undefined,
            { cookie: session.cookie, origin: this.origin },
          );
          const result = await this.call(
            "/_fribench/desktop/approve",
            {
              csrf: publicSession.csrf,
              code_challenge: intent.challenge,
              state: intent.state,
              redirect_uri: intent.redirectUri,
            },
            { cookie: session.cookie, origin: this.origin },
          );
          if (this.state.sessions[session.key]?.revoked) {
            this.intents.delete(intent.id);
            fail(403, "device_revoked");
          }
          json(200, result);
          return true;
        }
        if (path.startsWith("/api/devices/") && path.endsWith("/revoke")) {
          const parts = path.split("/");
          const device = this.state.devices.find(
            (d) => d.role === parts[3] && d.id === parts[4],
          );
          if (!device) fail(404, "device_missing");
          const next = structuredClone(this.state);
          const target = next.devices.find(
            (d) => d.role === device.role && d.id === device.id,
          )!;
          target.revoked = true;
          target.revision++;
          for (const binding of Object.values(next.sessions))
            if (binding.keyId === device.id) binding.revoked = true;
          this.persist(next);
          this.registry.remove(device.role, device.id);
          this.onRevoke(device.role, device.id);
          json(200, { revoked: true });
          return true;
        }
      }
      if (path === "/api/releases/stable") {
        const directory = process.env.RELEASE_DIRECTORY;
        if (!directory || !existsSync(resolve(directory, "stable.json")))
          fail(503, "release_preparing");
        json(
          200,
          JSON.parse(readFileSync(resolve(directory, "stable.json"), "utf8")),
        );
        return true;
      }
      if (path.startsWith("/downloads/")) {
        const directory = process.env.RELEASE_DIRECTORY || "";
        const release = JSON.parse(
          readFileSync(resolve(directory, "stable.json"), "utf8"),
        );
        if (path !== release.path) fail(404, "release_missing");
        response.writeHead(200, {
          "X-Accel-Redirect":
            "/_connector_files/" + path.slice("/downloads/".length),
          "content-type": "application/octet-stream",
          "content-disposition": "attachment",
          "cache-control": "private, no-store",
        });
        response.end();
        return true;
      }
      fail(404, "not_found");
    } catch (error) {
      const status = (error as any).status || 503;
      if (path === "/desktop-connect" && status === 401) {
        response.writeHead(303, {
          location:
            "/_fribench/auth/login?return_to=" +
            encodeURIComponent(request.url || "/"),
          "cache-control": "no-store",
        });
        response.end();
      } else
        json(status, {
          error: (error as Error).message,
          retryable: status === 503,
        });
    }
    return true;
  }
  private async finish(intent: Intent, body: any) {
    const grant = await this.internal("/internal/desktop/exchange", {
      code: body.code,
      code_verifier: body.verifier,
      redirect_uri: intent.redirectUri,
    });
    if (grant.sub !== this.owner) fail(403, "owner_required");
    const old = this.state.devices.find(
      (d) => d.role === "connector" && d.id === intent.idKey,
    );
    if (
      intent.approvalSession &&
      this.state.sessions[intent.approvalSession]?.revoked
    )
      fail(403, "device_revoked");
    if (old && old.routeId !== intent.routeId)
      fail(409, "device_route_conflict");
    if ((old?.revision || 0) !== intent.revision)
      fail(409, "authorization_changed");
    if (
      this.state.devices.some(
        (d) =>
          d.role === "connector" &&
          d.routeId === intent.routeId &&
          d.id !== intent.idKey,
      )
    )
      fail(409, "device_route_conflict");
    if (
      this.registry
        .listApproved()
        .some(
          (d) =>
            d.role === "connector" &&
            d.routeDeviceId === intent.routeId &&
            (d.id !== intent.idKey || d.publicKey !== intent.publicKey),
        )
    )
      fail(409, "device_route_conflict");
    if (
      this.registry
        .listApproved()
        .some(
          (d) =>
            d.role === "connector" &&
            d.id === intent.idKey &&
            d.routeDeviceId &&
            d.routeDeviceId !== intent.routeId,
        )
    )
      fail(409, "device_route_conflict");
    const record: Device = {
      role: "connector",
      id: intent.idKey,
      publicKey: intent.publicKey,
      label: intent.label,
      routeId: intent.routeId,
      revision: intent.revision + 1,
      revoked: false,
      securityVersion: grant.security_version,
    };
    const next = structuredClone(this.state);
    next.devices = next.devices.filter(
      (d) => d.role !== "connector" || d.id !== record.id,
    );
    next.devices.push(record);
    this.persist(next);
    return { bound: true, routeId: record.routeId };
  }
  private proxy(
    request: IncomingMessage,
    response: ServerResponse,
    path: string,
  ) {
    const allowed =
      /^\/_fribench\/auth\/(config|session|login|callback|logout|manage|bootstrap|complete)$/.test(
        path,
      ) || /^\/_fribench\/(client|account-view|viewport)\.(js|css)$/.test(path);
    if (!allowed) {
      response.writeHead(404);
      response.end();
      return;
    }
    const cookie = String(request.headers.cookie || "")
      .split(";")
      .map((c) => c.trim())
      .filter(
        (c) =>
          c.startsWith(cookieName + "=") || c.startsWith(cookieName + "_flow_"),
      )
      .join("; ");
    const headers: Record<string, string> = {
      host: new URL(this.origin).host,
      "x-fribench-app": this.app,
      cookie,
    };
    for (const key of ["origin", "content-type", "content-length", "accept"])
      if (request.headers[key]) headers[key] = String(request.headers[key]);
    const target = new URL(this.base);
    const source = new URL(request.url!, this.origin);
    target.pathname = source.pathname;
    target.search = source.search;
    const upstream = httpRequest(
      target,
      { method: request.method, headers, timeout: 5000 },
      (res) => {
        response.writeHead(res.statusCode || 503, res.headers);
        res.pipe(response);
      },
    );
    upstream.on("timeout", () => upstream.destroy());
    upstream.on("error", () => {
      if (!response.headersSent) response.writeHead(503);
      response.end();
    });
    request.pipe(upstream);
  }
  private downloadPage(response: ServerResponse) {
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(
      page(
        "下载客户端",
        '<a class="back-link" href="/">← 返回会话</a><div class="app-mark" aria-hidden="true">&gt;_</div><p class="eyebrow">CODEX ANYWHERE</p><h1>在手机上继续 Codex 会话</h1><p class="intro">安装 Fribench Codex Connector，从手机继续电脑上的 Codex 会话。</p><div class="download-card"><div><h2>Windows 客户端</h2><p>Windows 11 · x64 · 通用安装包</p></div><button id="download">下载安装包 ↓</button><p id="status" role="status"></p></div><section class="requirements"><h2>开始之前</h2><p>在已安装并登录 Codex Desktop 的 Windows 用户下安装。安装包内置运行环境，无需另外安装 Node.js 或 Git。</p><p>安装后连接 Fribench，选择允许访问的项目目录。每台电脑安装相同的客户端，在手机侧栏切换电脑。</p><p>远程使用时，电脑需保持开机、登录和联网。</p></section><p class="account-link"><a href="/_fribench/auth/login?return_to=%2Fdownload">登录 Fribench</a> 后可下载和管理设备</p><script src="/owner-download.js"></script>',
      ),
    );
  }
}
function hashBase64(value: string) {
  return createHash("sha256").update(String(value)).digest("base64url");
}
function escapeHtml(value: string) {
  return value.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
}
function page(title: string, body: string) {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="theme-color" content="#ffffff"><link rel="icon" type="image/png" href="/icons/icon-32.png?v=3"><link rel="apple-touch-icon" href="/icons/icon-180.png?v=3"><script src="/theme-init.js"></script><link rel="stylesheet" href="/owner.css"><title>${title}</title><main>${body}</main></html>`;
}
