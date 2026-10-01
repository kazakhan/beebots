import { randomBytes, scryptSync } from "node:crypto";
// Accept on stdin only, never command-line arguments or logs. For deployment,
// pipe from a hidden-input password prompt or password manager.
let text = "";
for await (const c of process.stdin) text += c;
const password = text.replace(/[\r\n]+$/, "");
if (password.length < 14) throw Error("Use at least 14 characters");
const salt = randomBytes(16).toString("hex");
console.log(salt + ":" + scryptSync(password, salt, 64).toString("hex"));
