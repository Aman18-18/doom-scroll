/**
 * animations.js
 * ------------------------------------------------------------------
 * Small shared animation helpers used by BOTH popup.js and
 * dashboard.js — plain JS using requestAnimationFrame and
 * IntersectionObserver, no libraries. Loaded before those files, same
 * global-namespace pattern as utils.js.
 * ------------------------------------------------------------------
 */

(function initScrollTrackerAnim(global) {
  if (global.ScrollTrackerAnim) return;

  function easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
  }

  /**
   * Animates a number counting up from its current displayed value
   * (or 0) to `endValue` inside `el`, over `duration` ms. Cancels any
   * in-progress count on the same element before starting a new one,
   * so rapid data updates don't stack animations.
   */
  function countUp(el, endValue, duration) {
    if (!el) return;
    const durationMs = duration || 650;

    // Cancel a previous in-flight animation on this element, if any.
    if (el._scrollTrackerCountUpFrame) {
      cancelAnimationFrame(el._scrollTrackerCountUpFrame);
    }

    const startValue = Number(el.textContent.replace(/[^\d.-]/g, "")) || 0;
    const startTime = performance.now();

    function tick(now) {
      const elapsed = now - startTime;
      const progress = Math.min(1, elapsed / durationMs);
      const eased = easeOutCubic(progress);
      const current = Math.round(startValue + (endValue - startValue) * eased);
      el.textContent = String(current);

      if (progress < 1) {
        el._scrollTrackerCountUpFrame = requestAnimationFrame(tick);
      } else {
        el.textContent = String(endValue);
        el._scrollTrackerCountUpFrame = null;
      }
    }

    el._scrollTrackerCountUpFrame = requestAnimationFrame(tick);
  }

  /**
   * Adds the "is-visible" class (see .st-reveal in theme.css) to each
   * element in `elements` as it scrolls into view, staggered by
   * `staggerMs` in DOM order. Falls back to showing everything
   * immediately if IntersectionObserver isn't available.
   */
  function revealOnScroll(elements, staggerMs) {
    const stagger = staggerMs || 70;
    const list = Array.prototype.slice.call(elements);

    if (!("IntersectionObserver" in global)) {
      list.forEach((el) => el.classList.add("is-visible"));
      return;
    }

    const observer = new IntersectionObserver(
      (entries, obs) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          const index = list.indexOf(entry.target);
          setTimeout(() => {
            entry.target.classList.add("is-visible");
          }, Math.max(0, index) * stagger);
          obs.unobserve(entry.target);
        });
      },
      { threshold: 0.08 }
    );

    list.forEach((el) => observer.observe(el));
  }

  global.ScrollTrackerAnim = { countUp, revealOnScroll };
})(typeof window !== "undefined" ? window : globalThis);
