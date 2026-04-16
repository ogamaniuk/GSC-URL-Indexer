const $ = (id) => document.getElementById(id);

const els = {
  sitemapUrl: $("sitemapUrl"),
  modeSelect: $("modeSelect"),
  startBtn: $("startBtn"),
  pauseBtn: $("pauseBtn"),
  resumeBtn: $("resumeBtn"),
  clearBtn: $("clearBtn"),
  labelRequested: $("labelRequested"),
  logPanel: $("logPanel"),
  remainingPanel: $("remainingPanel"),
  sitemapsPanel: $("sitemapsPanel"),
  summaryPanel: $("summaryPanel"),
  summaryDomain: $("summaryDomain"),
  summaryTotals: $("summaryTotals"),
  summaryList: $("summaryList"),
  summarySearch: $("summarySearch"),
  exportCsvBtn: $("exportCsvBtn"),
  copySelectedBtn: $("copySelectedBtn"),
  copySelectedCount: $("copySelectedCount"),
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

// Must match INDEX_REQUEST_COOLDOWN_DAYS in background.js — used only for
// classifying rows as "requested (pending)" in the Summary view.
const INDEX_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

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
  refreshSummaryIfOpen();
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
    if (tab.dataset.tab === "summary") loadSummary();
    if (tab.dataset.tab === "sitemaps") loadSitemaps();
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
async function loadSitemaps() {
  const data = await new Promise((r) =>
    chrome.runtime.sendMessage({ type: "GET_SITEMAPS" }, r)
  );
  if (!data) return;
  const panel = els.sitemapsPanel;
  const entries = Object.entries(data.history);

  if (entries.length === 0) {
    panel.innerHTML = '<div style="color:#9e9e9e;padding:20px;text-align:center;">No sitemaps processed yet</div>';
    return;
  }

  entries.sort((a, b) => b[1].lastRun - a[1].lastRun);

  // Fetch breakdown for each domain in parallel.
  const breakdowns = await Promise.all(
    entries.map(([url]) => fetchUrlStatuses(url).then((recs) => classify(recs)))
  );

  let html = "";
  entries.forEach(([url, info], i) => {
    const lastRun = new Date(info.lastRun).toLocaleString();
    const firstRun = new Date(info.firstRun).toLocaleString();
    const b = breakdowns[i];
    const breakdownLine = b.total === 0
      ? `<div class="sitemap-breakdown" style="color:#9e9e9e;">No status data yet</div>`
      : `<div class="sitemap-breakdown">
           <span class="c-green">${b.indexed} indexed</span> &middot;
           <span class="c-red">${b.notIndexed} not indexed</span> &middot;
           <span class="c-blue">${b.requested} requested</span>
         </div>`;
    html += `<div class="sitemap-entry" data-url="${escapeHtml(url)}">
      <div class="sitemap-url">${escapeHtml(url)}</div>
      <div class="sitemap-meta">${info.urlCount} URLs &middot; ${info.runs} runs &middot; last: ${lastRun} &middot; first: ${firstRun}</div>
      ${breakdownLine}
    </div>`;
  });

  if (data.rateLimits && data.rateLimits.length > 0) {
    const last429 = new Date(data.rateLimits[data.rateLimits.length - 1]).toLocaleString();
    html += `<div style="color:#c5221f;font-size:11px;padding:8px 0;border-top:1px solid #e0e0e0;margin-top:6px;">Last 429 rate limit: ${last429}</div>`;
  }

  panel.innerHTML = html;

  panel.querySelectorAll(".sitemap-entry").forEach((el) => {
    el.addEventListener("click", () => {
      els.sitemapUrl.value = el.dataset.url;
      chrome.storage.local.set({ lastSitemapUrl: el.dataset.url });
      refreshSummaryIfOpen();
    });
  });
}

// ── Summary tab ──
const ALL_FILTERS = ["indexed", "not_indexed", "requested", "unknown"];
let summaryState = {
  domainUrl: null,
  inputUrls: [],
  records: {},
  recordsByCanonical: new Map(),
  filters: new Set(ALL_FILTERS),
  search: "",
  inProgressUrl: null,
  selected: new Set(),
  loadId: 0,
};

function indexRecordsByCanonical(records) {
  const map = new Map();
  for (const [u, rec] of Object.entries(records)) {
    map.set(canonicalUrl(u), rec);
  }
  return map;
}

function currentInputSpec() {
  if (inputSource === "paste") {
    const urls = extractUrls(els.rawUrlsInput.value.trim());
    if (urls.length === 0) return null;
    return { rawUrls: urls, domainUrl: urls[0] };
  }
  const sitemapUrl = els.sitemapUrl.value.trim();
  if (!sitemapUrl) return null;
  try { new URL(sitemapUrl); } catch { return null; }
  return { sitemapUrl, domainUrl: sitemapUrl };
}

function fetchUrlStatuses(domainUrl) {
  return new Promise((resolve) => {
    if (!domainUrl) return resolve({});
    try {
      new URL(domainUrl);
    } catch {
      return resolve({});
    }
    chrome.runtime.sendMessage({ type: "GET_URL_STATUSES", domainUrl }, (resp) => {
      resolve((resp && resp.records) || {});
    });
  });
}

function classify(records) {
  const now = Date.now();
  let indexed = 0, notIndexed = 0, requested = 0;
  for (const rec of Object.values(records)) {
    const recentlyRequested = rec.requestedAt && now - rec.requestedAt < INDEX_COOLDOWN_MS;
    if (rec.status === "indexed") indexed++;
    else if (recentlyRequested) requested++;
    else if (rec.status === "not_indexed") notIndexed++;
  }
  return { indexed, notIndexed, requested, total: indexed + notIndexed + requested };
}

function classifyRecord(rec) {
  if (!rec || (!rec.status && !rec.requestedAt)) return "unknown";
  const now = Date.now();
  if (rec.status === "indexed") return "indexed";
  if (rec.requestedAt && now - rec.requestedAt < INDEX_COOLDOWN_MS) return "requested";
  if (rec.status === "not_indexed") return "not_indexed";
  return "unknown";
}

// Normalize a URL so trivial differences (trailing slash, www, hostname case,
// fragment) don't cause missed lookups between stored records and input URLs.
function canonicalUrl(u) {
  try {
    const url = new URL(u);
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    if (url.pathname !== "/" && url.pathname.endsWith("/")) {
      url.pathname = url.pathname.slice(0, -1);
    }
    url.hash = "";
    return url.toString();
  } catch {
    return u;
  }
}

function getRecord(url) {
  const direct = summaryState.records[url];
  if (direct) return direct;
  return summaryState.recordsByCanonical.get(canonicalUrl(url));
}

function timeAgoShort(ts) {
  if (!ts) return "—";
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m`;
  if (hours < 24) return `${hours}h`;
  return `${days}d`;
}

function fullDateTitle(ts) {
  if (!ts) return "";
  return new Date(ts).toLocaleString("en-US", {
    year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

function fetchInputUrls(spec) {
  return new Promise((resolve) => {
    const msg = { type: "GET_INPUT_URLS" };
    if (spec.rawUrls) msg.rawUrls = spec.rawUrls;
    if (spec.sitemapUrl) msg.sitemapUrl = spec.sitemapUrl;
    chrome.runtime.sendMessage(msg, (resp) => {
      if (!resp || !resp.ok) {
        resolve({ urls: [], error: resp && resp.error });
      } else {
        resolve({ urls: resp.urls || [] });
      }
    });
  });
}

async function loadSummary() {
  const spec = currentInputSpec();
  const domainUrl = spec ? spec.domainUrl : null;

  if (domainUrl !== summaryState.domainUrl) {
    summaryState.selected = new Set();
  }
  summaryState.domainUrl = domainUrl;

  if (!spec) {
    summaryState.inputUrls = [];
    summaryState.records = {};
    summaryState.recordsByCanonical = new Map();
    els.summaryDomain.textContent = "—";
    els.summaryTotals.textContent = "Enter a sitemap URL or paste URLs to see status";
    els.summaryList.innerHTML = '<div id="summaryEmpty">No domain selected</div>';
    updateSelectedCount();
    return;
  }

  let hostname;
  try { hostname = new URL(domainUrl).hostname.replace(/^www\./, ""); }
  catch { hostname = domainUrl; }
  els.summaryDomain.textContent = hostname;

  const loadId = ++summaryState.loadId;
  if (spec.sitemapUrl) {
    els.summaryTotals.textContent = "Loading sitemap…";
    els.summaryList.innerHTML = '<div id="summaryEmpty">Loading…</div>';
  }

  const [inputRes, records] = await Promise.all([
    fetchInputUrls(spec),
    fetchUrlStatuses(domainUrl),
  ]);

  if (loadId !== summaryState.loadId) return; // stale — input changed

  if (inputRes.error) {
    const msg = escapeHtml(inputRes.error);
    els.summaryTotals.textContent = "Could not load sitemap";
    els.summaryList.innerHTML = `<div id="summaryEmpty">${msg}</div>`;
    summaryState.inputUrls = [];
    summaryState.records = records;
    summaryState.recordsByCanonical = indexRecordsByCanonical(records);
    updateSelectedCount();
    return;
  }

  summaryState.inputUrls = inputRes.urls;
  summaryState.records = records;
  summaryState.recordsByCanonical = indexRecordsByCanonical(records);
  renderSummary();
}

function computeVisibleRows() {
  const urls = summaryState.inputUrls;
  const search = summaryState.search.toLowerCase();
  const filters = summaryState.filters;
  const ipUrl = summaryState.inProgressUrl;

  const rowMap = new Map(
    urls.map((u) => {
      const rec = getRecord(u) || {};
      return [u, { url: u, rec, cat: classifyRecord(rec) }];
    })
  );
  if (ipUrl && rowMap.has(ipUrl)) {
    rowMap.get(ipUrl).cat = "in_progress";
  }

  return [...rowMap.values()]
    .filter((row) => {
      if (row.cat !== "in_progress" && !filters.has(row.cat)) return false;
      if (search && !row.url.toLowerCase().includes(search)) return false;
      return true;
    })
    .sort((a, b) => {
      if (a.cat === "in_progress") return -1;
      if (b.cat === "in_progress") return 1;
      return (b.rec.checkedAt || 0) - (a.rec.checkedAt || 0);
    });
}

function updateFilterCounts(counts) {
  const set = (k, v) => {
    const el = document.querySelector(`.filter-count[data-count="${k}"]`);
    if (el) el.textContent = v;
  };
  set("all", counts.total);
  set("indexed", counts.indexed);
  set("not_indexed", counts.notIndexed);
  set("requested", counts.requested);
  set("unknown", counts.unknown);
}

function renderSummary() {
  const inputUrls = summaryState.inputUrls;
  const total = inputUrls.length;

  if (total === 0) {
    updateFilterCounts({ total: 0, indexed: 0, notIndexed: 0, requested: 0, unknown: 0 });
    els.summaryTotals.textContent = "No URLs in current input";
    els.summaryList.innerHTML = '<div id="summaryEmpty">Paste URLs or enter a sitemap URL above.</div>';
    updateSelectedCount();
    return;
  }

  let indexed = 0, notIndexed = 0, requested = 0, unknown = 0;
  for (const u of inputUrls) {
    switch (classifyRecord(getRecord(u))) {
      case "indexed": indexed++; break;
      case "requested": requested++; break;
      case "not_indexed": notIndexed++; break;
      default: unknown++;
    }
  }
  updateFilterCounts({ total, indexed, notIndexed, requested, unknown });
  els.summaryTotals.innerHTML =
    `<span class="c-green">${indexed} indexed</span> &middot; ` +
    `<span class="c-red">${notIndexed} not indexed</span> &middot; ` +
    `<span class="c-blue">${requested} requested (pending)</span> &middot; ` +
    `<span class="c-gray">${unknown} unknown</span> &middot; ` +
    `${total} total`;

  const rows = computeVisibleRows();

  if (rows.length === 0) {
    els.summaryList.innerHTML = '<div id="summaryEmpty">No URLs match the current filter</div>';
    updateSelectedCount();
    return;
  }

  const pillLabel = {
    indexed: "Indexed",
    not_indexed: "Not indexed",
    requested: "Requested",
    unknown: "Unknown",
    in_progress: "Checking…",
  };

  let html = `<table class="summary-table">
    <thead><tr>
      <th class="col-check"><input type="checkbox" id="summarySelectAll" title="Select all visible" /></th>
      <th class="col-url">URL</th>
      <th class="col-status">Status</th>
      <th class="col-checked" title="Last time status was observed">Checked</th>
      <th class="col-indexed" title="First time URL was seen as indexed">Indexed</th>
      <th class="col-requested" title="Last time indexing was requested">Requested</th>
    </tr></thead><tbody>`;
  for (const row of rows) {
    const urlSafe = escapeHtml(row.url);
    const rowClass = row.cat === "in_progress" ? " class=\"in-progress\"" : "";
    const checked = summaryState.selected.has(row.url) ? " checked" : "";
    html += `<tr${rowClass}>
      <td class="col-check"><input type="checkbox" class="row-check" data-url="${urlSafe}"${checked} /></td>
      <td class="col-url" title="${urlSafe}"><a href="${urlSafe}" target="_blank">${urlSafe}</a></td>
      <td class="col-status"><span class="status-pill ${row.cat}">${pillLabel[row.cat]}</span></td>
      <td class="col-checked" title="${escapeHtml(fullDateTitle(row.rec.checkedAt))}">${timeAgoShort(row.rec.checkedAt)}</td>
      <td class="col-indexed" title="${escapeHtml(fullDateTitle(row.rec.indexedAt))}">${timeAgoShort(row.rec.indexedAt)}</td>
      <td class="col-requested" title="${escapeHtml(fullDateTitle(row.rec.requestedAt))}">${timeAgoShort(row.rec.requestedAt)}</td>
    </tr>`;
  }
  html += "</tbody></table>";
  els.summaryList.innerHTML = html;

  updateHeaderCheckbox(rows);
  updateSelectedCount();
}

function updateHeaderCheckbox(visibleRows) {
  const header = document.getElementById("summarySelectAll");
  if (!header) return;
  if (visibleRows.length === 0) {
    header.checked = false;
    header.indeterminate = false;
    return;
  }
  let selectedCount = 0;
  for (const r of visibleRows) if (summaryState.selected.has(r.url)) selectedCount++;
  header.checked = selectedCount === visibleRows.length;
  header.indeterminate = selectedCount > 0 && selectedCount < visibleRows.length;
}

// URLs that would be copied/exported right now.
// Default = everything visible (filter + search). If the user has ticked any
// boxes, narrow to the intersection of ticked ∩ visible.
function copyableUrls() {
  const visible = computeVisibleRows().map((r) => r.url);
  if (summaryState.selected.size === 0) return visible;
  return visible.filter((u) => summaryState.selected.has(u));
}

function updateSelectedCount() {
  const n = copyableUrls().length;
  if (els.copySelectedCount) els.copySelectedCount.textContent = n;
  if (els.copySelectedBtn) els.copySelectedBtn.disabled = n === 0;
}

function refreshSummaryIfOpen() {
  if (els.summaryPanel.classList.contains("active")) loadSummary();
}

function rerenderSummaryIfOpen() {
  if (els.summaryPanel.classList.contains("active")) renderSummary();
}

// Light refresh: re-read stored records only, keep inputUrls in place.
// Used during live runs so the row for the finished URL updates without
// flashing "Loading…" or rebuilding the table from scratch.
async function refreshSummaryRecordsIfOpen() {
  if (!els.summaryPanel.classList.contains("active")) return;
  if (!summaryState.domainUrl) return;
  const records = await fetchUrlStatuses(summaryState.domainUrl);
  summaryState.records = records;
  summaryState.recordsByCanonical = indexRecordsByCanonical(records);
  renderSummary();
}

function updateFilterButtonStates() {
  document.querySelectorAll(".summary-filter").forEach((btn) => {
    const f = btn.dataset.filter;
    const active = f === "all"
      ? summaryState.filters.size === ALL_FILTERS.length
      : summaryState.filters.has(f);
    btn.classList.toggle("active", active);
  });
}

// Filter pills — multi-select. "All" toggles every filter on/off; others toggle individually.
document.querySelectorAll(".summary-filter").forEach((btn) => {
  btn.addEventListener("click", () => {
    const f = btn.dataset.filter;
    if (f === "all") {
      summaryState.filters = summaryState.filters.size === ALL_FILTERS.length
        ? new Set()
        : new Set(ALL_FILTERS);
    } else if (summaryState.filters.has(f)) {
      summaryState.filters.delete(f);
    } else {
      summaryState.filters.add(f);
    }
    updateFilterButtonStates();
    renderSummary();
  });
});
// Initialize all pills as active on load.
updateFilterButtonStates();

els.summarySearch.addEventListener("input", (e) => {
  summaryState.search = e.target.value;
  renderSummary();
});

// Row checkbox & select-all delegation
els.summaryList.addEventListener("change", (e) => {
  const t = e.target;
  if (t.classList.contains("row-check")) {
    const url = t.dataset.url;
    if (t.checked) summaryState.selected.add(url);
    else summaryState.selected.delete(url);
    updateHeaderCheckbox(computeVisibleRows());
    updateSelectedCount();
    return;
  }
  if (t.id === "summarySelectAll") {
    const rows = computeVisibleRows();
    if (t.checked) {
      for (const r of rows) summaryState.selected.add(r.url);
    } else {
      for (const r of rows) summaryState.selected.delete(r.url);
    }
    els.summaryList.querySelectorAll(".row-check").forEach((cb) => {
      cb.checked = summaryState.selected.has(cb.dataset.url);
    });
    t.indeterminate = false;
    updateSelectedCount();
  }
});

els.copySelectedBtn.addEventListener("click", () => {
  const urls = copyableUrls();
  if (urls.length === 0) {
    addLogEntry("No URLs to copy", "warning");
    return;
  }
  navigator.clipboard.writeText(urls.join("\n")).then(
    () => addLogEntry(`Copied ${urls.length} URLs to clipboard`, "success"),
    () => addLogEntry("Failed to copy URLs", "error")
  );
});

els.exportCsvBtn.addEventListener("click", () => {
  const visibleRows = computeVisibleRows();
  if (visibleRows.length === 0) {
    addLogEntry("No visible URLs to export", "warning");
    return;
  }
  const rows = [["url", "status", "checkedAt", "indexedAt", "requestedAt"]];
  for (const row of visibleRows) {
    const rec = row.rec || {};
    rows.push([
      row.url,
      rec.status || "",
      rec.checkedAt ? new Date(rec.checkedAt).toISOString() : "",
      rec.indexedAt ? new Date(rec.indexedAt).toISOString() : "",
      rec.requestedAt ? new Date(rec.requestedAt).toISOString() : "",
    ]);
  }
  const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");

  let hostSlug = "urls";
  try { hostSlug = new URL(summaryState.domainUrl).hostname.replace(/^www\./, ""); } catch {}
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const fname = `gsc-status-${hostSlug}-${ts}.csv`;

  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fname;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);

  addLogEntry(`Downloaded ${rows.length - 1} rows as ${fname}`, "success");
});

// Refresh summary when user changes the input (debounced)
let summaryInputTimer = null;
function scheduleSummaryRefresh() {
  clearTimeout(summaryInputTimer);
  summaryInputTimer = setTimeout(() => refreshSummaryIfOpen(), 400);
}
els.sitemapUrl.addEventListener("input", scheduleSummaryRefresh);
els.rawUrlsInput.addEventListener("input", scheduleSummaryRefresh);

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
  els.startBtn.style.display = running ? "none" : "inline-block";
  els.sitemapUrl.disabled = running;
  els.rawUrlsInput.disabled = running;
  els.modeSelect.disabled = running;
  if (!running) {
    isPaused = false;
  }
  updatePauseResumeButtons(running);
}

function updatePauseResumeButtons(running) {
  const showPause = running && !isPaused;
  const showResume = running && isPaused;
  els.pauseBtn.style.display = showPause ? "inline-block" : "none";
  els.resumeBtn.style.display = showResume ? "inline-block" : "none";
}

// ── Restore state on popup open ──
chrome.storage.local.get("lastSitemapUrl", (data) => {
  if (data.lastSitemapUrl) {
    els.sitemapUrl.value = data.lastSitemapUrl;
  }
  // Summary is the default active tab — populate it on popup open.
  loadSummary();
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
    isPaused = !!s.paused;
    setRunning(true);
    if (s.paused) {
      setStatus("Paused");
    } else {
      setStatus(`Processing ${s.currentIndex + 1} of ${s.total}...`);
      if (s.remaining && s.remaining.length > 0) {
        summaryState.inProgressUrl = s.remaining[0];
      }
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
  chrome.runtime.sendMessage({ type: "PAUSE" });
  isPaused = true;
  updatePauseResumeButtons(true);
  setStatus("Paused");
});

els.resumeBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "RESUME" });
  isPaused = false;
  updatePauseResumeButtons(true);
  setStatus("Resuming...");
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
    addLogEntry(`Cleared URL status memory for ${new URL(domainUrl).hostname}`);
    refreshSummaryIfOpen();
    loadSitemaps();
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

    case "ready": {
      stats.remaining = msg.toProcess;
      stats.done = msg.alreadyIndexed || 0;
      updateInfo();
      const sk = msg.skipCounts || {};
      const parts = [];
      if (sk.skippedIndexed) parts.push(`${sk.skippedIndexed} indexed`);
      if (sk.skippedRequested) parts.push(`${sk.skippedRequested} recently requested`);
      if (sk.skippedFresh) parts.push(`${sk.skippedFresh} fresh`);
      const skipLabel = parts.length ? ` · skipped: ${parts.join(", ")}` : "";
      setStatus(`${msg.toProcess} URLs to process${skipLabel}`);
      break;
    }

    case "processing":
      currentProcessingIndex = msg.index;
      remainingUrls = remainingUrls.length > 0 ? remainingUrls.slice(1) : [];
      stats.remaining = msg.total - msg.index;
      updateInfo();
      renderRemaining();
      setStatus(`Processing ${msg.index + 1} of ${msg.total}...`, msg.url);
      summaryState.inProgressUrl = msg.url;
      rerenderSummaryIfOpen();
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
      summaryState.inProgressUrl = null;
      refreshSummaryRecordsIfOpen();
      break;
    }

    case "meta_update":
      updateMeta(msg.runStats, msg.dailyQuota);
      break;

    case "quota_exceeded":
      setStatus("Quota exceeded — try again tomorrow");
      setRunning(false);
      summaryState.inProgressUrl = null;
      rerenderSummaryIfOpen();
      break;

    case "rate_limited":
      setStatus("429 Rate limited — too many requests");
      setRunning(false);
      summaryState.inProgressUrl = null;
      rerenderSummaryIfOpen();
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
      summaryState.inProgressUrl = null;
      rerenderSummaryIfOpen();
      break;

    case "error":
      setStatus(`Error: ${msg.error}`);
      setRunning(false);
      summaryState.inProgressUrl = null;
      rerenderSummaryIfOpen();
      break;

    case "stopped":
      setStatus(`Stopped — ${stats.remaining} remaining`);
      setRunning(false);
      summaryState.inProgressUrl = null;
      rerenderSummaryIfOpen();
      break;
  }
});
