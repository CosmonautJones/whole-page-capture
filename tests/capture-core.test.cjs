const assert = require("node:assert/strict");
const test = require("node:test");

const core = require("../capture-core.js");

test("accepts only ordinary web page URLs", () => {
  assert.equal(core.isSupportedUrl("https://example.com/a"), true);
  assert.equal(core.isSupportedUrl("http://127.0.0.1:4173/fixture"), true);
  assert.equal(core.isSupportedUrl("chrome://extensions"), false);
  assert.equal(core.isSupportedUrl("file:///fixture.html"), false);
  assert.equal(core.isSupportedUrl("not a url"), false);
});

test("builds a private filename without page title data", () => {
  const date = new Date(2026, 7, 30, 19, 45, 1);

  assert.equal(
    core.makeFilename("EXAMPLE.com", date),
    "example-com-2026-08-30-194501.png",
  );
  assert.equal(
    core.makeFilename(" weird / host !!! ", date),
    "weird-host-2026-08-30-194501.png",
  );
  assert.equal(
    core.makeFilename("---", date),
    "webpage-2026-08-30-194501.png",
  );
});

test("limits the sanitized hostname portion to 80 characters", () => {
  const date = new Date(2026, 7, 30, 19, 45, 1);
  const filename = core.makeFilename("a".repeat(120), date);

  assert.equal(filename, `${"a".repeat(80)}-2026-08-30-194501.png`);
});

test("plans one tile when the document fits the viewport", () => {
  assert.deepEqual(core.planTiles(799, 800), [0]);
  assert.deepEqual(core.planTiles(800, 800), [0]);
});

test("plans non-overlapping full tiles and one overlapping final tile", () => {
  assert.deepEqual(core.planTiles(1600, 800), [0, 800]);
  assert.deepEqual(core.planTiles(2100, 800), [0, 800, 1300]);
  assert.deepEqual(core.planTiles(2100.5, 800.25), [0, 800.25, 1300.25]);
});

test("rejects invalid tile dimensions", () => {
  assert.throws(() => core.planTiles(0, 800), /positive/);
  assert.throws(() => core.planTiles(800, Number.NaN), /positive/);
});

test("allows four CSS pixels of horizontal overflow but not five", () => {
  assert.deepEqual(
    core.validateDimensions({
      viewportWidth: 1000,
      documentWidth: 1004,
      documentHeight: 2000,
    }),
    { ok: true },
  );
  assert.equal(
    core.validateDimensions({
      viewportWidth: 1000,
      documentWidth: 1005,
      documentHeight: 2000,
    }).code,
    "horizontal-overflow",
  );
});

test("rejects each output limit before capture", () => {
  const cases = [
    { viewportWidth: 16001, documentWidth: 16001, documentHeight: 100 },
    { viewportWidth: 1000, documentWidth: 1000, documentHeight: 32001 },
    { viewportWidth: 10000, documentWidth: 10000, documentHeight: 10001 },
  ];

  for (const dimensions of cases) {
    assert.equal(core.validateDimensions(dimensions).code, "page-too-large");
  }
});

test("rejects non-finite and non-positive output dimensions", () => {
  assert.equal(
    core.validateDimensions({
      viewportWidth: Number.NaN,
      documentWidth: 1000,
      documentHeight: 1000,
    }).code,
    "canvas-failed",
  );
  assert.equal(
    core.validateDimensions({
      viewportWidth: 1000,
      documentWidth: 1000,
      documentHeight: 0,
    }).code,
    "canvas-failed",
  );
});

test("crops overlap from the final tile without a seam or duplicate", () => {
  assert.deepEqual(
    core.calculateCrop(
      {
        actualTop: 1300,
        viewportWidth: 1000,
        viewportHeight: 800,
        documentHeight: 2100,
        imageWidth: 2000,
        imageHeight: 1600,
      },
      1600,
      2,
    ),
    {
      sourceY: 600,
      sourceHeight: 1000,
      destinationY: 1600,
      destinationHeight: 500,
      nextBottom: 2100,
      scale: 2,
    },
  );
});

test("rejects tile gaps, reversed tiles, and scale drift over one percent", () => {
  const base = {
    actualTop: 801,
    viewportWidth: 1000,
    viewportHeight: 800,
    documentHeight: 2100,
    imageWidth: 2000,
    imageHeight: 1600,
  };

  assert.throws(() => core.calculateCrop(base, 800, 2), /gap/);
  assert.throws(
    () => core.calculateCrop({ ...base, actualTop: -1 }, 0, 2),
    /reversed/,
  );
  assert.throws(
    () => core.calculateCrop({ ...base, actualTop: 800, imageWidth: 2021 }, 800, 2),
    /scale/,
  );
});

test("shows each sticky element in exactly its natural tile", () => {
  const tiles = [
    [0, 800],
    [800, 1600],
    [1300, 2100],
  ];

  assert.deepEqual(
    tiles.map(([top, bottom]) => core.shouldShowSticky(1125, top, bottom)),
    [false, true, false],
  );
});

test("normalizes every public failure without leaking raw details", () => {
  const expectedCodes = [
    "already-running",
    "tab-not-active",
    "page-changed",
    "page-keeps-growing",
    "horizontal-overflow",
    "page-too-large",
    "capture-rate",
    "image-decode",
    "canvas-failed",
    "cancelled",
    "unexpected",
  ];

  assert.deepEqual(Object.keys(core.ERRORS).sort(), expectedCodes.sort());
  assert.deepEqual(core.normalizeError({ code: "cancelled", stack: "secret" }), {
    code: "cancelled",
    message: core.ERRORS.cancelled,
  });
  assert.deepEqual(core.normalizeError(new Error("sensitive page text")), {
    code: "unexpected",
    message: core.ERRORS.unexpected,
  });
});
