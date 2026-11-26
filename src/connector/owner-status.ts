import { ownerCommand } from "./owner-control.js";
void ownerCommand(process.argv.includes("--display") ? "display-status" : "status")
  .then((value) => console.log(JSON.stringify(value)))
  .catch(() => {
    process.exitCode = 1;
  });
