// Copy shared branding into the VS Code extension package before vsce runs.
const fs = require("fs");
const path = require("path");

const source = path.resolve(__dirname, "../../../assets/images/logo.png");
const destination = path.resolve(__dirname, "../media/logo.png");
fs.copyFileSync(source, destination);
