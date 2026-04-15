const $ = (id) => document.getElementById(id);

const els = {
  sitemapUrl: $("sitemapUrl"),
  modeSelect: $("modeSelect"),
  startBtn: $("startBtn"),
  pauseBtn: $("pauseBtn"),
  stopBtn: $("stopBtn"),
  clearBtn: $("clearBtn"),
  labelRequested: $("labelRequested"),
  logPanel: $("logPanel"),
  remainingPanel: $("remainingPanel"),
  sitemapsPanel: $("sitemapsPanel"),
  remainingCount: $("remainingCount"),
  statusLine: $("statusLine"),
  currentUrl: $("currentUrl"),
  progressBar: $("progressBar"),
  progressFill: $("progressFill"),
  valIndexed: $("valIndexed"),
  valRequested: $("valRequested"),
  valErrors: $("valErrors"),
  valDone: $("valDone"),
  valRemaining: $("valRemaining"),
  valTodayChecks: $("valTodayChecks"),
  valTodayRequests: $("valTodayRequests"),
  valLastRun: $("valLastRun"),
  valAllTime: $("valAllTime"),
  quotaCountdown: $("quotaCountdown"),
  rawUrlsInput: $("rawUrlsInput"),
  srcSitemap: $("srcSitemap"),
  srcPaste: $("srcPaste"),
};

let stats = { checked: 0, indexed: 0, requested: 0, errors: 0, done: 0, remaining: 0 };
let remainingUrls = [];
let currentProcessingIndex = -1;
let countdownInterval = null;
let currentMode = "index";
let isPaused = false;
let inputSource = "sitemap";

// ── Source toggle ──
function setInputSource(source) {
  inputSource = source;
  els.srcSitemap.classList.toggle("active", source === "sitemap");
  els.srcPaste.classList.toggle("active", source === "paste");
  els.sitemapUrl.style.display = source === "sitemap" ? "" : "none";
  els.rawUrlsInput.style.display = source === "paste" ? "block" : "none";
}

els.srcSitemap.addEventListener("click", () => setInputSource("sitemap"));
els.srcPaste.addEventListener("click", () => setInputSource("paste"));

function extractUrls(text) {
  const matches = text.match(/https?:\/\/[^\s,<>"']+/gi) || [];
  const cleaned = matches.map((u) => u.replace(/[.)>,;]+$/, ""));
  return [...new Set(cleaned)];
}

function startCountdown(nextResetMs) {
  if (!nextResetMs) return;
  if (countdownInterval) clearInterval(countdownInterval);
  function update() {
    const diff = nextResetMs - Date.now();
    if (diff <= 0) {
      els.quotaCountdown.textContent = "(quota reset!)";
      clearInterval(countdownInterval);
      return;
    }
    const h = Math.floor(diff / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    const s = Math.floor((diff % 60000) / 1000);
    if (h > 0) {
      els.quotaCountdown.textContent = `(resets in ${h}h ${m}m)`;
    } else {
      els.quotaCountdown.textContent = `(resets in ${m}m ${s}s)`;
    }
  }
  update();
  countdownInterval = setInterval(update, 1000);
}

// ── Tabs ──
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById(tab.dataset.tab + "Panel").classList.add("active");
  });
});

// ── Logging ──
function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

const MAX_LOG_ENTRIES = 200;

