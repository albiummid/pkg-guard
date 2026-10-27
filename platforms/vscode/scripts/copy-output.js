// Copy the built .vsix to <repo root>/output/vscode.
const fs = require("fs");
const path = require("path");
const out = path.resolve(__dirname, "../../../output/vscode");
fs.mkdirSync(out, { recursive: true });
for (const f of fs.readdirSync(path.resolve(__dirname, ".."))) {
  if (f.endsWith(".vsix")) fs.copyFileSync(path.resolve(__dirname, "..", f), path.join(out, f));
}
