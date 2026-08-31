const assert = require("node:assert/strict");
const test = require("node:test");
const { JSDOM } = require("jsdom");

const core = require("../capture-core.js");
const { createPageCapture } = require("../capture-page.js");

function createHarness(options = {}) {
  const dom = new JSDOM(
    `<!doctype html><html style="scroll-behavior: smooth !important"><body style="padding-right: 3px"><header id="fixed" style="position: fixed">Fixed</header><h2 id="sticky" style="position: sticky">Sticky</h2><main>Fixture</main></body></html>`,
    { url: "https://example.com/account" },
  );
  const { window } = dom;
  const { document } = window;
  let scrollX = 37;
  let scrollY = 911;
  const captures = [];
  const finishes = [];
  const downloads = [];
  const draws = [];
  const revoked = [];
  const dimensionSequence = options.dimensionSequence ?? [];
  let lastDimensions = options.dimensions ?? {
    viewportWidth: 1000,
    viewportHeight: 800,
    documentWidth: 1000,
    documentHeight: 2100,
  };

  Object.defineProperties(window, {
    innerWidth: { value: 1000, configurable: true },
    innerHeight: { value: 800, configurable: true },
    scrollX: { get: () => scrollX, configurable: true },
    scrollY: { get: () => scrollY, configurable: true },
  });
  window.scrollTo = (x, y) => {
    scrollX = Number(x);
    scrollY = Number(y);
  };
  document.getElementById("sticky").getBoundingClientRect = () => ({
    top: 1000 - scrollY,
    bottom: 1040 - scrollY,
    left: 0,
    right: 1000,
    width: 1000,
    height: 40,
    x: 0,
    y: 1000 - scrollY,
    toJSON() {},
  });

  const runtime = {
    async sendMessage(message) {
      if (message.type === "get-token") {
        return { ok: true, token: "token-1" };
      }
      if (message.type === "progress") {
        return { ok: true };
      }
      if (message.type === "capture-tile") {
        captures.push({
          scrollY,
          fixedVisibility: document.getElementById("fixed").style.visibility,
          stickyVisibility: document.getElementById("sticky").style.visibility,
        });
        if (options.tileError) {
          return { ok: false, error: { code: options.tileError } };
        }
        return { ok: true, dataUrl: "data:image/png;base64,dGlsZQ==" };
      }
      if (message.type === "finish") {
        finishes.push(message.result);
        return { ok: true };
      }
      throw new Error(`Unexpected message: ${message.type}`);
    },
  };

  const environment = {
    window,
    document,
    runtime,
    core,
    measure() {
      if (dimensionSequence.length > 0) {
        lastDimensions = dimensionSequence.shift();
      }
      return { ...lastDimensions };
    },
    async settle() {
      if (options.cancelDuringSettle && captures.length === 0) {
        options.cancelDuringSettle = false;
        document.dispatchEvent(
          new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        );
      }
    },
    async decodeImage() {
      if (options.decodeError) throw new Error("decode failed");
      return { width: 2000, height: 1600 };
    },
    createCanvas() {
      return {
        width: 0,
        height: 0,
        getContext() {
          return {
            drawImage(...args) {
              draws.push(args);
            },
          };
        },
        toBlob(callback) {
          callback(
            options.nullBlob
              ? null
              : new window.Blob(["verified-png"], { type: "image/png" }),
          );
        },
      };
    },
    createObjectURL() {
      return "blob:whole-page-capture";
    },
    revokeObjectURL(value) {
      revoked.push(value);
    },
    clickDownload({ href, filename }) {
      downloads.push({ href, filename });
    },
    now: () => new Date(2026, 7, 30, 19, 45, 1),
  };

  return {
    dom,
    window,
    document,
    captures,
    finishes,
    downloads,
    draws,
    revoked,
    getScroll: () => ({ x: scrollX, y: scrollY }),
    session: createPageCapture(environment),
  };
}

