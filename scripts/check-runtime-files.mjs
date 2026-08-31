import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(
  await fs.readFile(path.join(repositoryRoot, "manifest.json"), "utf8"),
);
const expectedPermissions = ["activeTab", "contextMenus", "scripting", "storage"];
assert.deepEqual([...manifest.permissions].sort(), expectedPermissions);
assert.equal("host_permissions" in manifest, false);
assert.equal("content_scripts" in manifest, false);

const runtimeFiles = [
  "capture-core.js",
  "capture-page.js",
  "service-worker.js",
  "popup.js",
  "popup.html",
  "popup.css",
  ...Object.values(manifest.icons),
];
for (const relativePath of runtimeFiles) {
  await fs.access(path.join(repositoryRoot, relativePath));
}

const forbiddenCode = [
  /\bfetch\s*\(/,
  /XMLHttpRequest/,
  /\bWebSocket\b/,
  /sendBeacon/,
  /google-analytics|segment\.com|sentry\.io/i,
];
for (const relativePath of runtimeFiles.filter((file) => /\.(js|html|css)$/.test(file))) {
  const source = await fs.readFile(path.join(repositoryRoot, relativePath), "utf8");
  for (const pattern of forbiddenCode) {
    assert.doesNotMatch(source, pattern, `${relativePath} contains a forbidden network path`);
  }
}

const popupHtml = await fs.readFile(path.join(repositoryRoot, "popup.html"), "utf8");
assert.doesNotMatch(popupHtml, /<(?:script|img|link)[^>]+(?:src|href)=["']https?:/i);
process.stdout.write(`Runtime boundary verified across ${runtimeFiles.length} files.\n`);
