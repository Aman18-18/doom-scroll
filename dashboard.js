/**
 * dashboard.js
 * ------------------------------------------------------------------
 * Powers the full-page analytics dashboard (opened via the popup's
 * "View Full Analytics" button). Renders:
 *   1. Today's snapshot (same numbers as the popup, just bigger).
 *   2. A 7-day bar chart (plain <canvas>, no chart library).
 *   3. A 24-hour "time of day" heatmap built from history.
 *   4. A shareable weekly recap card, downloadable as a PNG.
 * ------------------------------------------------------------------
 */

(function initDashboard() {
  const Utils = window.ScrollTrackerUtils;

  const elements = {
    todayDate: document.getElementById("today-date"),
    todayYoutube: document.getElementById("today-youtube"),
    todayInstagram: document.getElementById("today-instagram"),
    todayTotal: document.getElementById("today-total"),
    todayTime: document.getElementById("today-time"),
    weekChart: document.getElementById("week-chart"),
    heatmap: document.getElementById("heatmap"),
    recapCanvas: document.getElementById("recap-canvas"),
    downloadButton: document.getElementById("download-recap-button"),
  };

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

  // ------------------------------------------------------------------
  // Today's snapshot
  // ------------------------------------------------------------------

  function renderTodayStats(data) {
    elements.todayDate.textContent = formatDisplayDate(data.date);
    elements.todayYoutube.textContent = data.youtubeShorts;
    elements.todayInstagram.textContent = data.instagramReels;
    elements.todayTotal.textContent = data.youtubeShorts + data.instagramReels;
    elements.todayTime.textContent = Utils.formatDuration(
      (data.youtubeWatchTimeMs || 0) + (data.instagramWatchTimeMs || 0)
    );
  }

  // ------------------------------------------------------------------
  // 7-day bar chart (plain canvas, no library)
  // ------------------------------------------------------------------

  function drawWeekChart(canvas, series) {
    const ctx = canvas.getContext("2d");
    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);

    const maxValue = Math.max(1, ...series.map((day) => day.total)) * 1.25;
    const paddingBottom = 28;
    const paddingTop = 24;
    const chartHeight = height - paddingBottom - paddingTop;
    const barSlotWidth = width / series.length;
    const barWidth = barSlotWidth * 0.5;

    series.forEach((day, index) => {
      const barHeight = (day.total / maxValue) * chartHeight;
      const x = index * barSlotWidth + (barSlotWidth - barWidth) / 2;
      const y = paddingTop + (chartHeight - barHeight);

      // Bar, colored by the same green/yellow/orange/red tiers as the
      // on-page widget, so the visual language stays consistent.
      ctx.fillStyle = Utils.getTierColorForCount(day.total);
      ctx.beginPath();
      const radius = 4;
      ctx.moveTo(x, y + barHeight);
      ctx.lineTo(x, y + radius);
      ctx.arcTo(x, y, x + radius, y, radius);
      ctx.lineTo(x + barWidth - radius, y);
      ctx.arcTo(x + barWidth, y, x + barWidth, y + radius, radius);
      ctx.lineTo(x + barWidth, y + barHeight);
      ctx.closePath();
      ctx.fill();

      // Value label above the bar.
      ctx.fillStyle = "#111827";
      ctx.font = "600 12px -apple-system, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(String(day.total), x + barWidth / 2, y - 8);

      // Weekday label below the chart.
      ctx.fillStyle = "#6b7280";
      ctx.font = "500 11px -apple-system, sans-serif";
      ctx.fillText(
        formatWeekdayShort(day.date),
        x + barWidth / 2,
        height - paddingBottom + 16
      );
    });
  }

  // ------------------------------------------------------------------
  // Time-of-day heatmap
  // ------------------------------------------------------------------

  function renderHeatmap(hourlyTotals) {
    elements.heatmap.innerHTML = "";
    const maxCount = Math.max(1, ...hourlyTotals);

    for (let hour = 0; hour < 24; hour++) {
      const count = hourlyTotals[hour];
      const intensity = count / maxCount; // 0..1

      const cell = document.createElement("div");
      cell.className = "heatmap__cell";
      // Blend from a very light to a fully saturated blue based on
      // how much activity happened in this hour relative to the peak.
      cell.style.background =
        count === 0 ? "#eef2ff" : `rgba(37, 99, 235, ${0.15 + intensity * 0.85})`;

      const hourLabel = hour === 0 ? "12am" : hour < 12 ? `${hour}am` : hour === 12 ? "12pm" : `${hour - 12}pm`;
      cell.title = `${hourLabel}: ${count} Short${count === 1 ? "" : "s"}/Reel${count === 1 ? "" : "s"}`;

      elements.heatmap.appendChild(cell);
    }
  }

  // ------------------------------------------------------------------
  // Shareable weekly recap card
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

  function drawRecapCard(canvas, thisWeek, lastWeek) {
    const ctx = canvas.getContext("2d");
    const size = canvas.width; // square canvas
    ctx.clearRect(0, 0, size, size);

    // Background gradient.
    const gradient = ctx.createLinearGradient(0, 0, size, size);
    gradient.addColorStop(0, "#1e1b4b");
    gradient.addColorStop(1, "#701a75");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);

    ctx.textAlign = "center";

    // Header.
    ctx.fillStyle = "rgba(255,255,255,0.75)";
    ctx.font = "600 20px -apple-system, sans-serif";
    ctx.fillText("MY WEEK — SCROLL TRACKER", size / 2, size * 0.14);

    // Big total number.
    ctx.fillStyle = "#ffffff";
    ctx.font = "800 100px -apple-system, sans-serif";
    ctx.fillText(String(thisWeek.total), size / 2, size * 0.34);

    ctx.fillStyle = "rgba(255,255,255,0.75)";
    ctx.font = "600 20px -apple-system, sans-serif";
    ctx.fillText("Shorts + Reels watched", size / 2, size * 0.4);

    // Time spent.
    ctx.fillStyle = "#ffffff";
    ctx.font = "700 40px -apple-system, sans-serif";
    ctx.fillText(Utils.formatDuration(thisWeek.timeMs), size / 2, size * 0.52);

    ctx.fillStyle = "rgba(255,255,255,0.75)";
    ctx.font = "600 16px -apple-system, sans-serif";
    ctx.fillText("time spent", size / 2, size * 0.56);

    // Breakdown.
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.font = "600 18px -apple-system, sans-serif";
    ctx.fillText(
      `${thisWeek.youtubeShorts} Shorts  ·  ${thisWeek.instagramReels} Reels`,
      size / 2,
      size * 0.64
    );

    // Trend vs. previous week.
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

    // Footer.
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
  // Load everything and render
  // ------------------------------------------------------------------

  async function loadAndRenderAll() {
    const [todayData, last7Days, previous7Days, hourlyTotals] = await Promise.all([
      Utils.getStorageData(),
      Utils.getLast7DaysSeries(),
      Utils.getDaysSeries(7, 7),
      Utils.getHourlyHeatmap(30),
    ]);

    renderTodayStats(todayData);
    drawWeekChart(elements.weekChart, last7Days);
    renderHeatmap(hourlyTotals);
    drawRecapCard(elements.recapCanvas, sumSeries(last7Days), sumSeries(previous7Days));
  }

  document.addEventListener("DOMContentLoaded", () => {
    if (!Utils) {
      console.error("[Scroll Tracker] utils.js did not load correctly.");
      return;
    }

    loadAndRenderAll();
    elements.downloadButton.addEventListener("click", handleDownloadRecap);

    // Keep the dashboard live if left open while scrolling elsewhere.
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === "local") {
        loadAndRenderAll();
      }
    });
  });
})();
