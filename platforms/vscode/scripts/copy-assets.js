// Copy the small (256px, <1 MB Marketplace limit) icon into the VS Code extension package before vsce runs.
const fs = require("fs");
const path = require("path");

const source = path.resolve(__dirname, "../../../assets/images/icon.png");
const destination = path.resolve(__dirname, "../media/logo.png");
fs.copyFileSync(source, destination);
