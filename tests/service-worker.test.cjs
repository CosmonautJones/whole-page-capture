const assert = require("node:assert/strict");
const test = require("node:test");

const core = require("../capture-core.js");
const { createCoordinator } = require("../service-worker.js");

function createEvent() {
  const listeners = [];
  return {
    addListener(listener) {
      listeners.push(listener);
    },
    emit(...args) {
      return listeners.map((listener) => listener(...args));
    },
  };
}

function createFakeChrome() {
  const stored = new Map();
  const calls = {
    menus: [],
    injections: [],
    captures: [],
    badges: [],
  };
  let activeTabId = 17;

  const chrome = {
    runtime: {
      id: "extension-id",
      onInstalled: createEvent(),
      onStartup: createEvent(),
      onMessage: createEvent(),
    },
    contextMenus: {
      onClicked: createEvent(),
      async removeAll() {
        calls.menus.length = 0;
      },
      create(options) {
        calls.menus.push(options);
        return options.id;
      },
    },
    tabs: {
      onUpdated: createEvent(),
      onRemoved: createEvent(),
      async query() {
        return activeTabId == null
          ? []
          : [{ id: activeTabId, windowId: 4, active: true }];
      },
      async captureVisibleTab(windowId, options) {
        calls.captures.push({ windowId, options });
        return "data:image/png;base64,dGlsZQ==";
      },
    },
    scripting: {
      async executeScript(options) {
        calls.injections.push(options);
      },
    },
    storage: {
      session: {
        async get(key) {
          if (typeof key === "string") {
            return stored.has(key) ? { [key]: structuredClone(stored.get(key)) } : {};
          }
          return Object.fromEntries(stored);
        },
        async set(entries) {
          for (const [key, value] of Object.entries(entries)) {
            stored.set(key, structuredClone(value));
          }
        },
        async remove(key) {
          stored.delete(key);
        },
      },
    },
    action: {
      async setBadgeText(options) {
        calls.badges.push({ type: "text", ...options });
      },
      async setBadgeBackgroundColor(options) {
        calls.badges.push({ type: "color", ...options });
      },
    },
  };

  return {
    chrome,
    calls,
    stored,
    setActiveTabId(value) {
      activeTabId = value;
    },
  };
}

function sender(tabId = 17) {
  return {
    id: "extension-id",
    tab: { id: tabId, windowId: 4, active: true },
  };
}

test("creates one web-page-only context menu", async () => {
  const fake = createFakeChrome();
  const coordinator = createCoordinator(fake.chrome, core);

  await coordinator.ensureMenu();

  assert.deepEqual(fake.calls.menus, [
    {
      id: "whole-page-capture",
      title: "Capture full webpage",
      contexts: ["page"],
      documentUrlPatterns: ["http://*/*", "https://*/*"],
    },
  ]);
});

test("locks the clicked tab and injects capture scripts in order", async () => {
  const fake = createFakeChrome();
  const coordinator = createCoordinator(fake.chrome, core, {
    now: () => 1000,
    uuid: () => "token-1",
    wait: async () => {},
  });

  const result = await coordinator.startCapture({ id: 17, windowId: 4 });

  assert.deepEqual(result, { ok: true, token: "token-1" });
  assert.deepEqual(fake.stored.get("capture:17"), {
    token: "token-1",
    startedAt: 1000,
    status: "working",
  });
  assert.deepEqual(fake.calls.injections, [
    {
      target: { tabId: 17 },
      files: ["capture-core.js", "capture-page.js"],
    },
  ]);
});

test("keeps a live lock and replaces only a ten-minute stale lock", async () => {
  const fake = createFakeChrome();
  let now = 1000;
  let tokenNumber = 0;
  const coordinator = createCoordinator(fake.chrome, core, {
    now: () => now,
    uuid: () => `token-${++tokenNumber}`,
    wait: async () => {},
  });

  assert.equal((await coordinator.startCapture({ id: 17, windowId: 4 })).ok, true);
  assert.equal((await coordinator.startCapture({ id: 17, windowId: 4 })).error.code, "already-running");

  now += 10 * 60 * 1000 + 1;
  assert.deepEqual(await coordinator.startCapture({ id: 17, windowId: 4 }), {
    ok: true,
    token: "token-2",
  });
});

