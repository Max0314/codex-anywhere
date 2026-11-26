import { createHash, createPublicKey, verify } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  openSync,
  closeSync,
  unlinkSync,
  existsSync,
} from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { ownerCommand } from "./owner-control.js";

export function verifyRelease(
  manifest: Buffer,
  detached: string,
  publicText: string,
) {
  const pub = Buffer.from(publicText.trim().split(/\r?\n/)[1], "base64");
  const lines = detached.trim().split(/\r?\n/);
  const signature = Buffer.from(lines[1] || "", "base64");
  if (
    pub.length !== 42 ||
    signature.length !== 74 ||
    signature.subarray(0, 2).toString() !== "ED" ||
    !pub.subarray(2, 10).equals(signature.subarray(2, 10)) ||
    !lines[2]?.startsWith("trusted comment: ")
  )
    throw Error("更新签名不匹配");
  const key = createPublicKey({
    key: Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      pub.subarray(10),
    ]),
    format: "der",
    type: "spki",
  });
  if (
    !verify(
      null,
      createHash("blake2b512").update(manifest).digest(),
      key,
      signature.subarray(10),
    ) ||
    !verify(
      null,
      Buffer.concat([signature.subarray(10), Buffer.from(lines[2].slice(17))]),
      key,
      Buffer.from(lines[3], "base64"),
    )
  )
    throw Error("更新签名无效");
  return JSON.parse(manifest.toString("utf8"));
}

async function update() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const installed = JSON.parse(
    readFileSync(join(root, "connector-release.json"), "utf8"),
  );
  const { release, token } = await ownerCommand("release");
  const metadata = verifyRelease(
    Buffer.from(release.manifest, "base64"),
    release.signature,
    readFileSync(join(root, "release.pub"), "utf8"),
  );
  if (
    metadata.releaseSeq <= installed.releaseSeq ||
    metadata.version === installed.version
  ) {
    console.log("当前已是最新版本");
    return;
  }
  if (
    metadata.platform !== "win32-x64" ||
    metadata.protocolMin > 5 ||
    metadata.protocolMax < 5 ||
    !/^\/downloads\/[\w.-]+\/[\w.-]+\.exe$/.test(metadata.path)
  )
    throw Error("更新版本不兼容");
  console.log("可更新至 " + metadata.version);
  if (!process.argv.includes("--install")) return;
  const response = await fetch("https://codex.fribench.cn" + metadata.path, {
    headers: { authorization: "Bearer " + token },
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok) throw Error("下载失败，请重试");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (
    bytes.length !== metadata.bytes ||
    createHash("sha256").update(bytes).digest("hex") !== metadata.sha256
  )
    throw Error("安装包校验失败");
  const destination = join(
    process.env.LOCALAPPDATA!,
    "Fribench",
    "CodexConnector",
    "versions",
    metadata.version,
  );
  const download = join(process.env.USERPROFILE!, ".codex-anywhere", "updates");
  mkdirSync(download, { recursive: true });
  const exe = join(download, "connector-" + metadata.version + ".exe");
  writeFileSync(exe, bytes);
  try {
    await ownerCommand("prepare");
  } catch (error) {
    await ownerCommand("resume").catch(() => {});
    throw error;
  }
  await ownerCommand("stop");
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 1000));
  const child = spawn(exe, ["/S", "/D=" + destination], {
    windowsHide: true,
    stdio: "ignore",
  });
  const code = await new Promise((resolveExit) =>
    child.on("exit", resolveExit),
  );
  let healthy = false;
  if (code === 0) {
    for (let attempt = 0; attempt < 30; attempt++) {
      const status = await ownerCommand("status").catch(() => null);
      if (status?.version === metadata.version) {
        healthy = true;
        break;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 1000));
    }
  }
  if (!healthy) {
    const powershell = join(
      process.env.SystemRoot!,
      "System32/WindowsPowerShell/v1.0/powershell.exe",
    );
    const restore = spawn(
      powershell,
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        join(root, "scripts/install-owner-connector.ps1"),
      ],
      { windowsHide: true, stdio: "ignore" },
    );
    await new Promise((resolveExit) => restore.on("exit", resolveExit));
    throw Error("新版未通过启动检查，已恢复原版本启动配置。");
  }
  console.log("更新已安装");
}
async function exclusiveUpdate() {
  const directory = join(
    process.env.USERPROFILE!,
    ".codex-anywhere",
    "updates",
  );
  mkdirSync(directory, { recursive: true });
  const lock = join(directory, "update.lock");
  if (existsSync(lock)) {
    const pid = Number(readFileSync(lock, "utf8"));
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {
      /* An interrupted updater no longer owns its lock. */
    }
    if (alive) throw Error("另一更新任务正在进行");
    unlinkSync(lock);
  }
  const fd = openSync(lock, "wx", 0o600);
  writeFileSync(fd, String(process.pid));
  closeSync(fd);
  try {
    await update();
  } finally {
    unlinkSync(lock);
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  void exclusiveUpdate().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
