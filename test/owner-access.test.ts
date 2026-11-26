import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { DeviceRegistry } from "../src/server/device-registry.js";
import { OwnerAccess } from "../src/server/owner-access.js";
import {
  createDeviceIdentity,
  createDeviceAuthProof,
  signDevicePayload,
} from "../src/shared/device-auth.js";
import { DEVICE_KEY_AUTH_CONTEXT } from "../src/shared/pairing-auth.js";

test("owner registration deduplicates concurrent sockets and revocation blocks HTTP and key replacement", async () => {
  const directory = mkdtempSync(join(tmpdir(), "anywhere-owner-"));
  const ownerSub = "11111111-1111-4111-8111-111111111111";
  const provider = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify(
        request.headers.cookie?.includes("valid")
          ? { authenticated: true, sub: ownerSub }
          : { authenticated: false },
      ),
    );
  });
  await new Promise<void>((resolve) =>
    provider.listen(0, "127.0.0.1", resolve),
  );
  const address = provider.address() as any;
  const saved = { ...process.env };
  Object.assign(process.env, {
    PUBLIC_ORIGIN: "https://test.invalid",
    OWNER_SUB: ownerSub,
    IDENTITY_BASE_URL: "http://127.0.0.1:" + address.port,
    FRIBENCH_CLIENT_SECRET: "a".repeat(48),
    SESSION_BINDING_KEY: "b".repeat(48),
  });
  const access = new OwnerAccess(
    new DeviceRegistry(join(directory, "devices.json")),
  );
  const identity = createDeviceIdentity();
  const challenge = "c".repeat(64);
  const frame = {
    type: "auth.device",
    role: "client",
    protocol: { version: 5 },
    device: createDeviceAuthProof(identity, {
      role: "client",
      challenge,
      authProof: DEVICE_KEY_AUTH_CONTEXT,
    }),
  };
  const request = {
    url: "/ws/browser",
    headers: {
      origin: "https://test.invalid",
      cookie: "__Host-fribench_codex_anywhere=valid",
    },
  } as any;
  const service = createServer(async (req, res) => {
    await access.handle(req, res);
  });
  await new Promise<void>((resolve) => service.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + (service.address() as any).port;
  try {
    const [a, b] = await Promise.all([
      access.authorize(request, frame, challenge),
      access.authorize(request, frame, challenge),
    ]);
    assert.equal(access.valid(a), true);
    const headers = { cookie: request.headers.cookie };
    const list = (await fetch(base + "/api/devices", { headers }).then((r) =>
      r.json(),
    )) as any[];
    assert.equal(list.length, 1);
    const session = (await fetch(base + "/api/access", { headers }).then((r) =>
      r.json(),
    )) as any;
    const revoked = await fetch(
      base + "/api/devices/client/" + identity.id + "/revoke",
      {
        method: "POST",
        headers: {
          ...headers,
          origin: "https://test.invalid",
          "content-type": "application/json",
        },
        body: JSON.stringify({ csrf: session.csrf }),
      },
    );
    assert.equal(revoked.status, 200);
    assert.equal(access.valid(a), false);
    assert.equal(access.valid(b), false);
    assert.equal((await fetch(base + "/api/devices", { headers })).status, 403);
    await assert.rejects(
      access.authorize(request, frame, challenge),
      /device_revoked/,
    );
    const replacement = createDeviceIdentity();
    await assert.rejects(
      access.authorize(
        request,
        {
          ...frame,
          device: createDeviceAuthProof(replacement, {
            role: "client",
            challenge,
            authProof: DEVICE_KEY_AUTH_CONTEXT,
          }),
        },
        challenge,
      ),
      /device_revoked/,
    );
  } finally {
    process.env = saved;
    await new Promise<void>((resolve) => service.close(() => resolve()));
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});

