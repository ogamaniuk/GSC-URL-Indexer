// Service worker: orchestrates URL processing between popup and content script.

importScripts("storage.js");
importScripts("quota-time.js");

let state = {
  running: false,
  paused: false,
  mode: "index", // "index" or "inspect"
  sitemapUrl: null,
  gscProperty: null,
  queue: [],
  currentIndex: 0,
  results: [],
  gscTabId: null,
  logs: [], // persisted log entries for popup to read on open
  alreadyDone: 0,
  inputSource: "sitemap", // "sitemap" or "paste"
};

const REQUEST_DELAY_MS = 5000;
const MAX_LOGS = 500;

// Skip re-requesting indexing for URLs requested within this window
// (indexing can take days; re-requesting wastes the 10/day quota).
const INDEX_REQUEST_COOLDOWN_DAYS = 7;
// Skip re-inspecting URLs whose status was last observed within this window.
const INSPECT_STALE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Save run statistics persistently. Called after each URL processed.
 */
async function updateRunStats(action) {
  const now = Date.now();
  const data = await chrome.storage.local.get("runStats");
  const stats = data.runStats || { totalProcessed: 0, totalIndexed: 0, totalRequested: 0, lastRunAt: null };
  stats.totalProcessed++;
  stats.lastRunAt = now;
  if (action === "already_indexed") stats.totalIndexed++;
  if (action === "requested_indexing") stats.totalRequested++;
  await chrome.storage.local.set({ runStats: stats });
  return stats;
}

/**
 * Track daily quota usage.
 */
async function trackQuotaUsage(type) {
  const periodId = getQuotaPeriodId();
  const data = await chrome.storage.local.get("dailyQuota");
  const quota = data.dailyQuota || { date: periodId, checks: 0, indexRequests: 0 };

  // Reset if new quota period (1 PM Pacific)
  if (quota.date !== periodId) {
    quota.date = periodId;
    quota.checks = 0;
    quota.indexRequests = 0;
  }

  if (type === "check") quota.checks++;
  if (type === "index") quota.indexRequests++;

  await chrome.storage.local.set({ dailyQuota: quota });
}

/**
 * Track sitemap processing history.
 */
async function trackSitemapHistory(sitemapUrl, urlCount) {
  const data = await chrome.storage.local.get("sitemapHistory");
  const history = data.sitemapHistory || {};
  const existing = history[sitemapUrl] || { firstRun: Date.now(), runs: 0, urlCount: 0 };
  existing.lastRun = Date.now();
  existing.runs++;
  existing.urlCount = urlCount;
  history[sitemapUrl] = existing;
  await chrome.storage.local.set({ sitemapHistory: history });
}

/**
 * Track when we hit a 429 rate limit.
 */
async function trackRateLimit() {
  const now = Date.now();
  const data = await chrome.storage.local.get("rateLimits");
  const limits = data.rateLimits || [];
  limits.push(now);
  // Keep last 50
  if (limits.length > 50) limits.splice(0, limits.length - 50);
  await chrome.storage.local.set({ rateLimits: limits });
}

async function getDailyQuota() {
  const periodId = getQuotaPeriodId();
  const data = await chrome.storage.local.get("dailyQuota");
  const quota = data.dailyQuota || { date: periodId, checks: 0, indexRequests: 0 };
  if (quota.date !== periodId) return { date: periodId, checks: 0, indexRequests: 0, nextResetMs: getNextResetMs() };
  quota.nextResetMs = getNextResetMs();
  return quota;
}

/**
 * Add a log entry and broadcast to popup.
 */
function log(text, level = "info") {
  const entry = { text, level, time: Date.now() };
  state.logs.push(entry);
  if (state.logs.length > MAX_LOGS) state.logs.shift();
  console.log(`[GSC Indexer] ${text}`);
  broadcastProgress({ status: "log", entry });
}

/**
 * Update the extension badge with processed count.
 */
