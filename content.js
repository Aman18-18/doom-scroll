/**
 * content.js
 * ------------------------------------------------------------------
 * Runs on youtube.com and instagram.com (see manifest.json).
 *
 * Responsibility: detect when the user is watching a NEW YouTube
 * Short or a NEW Instagram Reel, and — if so — increment the correct
 * counter in chrome.storage.local exactly once.
 *
 * Both YouTube and Instagram are single-page apps (SPAs): the page
 * never fully reloads as the user scrolls or clicks around, so we
 * cannot rely on normal page-load events. Instead we:
 *
 *   1. Patch history.pushState/replaceState (the standard way SPAs
 *      change the URL) so we get notified on every navigation.
 *   2. Listen to YouTube's own "yt-navigate-finish" event as an extra,
 *      more reliable signal specific to YouTube's router.
 *   3. Fall back to polling location.href on an interval, in case a
 *      site changes the URL in a way that doesn't trigger the above
 *      (defensive, belt-and-suspenders).
 *   4. Use a MutationObserver + IntersectionObserver to watch the DOM
 *      directly. This matters most for Instagram's continuous
 *      "/reels/" feed, where the URL often does NOT change as the
 *      user scrolls from one reel to the next — so URL detection
 *      alone is not enough there.
 * ------------------------------------------------------------------
 */

