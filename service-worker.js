/* global chrome, importScripts */
(function initializeServiceWorker(root) {
  "use strict";

  let core;
  if (typeof module === "object" && module.exports) {
    core = require("./capture-core.js");
  } else {
    importScripts("capture-core.js");
    core = root.WholePageCaptureCore;
  }

  const MENU_ID = "whole-page-capture";
  const LOCK_TTL_MS = 10 * 60 * 1000;

  function createCoordinator(chromeApi, captureCore, dependencies = {}) {
    const now = dependencies.now ?? (() => Date.now());
    const uuid = dependencies.uuid ?? (() => crypto.randomUUID());
    const wait =
      dependencies.wait ??
      ((milliseconds) =>
        new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds)));
    let lastCaptureStartedAt = 0;
    let registered = false;

    const lockKey = (tabId) => `capture:${tabId}`;

    async function ensureMenu() {
      await chromeApi.contextMenus.removeAll();
      chromeApi.contextMenus.create({
        id: MENU_ID,
        title: "Capture full webpage",
        contexts: ["page"],
        documentUrlPatterns: ["http://*/*", "https://*/*"],
      });
    }

    async function getLock(tabId) {
      const key = lockKey(tabId);
      return (await chromeApi.storage.session.get(key))[key] ?? null;
    }

    async function releaseLock(tabId, token = null) {
      const key = lockKey(tabId);
      const lock = await getLock(tabId);
      if (lock && (token === null || lock.token === token)) {
        await chromeApi.storage.session.remove(key);
      }
    }

    async function acquireLock(tabId) {
      const key = lockKey(tabId);
      const startedAt = now();
      const current = await getLock(tabId);
      if (current && startedAt - current.startedAt <= LOCK_TTL_MS) {
        return { ok: false, error: captureCore.normalizeError("already-running") };
      }
      if (current) {
        await chromeApi.storage.session.remove(key);
      }

      const token = uuid();
      await chromeApi.storage.session.set({
        [key]: { token, startedAt, status: "working" },
      });
      return { ok: true, token };
    }

    function safeCount(value) {
      return Number.isInteger(value) && value >= 0 ? value : 0;
    }

    function safeFilename(value) {
      if (typeof value !== "string" || value.length > 180) return "";
      return /^[a-z0-9.-]+\.png$/i.test(value) ? value : "";
    }

    function sanitizeResult(result = {}) {
      const status = ["working", "success", "error", "cancelled"].includes(
        result.status,
      )
        ? result.status
        : "error";
      const normalized =
        status === "success"
          ? { code: null, message: "Capture saved." }
          : status === "working"
            ? { code: null, message: "Capturing the full page…" }
            : captureCore.normalizeError(
                status === "cancelled" ? "cancelled" : result.code,
              );

      return {
        status,
        code: normalized.code,
        message: normalized.message,
        filename: safeFilename(result.filename),
        completedTiles: safeCount(result.completedTiles),
        totalTiles: safeCount(result.totalTiles),
      };
    }

    async function setBadge(tabId, status) {
      const text =
        status === "working"
          ? "…"
          : status === "success"
            ? "✓"
            : status === "cancelled"
              ? "×"
              : "!";
      const color =
        status === "working"
          ? "#2563eb"
          : status === "success"
            ? "#15803d"
            : "#b91c1c";
      await chromeApi.action.setBadgeBackgroundColor({ tabId, color });
      await chromeApi.action.setBadgeText({ tabId, text });
    }

    async function setResult(tabId, result) {
      const sanitized = sanitizeResult(result);
      await chromeApi.storage.session.set({ lastResult: sanitized });
      await setBadge(tabId, sanitized.status);
      return sanitized;
    }

    async function startCapture(tab) {
      if (!tab || !Number.isInteger(tab.id) || !Number.isInteger(tab.windowId)) {
        return { ok: false, error: captureCore.normalizeError("unexpected") };
      }

      const lock = await acquireLock(tab.id);
      if (!lock.ok) {
        await setResult(tab.id, {
          status: "error",
          code: lock.error.code,
        });
        return lock;
      }

      try {
        await setResult(tab.id, { status: "working" });
        await chromeApi.scripting.executeScript({
          target: { tabId: tab.id },
          files: ["capture-core.js", "capture-page.js"],
        });
        return lock;
      } catch (error) {
        const normalized = captureCore.normalizeError(error);
        await setResult(tab.id, { status: "error", code: normalized.code });
        await releaseLock(tab.id, lock.token);
        return { ok: false, error: normalized };
      }
    }

    async function verifySender(sender, token, requireToken = true) {
      if (
        !sender ||
        sender.id !== chromeApi.runtime.id ||
        !sender.tab ||
        !Number.isInteger(sender.tab.id) ||
        !Number.isInteger(sender.tab.windowId)
      ) {
        return { ok: false, error: captureCore.normalizeError("unexpected") };
      }

      const lock = await getLock(sender.tab.id);
      if (!lock || (requireToken && lock.token !== token)) {
        return { ok: false, error: captureCore.normalizeError("unexpected") };
      }
      return { ok: true, lock };
    }

    async function verifyActiveSender(sender, token) {
      const verified = await verifySender(sender, token, true);
      if (!verified.ok) return verified;

      const activeTabs = await chromeApi.tabs.query({
        active: true,
        windowId: sender.tab.windowId,
      });
      if (activeTabs.length !== 1 || activeTabs[0].id !== sender.tab.id) {
        return {
          ok: false,
          error: captureCore.normalizeError("tab-not-active"),
        };
      }
      return verified;
    }

    async function captureTile(sender, token) {
      const verified = await verifyActiveSender(sender, token);
      if (!verified.ok) return verified;

      const elapsed = now() - lastCaptureStartedAt;
      const delay = Math.max(
        0,
        captureCore.LIMITS.minCaptureIntervalMs - elapsed,
      );
      if (lastCaptureStartedAt > 0 && delay > 0) {
        await wait(delay);
      }
      lastCaptureStartedAt = now();

      try {
        const dataUrl = await chromeApi.tabs.captureVisibleTab(
          sender.tab.windowId,
          { format: "png" },
        );
        return { ok: true, dataUrl };
      } catch (error) {
        const isRateFailure = String(error?.message ?? error).includes(
          "MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND",
        );
        return {
          ok: false,
          error: captureCore.normalizeError(
            isRateFailure ? "capture-rate" : "unexpected",
          ),
        };
      }
    }

    async function finish(tabId, token, result) {
      try {
        await setResult(tabId, result);
      } finally {
        await releaseLock(tabId, token);
      }
      return { ok: true };
    }

    async function cancelForTab(tabId) {
      const lock = await getLock(tabId);
      if (!lock) return;
      await finish(tabId, lock.token, {
        status: "cancelled",
        code: "cancelled",
      });
    }

    async function handleMessage(message, sender) {
      if (!message || typeof message.type !== "string") {
        return { ok: false, error: captureCore.normalizeError("unexpected") };
      }

      if (message.type === "get-token") {
        const verified = await verifySender(sender, null, false);
        return verified.ok
          ? { ok: true, token: verified.lock.token }
          : verified;
      }

      if (message.type === "capture-tile") {
        return captureTile(sender, message.token);
      }

      if (message.type === "progress") {
        const verified = await verifySender(sender, message.token, true);
        if (!verified.ok) return verified;
        await setResult(sender.tab.id, {
          status: "working",
          completedTiles: message.completedTiles,
          totalTiles: message.totalTiles,
        });
        return { ok: true };
      }

      if (message.type === "finish") {
        const verified = await verifySender(sender, message.token, true);
        if (!verified.ok) return verified;
        return finish(sender.tab.id, message.token, message.result);
      }

      return { ok: false, error: captureCore.normalizeError("unexpected") };
    }

    function register() {
      if (registered) return;
      registered = true;
      chromeApi.runtime.onInstalled.addListener(() => ensureMenu());
      chromeApi.runtime.onStartup.addListener(() => ensureMenu());
      chromeApi.contextMenus.onClicked.addListener((info, tab) => {
        if (info.menuItemId === MENU_ID) return startCapture(tab);
        return undefined;
      });
      chromeApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
        handleMessage(message, sender)
          .then(sendResponse)
          .catch((error) =>
            sendResponse({
              ok: false,
              error: captureCore.normalizeError(error),
            }),
          );
        return true;
      });
      chromeApi.tabs.onUpdated.addListener((tabId, changeInfo) => {
        if (changeInfo.status === "loading") return cancelForTab(tabId);
        return undefined;
      });
      chromeApi.tabs.onRemoved.addListener((tabId) => cancelForTab(tabId));
    }

    return Object.freeze({
      ensureMenu,
      startCapture,
      handleMessage,
      releaseLock,
      register,
    });
  }

  if (typeof module === "object" && module.exports) {
    module.exports = { createCoordinator };
  } else {
    createCoordinator(chrome, core).register();
  }
})(typeof globalThis === "object" ? globalThis : self);