function updateBadge() {
  const processed = state.results.length;
  const total = state.queue.length;

  if (!state.running && processed === 0) {
    chrome.action.setBadgeText({ text: "" });
    return;
  }

  chrome.action.setBadgeText({ text: `${processed}` });
  chrome.action.setBadgeTextColor({ color: "#ffffff" });

  // Color: yellow if paused, green if done, blue if running
  const bgColor = state.paused ? "#f9ab00" : state.running ? "#1a73e8" : "#34a853";
  chrome.action.setBadgeBackgroundColor({ color: bgColor });
}

/**
 * Derive GSC property from sitemap URL domain.
 * https://hipa.ai/news/... → "sc-domain:hipa.ai"
 */
function deriveGscProperty(sitemapUrl) {
  const hostname = new URL(sitemapUrl).hostname.replace(/^www\./, "");
  return `sc-domain:${hostname}`;
}

/**
 * Fetch and parse a sitemap XML, returning an array of URLs.
 * Handles sitemap index files recursively.
 */
async function fetchSitemap(sitemapUrl) {
  const response = await fetch(sitemapUrl);
  const xml = await response.text();

  // Check for sitemap index (contains <sitemap><loc>...</loc></sitemap>)
  const sitemapLocs = [...xml.matchAll(/<sitemap>\s*<loc>(.*?)<\/loc>/gs)];
  if (sitemapLocs.length > 0) {
    const allUrls = [];
    for (const match of sitemapLocs) {
      const childUrls = await fetchSitemap(match[1].trim());
      allUrls.push(...childUrls);
    }
    return allUrls;
  }

  // Regular sitemap — extract <url> entries with <loc> and optional <lastmod>
  const urlEntries = [];
  const urlBlocks = [...xml.matchAll(/<url>(.*?)<\/url>/gs)];
  for (const block of urlBlocks) {
    const locMatch = block[1].match(/<loc>(.*?)<\/loc>/s);
    const lastmodMatch = block[1].match(/<lastmod>(.*?)<\/lastmod>/s);
    if (locMatch) {
      urlEntries.push({
        url: locMatch[1].trim(),
        lastmod: lastmodMatch ? lastmodMatch[1].trim() : null,
      });
    }
  }

  // Sort by lastmod (newest first)
  urlEntries.sort((a, b) => (b.lastmod || "0000") > (a.lastmod || "0000") ? 1 : -1);
  return urlEntries.map((e) => e.url);
}

/**
 * Ensure the GSC tab exists and is on the right property page.
 * Returns the tab ID.
 */
async function ensureGscTab(gscProperty) {
  const encodedProperty = encodeURIComponent(gscProperty);
  const gscUrl = `https://search.google.com/search-console?resource_id=${encodedProperty}`;

  if (state.gscTabId) {
    try {
      const tab = await chrome.tabs.get(state.gscTabId);
      if (tab) {
        await chrome.tabs.update(state.gscTabId, { url: gscUrl, active: true });
        await waitForTabReady(state.gscTabId);
        return state.gscTabId;
      }
    } catch {
      // Tab was closed, create new one
    }
  }

  const tab = await chrome.tabs.create({ url: gscUrl, active: true });
  state.gscTabId = tab.id;
  await waitForTabReady(state.gscTabId);
  return state.gscTabId;
}

/**
 * Wait for a tab to finish loading.
 */
function waitForTabReady(tabId) {
  return new Promise((resolve) => {
    const check = () => {
      chrome.tabs.get(tabId, (tab) => {
        if (tab && tab.status === "complete") {
          resolve();
        } else {
          setTimeout(check, 500);
        }
      });
    };
    check();
  });
}

/**
 * Wait for content script to be ready in the tab.
 */
async function waitForContentScript(tabId, timeoutMs = 30000) {
  const start = Date.now();

  // First, try to inject the content script programmatically
  // (manifest-based injection can fail with GSC's redirects)
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
    console.log(`[GSC Indexer] Content script injected into tab ${tabId}`);
  } catch (e) {
    console.warn(`[GSC Indexer] Script injection note: ${e.message}`);
  }

  // Now wait for it to respond
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, { type: "PING" });
      if (response && response.ready) return true;
    } catch {
      // Content script not ready yet
    }
    await sleep(1000);
  }
  throw new Error("Content script not ready");
}

