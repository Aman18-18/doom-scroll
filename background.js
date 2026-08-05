/**
 * background.js
 * ------------------------------------------------------------------
 * MV3 service worker. Responsible for two things that content scripts
 * can't do directly:
 *   1. Keeping a small number badge on the extension's toolbar icon
 *      showing today's total (Shorts + Reels).
 *   2. Firing a one-time desktop notification each time the day's
 *      combined total crosses a milestone (50, 100, 150 — see
 *      Utils.COUNT_MILESTONES).
 *
 * Service workers can be shut down and restarted by Chrome at any
 * time, so this file avoids holding any state in memory — every
 * update reads fresh from chrome.storage.local via utils.js.
 * ------------------------------------------------------------------
 */

// importScripts works in a service worker the same way <script> tags
// work on a page. utils.js detects it's not in a `window` context and
// attaches itself to `globalThis` instead, so this just works.
importScripts("utils.js");

const Utils = self.ScrollTrackerUtils;

/**
 * Reads today's data and updates the toolbar badge to match.
 * Shows nothing (empty badge) when the total is zero, to keep the
 * icon clean until the user actually watches something.
 */
async function refreshBadge(data) {
  try {
    const total = data.youtubeShorts + data.instagramReels;
    await chrome.action.setBadgeText({ text: total > 0 ? String(total) : "" });
    await chrome.action.setBadgeBackgroundColor({ color: "#2563eb" });
  } catch (err) {
    console.error("[Scroll Tracker] Failed to update badge:", err);
  }
}

/**
 * Checks whether today's combined total just crossed a new milestone
 * (50 / 100 / 150) and, if so, fires a single desktop notification and
 * records it so the same milestone never fires twice in one day.
 */
async function checkMilestones(data) {
  const newMilestones = Utils.getNewlyCrossedMilestones(data);
  if (newMilestones.length === 0) return;

  Utils.markMilestonesWarned(data, newMilestones);
  await Utils.setStorageData(data);

  const highest = Math.max(...newMilestones);
  const total = data.youtubeShorts + data.instagramReels;

  chrome.notifications.create({
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: "Scroll Tracker",
    message: `You've watched ${total} Shorts/Reels today (past ${highest}). Maybe time for a break?`,
    priority: 1,
  });
}

/**
 * Runs both checks together against a single freshly-read copy of
 * today's data, so they agree on the same numbers.
 */
async function handleDataChange() {
  const data = await Utils.getStorageData();
  await refreshBadge(data);
  await checkMilestones(data);
}

// React any time the stored data changes (i.e. every time content.js
// counts a new Short/Reel, logs watch time, or the popup's Reset
// button clears the counters).
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes[Utils.STORAGE_KEY]) {
    handleDataChange();
  }
});

// Make sure everything is correct right when the extension is
// installed/updated, and whenever Chrome starts up.
chrome.runtime.onInstalled.addListener(handleDataChange);
chrome.runtime.onStartup.addListener(handleDataChange);

// Also run once immediately when this service worker file first
// executes (covers the case where it was woken up for some other
// reason and the badge happens to be stale).
handleDataChange();
