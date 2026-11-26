import { ownerCommand } from "./owner-control.js";
void (async () => {
  await ownerCommand("prepare");
  await ownerCommand("stop");
})().catch(async (error) => {
  await ownerCommand("resume").catch(() => {});
  console.error(error.message);
  process.exitCode = 1;
});
