import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import {
  createDeviceIdentity,
  signDevicePayload,
} from "../shared/device-auth.js";

const identity = createDeviceIdentity(process.env.BRIDGE_DEVICE_PRIVATE_KEY);
delete process.env.BRIDGE_DEVICE_PRIVATE_KEY;
delete process.env.BRIDGE_CONNECTOR_TOKEN;
const origin = process.env.BRIDGE_OWNER_ORIGIN || "https://codex.fribench.cn";
const routeId = process.env.BRIDGE_DEVICE_ID!;
const label = process.env.BRIDGE_DEVICE_LABEL || routeId;
const state = randomBytes(32).toString("base64url");
const verifier = randomBytes(32).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
const post = async (path: string, body: unknown) => {
  const response = await fetch(origin + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok)
    throw Error("Binding request failed (" + response.status + ")");
  return response.json() as Promise<any>;
};
let intentId = "",
  nonce = "";
let completing = false;
const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", "http://127.0.0.1");
  if (
    completing ||
    request.method !== "GET" ||
    url.pathname !== "/fribench/callback" ||
    url.searchParams.get("state") !== state
  ) {
    response.writeHead(400);
    response.end("Invalid callback");
    return;
  }
  completing = true;
  try {
    const code = url.searchParams.get("code") || "";
    const signature = signDevicePayload(
      identity,
      JSON.stringify([
        "pc-finish-v1",
        intentId,
        nonce,
        routeId,
        createHash("sha256").update(code).digest("hex"),
      ]),
    );
    await post("/api/pc/intents/" + intentId + "/finish", {
      code,
      verifier,
      signature,
    });
    response.writeHead(200, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end("电脑已连接，可以关闭此页面。");
    console.log("BOUND");
    server.close();
    clearTimeout(timer);
  } catch {
    response.writeHead(503);
    response.end("Binding failed. Please try again from the connector.");
    server.close();
    clearTimeout(timer);
    process.exitCode = 1;
  }
});
const timer = setTimeout(() => {
  server.close();
  process.exitCode = 1;
  console.error("Binding timed out");
}, 300000);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string")
  throw Error("Loopback unavailable");
const redirectUri = `http://127.0.0.1:${address.port}/fribench/callback`;
const signature = signDevicePayload(
  identity,
  JSON.stringify([
    "pc-intent-v1",
    origin,
    routeId,
    identity.publicKey,
    label,
    state,
    challenge,
    redirectUri,
  ]),
);
try {
  const intent = await post("/api/pc/intents", {
    routeId,
    label,
    keyId: identity.id,
    publicKey: identity.publicKey,
    state,
    challenge,
    redirectUri,
    signature,
  });
  intentId = intent.intentId;
  nonce = intent.nonce;
  console.log("请在系统浏览器中确认连接。");
  const child = spawn(
    "rundll32.exe",
    ["url.dll,FileProtocolHandler", intent.url],
    { windowsHide: true, stdio: "ignore" },
  );
  child.unref();
} catch {
  server.close();
  clearTimeout(timer);
  process.exitCode = 1;
  console.error("无法连接 Fribench，请重试。");
}
