/**
 * dashboard.js
 * ------------------------------------------------------------------
 * Powers the full-page analytics dashboard (opened via the popup's
 * "View Full Analytics" button). Renders:
 *   1. Today's snapshot (same numbers as the popup, just bigger).
 *   2. A history bar chart (plain <canvas>, no library) — toggles
 *      between the last 7 and last 30 days via a segmented control,
 *      with gradient-filled bars that grow in on every render.
 *   3. Auto-generated text insights for whichever range is selected.
 *   4. A 24-hour "time of day" heatmap built from the last 30 days.
 *   5. A shareable weekly recap card, downloadable as a PNG.
 *   6. Export of the full tracked history as CSV or JSON.
 *
 * Canvas-drawn elements (the chart) read their text/line colors from
 * the current theme at render time, and re-render whenever the theme
 * is toggled — CSS alone can't reach into <canvas> pixels.
 * ------------------------------------------------------------------
 */

(function initDashboard() {
  const Utils = window.ScrollTrackerUtils;
  const Anim = window.ScrollTrackerAnim;

  const elements = {
    todayDate: document.getElementById("today-date"),
    todayYoutube: document.getElementById("today-youtube"),
    todayInstagram: document.getElementById("today-instagram"),
    todayTotal: document.getElementById("today-total"),
    todayTime: document.getElementById("today-time"),
    segmented: document.getElementById("chart-range-segmented"),
    weekChart: document.getElementById("week-chart"),
    insightsList: document.getElementById("insights-list"),
    heatmap: document.getElementById("heatmap"),
    recapCanvas: document.getElementById("recap-canvas"),
    downloadRecapButton: document.getElementById("download-recap-button"),
    exportCsvButton: document.getElementById("export-csv-button"),
    exportJsonButton: document.getElementById("export-json-button"),
    themeToggleButton: document.getElementById("theme-toggle-button"),
  };

  // Cached so the range toggle, live storage updates, and theme
  // switches can all re-render without re-fetching from storage.
  let cachedHourlyTotals = new Array(24).fill(0);
  let cachedLast7Days = [];
  let cachedPrevious7Days = [];
  let selectedRangeDays = 7;
  let hasRevealedPanels = false;

  function isDarkTheme() {
    return document.documentElement.getAttribute("data-theme") === "dark";
  }

  /** Text colors for canvas drawing — canvas can't read CSS variables. */
  function getCanvasPalette() {
    return isDarkTheme()
      ? { strong: "#f2f3f7", muted: "#9199ab" }
      : { strong: "#111827", muted: "#6b7280" };
  }

  /** Same friendly date formatting used in the popup. */
  function formatDisplayDate(isoDateString) {
    try {
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

  /** Short weekday label ("Mon") for a "YYYY-MM-DD" string. */
  function formatWeekdayShort(isoDateString) {
    try {
      const date = new Date(`${isoDateString}T00:00:00`);
      return date.toLocaleDateString(undefined, { weekday: "short" });
    } catch (err) {
      return isoDateString.slice(5);
    }
  }

  /** Compact "8/2" style date label, used when the range is long. */
  function formatShortDate(isoDateString) {
    try {
      const date = new Date(`${isoDateString}T00:00:00`);
      return date.toLocaleDateString(undefined, { month: "numeric", day: "numeric" });
    } catch (err) {
      return isoDateString.slice(5);
    }
  }

  /** "9pm" / "12am" style label for an hour index (0-23). */
  function formatHourLabel(hour) {
    if (hour === 0) return "12am";
    if (hour < 12) return `${hour}am`;
    if (hour === 12) return "12pm";
    return `${hour - 12}pm`;
  }

  /** Parses a "#rrggbb" hex string into {r, g, b}. */
  function hexToRgb(hex) {
    const clean = hex.replace("#", "");
    const bigint = parseInt(clean, 16);
    return { r: (bigint >> 16) & 255, g: (bigint >> 8) & 255, b: bigint & 255 };
  }

  // ------------------------------------------------------------------
  // Today's snapshot
  // ------------------------------------------------------------------

  function renderTodayStats(data) {
    elements.todayDate.textContent = formatDisplayDate(data.date);

    const total = data.youtubeShorts + data.instagramReels;
    const timeMs = (data.youtubeWatchTimeMs || 0) + (data.instagramWatchTimeMs || 0);

    if (Anim) {
      Anim.countUp(elements.todayYoutube, data.youtubeShorts);
      Anim.countUp(elements.todayInstagram, data.instagramReels);
      Anim.countUp(elements.todayTotal, total);
    } else {
      elements.todayYoutube.textContent = data.youtubeShorts;
      elements.todayInstagram.textContent = data.instagramReels;
      elements.todayTotal.textContent = total;
    }
    elements.todayTime.textContent = Utils.formatDuration(timeMs);
  }

  // ------------------------------------------------------------------
  // History bar chart (plain canvas, no library) — gradient-filled
  // bars that grow in on every render; colors adapt to the theme.
  // ------------------------------------------------------------------

  function renderBarChart(canvas, series) {
    if (canvas._scrollTrackerChartFrame) {
      cancelAnimationFrame(canvas._scrollTrackerChartFrame);
    }

    const ctx = canvas.getContext("2d");
    const width = canvas.width;
    const height = canvas.height;
    const palette = getCanvasPalette();

    const isDense = series.length > 10;
    const maxValue = Math.max(1, ...series.map((day) => day.total)) * 1.25;
    const paddingBottom = 28;
    const paddingTop = isDense ? 12 : 24;
    const chartHeight = height - paddingBottom - paddingTop;
    const barSlotWidth = width / series.length;
    const barWidth = isDense ? barSlotWidth * 0.7 : barSlotWidth * 0.5;
    const labelEvery = isDense ? Math.ceil(series.length / 8) : 1;

    function drawFrame(progress) {
      ctx.clearRect(0, 0, width, height);

      series.forEach((day, index) => {
        const barHeight = (day.total / maxValue) * chartHeight * progress;
        const x = index * barSlotWidth + (barSlotWidth - barWidth) / 2;
        const y = paddingTop + (chartHeight - barHeight);

        // Gradient fill (lighter at top, richer at bottom) instead of
        // a flat color — reads as noticeably more polished.
        const { r, g, b } = hexToRgb(Utils.getTierColorForCount(day.total));
        const gradient = ctx.createLinearGradient(0, y, 0, y + Math.max(barHeight, 1));
        gradient.addColorStop(0, `rgba(${r}, ${g}, ${b}, 0.95)`);
        gradient.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0.65)`);

        ctx.globalAlpha = 0.4 + progress * 0.6;
        ctx.fillStyle = gradient;
        ctx.beginPath();
        const radius = 3;
        ctx.moveTo(x, y + barHeight);
        ctx.lineTo(x, y + radius);
        ctx.arcTo(x, y, x + radius, y, radius);
        ctx.lineTo(x + barWidth - radius, y);
        ctx.arcTo(x + barWidth, y, x + barWidth, y + radius, radius);
        ctx.lineTo(x + barWidth, y + barHeight);
        ctx.closePath();
        ctx.fill();
        ctx.globalAlpha = 1;

        if (progress > 0.85) {
          ctx.textAlign = "center";

          if (!isDense) {
            ctx.fillStyle = palette.strong;
            ctx.font = "600 12px -apple-system, sans-serif";
            ctx.fillText(String(day.total), x + barWidth / 2, y - 8);
          }

          if (index % labelEvery === 0) {
            ctx.fillStyle = palette.muted;
            ctx.font = "500 10.5px -apple-system, sans-serif";
            ctx.fillText(
              isDense ? formatShortDate(day.date) : formatWeekdayShort(day.date),
              x + barWidth / 2,
              height - paddingBottom + 16
            );
          }
        }
      });
    }

    const durationMs = 550;
    const startTime = performance.now();

    function tick(now) {
      const elapsed = now - startTime;
      const t = Math.min(1, elapsed / durationMs);
      const eased = 1 - Math.pow(1 - t, 3);
      drawFrame(eased);

      if (t < 1) {
        canvas._scrollTrackerChartFrame = requestAnimationFrame(tick);
      } else {
        canvas._scrollTrackerChartFrame = null;
      }
    }

    canvas._scrollTrackerChartFrame = requestAnimationFrame(tick);
  }

  // ------------------------------------------------------------------
  // Auto-generated text insights for the currently-selected range
  // ------------------------------------------------------------------

  function sumSeries(series) {
    return series.reduce(
      (acc, day) => ({
        total: acc.total + day.total,
        timeMs: acc.timeMs + day.timeMs,
        youtubeShorts: acc.youtubeShorts + day.youtubeShorts,
        instagramReels: acc.instagramReels + day.instagramReels,
      }),
      { total: 0, timeMs: 0, youtubeShorts: 0, instagramReels: 0 }
    );
  }

  function generateInsights(currentSeries, previousSeries, hourlyTotals) {
    const insights = [];
    const currentSum = sumSeries(currentSeries);
    const previousSum = sumSeries(previousSeries);
    const rangeLabel = currentSeries.length === 7 ? "week" : `${currentSeries.length} days`;

    if (previousSum.total > 0) {
      const percentChange = Math.round(
        ((currentSum.total - previousSum.total) / previousSum.total) * 100
      );
      if (percentChange < 0) {
        insights.push(
          `You watched ${Math.abs(percentChange)}% fewer Shorts/Reels than the previous ${rangeLabel}. Nice.`
        );
      } else if (percentChange > 0) {
        insights.push(
          `You watched ${percentChange}% more Shorts/Reels than the previous ${rangeLabel}.`
        );
      } else {
        insights.push(`Your total matched the previous ${rangeLabel} exactly.`);
      }
    } else if (currentSum.total > 0) {
      insights.push("This is your first tracked period — keep going to start seeing trends.");
    }

    if (currentSum.total > 0) {
      const avgPerDay = Math.round(currentSum.total / currentSeries.length);
      insights.push(`You're averaging ${avgPerDay} Shorts/Reels per day over this ${rangeLabel}.`);
    }

    const busiestDay = currentSeries.reduce(
      (max, day) => (day.total > max.total ? day : max),
      currentSeries[0]
    );
    if (busiestDay && busiestDay.total > 0) {
      insights.push(
        `Your busiest day was ${formatDisplayDate(busiestDay.date)} with ${busiestDay.total} watched.`
      );
    }

    const peakHour = hourlyTotals.indexOf(Math.max(...hourlyTotals));
    if (Math.max(...hourlyTotals) > 0) {
      insights.push(`You tend to scroll most around ${formatHourLabel(peakHour)}.`);
    }

    if (insights.length === 0) {
      insights.push("No activity tracked yet for this period — go watch something (or don't!).");
    }

    return insights;
  }

  function renderInsights(insights) {
    elements.insightsList.innerHTML = "";
    insights.forEach((text, index) => {
      const item = document.createElement("li");
      item.textContent = text;
      item.style.setProperty("--st-i", index);
      elements.insightsList.appendChild(item);
    });
  }

  // ------------------------------------------------------------------
  // Time-of-day heatmap (always the last 30 days combined). Colors are
  // driven by a CSS custom property (--intensity) rather than inline
  // rgba(), so [data-theme="dark"] can recolor cells automatically —
  // no JS re-render needed on theme toggle.
  // ------------------------------------------------------------------

  function renderHeatmap(hourlyTotals) {
    elements.heatmap.innerHTML = "";
    const maxCount = Math.max(1, ...hourlyTotals);

    for (let hour = 0; hour < 24; hour++) {
      const count = hourlyTotals[hour];
      const intensity = count / maxCount; // 0..1

      const cell = document.createElement("div");
      cell.className = "heatmap__cell" + (count > 0 ? " heatmap__cell--active" : "");
      cell.style.setProperty("--st-i", hour);
      cell.style.setProperty("--intensity", intensity);
      cell.title = `${formatHourLabel(hour)}: ${count} Short${count === 1 ? "" : "s"}/Reel${
        count === 1 ? "" : "s"
      }`;

      elements.heatmap.appendChild(cell);
    }
  }

  // ------------------------------------------------------------------
  // Shareable weekly recap card — intentionally a fixed dark/purple
  // gradient regardless of page theme, since it's a standalone
  // shareable image, not part of the dashboard's own UI.
  // ------------------------------------------------------------------

  function drawRecapCard(canvas, thisWeek, lastWeek) {
    const ctx = canvas.getContext("2d");
    const size = canvas.width;
    ctx.clearRect(0, 0, size, size);

    const gradient = ctx.createLinearGradient(0, 0, size, size);
    gradient.addColorStop(0, "#1e1b4b");
    gradient.addColorStop(1, "#701a75");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);

    ctx.textAlign = "center";

    ctx.fillStyle = "rgba(255,255,255,0.75)";
    ctx.font = "600 20px -apple-system, sans-serif";
    ctx.fillText("MY WEEK — SCROLL TRACKER", size / 2, size * 0.14);

    ctx.fillStyle = "#ffffff";
    ctx.font = "800 100px -apple-system, sans-serif";
    ctx.fillText(String(thisWeek.total), size / 2, size * 0.34);

    ctx.fillStyle = "rgba(255,255,255,0.75)";
    ctx.font = "600 20px -apple-system, sans-serif";
    ctx.fillText("Shorts + Reels watched", size / 2, size * 0.4);

    ctx.fillStyle = "#ffffff";
    ctx.font = "700 40px -apple-system, sans-serif";
    ctx.fillText(Utils.formatDuration(thisWeek.timeMs), size / 2, size * 0.52);

    ctx.fillStyle = "rgba(255,255,255,0.75)";
    ctx.font = "600 16px -apple-system, sans-serif";
    ctx.fillText("time spent", size / 2, size * 0.56);

    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.font = "600 18px -apple-system, sans-serif";
    ctx.fillText(
      `${thisWeek.youtubeShorts} Shorts  ·  ${thisWeek.instagramReels} Reels`,
      size / 2,
      size * 0.64
    );

    let trendText = "First week tracked!";
    let trendColor = "rgba(255,255,255,0.85)";
    if (lastWeek.total > 0) {
      const percentChange = Math.round(((thisWeek.total - lastWeek.total) / lastWeek.total) * 100);
      if (percentChange < 0) {
        trendText = `↓ ${Math.abs(percentChange)}% vs last week`;
        trendColor = "#4ade80";
      } else if (percentChange > 0) {
        trendText = `↑ ${percentChange}% vs last week`;
        trendColor = "#f87171";
      } else {
        trendText = "Same as last week";
      }
    }
    ctx.fillStyle = trendColor;
    ctx.font = "700 24px -apple-system, sans-serif";
    ctx.fillText(trendText, size / 2, size * 0.74);

    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.font = "500 14px -apple-system, sans-serif";
    ctx.fillText("Tracked with Scroll Tracker", size / 2, size * 0.94);
  }

  function handleDownloadRecap() {
    const dateSuffix = Utils.getTodayDateString();
    const link = document.createElement("a");
    link.download = `scroll-tracker-recap-${dateSuffix}.png`;
    link.href = elements.recapCanvas.toDataURL("image/png");
    link.click();
  }

  // ------------------------------------------------------------------
  // Export data (CSV / JSON)
  // ------------------------------------------------------------------

  function triggerDownload(filename, content, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  }

  function buildCsv(fullHistory) {
    const header = "Date,YouTube Shorts,Instagram Reels,Total,Watch Time (minutes)";
    const rows = Object.keys(fullHistory)
      .sort()
      .map((date) => {
        const day = fullHistory[date];
        const total = (day.youtubeShorts || 0) + (day.instagramReels || 0);
        const minutes = Math.round(
          ((day.youtubeWatchTimeMs || 0) + (day.instagramWatchTimeMs || 0)) / 60000
        );
        return `${date},${day.youtubeShorts || 0},${day.instagramReels || 0},${total},${minutes}`;
      });
    return [header, ...rows].join("\n");
  }

  async function handleExportCsv() {
    const fullHistory = await Utils.getFullHistoryIncludingToday();
    triggerDownload(
      `scroll-tracker-export-${Utils.getTodayDateString()}.csv`,
      buildCsv(fullHistory),
      "text/csv"
    );
  }

  async function handleExportJson() {
    const fullHistory = await Utils.getFullHistoryIncludingToday();
    triggerDownload(
      `scroll-tracker-export-${Utils.getTodayDateString()}.json`,
      JSON.stringify(fullHistory, null, 2),
      "application/json"
    );
  }

  // ------------------------------------------------------------------
  // Segmented range control (7 days / 30 days)
  // ------------------------------------------------------------------

  function setActiveRange(days) {
    selectedRangeDays = days;
    elements.segmented.setAttribute("data-active", String(days));
    elements.segmented.querySelectorAll(".segmented__option").forEach((btn) => {
      const isActive = parseInt(btn.dataset.days, 10) === days;
      btn.classList.toggle("is-active", isActive);
      btn.setAttribute("aria-selected", String(isActive));
    });
  }

  function initSegmentedControl() {
    setActiveRange(selectedRangeDays);
    elements.segmented.querySelectorAll(".segmented__option").forEach((btn) => {
      btn.addEventListener("click", () => {
        const days = parseInt(btn.dataset.days, 10) || 7;
        if (days === selectedRangeDays) return;
        setActiveRange(days);
        refreshChartAndInsights(days);
      });
    });
  }

  // ------------------------------------------------------------------
  // Chart + insights refresh (re-run whenever the range control
  // changes, without needing to reload everything else on the page)
  // ------------------------------------------------------------------

  async function refreshChartAndInsights(days) {
    const [currentSeries, previousSeries] = await Promise.all([
      Utils.getDaysSeries(days, 0),
      Utils.getDaysSeries(days, days),
    ]);
    renderBarChart(elements.weekChart, currentSeries);
    renderInsights(generateInsights(currentSeries, previousSeries, cachedHourlyTotals));
  }

  // ------------------------------------------------------------------
  // Load everything and render
  // ------------------------------------------------------------------

  async function loadAndRenderAll() {
    const [todayData, hourlyTotals, last7Days, previous7Days] = await Promise.all([
      Utils.getStorageData(),
      Utils.getHourlyHeatmap(30),
      Utils.getLast7DaysSeries(),
      Utils.getDaysSeries(7, 7),
    ]);

    cachedHourlyTotals = hourlyTotals;
    cachedLast7Days = last7Days;
    cachedPrevious7Days = previous7Days;

    renderTodayStats(todayData);
    renderHeatmap(hourlyTotals);
    drawRecapCard(elements.recapCanvas, sumSeries(last7Days), sumSeries(previous7Days));

    await refreshChartAndInsights(selectedRangeDays);

    // Reveal the panels with a stagger the first time data loads —
    // subsequent live updates shouldn't re-trigger the entrance.
    if (!hasRevealedPanels && Anim) {
      hasRevealedPanels = true;
      Anim.revealOnScroll(document.querySelectorAll(".panel.st-reveal"), 90);
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    if (!Utils) {
      console.error("[Scroll Tracker] utils.js did not load correctly.");
      return;
    }

    initSegmentedControl();
    loadAndRenderAll();

    elements.downloadRecapButton.addEventListener("click", handleDownloadRecap);
    elements.exportCsvButton.addEventListener("click", handleExportCsv);
    elements.exportJsonButton.addEventListener("click", handleExportJson);

    if (window.ScrollTrackerTheme) {
      elements.themeToggleButton.addEventListener("click", () => {
        window.ScrollTrackerTheme.toggleTheme();
      });
    }

    // The chart's text/gradient colors are baked into canvas pixels,
    // so re-render it (and the recap card) whenever the theme flips —
    // everything else (CSS-driven) updates automatically.
    document.addEventListener("scrolltracker:themechange", () => {
      refreshChartAndInsights(selectedRangeDays);
      drawRecapCard(elements.recapCanvas, sumSeries(cachedLast7Days), sumSeries(cachedPrevious7Days));
    });

    // Keep the dashboard live if left open while scrolling elsewhere.
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === "local") {
        loadAndRenderAll();
      }
    });
  });
})();
