const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const repositoryRoot = path.resolve(__dirname, "..");
const expectedEntries = [
  "README.md",
  "capture-core.js",
  "capture-page.js",
  "icons/icon-128.png",
  "icons/icon-16.png",
  "icons/icon-32.png",
  "icons/icon-48.png",
  "manifest.json",
  "popup.css",
  "popup.html",
  "popup.js",
  "service-worker.js",
].sort();

function runPowerShell(scriptPath) {
  return spawnSync(
    "pwsh",
    ["-NoProfile", "-File", scriptPath],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
}

test("popup gives one instruction and an honest local-only status", () => {
  const html = fs.readFileSync(path.join(repositoryRoot, "popup.html"), "utf8");

  assert.match(html, /Right-click a webpage/);
  assert.match(html, /Captures stay on this device/);
  assert.match(html, /aria-live="polite"/);
  assert.doesNotMatch(html, /<script(?![^>]+src=)/i);
});

test("runtime code contains no network or telemetry path", () => {
  const runtimeFiles = [
    "capture-core.js",
    "capture-page.js",
    "service-worker.js",
    "popup.js",
  ];
  const forbidden = [
    /\bfetch\s*\(/,
    /XMLHttpRequest/,
    /\bWebSocket\b/,
    /sendBeacon/,
    /google-analytics|segment\.com|sentry\.io/i,
  ];

  for (const relativePath of runtimeFiles) {
    const source = fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8");
    for (const pattern of forbidden) {
      assert.doesNotMatch(source, pattern, `${relativePath} must stay local-only`);
    }
  }
});

test("packaging produces only the approved runtime files and a matching checksum", () => {
  const result = runPowerShell(path.join(repositoryRoot, "scripts", "package.ps1"));
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

  const zipPath = path.join(repositoryRoot, "dist", "whole-page-capture.zip");
  const checksumPath = `${zipPath}.sha256`;
  const escapedZipPath = zipPath.replaceAll("'", "''");
  const listCommand = [
    `$zip = [IO.Compression.ZipFile]::OpenRead('${escapedZipPath}')`,
    "try { $zip.Entries.FullName | Sort-Object | ConvertTo-Json -Compress } finally { $zip.Dispose() }",
  ].join("; ");
  const listed = spawnSync(
    "pwsh",
    ["-NoProfile", "-Command", listCommand],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(JSON.parse(listed.stdout.trim()).sort(), expectedEntries);

  const actualHash = crypto
    .createHash("sha256")
    .update(fs.readFileSync(zipPath))
    .digest("hex");
  assert.equal(
    fs.readFileSync(checksumPath, "utf8").trim(),
    `${actualHash}  whole-page-capture.zip`,
  );
});