function addLogEntry(text, level = "info", time = null) {
  const entry = document.createElement("div");
  entry.className = `log-entry ${level}`;
  const timeStr = formatTime(time || Date.now());
  entry.innerHTML = `<span class="log-time">${timeStr}</span>${linkifyUrls(escapeHtml(text))}`;
  els.logPanel.appendChild(entry);
  while (els.logPanel.children.length > MAX_LOG_ENTRIES) {
    els.logPanel.removeChild(els.logPanel.firstChild);
  }
  els.logPanel.scrollTop = els.logPanel.scrollHeight;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function linkifyUrls(html) {
  return html.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank">$1</a>');
}

// ── Info panel ──
function updateInfo() {
  els.valIndexed.textContent = stats.indexed;
  els.valRequested.textContent = stats.requested;
  els.valErrors.textContent = stats.errors;
  els.valDone.textContent = stats.done;
  els.valRemaining.textContent = stats.remaining;
  els.remainingCount.textContent = stats.remaining;

  // Progress bar
  const total = stats.checked + stats.remaining;
  if (total > 0) {
    const pct = Math.round((stats.checked / total) * 100);
    els.progressFill.style.width = `${pct}%`;
    els.progressBar.classList.add("visible");
  }
}

function updateMeta(runStats, dailyQuota) {
  if (runStats && runStats.lastRunAt) {
    const d = new Date(runStats.lastRunAt);
    const dateStr = d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
    els.valLastRun.textContent = `${dateStr} (${timeAgo(runStats.lastRunAt)})`;
    els.valAllTime.textContent = runStats.totalProcessed.toLocaleString();
  }
  if (dailyQuota) {
    els.valTodayChecks.textContent = dailyQuota.checks.toLocaleString();
    els.valTodayRequests.textContent = dailyQuota.indexRequests.toLocaleString();
    startCountdown(dailyQuota.nextResetMs);
  }
}

function timeAgo(ts) {
  const diffMs = Date.now() - ts;
  const mins = Math.floor(diffMs / 60000);
  const hours = Math.floor(diffMs / 3600000);
  const days = Math.floor(diffMs / 86400000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
}

function setStatus(text, url) {
  els.statusLine.textContent = text;
  els.currentUrl.innerHTML = url ? linkifyUrls(escapeHtml(url)) : "";
  if (!url) els.progressBar.classList.remove("visible");
}

// ── Remaining URLs list ──
function renderRemaining() {
  els.remainingPanel.innerHTML = "";
  if (remainingUrls.length === 0) {
    els.remainingPanel.innerHTML = '<div style="color:#9e9e9e;padding:20px;text-align:center;">No URLs remaining</div>';
    return;
  }
  remainingUrls.forEach((url, i) => {
    const globalIndex = currentProcessingIndex + i;
    const div = document.createElement("div");
    div.className = `remaining-url${i === 0 ? " current" : ""}`;
    div.innerHTML = `<span class="url-index">${globalIndex + 1}.</span><a href="${escapeHtml(url)}" target="_blank">${escapeHtml(url)}</a>`;
    els.remainingPanel.appendChild(div);
  });
}

// ── Sitemaps tab ──
function loadSitemaps() {
  chrome.runtime.sendMessage({ type: "GET_SITEMAPS" }, (data) => {
    if (!data) return;
    const panel = els.sitemapsPanel;
    const entries = Object.entries(data.history);

    if (entries.length === 0) {
      panel.innerHTML = '<div style="color:#9e9e9e;padding:20px;text-align:center;">No sitemaps processed yet</div>';
      return;
    }

    // Sort by last run, newest first
    entries.sort((a, b) => b[1].lastRun - a[1].lastRun);

    let html = "";
    for (const [url, info] of entries) {
      const lastRun = new Date(info.lastRun).toLocaleString();
      const firstRun = new Date(info.firstRun).toLocaleString();
      html += `<div class="sitemap-entry" data-url="${escapeHtml(url)}">
        <div class="sitemap-url">${escapeHtml(url)}</div>
        <div class="sitemap-meta">${info.urlCount} URLs &middot; ${info.runs} runs &middot; last: ${lastRun} &middot; first: ${firstRun}</div>
      </div>`;
    }

    // Show last rate limit if any
    if (data.rateLimits && data.rateLimits.length > 0) {
      const last429 = new Date(data.rateLimits[data.rateLimits.length - 1]).toLocaleString();
      html += `<div style="color:#c5221f;font-size:11px;padding:8px 0;border-top:1px solid #e0e0e0;margin-top:6px;">Last 429 rate limit: ${last429}</div>`;
    }

    panel.innerHTML = html;

    // Click to load sitemap URL into input
    panel.querySelectorAll(".sitemap-entry").forEach((el) => {
      el.addEventListener("click", () => {
        els.sitemapUrl.value = el.dataset.url;
        chrome.storage.local.set({ lastSitemapUrl: el.dataset.url });
      });
    });
  });
}

// ── Mode labels ──
function updateStatsLabels() {
  if (currentMode === "inspect") {
    els.labelRequested.textContent = "Not on Google";
    els.valRequested.className = "c-red";
  } else {
    els.labelRequested.textContent = "Requested";
    els.valRequested.className = "c-blue";
  }
}

els.modeSelect.addEventListener("change", () => {
  currentMode = els.modeSelect.value;
  updateStatsLabels();
});

// ── Running state ──
function setRunning(running) {
  els.startBtn.style.display = running ? "none" : "";
  els.pauseBtn.style.display = running ? "" : "none";
  els.stopBtn.style.display = running ? "" : "none";
  els.sitemapUrl.disabled = running;
  els.rawUrlsInput.disabled = running;
  els.modeSelect.disabled = running;
  if (!running) {
    isPaused = false;
    els.pauseBtn.textContent = "Pause";
    els.pauseBtn.classList.remove("resume");
  }
}

// ── Restore state on popup open ──
chrome.storage.local.get("lastSitemapUrl", (data) => {
  if (data.lastSitemapUrl) {
    els.sitemapUrl.value = data.lastSitemapUrl;
  }
});

chrome.runtime.sendMessage({ type: "GET_STATE" }, (s) => {
  if (!s) return;

  // Restore mode
  if (s.mode) {
    currentMode = s.mode;
    els.modeSelect.value = s.mode;
    updateStatsLabels();
  }

  if (s.total > 0) {
    stats.checked = s.results.length;
    stats.indexed = s.results.filter((r) => r.action === "already_indexed").length;
    stats.requested = s.results.filter((r) => r.action === "requested_indexing" || r.action === "not_indexed").length;
    stats.errors = s.results.filter((r) => r.error).length;
    stats.remaining = s.total - s.results.length;
    stats.done = s.alreadyDone || 0;
    remainingUrls = s.remaining || [];
    currentProcessingIndex = s.currentIndex;
    updateInfo();
    renderRemaining();
    if (s.inputSource === "paste") setInputSource("paste");
    if (s.sitemapUrl) els.sitemapUrl.value = s.sitemapUrl;
  }

  if (s.logs && s.logs.length > 0) {
    for (const entry of s.logs) {
      addLogEntry(entry.text, entry.level, entry.time);
    }
  }

  updateMeta(s.runStats, s.dailyQuota);
  loadSitemaps();

  if (s.running) {
    setRunning(true);
    if (s.paused) {
      isPaused = true;
      els.pauseBtn.textContent = "Resume";
      els.pauseBtn.classList.add("resume");
      setStatus("Paused");
    } else {
      setStatus(`Processing ${s.currentIndex + 1} of ${s.total}...`);
    }
  } else if (s.results.length > 0 && s.results.length >= s.total) {
    setStatus(`Complete — ${s.results.length} checked`);
  } else if (s.results.length > 0) {
    setStatus(`Stopped — ${s.results.length}/${s.total} checked`);
  }
});

// ── Start ──
els.startBtn.addEventListener("click", () => {
  let message;

  if (inputSource === "paste") {
    const rawText = els.rawUrlsInput.value.trim();
    if (!rawText) {
      addLogEntry("Please paste some URLs", "error");
      return;
    }
    const urls = extractUrls(rawText);
    if (urls.length === 0) {
      addLogEntry("No valid URLs found in pasted text", "error");
      return;
    }
    const domains = new Set(urls.map((u) => new URL(u).hostname.replace(/^www\./, "")));
    if (domains.size > 1) {
      addLogEntry(`All URLs must be from the same domain (found: ${[...domains].join(", ")})`, "error");
      return;
    }
    message = { type: "START", rawUrls: urls, mode: currentMode };
  } else {
    const sitemapUrl = els.sitemapUrl.value.trim();
    if (!sitemapUrl) {
      addLogEntry("Please enter a sitemap URL", "error");
      return;
    }
    chrome.storage.local.set({ lastSitemapUrl: sitemapUrl });
    message = { type: "START", sitemapUrl, mode: currentMode };
  }

  els.logPanel.innerHTML = "";
  stats = { checked: 0, indexed: 0, requested: 0, errors: 0, remaining: 0 };
  remainingUrls = [];
  updateInfo();
  renderRemaining();
  setRunning(true);
  els.progressBar.classList.remove("done");
  els.progressFill.style.width = "0%";
  setStatus(inputSource === "paste" ? "Preparing URLs..." : "Fetching sitemap...");

  chrome.runtime.sendMessage(message, (response) => {
    if (chrome.runtime.lastError) {
      addLogEntry(`Error: ${chrome.runtime.lastError.message}`, "error");
      setRunning(false);
      setStatus("Error");
      return;
    }
    if (!response.ok) {
      addLogEntry(`Error: ${response.error}`, "error");
      setRunning(false);
      setStatus("Error");
    }
  });
});

// ── Pause / Resume ──
els.pauseBtn.addEventListener("click", () => {
  if (!isPaused) {
    chrome.runtime.sendMessage({ type: "PAUSE" });
    isPaused = true;
    els.pauseBtn.textContent = "Resume";
    els.pauseBtn.classList.add("resume");
    setStatus("Paused");
  } else {
    chrome.runtime.sendMessage({ type: "RESUME" });
    isPaused = false;
    els.pauseBtn.textContent = "Pause";
    els.pauseBtn.classList.remove("resume");
    setStatus("Resuming...");
  }
});

// ── Stop ──
els.stopBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "STOP" });
  setRunning(false);
  setStatus(`Stopped — ${stats.remaining} remaining`);
});

