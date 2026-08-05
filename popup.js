/**
 * popup.js
 * ------------------------------------------------------------------
 * Controls the extension popup: loads today's stats from
 * chrome.storage.local, renders them, and handles the "Reset" button.
 * ------------------------------------------------------------------
 */

(function initPopup() {
  const Utils = window.ScrollTrackerUtils;

  // Cache DOM references once.
  const elements = {
    date: document.getElementById("today-date"),
    youtubeCount: document.getElementById("youtube-count"),
    instagramCount: document.getElementById("instagram-count"),
    totalCount: document.getElementById("total-count"),
    timeSpent: document.getElementById("time-spent"),
    resetButton: document.getElementById("reset-button"),
    dashboardButton: document.getElementById("open-dashboard-button"),
    statusMessage: document.getElementById("status-message"),
  };

  /**
   * Formats "YYYY-MM-DD" into a friendlier, human-readable string,
   * e.g. "Saturday, July 4, 2026". Falls back to the raw string if
   * parsing fails for any reason.
   */
  function formatDisplayDate(isoDateString) {
    try {
      // Appending T00:00:00 avoids timezone-shift surprises when the
      // browser parses a bare "YYYY-MM-DD" as UTC midnight.
      const date = new Date(`${isoDateString}T00:00:00`);
      return date.toLocaleDateString(undefined, {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
      });
    } catch (err) {
      return isoDateString;
    }
  }

  /**
   * Updates all visible numbers/text based on the given data object.
   */
  function render(data) {
    elements.date.textContent = formatDisplayDate(data.date);
    elements.youtubeCount.textContent = data.youtubeShorts;
    elements.instagramCount.textContent = data.instagramReels;
    elements.totalCount.textContent = data.youtubeShorts + data.instagramReels;
    elements.timeSpent.textContent = Utils.formatDuration(
      (data.youtubeWatchTimeMs || 0) + (data.instagramWatchTimeMs || 0)
    );
  }

  /**
   * Briefly shows a status message under the Reset button, then
   * clears it after a couple of seconds.
   */
  function showStatusMessage(message) {
    elements.statusMessage.textContent = message;
    setTimeout(() => {
      elements.statusMessage.textContent = "";
    }, 2000);
  }

  /**
   * Loads the current data from storage and renders it. Used both on
   * initial popup open and any time we need to refresh the view.
   */
  async function loadAndRender() {
    try {
      const data = await Utils.getStorageData();
      render(data);
    } catch (err) {
      console.error("[Scroll Tracker] Failed to load stats:", err);
      elements.statusMessage.textContent = "Could not load stats.";
    }
  }

  /**
   * Handles the Reset button click: clears today's counts (but keeps
   * track of the currently-open video/reel, per resetTodayData()),
   * re-renders, and gives the user quick feedback.
   */
  async function handleResetClick() {
    elements.resetButton.disabled = true;
    try {
      const freshData = await Utils.resetTodayData();
      render(freshData);
      showStatusMessage("Counters reset for today.");
    } catch (err) {
      console.error("[Scroll Tracker] Failed to reset stats:", err);
      showStatusMessage("Reset failed — please try again.");
    } finally {
      elements.resetButton.disabled = false;
    }
  }

  /**
   * Keeps the popup live if it's left open while the user keeps
   * scrolling in another tab — chrome.storage.onChanged fires
   * whenever content.js updates the counts.
   */
  function watchForLiveUpdates() {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === "local" && changes[Utils.STORAGE_KEY]) {
        render(Utils.ensureDataIsForToday(changes[Utils.STORAGE_KEY].newValue));
      }
    });
  }

  /**
   * Opens the full analytics dashboard in a new tab. Uses a plain
   * window.open() rather than chrome.tabs.create() so this works
   * without needing the "tabs" permission.
   */
  function handleOpenDashboardClick() {
    window.open(chrome.runtime.getURL("dashboard.html"), "_blank");
  }

  // ------------------------------------------------------------------
  // Wire everything up once the popup's DOM is ready.
  // ------------------------------------------------------------------
  document.addEventListener("DOMContentLoaded", () => {
    if (!Utils) {
      console.error("[Scroll Tracker] utils.js did not load correctly.");
      elements.statusMessage.textContent = "Extension error — please reload.";
      return;
    }

    loadAndRender();
    watchForLiveUpdates();
    elements.resetButton.addEventListener("click", handleResetClick);
    elements.dashboardButton.addEventListener("click", handleOpenDashboardClick);
  });
})();
