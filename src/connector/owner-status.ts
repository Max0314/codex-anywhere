import { ownerCommand } from "./owner-control.js";
void ownerCommand("status")
  .then((value) => console.log(JSON.stringify(value)))
  .catch(() => {
    process.exitCode = 1;
  });
