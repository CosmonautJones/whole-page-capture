/* global chrome */
(function initializePageCapture(root) {
  "use strict";

  function createBrowserEnvironment() {
    const win = window;
    const doc = document;
    return {
      window: win,
      document: doc,
      runtime: chrome.runtime,
      core: root.WholePageCaptureCore,
      measure() {
        const html = doc.documentElement;
        const body = doc.body;
        return {
          viewportWidth: html.clientWidth || win.innerWidth,
          viewportHeight: win.innerHeight,
          documentWidth: Math.max(
            html.scrollWidth,
            html.offsetWidth,
            html.clientWidth,
            body?.scrollWidth ?? 0,
            body?.offsetWidth ?? 0,
          ),
          documentHeight: Math.max(
            html.scrollHeight,
            html.offsetHeight,
            html.clientHeight,
            body?.scrollHeight ?? 0,
            body?.offsetHeight ?? 0,
          ),
        };
      },
      async settle() {
        await new Promise((resolve) => win.requestAnimationFrame(resolve));
        await new Promise((resolve) => win.requestAnimationFrame(resolve));
        await new Promise((resolve) => win.setTimeout(resolve, 120));
      },
      decodeImage(dataUrl) {
        return new Promise((resolve, reject) => {
          const image = new Image();
          image.onload = () => resolve(image);
          image.onerror = () => reject(new Error("Image decode failed."));
          image.src = dataUrl;
        });
      },
      createCanvas() {
        return doc.createElement("canvas");
      },
      createObjectURL(blob) {
        return URL.createObjectURL(blob);
      },
      revokeObjectURL(url) {
        URL.revokeObjectURL(url);
      },
      clickDownload({ href, filename }) {
        const anchor = doc.createElement("a");
        anchor.href = href;
        anchor.download = filename;
        anchor.hidden = true;
        doc.body.append(anchor);
        anchor.click();
        anchor.remove();
      },
      now: () => new Date(),
    };
  }

  function createPageCapture(environment) {
    const win = environment.window;
    const doc = environment.document;
    const runtime = environment.runtime;
    const core = environment.core;
    const measure = environment.measure;
    const settle = environment.settle;
    const decodeImage = environment.decodeImage;
    const createCanvas = environment.createCanvas;
    const createObjectURL = environment.createObjectURL;
    const revokeObjectURL = environment.revokeObjectURL;
    const clickDownload = environment.clickDownload;
    const now = environment.now ?? (() => new Date());
    const initialScroll = { x: win.scrollX, y: win.scrollY };
    const restorations = [];
    const rememberedStyles = new WeakMap();
    const trackedElements = [];
    const cleanupErrors = [];
    let token = null;
    let cancelled = false;
    let cleaned = false;
    let panelHost = null;
    let panelText = null;

    function captureError(code) {
      return new core.CaptureError(code);
    }

    function rememberStyle(element, property) {
      let properties = rememberedStyles.get(element);
      if (!properties) {
        properties = new Map();
        rememberedStyles.set(element, properties);
      }
      if (properties.has(property)) return properties.get(property);

      const original = {
        value: element.style.getPropertyValue(property),
        priority: element.style.getPropertyPriority(property),
      };
      properties.set(property, original);
      restorations.push(() => {
        if (original.value) {
          element.style.setProperty(property, original.value, original.priority);
        } else {
          element.style.removeProperty(property);
        }
      });
      return original;
    }

    function setStyle(element, property, value, priority = "important") {
      rememberStyle(element, property);
      element.style.setProperty(property, value, priority);
    }

    function restoreRememberedStyle(element, property) {
      const original = rememberedStyles.get(element)?.get(property);
      if (!original || !original.value) {
        element.style.removeProperty(property);
        return;
      }
      element.style.setProperty(property, original.value, original.priority);
    }

    function scrollTo(x, y) {
      win.scrollTo(x, y);
    }

    function assertNotCancelled() {
      if (cancelled) throw captureError("cancelled");
    }

    function cancel() {
      cancelled = true;
    }

    function registerCancellationListeners() {
      const cancelOnInteraction = (event) => {
        if (event.type !== "keydown" || event.key) cancel();
      };
      const cancelOnVisibility = () => {
        if (doc.visibilityState === "hidden") cancel();
      };
      const documentEvents = ["keydown", "pointerdown", "wheel", "touchstart"];
      const windowEvents = ["pagehide", "beforeunload"];

      for (const type of documentEvents) {
        doc.addEventListener(type, cancelOnInteraction, { capture: true, passive: true });
      }
      doc.addEventListener("visibilitychange", cancelOnVisibility, true);
      for (const type of windowEvents) {
        win.addEventListener(type, cancelOnInteraction, true);
      }

      restorations.push(() => {
        for (const type of documentEvents) {
          doc.removeEventListener(type, cancelOnInteraction, true);
        }
        doc.removeEventListener("visibilitychange", cancelOnVisibility, true);
        for (const type of windowEvents) {
          win.removeEventListener(type, cancelOnInteraction, true);
        }
      });
    }

    function createStatusPanel() {
      panelHost = doc.createElement("div");
      panelHost.dataset.wholePageCapture = "";
      Object.assign(panelHost.style, {
        position: "fixed",
        zIndex: "2147483647",
        top: "16px",
        right: "16px",
        maxWidth: "320px",
        padding: "12px 14px",
        border: "1px solid rgba(255,255,255,.18)",
        borderRadius: "10px",
        background: "#111827",
        color: "#f9fafb",
        boxShadow: "0 12px 32px rgba(0,0,0,.28)",
        font: "600 13px/1.4 system-ui, sans-serif",
      });
      panelHost.setAttribute("role", "status");
      panelHost.setAttribute("aria-live", "polite");
      panelText = doc.createElement("span");
      panelText.textContent = "Preparing the page… Press Esc to cancel.";
      panelHost.append(panelText);
      doc.documentElement.append(panelHost);
      restorations.push(() => panelHost?.remove());
    }

    function updatePanel(message) {
      if (panelText) panelText.textContent = message;
    }

    function setPanelVisible(visible) {
      if (panelHost) panelHost.style.visibility = visible ? "visible" : "hidden";
    }

    function preparePage() {
      registerCancellationListeners();
      createStatusPanel();

      const html = doc.documentElement;
      const body = doc.body;
      setStyle(html, "scroll-behavior", "auto");
      setStyle(html, "scroll-snap-type", "none");
      setStyle(html, "overflow-y", "hidden");

      const clientWidth = html.clientWidth;
      const scrollbarWidth =
        clientWidth > 0 && win.innerWidth - clientWidth > 0
          ? Math.min(100, win.innerWidth - clientWidth)
          : 0;
      if (body && scrollbarWidth > 0) {
        const computedPadding = Number.parseFloat(
          win.getComputedStyle(body).paddingRight || "0",
        );
        setStyle(body, "padding-right", `${computedPadding + scrollbarWidth}px`);
      }

      const captureStyle = doc.createElement("style");
      captureStyle.dataset.wholePageCapture = "styles";
      captureStyle.textContent = `
        *, *::before, *::after {
          animation-play-state: paused !important;
          transition: none !important;
          caret-color: transparent !important;
          scroll-behavior: auto !important;
          scroll-snap-type: none !important;
        }
        html { scrollbar-width: none !important; }
        html::-webkit-scrollbar { display: none !important; }
      `;
      html.append(captureStyle);
      restorations.push(() => captureStyle.remove());
    }

    async function waitForFonts() {
      if (!doc.fonts?.ready) return;
      await Promise.race([
        Promise.resolve(doc.fonts.ready).catch(() => undefined),
        new Promise((resolve) => win.setTimeout(resolve, 2000)),
      ]);
    }

    function validateMeasuredDimensions(dimensions) {
      const validation = core.validateDimensions(dimensions);
      if (!validation.ok) throw captureError(validation.code);
    }

    async function warmUpLazyContent() {
      updatePanel("Loading the full page… Press Esc to cancel.");
      let dimensions = measure();
      validateMeasuredDimensions(dimensions);
      let growthRounds = 0;
      let stableMeasurements = 0;

      while (stableMeasurements < 2) {
        const targets = core.planTiles(
          dimensions.documentHeight,
          dimensions.viewportHeight,
        );
        for (const target of targets) {
          assertNotCancelled();
          scrollTo(0, target);
          await settle();
          assertNotCancelled();
        }

        const next = measure();
        validateMeasuredDimensions(next);
        const growth = next.documentHeight - dimensions.documentHeight;
        if (growth > 1) {
          growthRounds += 1;
          if (growthRounds > 3) throw captureError("page-keeps-growing");
          stableMeasurements = 0;
          dimensions = next;
          continue;
        }
        if (Math.abs(growth) <= 1) {
          stableMeasurements += 1;
          dimensions = next;
          continue;
        }
        throw captureError("page-changed");
      }

      return dimensions;
    }

    function discoverPositionedElements() {
      trackedElements.length = 0;
      for (const element of doc.querySelectorAll("body *")) {
        if (element === panelHost || panelHost?.contains(element)) continue;
        const position = win.getComputedStyle(element).position;
        if (position !== "fixed" && position !== "sticky") continue;
        rememberStyle(element, "visibility");
        trackedElements.push({
          element,
          position,
          originalTop: element.getBoundingClientRect().top + win.scrollY,
        });
      }
    }

    function setPositionedVisibility(tileIndex, tileTop, tileBottom) {
      for (const item of trackedElements) {
        const visible =
          item.position === "fixed"
            ? tileIndex === 0
            : core.shouldShowSticky(item.originalTop, tileTop, tileBottom);
        if (visible) restoreRememberedStyle(item.element, "visibility");
        else item.element.style.setProperty("visibility", "hidden", "important");
      }
    }

    function dimensionsMatch(expected, actual) {
      return [
        "viewportWidth",
        "viewportHeight",
        "documentWidth",
        "documentHeight",
      ].every((key) => Math.abs(expected[key] - actual[key]) <= 1);
    }

    function canvasToBlob(canvas) {
      return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    }

    async function captureTiles(dimensions) {
      const canvas = createCanvas();
      canvas.width = Math.round(dimensions.viewportWidth);
      canvas.height = Math.round(dimensions.documentHeight);
      if (
        canvas.width !== Math.round(dimensions.viewportWidth) ||
        canvas.height !== Math.round(dimensions.documentHeight)
      ) {
        throw captureError("canvas-failed");
      }
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw captureError("canvas-failed");

      const targets = core.planTiles(
        dimensions.documentHeight,
        dimensions.viewportHeight,
      );
      let completedTiles = 0;
      let previousBottom = 0;
      let expectedScale = null;

      for (let index = 0; index < targets.length; index += 1) {
        assertNotCancelled();
        scrollTo(0, targets[index]);
        await settle();
        assertNotCancelled();

        const currentDimensions = measure();
        if (!dimensionsMatch(dimensions, currentDimensions)) {
          throw captureError("page-changed");
        }

        const actualTop = win.scrollY;
        const compositionBottom = Math.min(
          dimensions.documentHeight,
          actualTop + dimensions.viewportHeight,
        );
        setPositionedVisibility(index, previousBottom, compositionBottom);
        updatePanel(`Capturing ${index + 1} of ${targets.length}…`);
        await runtime.sendMessage({
          type: "progress",
          token,
          completedTiles,
          totalTiles: targets.length,
        });
        setPanelVisible(false);
        const tileResponse = await runtime.sendMessage({
          type: "capture-tile",
          token,
        });
        setPanelVisible(true);
        if (!tileResponse?.ok) {
          throw captureError(tileResponse?.error?.code ?? "unexpected");
        }

        let image;
        try {
          image = await decodeImage(tileResponse.dataUrl);
        } catch {
          throw captureError("image-decode");
        }
        const scale = image.width / dimensions.viewportWidth;
        expectedScale ??= scale;
        const crop = core.calculateCrop(
          {
            actualTop,
            viewportWidth: dimensions.viewportWidth,
            viewportHeight: dimensions.viewportHeight,
            documentHeight: dimensions.documentHeight,
            imageWidth: image.width,
            imageHeight: image.height,
          },
          previousBottom,
          expectedScale,
        );
        context.drawImage(
          image,
          0,
          crop.sourceY,
          image.width,
          crop.sourceHeight,
          0,
          crop.destinationY,
          dimensions.viewportWidth,
          crop.destinationHeight,
        );
        previousBottom = crop.nextBottom;
        completedTiles += 1;
      }

      if (Math.abs(previousBottom - dimensions.documentHeight) > 1) {
        throw captureError("page-changed");
      }

      updatePanel("Building the PNG…");
      const blob = await canvasToBlob(canvas);
      if (!blob) throw captureError("canvas-failed");
      const filename = core.makeFilename(win.location.hostname, now());
      const objectUrl = createObjectURL(blob);
      try {
        clickDownload({ href: objectUrl, filename });
        await Promise.resolve();
      } finally {
        revokeObjectURL(objectUrl);
      }

      return {
        status: "success",
        filename,
        completedTiles,
        totalTiles: targets.length,
      };
    }

    async function cleanup() {
      if (cleaned) return cleanupErrors;
      cleaned = true;
      for (const restore of restorations.reverse()) {
        try {
          restore();
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      try {
        scrollTo(initialScroll.x, initialScroll.y);
      } catch (error) {
        cleanupErrors.push(error);
      }
      return cleanupErrors;
    }

    async function sendFinish(result) {
      if (!token) return;
      try {
        await runtime.sendMessage({ type: "finish", token, result });
      } catch {
        // Navigation may have already released the worker lock.
      }
    }

    async function run() {
      let result;
      try {
        const tokenResponse = await runtime.sendMessage({ type: "get-token" });
        if (!tokenResponse?.ok || !tokenResponse.token) {
          throw captureError(tokenResponse?.error?.code ?? "unexpected");
        }
        token = tokenResponse.token;
        preparePage();
        await waitForFonts();
        const dimensions = await warmUpLazyContent();
        assertNotCancelled();
        scrollTo(0, 0);
        await settle();
        assertNotCancelled();
        discoverPositionedElements();
        result = await captureTiles(dimensions);
      } catch (error) {
        const normalized = core.normalizeError(error);
        result = {
          status: normalized.code === "cancelled" ? "cancelled" : "error",
          code: normalized.code,
          message: normalized.message,
          completedTiles: 0,
          totalTiles: 0,
        };
      } finally {
        const errors = await cleanup();
        if (errors.length > 0 && result?.status === "success") {
          const normalized = core.normalizeError("unexpected");
          result = {
            status: "error",
            code: normalized.code,
            message: normalized.message,
            completedTiles: 0,
            totalTiles: 0,
          };
        }
        await sendFinish(result);
      }
      return result;
    }

    return Object.freeze({ run, cancel, cleanup });
  }

  if (typeof module === "object" && module.exports) {
    module.exports = { createPageCapture };
    return;
  }

  if (root.__wholePageCaptureInjected) return;
  root.__wholePageCaptureInjected = true;
  createPageCapture(createBrowserEnvironment())
    .run()
    .finally(() => {
      root.__wholePageCaptureInjected = false;
    });
})(typeof globalThis === "object" ? globalThis : self);
