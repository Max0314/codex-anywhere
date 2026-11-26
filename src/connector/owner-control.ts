import { createServer, connect } from "node:net";
import { createHash } from "node:crypto";
import { userInfo } from "node:os";

export const controlPipe = () =>
  "\\\\.\\pipe\\codex-anywhere-owner-" +
  createHash("sha256").update(userInfo().username).digest("hex").slice(0, 24);
export function startOwnerControl(
  handle: (command: string) => Promise<unknown>,
) {
  const server = createServer((socket) => {
    let input = "";
    socket.setTimeout(15000, () => socket.destroy());
    socket.on("data", (chunk) => {
      input += chunk;
      if (input.length > 1024) {
        socket.destroy();
        return;
      }
      if (!input.includes("\n")) return;
      socket.pause();
      void handle(input.trim())
        .then((data) => socket.end(JSON.stringify({ ok: true, data }) + "\n"))
        .catch((error) =>
          socket.end(
            JSON.stringify({ ok: false, error: error.message }) + "\n",
          ),
        );
    });
  });
  server.listen({
    path: controlPipe(),
    readableAll: false,
    writableAll: false,
  });
  return server;
}
export async function ownerCommand(command: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = connect(controlPipe());
    let input = "";
    socket.setTimeout(15000, () =>
      socket.destroy(Error("Connector request timed out")),
    );
    socket.on("connect", () => socket.write(command + "\n"));
    socket.on("data", (chunk) => {
      input += chunk;
    });
    socket.on("end", () => {
      try {
        const result = JSON.parse(input);
        result.ok ? resolve(result.data) : reject(Error(result.error));
      } catch (error) {
        reject(error);
      }
    });
    socket.on("error", reject);
  });
}
