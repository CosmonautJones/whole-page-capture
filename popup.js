(async function renderLastCaptureStatus() {
  "use strict";

  const title = document.getElementById("status-title");
  const copy = document.getElementById("status-copy");
  const filename = document.getElementById("status-filename");
  const card = document.getElementById("status-card");
  const { lastResult } = await chrome.storage.session.get("lastResult");

  if (!lastResult) return;

  card.dataset.status = lastResult.status;
  if (lastResult.status === "working") {
    title.textContent = "Working";
    copy.textContent = lastResult.totalTiles
      ? `Capturing tile ${lastResult.completedTiles + 1} of ${lastResult.totalTiles}. Keep this tab active.`
      : "Preparing the page. Keep this tab active.";
  } else if (lastResult.status === "success") {
    title.textContent = "Saved";
    copy.textContent = "The complete page was downloaded as one PNG.";
  } else if (lastResult.status === "cancelled") {
    title.textContent = "Cancelled";
    copy.textContent = lastResult.message;
  } else {
    title.textContent = "Needs attention";
    copy.textContent = lastResult.message;
  }

  if (lastResult.filename) {
    filename.textContent = lastResult.filename;
    filename.hidden = false;
  }
})();
