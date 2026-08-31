(function attachWholePageCaptureCore(root, factory) {
  const api = factory();
  root.WholePageCaptureCore = api;
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis === "object" ? globalThis : self, function createCore() {
  "use strict";

  const LIMITS = Object.freeze({
    maxWidth: 16000,
    maxHeight: 32000,
    maxArea: 100000000,
    overflowTolerance: 4,
    minCaptureIntervalMs: 600,
  });

  const ERRORS = Object.freeze({
    "already-running":
      "A capture is already running on this tab. Wait or press Esc to cancel it.",
    "tab-not-active":
      "Keep this tab active until the download starts, then try again.",
    "page-changed":
      "The page changed size during capture. Nothing was downloaded. Let it finish loading and retry.",
    "page-keeps-growing":
      "This page keeps loading more content. Capture stopped so the PNG would not be incomplete.",
    "horizontal-overflow":
      "This page scrolls sideways. Version 1 captures pages that fit the browser width.",
    "page-too-large":
      "This page is too large for one reliable PNG. Nothing was downloaded.",
    "capture-rate":
      "Chrome paused screenshot capture. Wait a moment and retry.",
    "image-decode":
      "A screenshot tile could not be decoded. Nothing was downloaded.",
    "canvas-failed":
      "The browser could not create the final image. Close memory-heavy tabs and retry.",
    cancelled:
      "Capture cancelled. The page was restored and nothing was downloaded.",
    unexpected:
      "Capture failed safely. The page was restored and nothing was downloaded.",
  });

  class CaptureError extends Error {
    constructor(code) {
      const normalizedCode = Object.hasOwn(ERRORS, code) ? code : "unexpected";
      super(ERRORS[normalizedCode]);
      this.name = "CaptureError";
      this.code = normalizedCode;
    }
  }

  function isSupportedUrl(value) {
    try {
      return ["http:", "https:"].includes(new URL(value).protocol);
    } catch {
      return false;
    }
  }

  function pad(value) {
    return String(value).padStart(2, "0");
  }

  function makeFilename(hostname, date = new Date()) {
    const safeHostname = String(hostname ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80)
      .replace(/-$/g, "") || "webpage";
    const stamp = [
      date.getFullYear(),
      pad(date.getMonth() + 1),
      pad(date.getDate()),
      `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`,
    ].join("-");

    return `${safeHostname}-${stamp}.png`;
  }

  function planTiles(documentHeight, viewportHeight) {
    if (
      !Number.isFinite(documentHeight) ||
      !Number.isFinite(viewportHeight) ||
      documentHeight <= 0 ||
      viewportHeight <= 0
    ) {
      throw new TypeError("Tile dimensions must be positive finite numbers.");
    }

    if (documentHeight <= viewportHeight) {
      return [0];
    }

    const lastTop = documentHeight - viewportHeight;
    const targets = [];
    for (let top = 0; top < lastTop; top += viewportHeight) {
      targets.push(top);
    }
    if (targets.at(-1) !== lastTop) {
      targets.push(lastTop);
    }
    return targets;
  }

  function validateDimensions({ viewportWidth, documentWidth, documentHeight }) {
    if (
      ![viewportWidth, documentWidth, documentHeight].every(
        (value) => Number.isFinite(value) && value > 0,
      )
    ) {
      return { ok: false, code: "canvas-failed" };
    }

    if (documentWidth - viewportWidth > LIMITS.overflowTolerance) {
      return { ok: false, code: "horizontal-overflow" };
    }

    if (
      viewportWidth > LIMITS.maxWidth ||
      documentHeight > LIMITS.maxHeight ||
      viewportWidth * documentHeight > LIMITS.maxArea
    ) {
      return { ok: false, code: "page-too-large" };
    }

    return { ok: true };
  }

  function calculateCrop(tile, previousBottom, expectedScale) {
    const values = [
      tile.actualTop,
      tile.viewportWidth,
      tile.viewportHeight,
      tile.documentHeight,
      tile.imageWidth,
      tile.imageHeight,
      previousBottom,
      expectedScale,
    ];
    if (!values.every(Number.isFinite) || tile.actualTop < 0) {
      throw new RangeError("Tile order is reversed or invalid.");
    }
    if (tile.actualTop > previousBottom + 0.01) {
      throw new RangeError("Tile gap detected.");
    }

    const scale = tile.imageWidth / tile.viewportWidth;
    if (scale <= 0 || Math.abs(scale / expectedScale - 1) > 0.01) {
      throw new RangeError("Tile scale changed during capture.");
    }

    const overlapCss = Math.max(0, previousBottom - tile.actualTop);
    if (overlapCss >= tile.viewportHeight) {
      throw new RangeError("Tile order is reversed.");
    }

    const sourceY = Math.round(overlapCss * scale);
    const destinationY = tile.actualTop + overlapCss;
    const sourceAvailableCss = (tile.imageHeight - sourceY) / scale;
    const destinationAvailableCss = tile.documentHeight - destinationY;
    const destinationHeight = Math.min(
      tile.viewportHeight - overlapCss,
      sourceAvailableCss,
      destinationAvailableCss,
    );
    if (!(destinationHeight > 0)) {
      throw new RangeError("Tile order is reversed.");
    }

    return {
      sourceY,
      sourceHeight: Math.round(destinationHeight * scale),
      destinationY,
      destinationHeight,
      nextBottom: destinationY + destinationHeight,
      scale,
    };
  }

  function shouldShowSticky(originalTop, tileTop, tileBottom) {
    return originalTop >= tileTop && originalTop < tileBottom;
  }

  function normalizeError(error) {
    const code =
      error && typeof error === "object" && Object.hasOwn(ERRORS, error.code)
        ? error.code
        : typeof error === "string" && Object.hasOwn(ERRORS, error)
          ? error
          : "unexpected";
    return Object.freeze({ code, message: ERRORS[code] });
  }

  return Object.freeze({
    LIMITS,
    ERRORS,
    CaptureError,
    isSupportedUrl,
    makeFilename,
    planTiles,
    validateDimensions,
    calculateCrop,
    shouldShowSticky,
    normalizeError,
  });
});