test("returns a token only to the injected script in its locked tab", async () => {
  const fake = createFakeChrome();
  const coordinator = createCoordinator(fake.chrome, core, {
    now: () => 1000,
    uuid: () => "token-1",
    wait: async () => {},
  });
  await coordinator.startCapture({ id: 17, windowId: 4 });

  assert.deepEqual(await coordinator.handleMessage({ type: "get-token" }, sender()), {
    ok: true,
    token: "token-1",
  });
  assert.equal(
    (await coordinator.handleMessage({ type: "get-token" }, { ...sender(), id: "other" })).error.code,
    "unexpected",
  );
});

test("rejects a tile from the wrong token or an inactive tab", async () => {
  const fake = createFakeChrome();
  const coordinator = createCoordinator(fake.chrome, core, {
    now: () => 1000,
    uuid: () => "token-1",
    wait: async () => {},
  });
  await coordinator.startCapture({ id: 17, windowId: 4 });

  assert.equal(
    (
      await coordinator.handleMessage(
        { type: "capture-tile", token: "wrong" },
        sender(),
      )
    ).error.code,
    "unexpected",
  );

  fake.setActiveTabId(99);
  assert.equal(
    (
      await coordinator.handleMessage(
        { type: "capture-tile", token: "token-1" },
        sender(),
      )
    ).error.code,
    "tab-not-active",
  );
  assert.equal(fake.calls.captures.length, 0);
});

test("spaces visible-tab captures by at least 600 milliseconds", async () => {
  const fake = createFakeChrome();
  let now = 1000;
  const waits = [];
  const coordinator = createCoordinator(fake.chrome, core, {
    now: () => now,
    uuid: () => "token-1",
    wait: async (milliseconds) => {
      waits.push(milliseconds);
      now += milliseconds;
    },
  });
  await coordinator.startCapture({ id: 17, windowId: 4 });

  const first = await coordinator.handleMessage(
    { type: "capture-tile", token: "token-1" },
    sender(),
  );
  now += 100;
  const second = await coordinator.handleMessage(
    { type: "capture-tile", token: "token-1" },
    sender(),
  );

  assert.equal(first.dataUrl, "data:image/png;base64,dGlsZQ==");
  assert.equal(second.dataUrl, "data:image/png;base64,dGlsZQ==");
  assert.deepEqual(waits, [500]);
  assert.equal(fake.calls.captures.length, 2);
});

test("stores only sanitized status and clears the lock when finished", async () => {
  const fake = createFakeChrome();
  const coordinator = createCoordinator(fake.chrome, core, {
    now: () => 1000,
    uuid: () => "token-1",
    wait: async () => {},
  });
  await coordinator.startCapture({ id: 17, windowId: 4 });

  const response = await coordinator.handleMessage(
    {
      type: "finish",
      token: "token-1",
      result: {
        status: "success",
        filename: "example-com-2026-08-30-194501.png",
        completedTiles: 8,
        totalTiles: 8,
        url: "https://secret.example/account",
        dataUrl: "data:image/png;base64,secret",
        title: "Secret account",
      },
    },
    sender(),
  );

  assert.deepEqual(response, { ok: true });
  assert.equal(fake.stored.has("capture:17"), false);
  assert.deepEqual(fake.stored.get("lastResult"), {
    status: "success",
    code: null,
    message: "Capture saved.",
    filename: "example-com-2026-08-30-194501.png",
    completedTiles: 8,
    totalTiles: 8,
  });
});

test("navigation and tab closure release a matching capture lock", async () => {
  const fake = createFakeChrome();
  const coordinator = createCoordinator(fake.chrome, core, {
    now: () => 1000,
    uuid: () => "token-1",
    wait: async () => {},
  });
  coordinator.register();
  await coordinator.startCapture({ id: 17, windowId: 4 });

  await Promise.all(fake.chrome.tabs.onUpdated.emit(17, { status: "loading" }));
  assert.equal(fake.stored.has("capture:17"), false);

  await coordinator.startCapture({ id: 17, windowId: 4 });
  await Promise.all(fake.chrome.tabs.onRemoved.emit(17));
  assert.equal(fake.stored.has("capture:17"), false);
});