/**
 * Send a URL to the content script for processing (index mode).
 */
async function processUrlInTab(tabId, url) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, { type: "PROCESS_URL", url }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}

/**
 * Send a URL to the content script for inspection only (inspect mode).
 */
async function inspectUrlInTab(tabId, url) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, { type: "INSPECT_URL", url }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}

/**
 * Wait while processing is paused. Returns when unpaused or stopped.
 */
async function waitWhilePaused() {
  while (state.paused && state.running) {
    await sleep(500);
  }
}

/**
 * Broadcast progress to any open popup.
 */
function broadcastProgress(data) {
  chrome.runtime.sendMessage({ type: "PROGRESS", ...data }).catch(() => {
    // Popup may not be open
  });
}

/**
 * Main processing loop.
 */
async function processQueue() {
  state.running = true;
  updateBadge();

  try {
    const gscProperty = state.gscProperty;
    const modeLabel = state.mode === "inspect" ? "Inspecting" : "Indexing";
    log(`${modeLabel}: ${state.queue.length} URLs for ${gscProperty}`);

    const tabId = await ensureGscTab(gscProperty);
    console.log(`[GSC Indexer] GSC tab opened: ${tabId}`);

    // Wait for initial page load + content script
    await sleep(3000);
    await waitForContentScript(tabId);

    for (let i = state.currentIndex; i < state.queue.length; i++) {
      // Wait if paused
      await waitWhilePaused();

      if (!state.running) {
        log("Processing stopped by user", "warning");
        broadcastProgress({ status: "stopped", index: i, total: state.queue.length });
        updateBadge();
        return;
      }

      state.currentIndex = i;
      const url = state.queue[i];
      log(`[${i + 1}/${state.queue.length}] ${url}`);

      broadcastProgress({
        status: "processing",
        index: i,
        total: state.queue.length,
        url,
      });

      // Navigate GSC to property page for each URL (resets the inspection)
      const encodedProperty = encodeURIComponent(gscProperty);
      const gscUrl = `https://search.google.com/search-console?resource_id=${encodedProperty}`;
      await chrome.tabs.update(tabId, { url: gscUrl });
      await waitForTabReady(tabId);
      await sleep(2000);
      await waitForContentScript(tabId);

      let result;
      try {
        if (state.mode === "inspect") {
          result = await inspectUrlInTab(tabId, url);
        } else {
          result = await processUrlInTab(tabId, url);
        }
      } catch (e) {
        log(`Error processing ${url}: ${e.message}`, "error");
        result = { url, is_indexed: null, status: null, action: null, error: e.message };
      }

      state.results.push(result);
      updateBadge();

      // Track quota & run stats
      await trackQuotaUsage("check");
      const runStats = await updateRunStats(result.action);
      const quota = await getDailyQuota();

      // Log result
      if (result.action === "already_indexed") {
        log(`  → already indexed`, "success");
      } else if (result.action === "not_indexed") {
        log(`  → not on Google`, "warning");
      } else if (result.action === "requested_indexing") {
        await trackQuotaUsage("index");
        const updatedQuota = await getDailyQuota();
        log(`  → indexing requested (${updatedQuota.indexRequests}/10 today)`, "success");
      } else if (result.error) {
        log(`  → error: ${result.error}`, "error");
      }

      // Broadcast updated meta to popup
      broadcastProgress({ status: "meta_update", runStats, dailyQuota: quota });

      // Persist status record based on what we observed.
      if (result.action === "already_indexed") {
        await Storage.saveUrlStatus(state.sitemapUrl, url, { status: "indexed" });
      } else if (result.action === "not_indexed") {
        await Storage.saveUrlStatus(state.sitemapUrl, url, { status: "not_indexed" });
      } else if (result.action === "requested_indexing") {
        // Not confirmed indexed yet — just mark that we requested.
        await Storage.saveUrlStatus(state.sitemapUrl, url, {
          status: "not_indexed",
          requestedAt: Date.now(),
        });
      }

      broadcastProgress({
        status: "url_done",
        index: i,
        total: state.queue.length,
        result,
      });

      // Stop on quota exceeded
      if (result.action === "quota_exceeded") {
        log("QUOTA EXCEEDED — Daily limit reached. Try again tomorrow.", "error");
        broadcastProgress({ status: "quota_exceeded", index: i, total: state.queue.length });
        state.running = false;
        updateBadge();
        return;
      }

      // Stop on rate limit (429)
      if (result.action === "rate_limited") {
        await trackRateLimit();
        log("RATE LIMITED (429) — Too many requests. Stopping.", "error");
        broadcastProgress({ status: "rate_limited", index: i, total: state.queue.length });
        state.running = false;
        updateBadge();
        return;
      }

      // Stop after 3 consecutive errors (something is broken)
      const recentResults = state.results.slice(-3);
      if (recentResults.length >= 3 && recentResults.every(r => r.error)) {
        log("3 consecutive errors — stopping to avoid wasting quota.", "error");
        broadcastProgress({ status: "error", error: "3 consecutive errors" });
        state.running = false;
        updateBadge();
        return;
      }

      // Delay between requests
      if (i < state.queue.length - 1) {
        await sleep(REQUEST_DELAY_MS);
      }
    }

    state.running = false;
    updateBadge();
    const sessionIndexed = state.results.filter(r => r.action === "already_indexed").length;
    const sessionErrors = state.results.filter(r => r.error).length;
    if (state.mode === "inspect") {
      const sessionNotIndexed = state.results.filter(r => r.action === "not_indexed").length;
      log(`Done! ${state.results.length} checked, ${sessionIndexed} on Google, ${sessionNotIndexed} not on Google, ${sessionErrors} errors`, "success");
    } else {
      const sessionRequested = state.results.filter(r => r.action === "requested_indexing").length;
      log(`Done! ${state.results.length} processed, ${sessionIndexed} indexed, ${sessionRequested} requested, ${sessionErrors} errors`, "success");
    }

    broadcastProgress({ status: "complete", total: state.queue.length, results: state.results });

  } catch (e) {
    console.error("[GSC Indexer] Fatal error in processQueue:", e);
    log(`Fatal error: ${e.message}`, "error");
    state.running = false;
    updateBadge();
    broadcastProgress({ status: "error", error: e.message });
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Listen for messages from popup
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "START") {
    (async () => {
      try {
        state.mode = msg.mode || "index";
        state.paused = false;
        state.results = [];
        state.currentIndex = 0;
        state.logs = [];

        let allUrls;

        if (msg.rawUrls && msg.rawUrls.length > 0) {
          // Paste mode: URLs provided directly
          allUrls = msg.rawUrls;
          state.sitemapUrl = allUrls[0]; // used as domain key source
          state.gscProperty = deriveGscProperty(allUrls[0]);
          state.inputSource = "paste";
          log(`${allUrls.length} pasted URLs for ${state.gscProperty}`);
        } else {
          // Sitemap mode: fetch and parse
          state.sitemapUrl = msg.sitemapUrl;
          state.gscProperty = deriveGscProperty(msg.sitemapUrl);
          state.inputSource = "sitemap";
          broadcastProgress({ status: "fetching_sitemap" });
          allUrls = await fetchSitemap(msg.sitemapUrl);
          await trackSitemapHistory(msg.sitemapUrl, allUrls.length);
        }

        // Filter based on stored status records.
        const records = await Storage.getUrlStatuses(state.sitemapUrl);
        const now = Date.now();
        const cooldownMs = INDEX_REQUEST_COOLDOWN_DAYS * DAY_MS;
        const staleMs = INSPECT_STALE_DAYS * DAY_MS;
        let skippedIndexed = 0;
        let skippedRequested = 0;
        let skippedFresh = 0;

        state.queue = allUrls.filter((u) => {
          const rec = records[u];
          if (!rec) return true; // never seen → process
          if (state.mode === "index") {
            if (rec.status === "indexed") { skippedIndexed++; return false; }
            if (rec.requestedAt && now - rec.requestedAt < cooldownMs) {
              skippedRequested++; return false;
            }
            return true;
          }
          // inspect mode
          if (rec.checkedAt && now - rec.checkedAt < staleMs) {
            skippedFresh++; return false;
          }
          return true;
        });
        state.alreadyDone = skippedIndexed + skippedRequested + skippedFresh;
        state.skipCounts = { skippedIndexed, skippedRequested, skippedFresh };

        const skipParts = [];
        if (skippedIndexed) skipParts.push(`${skippedIndexed} known indexed`);
        if (skippedRequested) skipParts.push(`${skippedRequested} recently requested`);
        if (skippedFresh) skipParts.push(`${skippedFresh} fresh`);
        const skipSummary = skipParts.length ? ` (skipped: ${skipParts.join(", ")})` : "";
        log(`${allUrls.length} URLs total, ${state.queue.length} to process${skipSummary}`);

        // Update last run timestamp immediately
        const data = await chrome.storage.local.get("runStats");
        const rs = data.runStats || { totalProcessed: 0, totalIndexed: 0, totalRequested: 0, lastRunAt: null };
        rs.lastRunAt = Date.now();
        await chrome.storage.local.set({ runStats: rs });

        broadcastProgress({
          status: "ready",
          alreadyIndexed: state.alreadyDone,
          toProcess: state.queue.length,
          skipCounts: state.skipCounts,
        });

        updateBadge();

        // Start processing
        processQueue();
        sendResponse({ ok: true, toProcess: state.queue.length });
      } catch (e) {
        log(`Failed to start: ${e.message}`, "error");
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  if (msg.type === "STOP") {
    state.running = false;
    state.paused = false;
    log("Stop requested by user", "warning");
    updateBadge();
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === "PAUSE") {
    state.paused = true;
    log("Paused by user", "warning");
    updateBadge();
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === "RESUME") {
    state.paused = false;
    log("Resumed by user", "info");
    updateBadge();
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === "GET_STATE") {
    (async () => {
      const remaining = state.running
        ? state.queue.slice(state.currentIndex)
        : state.queue.slice(state.results.length);
      const runStatsData = await chrome.storage.local.get("runStats");
      const quota = await getDailyQuota();
      sendResponse({
        running: state.running,
        paused: state.paused,
        mode: state.mode,
        sitemapUrl: state.sitemapUrl,
        gscProperty: state.gscProperty,
        currentIndex: state.currentIndex,
        total: state.queue.length,
        results: state.results,
        remaining,
        logs: state.logs,
        alreadyDone: state.alreadyDone,
        inputSource: state.inputSource,
        runStats: runStatsData.runStats || null,
        dailyQuota: quota,
      });
    })();
    return true;
  }

  if (msg.type === "GET_SITEMAPS") {
    (async () => {
      const data = await chrome.storage.local.get(["sitemapHistory", "rateLimits"]);
      sendResponse({
        history: data.sitemapHistory || {},
        rateLimits: data.rateLimits || [],
      });
    })();
    return true;
  }

  if (msg.type === "CLEAR_MEMORY") {
    Storage.clearUrlStatuses(msg.sitemapUrl).then(() => {
      log(`Cleared URL status memory for ${new URL(msg.sitemapUrl).hostname}`);
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.type === "GET_URL_STATUSES") {
    (async () => {
      try {
        const records = await Storage.getUrlStatuses(msg.domainUrl);
        sendResponse({ ok: true, records });
      } catch (e) {
        sendResponse({ ok: false, error: e.message, records: {} });
      }
    })();
    return true;
  }
});