test("PC intent binds PKCE and device signature, rejects conflicting identity and reuses exact finish", async () => {
  const directory = mkdtempSync(join(tmpdir(), "anywhere-bind-"));
  const ownerSub = "11111111-1111-4111-8111-111111111111";
  let approvalAttempts = 0;
  const provider = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/internal/identity")
      response.end(JSON.stringify({ authenticated: true, sub: ownerSub }));
    else if (request.url === "/_fribench/auth/session") {
      assert.equal(request.method, "GET");
      response.end(JSON.stringify({ csrf: "provider-csrf" }));
    } else if (request.url === "/_fribench/desktop/approve") {
      if (++approvalAttempts === 1) {
        response.writeHead(503);
        response.end("{}");
        return;
      }
      response.end(
        JSON.stringify({
          redirect: "http://127.0.0.1:12345/fribench/callback?code=one",
        }),
      );
    } else
      response.end(
        JSON.stringify({ sub: ownerSub, security_version: "v1", active: true }),
      );
  });
  await new Promise<void>((resolve) =>
    provider.listen(0, "127.0.0.1", resolve),
  );
  const saved = { ...process.env };
  Object.assign(process.env, {
    PUBLIC_ORIGIN: "https://test.invalid",
    OWNER_SUB: ownerSub,
    IDENTITY_BASE_URL: "http://127.0.0.1:" + (provider.address() as any).port,
    FRIBENCH_CLIENT_SECRET: "a".repeat(48),
    SESSION_BINDING_KEY: "b".repeat(48),
  });
  const access = new OwnerAccess(
    new DeviceRegistry(join(directory, "devices.json")),
  );
  const service = createServer(async (req, res) => {
    await access.handle(req, res);
  });
  await new Promise<void>((resolve) => service.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + (service.address() as any).port;
  const identity = createDeviceIdentity();
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(32).toString("base64url");
  const fields = {
    routeId: "pc-test",
    label: "Test PC",
    keyId: identity.id,
    publicKey: identity.publicKey,
    state,
    challenge,
    redirectUri: "http://127.0.0.1:12345/fribench/callback",
  };
  const signature = signDevicePayload(
    identity,
    JSON.stringify([
      "pc-intent-v1",
      "https://test.invalid",
      fields.routeId,
      fields.publicKey,
      fields.label,
      state,
      challenge,
      fields.redirectUri,
    ]),
  );
  const headers = {
    cookie: "__Host-fribench_codex_anywhere=valid",
    origin: "https://test.invalid",
    "content-type": "application/json",
  };
  const post = (path: string, body: unknown) =>
    fetch(base + path, { method: "POST", headers, body: JSON.stringify(body) });
  try {
    assert.equal(
      (await post("/api/pc/intents", { ...fields, signature: "bad" })).status,
      403,
    );
    const intent = (await post("/api/pc/intents", {
      ...fields,
      signature,
    }).then((r) => r.json())) as any;
    const session = (await fetch(base + "/api/access", { headers }).then((r) =>
      r.json(),
    )) as any;
    const approve = () => post("/api/pc/intents/" + intent.intentId + "/approve", { csrf: session.csrf });
    assert.equal((await approve()).status, 503);
    const approved = await approve();
    assert.equal(approved.status, 200);
    assert.deepEqual(await (await approve()).json(), await approved.json());
    assert.equal(approvalAttempts, 2);
    const finish = {
      code: "one",
      verifier,
      signature: signDevicePayload(
        identity,
        JSON.stringify([
          "pc-finish-v1",
          intent.intentId,
          intent.nonce,
          fields.routeId,
          createHash("sha256").update("one").digest("hex"),
        ]),
      ),
    };
    assert.equal(
      (
        await post("/api/pc/intents/" + intent.intentId + "/finish", {
          ...finish,
          verifier: "bad",
        })
      ).status,
      403,
    );
    assert.equal(
      (await post("/api/pc/intents/" + intent.intentId + "/finish", finish))
        .status,
      200,
    );
    assert.equal(
      (await post("/api/pc/intents/" + intent.intentId + "/finish", finish))
        .status,
      200,
    );
  } finally {
    process.env = saved;
    await new Promise<void>((resolve) => service.close(() => resolve()));
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});