// ── Clear memory ──
els.clearBtn.addEventListener("click", () => {
  let domainUrl;
  if (inputSource === "paste") {
    const urls = extractUrls(els.rawUrlsInput.value.trim());
    if (urls.length === 0) {
      addLogEntry("Paste some URLs first", "error");
      return;
    }
    domainUrl = urls[0];
  } else {
    domainUrl = els.sitemapUrl.value.trim();
    if (!domainUrl) {
      addLogEntry("Enter a sitemap URL first", "error");
      return;
    }
  }
  chrome.runtime.sendMessage({ type: "CLEAR_MEMORY", sitemapUrl: domainUrl }, () => {
    addLogEntry(`Cleared indexed URL memory for ${new URL(domainUrl).hostname}`);
  });
});

// ── Listen for live progress ──
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== "PROGRESS") return;

  switch (msg.status) {
    case "log":
      addLogEntry(msg.entry.text, msg.entry.level, msg.entry.time);
      break;

    case "fetching_sitemap":
      setStatus("Fetching sitemap...");
      break;

    case "ready":
      stats.remaining = msg.toProcess;
      stats.done = msg.alreadyIndexed || 0;
      updateInfo();
      setStatus(`${msg.toProcess} URLs to process`);
      break;

    case "processing":
      currentProcessingIndex = msg.index;
      remainingUrls = remainingUrls.length > 0 ? remainingUrls.slice(1) : [];
      stats.remaining = msg.total - msg.index;
      updateInfo();
      renderRemaining();
      setStatus(`Processing ${msg.index + 1} of ${msg.total}...`, msg.url);
      break;

    case "url_done": {
      const r = msg.result;
      stats.checked++;
      if (r.action === "already_indexed") stats.indexed++;
      else if (r.action === "requested_indexing") stats.requested++;
      else if (r.action === "not_indexed") stats.requested++;
      else if (r.error) stats.errors++;
      stats.remaining = msg.total - msg.index - 1;
      updateInfo();
      break;
    }

    case "meta_update":
      updateMeta(msg.runStats, msg.dailyQuota);
      break;

    case "quota_exceeded":
      setStatus("Quota exceeded — try again tomorrow");
      setRunning(false);
      break;

    case "rate_limited":
      setStatus("429 Rate limited — too many requests");
      setRunning(false);
      break;

    case "complete":
      if (currentMode === "inspect") {
        setStatus(`Complete — ${stats.checked} checked, ${stats.indexed} on Google, ${stats.requested} not on Google`);
      } else {
        setStatus(`Complete — ${stats.checked} checked, ${stats.indexed} on Google, ${stats.requested} requested`);
      }
      stats.remaining = 0;
      remainingUrls = [];
      updateInfo();
      renderRemaining();
      els.progressBar.classList.add("visible", "done");
      els.progressFill.style.width = "100%";
      setRunning(false);
      break;

    case "error":
      setStatus(`Error: ${msg.error}`);
      setRunning(false);
      break;

    case "stopped":
      setStatus(`Stopped — ${stats.remaining} remaining`);
      setRunning(false);
      break;
  }
});