test("captures all tiles once and restores exact page state", async () => {
  const harness = createHarness();
  const html = harness.document.documentElement;
  const body = harness.document.body;

  const result = await harness.session.run();

  assert.equal(result.status, "success");
  assert.deepEqual(
    harness.captures.map((capture) => capture.scrollY),
    [0, 800, 1300],
  );
  assert.deepEqual(
    harness.captures.map((capture) => capture.fixedVisibility),
    ["", "hidden", "hidden"],
  );
  assert.deepEqual(
    harness.captures.map((capture) => capture.stickyVisibility),
    ["hidden", "", "hidden"],
  );
  assert.equal(harness.draws.length, 3);
  assert.deepEqual(harness.downloads, [
    {
      href: "blob:whole-page-capture",
      filename: "example-com-2026-08-30-194501.png",
    },
  ]);
  assert.deepEqual(harness.revoked, ["blob:whole-page-capture"]);
  assert.deepEqual(harness.getScroll(), { x: 37, y: 911 });
  assert.equal(html.style.getPropertyValue("scroll-behavior"), "smooth");
  assert.equal(html.style.getPropertyPriority("scroll-behavior"), "important");
  assert.equal(body.style.getPropertyValue("padding-right"), "3px");
  assert.equal(harness.document.getElementById("fixed").style.visibility, "");
  assert.equal(harness.document.getElementById("sticky").style.visibility, "");
  assert.equal(harness.document.querySelector("[data-whole-page-capture]"), null);
  assert.deepEqual(harness.finishes.at(-1), {
    status: "success",
    filename: "example-com-2026-08-30-194501.png",
    completedTiles: 3,
    totalTiles: 3,
  });
});

test("Escape cancels without a download and restores the starting scroll", async () => {
  const harness = createHarness({ cancelDuringSettle: true });

  const result = await harness.session.run();

  assert.equal(result.status, "cancelled");
  assert.equal(result.code, "cancelled");
  assert.equal(harness.downloads.length, 0);
  assert.deepEqual(harness.getScroll(), { x: 37, y: 911 });
  assert.equal(harness.document.querySelector("[data-whole-page-capture]"), null);
  assert.equal(harness.finishes.at(-1).status, "cancelled");
});

test("stops an endlessly growing page after three bounded growth rounds", async () => {
  const dimensions = [1000, 1100, 1200, 1300, 1400].map((documentHeight) => ({
    viewportWidth: 1000,
    viewportHeight: 800,
    documentWidth: 1000,
    documentHeight,
  }));
  const harness = createHarness({ dimensionSequence: dimensions });

  const result = await harness.session.run();

  assert.equal(result.status, "error");
  assert.equal(result.code, "page-keeps-growing");
  assert.equal(harness.downloads.length, 0);
  assert.deepEqual(harness.getScroll(), { x: 37, y: 911 });
});

test("a tile decode failure produces no partial image and restores the page", async () => {
  const harness = createHarness({ decodeError: true });

  const result = await harness.session.run();

  assert.equal(result.status, "error");
  assert.equal(result.code, "image-decode");
  assert.equal(harness.downloads.length, 0);
  assert.deepEqual(harness.getScroll(), { x: 37, y: 911 });
});

test("a null canvas blob fails safely without a download", async () => {
  const harness = createHarness({ nullBlob: true });

  const result = await harness.session.run();

  assert.equal(result.status, "error");
  assert.equal(result.code, "canvas-failed");
  assert.equal(harness.downloads.length, 0);
  assert.deepEqual(harness.getScroll(), { x: 37, y: 911 });
});

test("cleanup is idempotent", async () => {
  const harness = createHarness({ cancelDuringSettle: true });
  await harness.session.run();

  await harness.session.cleanup();
  await harness.session.cleanup();

  assert.deepEqual(harness.getScroll(), { x: 37, y: 911 });
  assert.equal(harness.document.querySelector("[data-whole-page-capture]"), null);
});