(function scrollTrackerContentScript() {
  const Utils = window.ScrollTrackerUtils;
  if (!Utils) {
    // Should never happen because utils.js is loaded before content.js
    // in manifest.json, but guard defensively just in case.
    console.error("[Scroll Tracker] utils.js did not load correctly.");
    return;
  }

  const isYoutube = location.hostname.includes("youtube.com");
  const isInstagram = location.hostname.includes("instagram.com");

  // ------------------------------------------------------------------
  // Extension context invalidation handling
  // ------------------------------------------------------------------
  //
  // Whenever the extension is reloaded/updated from chrome://extensions
  // (or unpacked-reloaded during development), any tab that was already
  // open keeps running its OLD content script — which is now orphaned:
  // every chrome.* API call it makes throws "Extension context
  // invalidated." This is expected Chrome behavior, not a bug, but
  // left unhandled it means every scroll spams a new console error
  // forever. Instead, we detect it once, clean up everything (timers,
  // observers, the on-page widget), and stay quiet — a normal page
  // refresh re-injects a fresh, correctly-connected content script.

  let extensionContextInvalidated = false;
  const activeIntervalIds = [];
  let bodyObserverRef = null;

  function isContextInvalidationError(err) {
    return Boolean(err && String(err.message || err).includes("Extension context invalidated"));
  }

  /**
   * Stops every timer/observer this script owns and removes the
   * on-page widget, then logs a single friendly (not scary) message.
   * Safe to call more than once — subsequent calls are no-ops.
   */
  function handleContextInvalidated() {
    if (extensionContextInvalidated) return;
    extensionContextInvalidated = true;

    activeIntervalIds.forEach((id) => clearInterval(id));
    activeIntervalIds.length = 0;
    clearTimeout(debounceTimer);

    if (bodyObserverRef) {
      bodyObserverRef.disconnect();
      bodyObserverRef = null;
    }

    const widget = document.getElementById(WIDGET_ID);
    if (widget) widget.remove();

    console.log(
      "[Scroll Tracker] The extension was updated/reloaded — refresh this page to keep tracking."
    );
  }

  // ------------------------------------------------------------------
  // Guard against overlapping/duplicate processing.
  // ------------------------------------------------------------------
  let isProcessing = false; // simple mutex around the storage read-modify-write
  let debounceTimer = null; // collapses bursts of events into one check

  /**
   * Schedules a detection pass a short moment in the future. Many
   * events can fire in quick succession (mutation observer batches,
   * multiple navigation signals for the same navigation, etc.) — the
   * debounce collapses them into a single check.
   */
  function scheduleCheck() {
    if (extensionContextInvalidated) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(runDetection, 350);
  }

  /**
   * The main entry point: figures out whether the user is currently
   * looking at a Short/Reel, and if it's a NEW one, counts it. Also
   * keeps the on-page floating widget's visibility in sync with
   * whether we're currently in a Shorts/Reels context.
   */
  async function runDetection() {
    if (extensionContextInvalidated) return;
    updateWidgetVisibility();

    if (isProcessing) return;
    isProcessing = true;
    try {
      if (isYoutube) {
        await handleYoutube();
      } else if (isInstagram) {
        await handleInstagram();
      }
    } catch (err) {
      if (isContextInvalidationError(err)) {
        handleContextInvalidated();
      } else {
        console.error("[Scroll Tracker] Detection error:", err);
      }
    } finally {
      isProcessing = false;
    }
  }

  // ------------------------------------------------------------------
  // YouTube Shorts detection
  // ------------------------------------------------------------------

  async function handleYoutube() {
    const shortId = Utils.extractYoutubeShortId(location.href);

    // Not currently on a Shorts URL (e.g. user is watching a regular
    // long-form video, browsing the homepage, etc.) — nothing to do.
    if (!shortId) return;

    const data = await Utils.getStorageData();

    // recordIfNewId checks this id against EVERY id counted so far
    // today (not just the most recent one), so refreshing, staying
    // put, AND scrolling back up to a Short you already watched all
    // correctly avoid double counting.
    const wasNew = Utils.recordIfNewId(data, "youtube", shortId);
    if (!wasNew) return;

    await Utils.setStorageData(data);

    console.log(
      `[Scroll Tracker] YouTube Short counted (today's total: ${data.youtubeShorts}) ->`,
      shortId
    );
  }

  // ------------------------------------------------------------------
  // Instagram Reels detection
  // ------------------------------------------------------------------
  //
  // NOTE on why this is trickier than YouTube: Instagram's Reels feed
  // frequently REUSES the same <video> DOM element and simply swaps
  // its `src` as you scroll to the next reel, rather than creating a
  // brand-new element each time. That means approaches based purely
  // on "a new element scrolled into view" can miss most reels. To
  // handle this reliably we do two things:
  //
  //   1. Listen (in the capture phase, on `document`) for `playing`
  //      events from ANY <video> element. This fires every time a
  //      reel starts playing — including when it's the same element
  //      just being reused with a new source — so it's a much more
  //      reliable trigger than DOM-insertion-based observers.
  //   2. When triggered, scan all currently on-screen <video>
  //      elements and pick whichever one is closest to the vertical
  //      center of the viewport (that's the one actually being
  //      watched; Reels fill the screen one at a time).

  /**
   * Finds the <video> element that is currently centered in the
   * viewport (i.e. the reel the user is actually watching), out of
   * all video elements currently in the DOM.
   */
  function findCenteredVideo() {
    const videos = Array.from(document.querySelectorAll("video"));
    if (videos.length === 0) return null;

    const viewportCenterY = window.innerHeight / 2;
    let best = null;
    let bestDistance = Infinity;

    for (const video of videos) {
      const rect = video.getBoundingClientRect();

      // Skip elements with no visible size or fully off-screen.
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.bottom <= 0 || rect.top >= window.innerHeight) continue;

      const videoCenterY = rect.top + rect.height / 2;
      const distance = Math.abs(videoCenterY - viewportCenterY);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = video;
      }
    }

    return best;
  }

  /**
   * Determines a best-effort unique identifier for the reel currently
   * being watched.
   *
   * Priority order:
   *   1. The URL, when the user opened a direct reel link
   *      (e.g. instagram.com/reel/<shortcode>/). This is the most
   *      reliable source when available.
   *   2. A permalink <a href="/reel/..."> found near the centered
   *      video in the DOM (Instagram often renders one for sharing).
   *   3. The video's resolved source URL, as a last-resort fallback
   *      (still unique per reel, even if not a clean shortcode).
   *
   * Returns null if we cannot currently identify a reel (e.g. the
   * user is browsing their profile grid, not watching anything).
   */
  function getActiveInstagramReelId() {
    const urlReelId = Utils.extractInstagramReelId(location.href);
    if (urlReelId) return urlReelId;

    const video = findCenteredVideo();
    if (!video) return null;

    // Look a few levels up for a container that might hold a
    // permalink anchor pointing at this specific reel.
    const container = video.closest(
      'article, div[role="presentation"], div[role="dialog"], section'
    );
    const anchor = container
      ? container.querySelector('a[href*="/reel/"], a[href*="/reels/"]')
      : null;

    if (anchor) {
      const anchorReelId = Utils.extractInstagramReelId(anchor.href);
      if (anchorReelId) return anchorReelId;
    }

    // Last resort: use the video's own source as a pseudo-id.
    const src =
      video.currentSrc || video.getAttribute("src") || video.getAttribute("poster");

    return src ? `dom:${src}` : null;
  }

  async function handleInstagram() {
    const reelId = getActiveInstagramReelId();
    if (!reelId) return;

    const data = await Utils.getStorageData();

    // Same full-history guard as YouTube: this is what fixes the
    // "scrolled back up and it counted again" bug — we check against
    // every id seen today, not just the immediately previous one.
    const wasNew = Utils.recordIfNewId(data, "instagram", reelId);
    if (!wasNew) return;

    await Utils.setStorageData(data);

    console.log(
      `[Scroll Tracker] Instagram Reel counted (today's total: ${data.instagramReels}) ->`,
      reelId
    );
  }

  /**
   * Capture-phase listeners on `document` catch `playing`/`loadeddata`
   * events from any <video> element, present now or added later —
   * no need to track individual elements or re-attach listeners as
   * Instagram recycles DOM nodes. This is what actually catches
   * "same element, new reel" transitions.
   */
  function startInstagramVideoEventListeners() {
    const onVideoEvent = (event) => {
      if (event.target && event.target.tagName === "VIDEO") {
        scheduleCheck();
      }
    };
    document.addEventListener("playing", onVideoEvent, true);
    document.addEventListener("loadeddata", onVideoEvent, true);
  }

  /**
   * Extra safety net purely for Instagram: even without any DOM event
   * at all, periodically re-check which video is centered. Cheap, and
   * guarantees we never go more than ~1.5s without noticing a swipe.
   */
  function startInstagramPollingFallback() {
    const intervalId = setInterval(scheduleCheck, 1500);
    activeIntervalIds.push(intervalId);
  }

  // ------------------------------------------------------------------
  // SPA navigation detection (shared by both sites)
  // ------------------------------------------------------------------

  /**
   * Patches the History API so that pushState/replaceState calls —
   * which is how YouTube and Instagram change the URL without a full
   * page reload — dispatch a regular DOM event we can listen for.
   */
  function patchHistoryForSpaNavigation() {
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;

    history.pushState = function patchedPushState(...args) {
      const result = originalPushState.apply(this, args);
      window.dispatchEvent(new Event("scrolltracker:locationchange"));
      return result;
    };

    history.replaceState = function patchedReplaceState(...args) {
      const result = originalReplaceState.apply(this, args);
      window.dispatchEvent(new Event("scrolltracker:locationchange"));
      return result;
    };

    window.addEventListener("popstate", () => {
      window.dispatchEvent(new Event("scrolltracker:locationchange"));
    });
  }

  /**
   * Defensive fallback: some SPA route changes can slip past both the
   * patched History API and site-specific events. Polling is cheap
   * and guarantees we never miss a URL change for long.
   */
  function startUrlPollingFallback() {
    let lastKnownHref = location.href;
    const intervalId = setInterval(() => {
      if (location.href !== lastKnownHref) {
        lastKnownHref = location.href;
        scheduleCheck();
      }
    }, 1000);
    activeIntervalIds.push(intervalId);
  }

  /**
   * Watches the DOM for structural changes and uses that as an extra
   * general-purpose trigger for re-running detection, since both
   * sites re-render heavily without necessarily firing a dedicated
   * navigation event every time.
   */
  function startDomObserver() {
    bodyObserverRef = new MutationObserver(() => {
      scheduleCheck();
    });

    bodyObserverRef.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  // ------------------------------------------------------------------
  // On-page floating widget
  // ------------------------------------------------------------------
  //
  // A small draggable pill showing today's TOTAL count (Shorts +
  // Reels combined), injected directly into the page. Behavior:
  //   - Appears automatically the moment you're on a Short/Reel.
  //   - Disappears automatically the moment you navigate away from
  //     Shorts/Reels (e.g. back to the regular YouTube homepage).
  //   - Can be dragged anywhere on screen; its position is remembered
  //     (per device) across page loads.
  //   - Double-click hides it manually; it reappears next time you
  //     enter a Shorts/Reels context again.

  const WIDGET_ID = "scroll-tracker-floating-widget";
  const WIDGET_POSITION_STORAGE_KEY = "scrollTrackerWidgetPosition";
  const WIDGET_VISIBLE_CLASS = "scroll-tracker-widget--visible";
  const WIDGET_DRAGGING_CLASS = "scroll-tracker-widget--dragging";

  // Was the widget in a Shorts/Reels context on the last check? Used
  // to detect "just entered" vs. "just left" transitions.
  let wasInShortsOrReelsContext = false;

  // True once the user double-clicks to dismiss the widget; reset
  // back to false whenever they re-enter a Shorts/Reels context.
  let widgetManuallyHidden = false;

  /**
   * Whether the current page is showing a Short (YouTube) or a Reel
   * (Instagram) right now — used purely to decide whether the widget
   * should be visible, independent of the id-based de-dup logic used
   * for counting.
   */
  function isCurrentlyInShortsOrReelsContext() {
    if (isYoutube) {
      return /\/shorts\//.test(location.pathname);
    }
    if (isInstagram) {
      return /^\/reels?(\/|$)/.test(location.pathname);
    }
    return false;
  }

  /**
   * Injects the widget's CSS once. Kept in a <style> tag rather than
   * inline styles so hover/transition rules are easy to express.
   */
  function injectWidgetStyles() {
    if (document.getElementById(`${WIDGET_ID}-styles`)) return;

    const style = document.createElement("style");
    style.id = `${WIDGET_ID}-styles`;
    style.textContent = `
      #${WIDGET_ID} {
        position: fixed;
        top: 16px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 2147483647;
        display: flex;
        align-items: center;
        gap: 7px;
        padding: 8px 16px;
        background: rgba(18, 18, 22, 0.88);
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
        border: 1px solid rgba(255, 255, 255, 0.14);
        border-radius: 999px;
        color: #ffffff;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 15px;
        font-weight: 700;
        box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35);
        cursor: grab;
        user-select: none;
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.2s ease, transform 0.15s ease;
      }
      #${WIDGET_ID}.${WIDGET_VISIBLE_CLASS} {
        opacity: 1;
        pointer-events: auto;
      }
      #${WIDGET_ID}.${WIDGET_DRAGGING_CLASS} {
        cursor: grabbing;
        transition: none;
      }
      #${WIDGET_ID} .scroll-tracker-widget__dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: #22c55e;
        flex-shrink: 0;
      }
      #${WIDGET_ID} .scroll-tracker-widget__count {
        font-variant-numeric: tabular-nums;
        line-height: 1;
      }
      #${WIDGET_ID} .scroll-tracker-widget__divider {
        opacity: 0.4;
        font-weight: 400;
      }
      #${WIDGET_ID} .scroll-tracker-widget__time {
        font-variant-numeric: tabular-nums;
        font-weight: 500;
        font-size: 13px;
        opacity: 0.85;
        line-height: 1;
      }
      #scroll-tracker-onboarding-tooltip {
        position: fixed;
        transform: translateX(-50%);
        z-index: 2147483647;
        background: #111827;
        color: #ffffff;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 12.5px;
        font-weight: 600;
        padding: 8px 12px;
        border-radius: 8px;
        box-shadow: 0 6px 16px rgba(0, 0, 0, 0.3);
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.25s ease;
        white-space: nowrap;
      }
      #scroll-tracker-onboarding-tooltip.scroll-tracker-onboarding-tooltip--visible {
        opacity: 1;
      }
      #scroll-tracker-onboarding-tooltip::before {
        content: "";
        position: absolute;
        top: -5px;
        left: 50%;
        transform: translateX(-50%);
        border-left: 5px solid transparent;
        border-right: 5px solid transparent;
        border-bottom: 5px solid #111827;
      }
    `;
    document.head.appendChild(style);
  }

  /**
   * Saves the widget's dragged position so it's remembered next time
   * a Short/Reel page loads. Not critical if this fails, so errors
   * are swallowed (best-effort only) — except context invalidation,
   * which triggers the same cleanup as everywhere else.
   */
  function saveWidgetPosition(left, top) {
    try {
      chrome.storage.local.set({ [WIDGET_POSITION_STORAGE_KEY]: { left, top } });
    } catch (err) {
      if (isContextInvalidationError(err)) handleContextInvalidated();
    }
  }

  /**
   * Applies a previously-saved position, if one exists, overriding
   * the default "top center" CSS placement.
   */
  function applySavedWidgetPosition(widget) {
    try {
      chrome.storage.local.get([WIDGET_POSITION_STORAGE_KEY], (result) => {
        const pos = result[WIDGET_POSITION_STORAGE_KEY];
        if (pos && typeof pos.left === "number" && typeof pos.top === "number") {
          widget.style.left = `${pos.left}px`;
          widget.style.top = `${pos.top}px`;
          widget.style.transform = "none";
        }
      });
    } catch (err) {
      if (isContextInvalidationError(err)) handleContextInvalidated();
    }
  }

  /**
   * Makes the widget draggable anywhere within the viewport. Uses a
   * small movement threshold to distinguish an intentional drag from
   * a plain click/double-click.
   */
  function makeWidgetDraggable(widget) {
    let isPointerDown = false;
    let didDrag = false;
    let startX = 0;
    let startY = 0;
    let originLeft = 0;
    let originTop = 0;

    widget.addEventListener("mousedown", (event) => {
      isPointerDown = true;
      didDrag = false;
      const rect = widget.getBoundingClientRect();
      startX = event.clientX;
      startY = event.clientY;
      originLeft = rect.left;
      originTop = rect.top;
      event.preventDefault();
    });

    window.addEventListener("mousemove", (event) => {
      if (!isPointerDown) return;

      const deltaX = event.clientX - startX;
      const deltaY = event.clientY - startY;

      if (!didDrag && (Math.abs(deltaX) > 3 || Math.abs(deltaY) > 3)) {
        didDrag = true;
        widget.classList.add(WIDGET_DRAGGING_CLASS);
      }
      if (!didDrag) return;

      const maxLeft = window.innerWidth - widget.offsetWidth;
      const maxTop = window.innerHeight - widget.offsetHeight;
      const newLeft = Math.min(Math.max(0, originLeft + deltaX), maxLeft);
      const newTop = Math.min(Math.max(0, originTop + deltaY), maxTop);

      widget.style.left = `${newLeft}px`;
      widget.style.top = `${newTop}px`;
      widget.style.transform = "none";
    });

    window.addEventListener("mouseup", () => {
      if (!isPointerDown) return;
      isPointerDown = false;
      widget.classList.remove(WIDGET_DRAGGING_CLASS);

      if (didDrag) {
        const rect = widget.getBoundingClientRect();
        saveWidgetPosition(rect.left, rect.top);
      }
    });

    // Double-click hides the widget until the user next enters a
    // fresh Shorts/Reels context (see updateWidgetVisibility()).
    widget.addEventListener("dblclick", (event) => {
      event.preventDefault();
      widgetManuallyHidden = true;
      hideWidget();
    });
  }

  /**
   * Creates the widget element (once) and appends it to the page.
   * Safe to call repeatedly — it's a no-op after the first call.
   */
  function ensureWidgetExists() {
    let widget = document.getElementById(WIDGET_ID);
    if (widget) return widget;

    injectWidgetStyles();

    widget = document.createElement("div");
    widget.id = WIDGET_ID;
    widget.title = "Scroll Tracker — drag to move, double-click to hide";
    widget.innerHTML = `
      <span class="scroll-tracker-widget__dot" aria-hidden="true"></span>
      <span class="scroll-tracker-widget__count">0</span>
      <span class="scroll-tracker-widget__divider" aria-hidden="true">·</span>
      <span class="scroll-tracker-widget__time">0m</span>
    `;

    document.body.appendChild(widget);
    makeWidgetDraggable(widget);
    applySavedWidgetPosition(widget);

    return widget;
  }

  function showWidget() {
    const widget = ensureWidgetExists();
    widget.classList.add(WIDGET_VISIBLE_CLASS);
    maybeShowOnboardingTooltip(widget);
  }

  function hideWidget() {
    const widget = document.getElementById(WIDGET_ID);
    if (widget) widget.classList.remove(WIDGET_VISIBLE_CLASS);
  }

  // ------------------------------------------------------------------
  // One-time onboarding tooltip
  // ------------------------------------------------------------------
  //
  // The very first time the widget appears (across the extension's
  // entire lifetime, tracked via a chrome.storage.local flag), show a
  // brief tooltip pointing out that it's draggable and dismissible.
  // This is the only place those two behaviors are explained, so
  // without it they're easy to never discover.

  const ONBOARDING_SEEN_KEY = "scrollTrackerWidgetOnboardingSeen";
  const ONBOARDING_TOOLTIP_ID = "scroll-tracker-onboarding-tooltip";

  // Guards against checking storage more than once per page load —
  // the actual "only ever show once" guarantee comes from the
  // ONBOARDING_SEEN_KEY flag in storage, checked inside.
  let onboardingCheckStarted = false;

  function maybeShowOnboardingTooltip(widget) {
    if (onboardingCheckStarted) return;
    onboardingCheckStarted = true;

    try {
      chrome.storage.local.get([ONBOARDING_SEEN_KEY], (result) => {
        if (result[ONBOARDING_SEEN_KEY]) return; // already shown before, ever

        const tooltip = document.createElement("div");
        tooltip.id = ONBOARDING_TOOLTIP_ID;
        tooltip.textContent = "Drag me anywhere · Double-click to hide";
        document.body.appendChild(tooltip);

        const positionTooltip = () => {
          const rect = widget.getBoundingClientRect();
          tooltip.style.top = `${rect.bottom + 10}px`;
          tooltip.style.left = `${rect.left + rect.width / 2}px`;
        };
        positionTooltip();

        requestAnimationFrame(() => tooltip.classList.add("scroll-tracker-onboarding-tooltip--visible"));

        setTimeout(() => {
          tooltip.classList.remove("scroll-tracker-onboarding-tooltip--visible");
          setTimeout(() => tooltip.remove(), 300);
        }, 6000);

        // Mark as seen immediately — even if the user navigates away
        // before the 6s auto-dismiss, it should never show again.
        try {
          chrome.storage.local.set({ [ONBOARDING_SEEN_KEY]: true });
        } catch (err) {
          if (isContextInvalidationError(err)) handleContextInvalidated();
        }
      });
    } catch (err) {
      if (isContextInvalidationError(err)) handleContextInvalidated();
    }
  }

  /**
   * Updates the number, time, and color shown inside the widget. Safe
   * to call even if the widget hasn't been created yet (no-op then).
   * The dot's color shifts through green -> yellow -> orange -> red
   * as the combined total approaches/crosses the daily milestones —
   * an at-a-glance signal without needing to read the number.
   */
  function updateWidgetCount(total, totalTimeMs) {
    const widget = document.getElementById(WIDGET_ID);
    if (!widget) return;
    const countEl = widget.querySelector(".scroll-tracker-widget__count");
    const timeEl = widget.querySelector(".scroll-tracker-widget__time");
    const dotEl = widget.querySelector(".scroll-tracker-widget__dot");
    if (countEl) countEl.textContent = String(total);
    if (timeEl) timeEl.textContent = Utils.formatDuration(totalTimeMs || 0);
    if (dotEl) dotEl.style.background = Utils.getTierColorForCount(total);
  }

  /**
   * Called on every detection pass. Shows the widget the moment the
   * user enters a Shorts/Reels context, hides it the moment they
   * leave, and respects a manual double-click dismissal in between.
   */
  function updateWidgetVisibility() {
    const isInContext = isCurrentlyInShortsOrReelsContext();

    if (isInContext && !wasInShortsOrReelsContext) {
      // Just entered Shorts/Reels — always show, even if it was
      // manually hidden during a previous visit.
      widgetManuallyHidden = false;
      showWidget();
    } else if (!isInContext && wasInShortsOrReelsContext) {
      // Just left Shorts/Reels — always hide.
      hideWidget();
    } else if (isInContext && !widgetManuallyHidden) {
      showWidget();
    } else if (!isInContext) {
      hideWidget();
    }

    wasInShortsOrReelsContext = isInContext;
  }

  /**
   * Keeps the widget's number in sync with storage in real time —
   * including counts made from OTHER tabs of the same site — and
   * sets the initial value on first load.
   */
  function startWidgetLiveUpdates() {
    Utils.getStorageData().then((data) => {
      updateWidgetDisplay(data);
    });

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === "local" && changes[Utils.STORAGE_KEY]) {
        const data = Utils.ensureDataIsForToday(changes[Utils.STORAGE_KEY].newValue);
        updateWidgetDisplay(data);
      }
    });
  }

  /**
   * Updates the widget with both the combined count and the combined
   * watch time for today, e.g. "42 · 1h 05m".
   */
  function updateWidgetDisplay(data) {
    const totalCount = data.youtubeShorts + data.instagramReels;
    const totalTimeMs = data.youtubeWatchTimeMs + data.instagramWatchTimeMs;
    updateWidgetCount(totalCount, totalTimeMs);
  }

  // ------------------------------------------------------------------
  // Watch-time tracking
  // ------------------------------------------------------------------
  //
  // We can't get exact "how long was this one video watched" data
  // easily across both sites, so instead we track TOTAL active time
  // spent in a Shorts/Reels context per day: a 1-second ticker adds
  // to a small in-memory buffer only while (a) the user is currently
  // on a Short/Reel, and (b) the tab is actually visible — so time
  // spent on a background tab is never counted. The buffer is flushed
  // to chrome.storage.local periodically rather than every second, to
  // keep storage writes light.

  let pendingWatchTimeMs = 0;

  /**
   * Writes any accumulated watch time to storage. Safe to call often
   * — it's a no-op if nothing has accumulated yet.
   */
  async function flushWatchTime() {
    if (extensionContextInvalidated) return;
    if (pendingWatchTimeMs <= 0) return;
    const msToFlush = pendingWatchTimeMs;
    pendingWatchTimeMs = 0;

    try {
      const data = await Utils.getStorageData();
      Utils.addWatchTime(data, isYoutube ? "youtube" : "instagram", msToFlush);
      await Utils.setStorageData(data);
    } catch (err) {
      if (isContextInvalidationError(err)) {
        handleContextInvalidated();
        return;
      }
      console.error("[Scroll Tracker] Failed to save watch time:", err);
      // Put it back so we retry on the next flush instead of losing it.
      pendingWatchTimeMs += msToFlush;
    }
  }

  function startWatchTimeTracking() {
    // Tick every second: only accumulate time while actively watching
    // AND the tab is visible (avoids counting time on a muted/
    // background tab as "watch time").
    const tickIntervalId = setInterval(() => {
      if (extensionContextInvalidated) return;
      const isActivelyWatching =
        isCurrentlyInShortsOrReelsContext() && document.visibilityState === "visible";
      if (isActivelyWatching) {
        pendingWatchTimeMs += 1000;
      }
    }, 1000);
    activeIntervalIds.push(tickIntervalId);

    // Flush the buffer periodically rather than every tick.
    const flushIntervalId = setInterval(flushWatchTime, 5000);
    activeIntervalIds.push(flushIntervalId);

    // And flush on the way out, best-effort (not guaranteed to
    // complete on every browser, but harmless to attempt).
    window.addEventListener("beforeunload", flushWatchTime);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flushWatchTime();
    });
  }

  // ------------------------------------------------------------------
  // Initialization
  // ------------------------------------------------------------------

  function init() {
    patchHistoryForSpaNavigation();
    window.addEventListener("scrolltracker:locationchange", scheduleCheck);

    if (isYoutube) {
      // YouTube's SPA router dispatches this custom event on every
      // completed in-app navigation — the most reliable signal there.
      window.addEventListener("yt-navigate-finish", scheduleCheck);
    }

    if (isInstagram) {
      startInstagramVideoEventListeners();
      startInstagramPollingFallback();
    }

    startDomObserver();
    startUrlPollingFallback();
    startWidgetLiveUpdates();
    startWatchTimeTracking();

    // Run once immediately in case the content script loads directly
    // on a Short/Reel URL (e.g. user pasted a link or refreshed).
    scheduleCheck();
  }

  if (document.body) {
    init();
  } else {
    document.addEventListener("DOMContentLoaded", init);
  }
})();
