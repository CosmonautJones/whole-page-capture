const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repositoryRoot = path.resolve(__dirname, "..");

test("requests only the four permissions needed for an explicit local capture", () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(repositoryRoot, "manifest.json"), "utf8"),
  );

  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.minimum_chrome_version, "116");
  assert.deepEqual([...manifest.permissions].sort(), [
    "activeTab",
    "contextMenus",
    "scripting",
    "storage",
  ]);
  assert.equal("host_permissions" in manifest, false);
  assert.equal("content_scripts" in manifest, false);
  assert.equal(manifest.background.service_worker, "service-worker.js");
  assert.equal(manifest.action.default_popup, "popup.html");
});
