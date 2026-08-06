/**
 * utils.js
 * ------------------------------------------------------------------
 * Shared helper functions used by BOTH content.js (runs on YouTube /
 * Instagram pages) and popup.js (runs inside the extension popup).
 *
 * IMPORTANT: This file does not use ES modules (import/export) because
 * content scripts and popup scripts are loaded via plain <script> tags
 * / the "js" array in manifest.json, which do not support modules
 * without extra configuration. Everything is attached to a single
 * namespace object (window.ScrollTrackerUtils) to avoid polluting the
 * global scope and to avoid "already declared" errors if the content
 * script is ever injected more than once.
 * ------------------------------------------------------------------
 */

(function initScrollTrackerUtils(global) {
  // Avoid re-initializing if this script somehow runs twice on the
  // same page (can happen with some SPA re-injection edge cases).
  if (global.ScrollTrackerUtils) {
    return;
  }

  // The single key under which all Scroll Tracker data lives in
  // chrome.storage.local. Keeping everything under one key makes
  // reads/writes atomic-ish and easy to reason about.
  const STORAGE_KEY = "scrollTrackerData";

  // A separate key holding a rolling archive of past days' totals,
  // keyed by date string (e.g. "2026-08-01"). Used for the analytics
  // dashboard's 7-day chart and time-of-day heatmap. Kept separate
  // from STORAGE_KEY so "today" reads/writes stay small and fast.
  const HISTORY_STORAGE_KEY = "scrollTrackerHistory";

  // How many days of history to retain. Old days beyond this are
  // dropped automatically to keep storage usage bounded.
  const MAX_HISTORY_DAYS = 30;

  /**
   * Returns today's date as a "YYYY-MM-DD" string, based on the
   * user's LOCAL time (not UTC). Using local time means the daily
   * counter resets at local midnight, which matches user expectation.
   */
  function getTodayDateString() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  // Caps how many ids we remember per platform, per day. This is a
  // generous safety limit purely to keep chrome.storage.local writes
  // small — realistically no one watches tens of thousands of Shorts
  // or Reels in a single day.
  const MAX_TRACKED_IDS_PER_DAY = 5000;

  // Combined-total milestones that trigger a one-time notification
  // each time they're crossed for the day. Extend this array to add
  // more checkpoints (e.g. 200, 250...) without touching any other
  // logic — everything downstream just iterates over this list. The
  // same thresholds also define the widget's color tiers (see
  // getTierColorForCount below).
  const COUNT_MILESTONES = [50, 100, 150];

  // One color per tier: under the 1st milestone, between 1st & 2nd,
  // between 2nd & 3rd, and at/above the 3rd. Length is always
  // COUNT_MILESTONES.length + 1.
  const TIER_COLORS = ["#22c55e", "#eab308", "#f97316", "#dc2626"];

  /**
   * Maps a combined Shorts+Reels total to a color representing how
   * close the user is to their daily milestones — green (comfortably
   * under), yellow, orange, red (past the highest milestone). Used by
   * both the on-page widget (content.js) and the dashboard charts, so
   * the color scheme stays consistent everywhere.
   */
  function getTierColorForCount(total) {
    if (total >= COUNT_MILESTONES[2]) return TIER_COLORS[3];
    if (total >= COUNT_MILESTONES[1]) return TIER_COLORS[2];
    if (total >= COUNT_MILESTONES[0]) return TIER_COLORS[1];
    return TIER_COLORS[0];
  }

  /**
   * Returns a brand-new, empty data object for "today".
   * @param {object} [previous] - previous stored data, if any. We
   *   carry forward lastYoutubeVideo/lastInstagramReel so that if the
   *   user is still sitting on the same video/reel across a midnight
   *   rollover, it is not immediately re-counted as "new". The
   *   counted-id lists, watch time, and milestone-warning history are
   *   always reset fresh for the new day.
   */
  function getDefaultData(previous) {
    return {
      date: getTodayDateString(),
      youtubeShorts: 0,
      instagramReels: 0,
      lastYoutubeVideo: (previous && previous.lastYoutubeVideo) || "",
      lastInstagramReel: (previous && previous.lastInstagramReel) || "",
      // Every Short/Reel id counted so far today. We check against
      // this FULL list (not just the last item) so that scrolling
      // back up to something you already watched doesn't re-count it.
      countedYoutubeShortIds: [],
      countedInstagramReelIds: [],
      // Milliseconds spent actively watching Shorts/Reels today, per
      // platform (only counted while the tab is visible/focused).
      youtubeWatchTimeMs: 0,
      instagramWatchTimeMs: 0,
      // Which COUNT_MILESTONES have already triggered a notification
      // today, so we never show the same milestone twice.
      warnedMilestones: [],
      // Count of Shorts/Reels watched in each hour of the day (index
      // 0 = midnight–1am, 23 = 11pm–midnight, local time). Powers the
      // dashboard's "time of day" heatmap.
      hourlyCounts: new Array(24).fill(0),
    };
  }

  /**
   * Given whatever is currently in storage, returns data that is
   * guaranteed to be valid for TODAY. If the stored date does not
   * match today's date (i.e. this is the first activity of a new
   * day), the counts are reset to zero automatically.
   */
  function ensureDataIsForToday(data) {
    const today = getTodayDateString();
    if (!data || typeof data !== "object" || data.date !== today) {
      return getDefaultData(data);
    }
    // Defensive backfill: if this data was written by an older version
    // of the extension (before certain fields existed), make sure
    // they're present so callers can safely use them without extra
    // null-checks.
    if (!Array.isArray(data.countedYoutubeShortIds)) {
      data.countedYoutubeShortIds = [];
    }
    if (!Array.isArray(data.countedInstagramReelIds)) {
      data.countedInstagramReelIds = [];
    }
    if (typeof data.youtubeWatchTimeMs !== "number") {
      data.youtubeWatchTimeMs = 0;
    }
    if (typeof data.instagramWatchTimeMs !== "number") {
      data.instagramWatchTimeMs = 0;
    }
    if (!Array.isArray(data.warnedMilestones)) {
      data.warnedMilestones = [];
    }
    if (!Array.isArray(data.hourlyCounts) || data.hourlyCounts.length !== 24) {
      data.hourlyCounts = new Array(24).fill(0);
    }
    return data;
  }

  /**
   * Records a newly-watched Short/Reel id, IF it hasn't already been
   * counted today. Returns true if it was a new id (and the counter
   * was incremented), or false if it was a duplicate (nothing changed).
   *
   * Centralizing this logic here (rather than duplicating it for
   * YouTube and Instagram in content.js) keeps the de-duplication rule
   * consistent: an id counts once per day, no matter how many times
   * the user scrolls back and forth across it.
   *
   * @param {object} data - the current day's data object (mutated in place)
   * @param {"youtube"|"instagram"} platform
   * @param {string} id
   * @returns {boolean} whether the id was newly counted
   */
  function recordIfNewId(data, platform, id) {
    const isYoutube = platform === "youtube";
    const countedIdsKey = isYoutube
      ? "countedYoutubeShortIds"
      : "countedInstagramReelIds";
    const countKey = isYoutube ? "youtubeShorts" : "instagramReels";
    const lastIdKey = isYoutube ? "lastYoutubeVideo" : "lastInstagramReel";

    if (data[countedIdsKey].includes(id)) {
      return false; // already counted today — could be anywhere in history
    }

    data[countedIdsKey].push(id);
    // Trim from the front (oldest first) if we somehow hit the cap.
    if (data[countedIdsKey].length > MAX_TRACKED_IDS_PER_DAY) {
      data[countedIdsKey].shift();
    }

    data[countKey] += 1;
    data[lastIdKey] = id;

    // Track which hour of the day this happened in, for the
    // dashboard's time-of-day heatmap.
    if (!Array.isArray(data.hourlyCounts) || data.hourlyCounts.length !== 24) {
      data.hourlyCounts = new Array(24).fill(0);
    }
    data.hourlyCounts[new Date().getHours()] += 1;

    return true;
  }

  /**
   * Adds watch time (in milliseconds) to the correct platform's
   * running total for today. Mutates the given data object in place.
   * @param {object} data
   * @param {"youtube"|"instagram"} platform
   * @param {number} ms
   */
  function addWatchTime(data, platform, ms) {
    if (!ms || ms <= 0) return;
    const key = platform === "youtube" ? "youtubeWatchTimeMs" : "instagramWatchTimeMs";
    data[key] = (data[key] || 0) + ms;
  }

  /**
   * Formats a millisecond duration into a short, readable string,
   * e.g. 3900000 -> "1h 05m", 240000 -> "4m", 0 -> "0m".
   */
  function formatDuration(ms) {
    const totalMinutes = Math.floor(ms / 60000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours > 0) {
      return `${hours}h ${String(minutes).padStart(2, "0")}m`;
    }
    return `${minutes}m`;
  }

  /**
   * Returns any COUNT_MILESTONES that the combined today's total has
   * reached or passed, but that haven't already triggered a
   * notification today (per data.warnedMilestones).
   */
  function getNewlyCrossedMilestones(data) {
    const total = data.youtubeShorts + data.instagramReels;
    const warned = Array.isArray(data.warnedMilestones) ? data.warnedMilestones : [];
    return COUNT_MILESTONES.filter((milestone) => total >= milestone && !warned.includes(milestone));
  }

  /**
   * Marks the given milestones as "already warned" for today so they
   * don't trigger a duplicate notification. Mutates data in place.
   */
  function markMilestonesWarned(data, milestones) {
    const warned = Array.isArray(data.warnedMilestones) ? data.warnedMilestones : [];
    data.warnedMilestones = Array.from(new Set([...warned, ...milestones]));
  }

  /**
   * Builds a compact snapshot of a day's data suitable for long-term
   * storage in history — drops per-id lists and "last watched"
   * pointers (only meaningful for today), keeping just the numbers
   * the dashboard needs.
   */
  function summarizeForHistory(data) {
    return {
      date: data.date,
      youtubeShorts: data.youtubeShorts || 0,
      instagramReels: data.instagramReels || 0,
      youtubeWatchTimeMs: data.youtubeWatchTimeMs || 0,
      instagramWatchTimeMs: data.instagramWatchTimeMs || 0,
      hourlyCounts:
        Array.isArray(data.hourlyCounts) && data.hourlyCounts.length === 24
          ? data.hourlyCounts
          : new Array(24).fill(0),
    };
  }

  /**
   * Drops the oldest entries from a history object (mutates in place)
   * so it never grows past MAX_HISTORY_DAYS days.
   */
  function trimHistory(history) {
    const dates = Object.keys(history).sort(); // ascending: oldest first
    while (dates.length > MAX_HISTORY_DAYS) {
      delete history[dates.shift()];
    }
  }

  /**
   * Reads Scroll Tracker data from chrome.storage.local.
   * Always resolves with a valid, "today-normalized" data object
   * (never null/undefined), so callers never have to null-check.
   *
   * If the stored data turns out to belong to a PAST day (i.e. this
   * is the first read since midnight), that past day's snapshot is
   * archived into history before today's fresh, zeroed data is
   * returned — this is what feeds the dashboard's daily history.
   * @returns {Promise<object>}
   */
  function getStorageData() {
    return new Promise((resolve, reject) => {
      chrome.storage.local.get([STORAGE_KEY, HISTORY_STORAGE_KEY], (result) => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
          return;
        }

        const raw = result[STORAGE_KEY];
        const today = getTodayDateString();

        if (raw && typeof raw === "object" && raw.date && raw.date !== today) {
          // A new day has started since this was last written —
          // archive the old snapshot, then start today fresh.
          const history =
            result[HISTORY_STORAGE_KEY] && typeof result[HISTORY_STORAGE_KEY] === "object"
              ? result[HISTORY_STORAGE_KEY]
              : {};
          history[raw.date] = summarizeForHistory(raw);
          trimHistory(history);

          const fresh = getDefaultData(raw);
          chrome.storage.local.set(
            { [STORAGE_KEY]: fresh, [HISTORY_STORAGE_KEY]: history },
            () => {
              if (chrome.runtime.lastError) {
                reject(chrome.runtime.lastError);
                return;
              }
              resolve(fresh);
            }
          );
          return;
        }

        resolve(ensureDataIsForToday(raw));
      });
    });
  }

  /**
   * Reads the raw history archive (past days only, NOT today).
   * @returns {Promise<object>} keyed by "YYYY-MM-DD"
   */
  function getHistory() {
    return new Promise((resolve, reject) => {
      chrome.storage.local.get([HISTORY_STORAGE_KEY], (result) => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
          return;
        }
        const history = result[HISTORY_STORAGE_KEY];
        resolve(history && typeof history === "object" ? history : {});
      });
    });
  }

  /** Formats a Date object as "YYYY-MM-DD" in local time. */
  function formatDateAsKey(dateObj) {
    const year = dateObj.getFullYear();
    const month = String(dateObj.getMonth() + 1).padStart(2, "0");
    const day = String(dateObj.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  /**
   * Returns a chronological series of `count` days, ending `offsetDays`
   * days ago (offsetDays=0 means the series ends today). Combines
   * today's live data with the history archive so the most recent day
   * is always accurate even before it's been archived.
   *
   * Example: getDaysSeries(7, 0) -> the last 7 days including today.
   *          getDaysSeries(7, 7) -> the 7 days before that (for
   *          week-over-week comparisons).
   *
   * @returns {Promise<Array<{date: string, total: number, timeMs: number}>>}
   */
  async function getDaysSeries(count = 7, offsetDays = 0) {
    const [todayData, history] = await Promise.all([getStorageData(), getHistory()]);
    const days = [];

    for (let i = count - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i - offsetDays);
      const dateKey = formatDateAsKey(d);

      let entry;
      if (dateKey === todayData.date) {
        entry = todayData;
      } else if (history[dateKey]) {
        entry = history[dateKey];
      } else {
        entry = {
          youtubeShorts: 0,
          instagramReels: 0,
          youtubeWatchTimeMs: 0,
          instagramWatchTimeMs: 0,
        };
      }

      days.push({
        date: dateKey,
        youtubeShorts: entry.youtubeShorts || 0,
        instagramReels: entry.instagramReels || 0,
        total: (entry.youtubeShorts || 0) + (entry.instagramReels || 0),
        timeMs: (entry.youtubeWatchTimeMs || 0) + (entry.instagramWatchTimeMs || 0),
      });
    }

    return days;
  }

  /** Convenience wrapper: the last 7 days, including today. */
  function getLast7DaysSeries() {
    return getDaysSeries(7, 0);
  }

  /**
   * Aggregates hourlyCounts across today plus up to `daysBack` days of
   * history, returning a single 24-length array — total Shorts/Reels
   * watched in each hour of the day, across all those days combined.
   * Powers the dashboard's "what time of day do I scroll most" heatmap.
   */
  async function getHourlyHeatmap(daysBack = 30) {
    const [todayData, history] = await Promise.all([getStorageData(), getHistory()]);
    const totals = new Array(24).fill(0);

    const addHourly = (hourlyCounts) => {
      if (!Array.isArray(hourlyCounts)) return;
      for (let hour = 0; hour < 24; hour++) {
        totals[hour] += hourlyCounts[hour] || 0;
      }
    };

    addHourly(todayData.hourlyCounts);

    Object.keys(history)
      .sort()
      .slice(-daysBack)
      .forEach((dateKey) => addHourly(history[dateKey].hourlyCounts));

    return totals;
  }

  /**
   * Returns every day of data available (full history archive plus
   * today), merged into one object keyed by "YYYY-MM-DD". Used for
   * the dashboard's "Export Data" feature — this is the one place
   * that needs literally everything, not just a recent window.
   * @returns {Promise<object>}
   */
  async function getFullHistoryIncludingToday() {
    const [todayData, history] = await Promise.all([getStorageData(), getHistory()]);
    const merged = { ...history };
    merged[todayData.date] = summarizeForHistory(todayData);
    return merged;
  }

  /**
   * Writes Scroll Tracker data to chrome.storage.local.
   * @param {object} data
   * @returns {Promise<void>}
   */
  function setStorageData(data) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.set({ [STORAGE_KEY]: data }, () => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
          return;
        }
        resolve();
      });
    });
  }

  /**
   * Resets today's data back to zero counts (used by the popup's
   * "Reset" button). Keeps the lastYoutubeVideo/lastInstagramReel
   * pointers so the currently-open video/reel is not double counted
   * immediately after a manual reset.
   */
  async function resetTodayData() {
    const current = await getStorageData();
    const fresh = getDefaultData(current);
    await setStorageData(fresh);
    return fresh;
  }

  /**
   * Extracts a YouTube Shorts video ID from a URL.
   * Example: https://www.youtube.com/shorts/AbC123xyz -> "AbC123xyz"
   * Returns null if the URL is not a Shorts URL.
   */
  function extractYoutubeShortId(url) {
    try {
      const { pathname } = new URL(url);
      const match = pathname.match(/\/shorts\/([A-Za-z0-9_-]+)/);
      return match ? match[1] : null;
    } catch (err) {
      return null;
    }
  }

  /**
   * Extracts an Instagram Reel shortcode from a URL.
   * Handles both singular ("/reel/<code>/") and plural
   * ("/reels/<code>/") path forms that Instagram has used.
   * Returns null if the URL does not contain a specific reel code
   * (e.g. the generic "/reels/" feed root).
   */
  function extractInstagramReelId(url) {
    try {
      const { pathname } = new URL(url);
      const match = pathname.match(/\/reels?\/([A-Za-z0-9_-]+)\/?/);
      return match ? match[1] : null;
    } catch (err) {
      return null;
    }
  }

  // Expose everything under a single namespace object.
  global.ScrollTrackerUtils = {
    STORAGE_KEY,
    HISTORY_STORAGE_KEY,
    COUNT_MILESTONES,
    getTodayDateString,
    getDefaultData,
    ensureDataIsForToday,
    getStorageData,
    setStorageData,
    resetTodayData,
    recordIfNewId,
    addWatchTime,
    formatDuration,
    getNewlyCrossedMilestones,
    markMilestonesWarned,
    getTierColorForCount,
    getHistory,
    getDaysSeries,
    getLast7DaysSeries,
    getHourlyHeatmap,
    getFullHistoryIncludingToday,
    extractYoutubeShortId,
    extractInstagramReelId,
  };
})(typeof window !== "undefined" ? window : globalThis);
