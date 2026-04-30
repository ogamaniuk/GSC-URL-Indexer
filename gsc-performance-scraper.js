// Injected into a GSC Performance tab to scrape page-breakdown URLs across
// all pages of the table, then send them to the background for status update.
(() => {
  if (window.__gscPerfScraperRunning) {
    console.log("[GSC Scraper] already running, skipping re-entry");
    return;
  }
  window.__gscPerfScraperRunning = true;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const send = (payload) =>
    chrome.runtime.sendMessage({ type: "GSC_PERF_PROGRESS", ...payload }).catch(() => {});

  // Verbose log helper — fires both to background (so it lands in the popup
  // Logs tab) and to the GSC tab DevTools console.
  const dlog = (msg, data) => {
    console.log(`[GSC Scraper] ${msg}`, data ?? "");
    send({ event: "debug", message: msg, data: data ?? null });
  };

  function fireMouseSequence(el, label) {
    const opts = { bubbles: true, cancelable: true, view: window, button: 0 };
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    el.dispatchEvent(new MouseEvent("click", opts));
    dlog(`fired mousedown/mouseup/click on ${label}`, {
      tag: el.tagName,
      classes: el.className,
      id: el.id,
    });
  }

  async function waitFor(predicate, { timeoutMs = 30000, intervalMs = 250, label = "condition" } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const v = predicate();
        if (v) return v;
      } catch {}
      await sleep(intervalMs);
    }
    throw new Error(`Timed out waiting for ${label} (${timeoutMs}ms)`);
  }

  // Scope row queries to the table that owns the rows-per-page listbox we're
  // already interacting with. Otherwise [role="row"] picks up rows from every
  // breakdown table rendered on the page (Queries, Pages, Countries, etc.) and
  // ignores the user's URL-path filter, which only applies to the Pages table.
  //
  // Strategy: walk up from the listbox until we find an ancestor that contains
  // both the listbox AND at least one URL-bearing descendant — that ancestor
  // owns the active table. Don't stop early at any specific tag; row count is
  // the only reliable signal.
  function getActiveTableContainer() {
    const listbox = findVisibleListbox();
    if (!listbox) return null;
    const containsUrlBearingRow = (n) => {
      const rows = n.querySelectorAll('[role="row"], [role="rowgroup"] > div, tbody tr');
      for (const r of rows) {
        if (/https?:\/\//.test(r.textContent)) return true;
      }
      return false;
    };
    let node = listbox.parentElement;
    while (node && node !== document.body) {
      if (containsUrlBearingRow(node)) return node;
      node = node.parentElement;
    }
    return null;
  }

  function getRows() {
    const container = getActiveTableContainer() || document;
    const candidates = [
      '[role="row"]',
      '[role="rowgroup"] > div',
      'tbody tr',
    ];
    for (const sel of candidates) {
      const rows = Array.from(container.querySelectorAll(sel));
      const withUrl = rows.filter((r) => /https?:\/\//.test(r.textContent));
      if (withUrl.length > 0) return withUrl;
    }
    return [];
  }

  function extractUrlsFromRows(rows) {
    const urls = [];
    for (const row of rows) {
      const text = row.textContent.trim();
      const match = text.match(/https?:\/\/[^\s]+/);
      if (match) urls.push(match[0]);
    }
    return urls;
  }

  function dumpDomDiagnostics() {
    // Sample of any URL-bearing nodes anywhere on the page so we can see what
    // selector would actually work.
    const allUrlNodes = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, null);
    let n;
    let scanned = 0;
    while ((n = walker.nextNode()) && scanned < 5000) {
      scanned++;
      const txt = n.textContent || "";
      if (/^https?:\/\/\S+$/.test(txt.trim()) && txt.length < 200) {
        allUrlNodes.push({
          tag: n.tagName,
          role: n.getAttribute("role"),
          classes: (n.className || "").toString().slice(0, 80),
          parentTag: n.parentElement && n.parentElement.tagName,
          parentRole: n.parentElement && n.parentElement.getAttribute("role"),
          parentClasses: (n.parentElement && (n.parentElement.className || "").toString().slice(0, 80)),
          text: txt.trim().slice(0, 100),
        });
        if (allUrlNodes.length >= 5) break;
      }
    }
    const roleSummary = {};
    for (const role of ["row", "grid", "rowgroup", "gridcell", "cell", "table"]) {
      roleSummary[role] = document.querySelectorAll(`[role="${role}"]`).length;
    }
    dlog("DOM diagnostics", {
      roleSummary,
      sampleUrlNodes: allUrlNodes,
      tableCount: document.querySelectorAll("table").length,
    });
  }

  function findVisibleListbox() {
    // GSC renders multiple "rows per page" listboxes — one per breakdown
    // table — but only the active tab's listbox is visible. offsetParent is
    // null for elements inside `display:none` ancestors, so use it to filter.
    const all = Array.from(document.querySelectorAll('[aria-label="Number of rows per page"]'));
    const visible = all.filter((el) => el.offsetParent !== null);
    return visible[0] || all[0] || null;
  }

  async function describeListbox() {
    const all = Array.from(document.querySelectorAll('[aria-label="Number of rows per page"]'));
    const visibilityMap = all.map((el, i) => ({
      idx: i,
      visible: el.offsetParent !== null,
      ariaExpanded: el.getAttribute("aria-expanded"),
      selected: (el.querySelector('[role="option"][aria-selected="true"]') || {}).getAttribute
        ? el.querySelector('[role="option"][aria-selected="true"]').getAttribute("data-value")
        : null,
    }));
    dlog("listbox candidates", { count: all.length, candidates: visibilityMap });
    const listbox = findVisibleListbox();
    if (!listbox) {
      const allListboxes = Array.from(document.querySelectorAll('[role="listbox"]')).map(
        (l) => ({ aria: l.getAttribute("aria-label"), text: l.textContent.slice(0, 60) })
      );
      dlog("listbox NOT FOUND. all listboxes on page:", allListboxes);
      return null;
    }
    const opts = Array.from(listbox.querySelectorAll('[role="option"]')).map((o) => ({
      val: o.getAttribute("data-value"),
      sel: o.getAttribute("aria-selected"),
    }));
    const popup = listbox.parentElement && listbox.parentElement.querySelector(".OA0qNb");
    dlog("listbox found", {
      ariaExpanded: listbox.getAttribute("aria-expanded"),
      options: opts,
      popupPresent: !!popup,
      popupDisplay: popup ? popup.style.display : null,
    });
    return listbox;
  }

  async function setPageSizeTo500() {
    const listbox = await describeListbox();
    if (!listbox) throw new Error("Rows-per-page listbox not found");

    const currentSelected = listbox.querySelector('[role="option"][aria-selected="true"]');
    if (currentSelected && currentSelected.getAttribute("data-value") === "500") {
      send({ event: "page_size_already_500" });
      return;
    }

    const trigger =
      listbox.querySelector('[role="option"][aria-selected="true"]') ||
      listbox.querySelector('[jsname="LgbsSe"]') ||
      listbox;
    dlog("opening listbox via trigger", {
      tag: trigger.tagName,
      jsname: trigger.getAttribute && trigger.getAttribute("jsname"),
      role: trigger.getAttribute && trigger.getAttribute("role"),
      dataValue: trigger.getAttribute && trigger.getAttribute("data-value"),
    });
    fireMouseSequence(trigger, "listbox trigger");
    await sleep(400);

    const ariaExpandedAfter = listbox.getAttribute("aria-expanded");
    const popup = listbox.parentElement && listbox.parentElement.querySelector(".OA0qNb");
    dlog("after trigger click", {
      ariaExpanded: ariaExpandedAfter,
      popupDisplay: popup ? popup.style.display : null,
    });

    let option500 =
      (popup && popup.querySelector('[role="option"][data-value="500"]')) ||
      (popup && popup.querySelector('[data-value="500"]')) ||
      listbox.querySelector('[role="option"][data-value="500"]');

    if (!option500) throw new Error("500 option not found in listbox/popup");

    dlog("clicking 500 option", {
      from: option500.closest(".OA0qNb") ? "popup" : "inline",
      classes: option500.className,
    });
    fireMouseSequence(option500, "500 option");

    try {
      await waitFor(
        () => listbox.querySelector('[role="option"][data-value="500"][aria-selected="true"]'),
        { timeoutMs: 5000, label: "page size = 500" }
      );
    } catch (e) {
      dlog("aria-selected didn't flip; trying inline option as fallback");
      const inlineOpt = listbox.querySelector('[role="option"][data-value="500"]');
      if (inlineOpt && inlineOpt !== option500) {
        fireMouseSequence(inlineOpt, "500 option (inline fallback)");
        await waitFor(
          () => listbox.querySelector('[role="option"][data-value="500"][aria-selected="true"]'),
          { timeoutMs: 5000, label: "page size = 500 (after fallback)" }
        );
      } else {
        throw e;
      }
    }

    send({ event: "page_size_set", value: 500 });
    await sleep(1500);
  }

  function getNextButton() {
    const container = getActiveTableContainer() || document;
    return (
      container.querySelector('[data-paginate="next"] button') ||
      container.querySelector('button[aria-label="Next page"]') ||
      // Fall back to the visible Next button anywhere on the page.
      Array.from(document.querySelectorAll('[data-paginate="next"] button, button[aria-label="Next page"]'))
        .find((b) => b.offsetParent !== null) ||
      null
    );
  }

  async function waitForTablePopulated() {
    const start = Date.now();
    let lastDump = 0;
    while (Date.now() - start < 30000) {
      const rows = getRows();
      const urls = extractUrlsFromRows(rows);
      if (urls.length > 0) {
        dlog("table populated", {
          rowCount: rows.length,
          urlCount: urls.length,
          firstUrl: urls[0] || null,
        });
        return;
      }
      // Every 4s of waiting, dump DOM diagnostics so the user can see what's there.
      if (Date.now() - lastDump > 4000) {
        lastDump = Date.now();
        dumpDomDiagnostics();
      }
      await sleep(500);
    }
    dumpDomDiagnostics();
    throw new Error("Timed out waiting for table to populate (30s)");
  }

  async function scrapeAllPages() {
    const collected = new Set();
    let pageNum = 0;

    dlog("scrapeAllPages: start");
    await waitForTablePopulated();
    const container = getActiveTableContainer();
    dlog("active table container", {
      tag: container && container.tagName,
      id: container && container.id,
      classes: container && (container.className || "").toString().slice(0, 100),
      rowsInside: container ? container.querySelectorAll('[role="row"]').length : 0,
    });
    const beforeResizeFirst = (extractUrlsFromRows(getRows())[0]) || "";
    const beforeResizeCount = extractUrlsFromRows(getRows()).length;
    dlog("pre-resize state", { beforeResizeFirst, beforeResizeCount });

    await setPageSizeTo500();

    try {
      await waitFor(() => {
        const urls = extractUrlsFromRows(getRows());
        if (urls.length > beforeResizeCount) return true;
        if (urls[0] && urls[0] !== beforeResizeFirst) return true;
        return false;
      }, { timeoutMs: 8000, label: "table to repopulate after resize" });
      dlog("table repopulated after resize", {
        rowCount: extractUrlsFromRows(getRows()).length,
      });
    } catch {
      dlog("no signal of table reload; falling back to 2s sleep");
      await sleep(2000);
    }

    while (true) {
      pageNum++;
      const rows = getRows();
      const pageUrls = extractUrlsFromRows(rows);
      let added = 0;
      for (const u of pageUrls) {
        if (!collected.has(u)) {
          collected.add(u);
          added++;
        }
      }
      send({
        event: "page_scraped",
        page: pageNum,
        pageCount: pageUrls.length,
        newCount: added,
        total: collected.size,
        sampleUrls: pageUrls.slice(0, 3),
      });

      const nextBtn = getNextButton();
      const nextDisabled = !nextBtn || nextBtn.disabled || nextBtn.getAttribute("disabled") !== null;
      dlog("pagination check", {
        page: pageNum,
        nextBtnFound: !!nextBtn,
        nextDisabled,
      });
      if (nextDisabled) break;

      const beforeFirst = pageUrls[0] || "";
      fireMouseSequence(nextBtn, "Next page button");

      try {
        await waitFor(() => {
          const newRows = getRows();
          const newUrls = extractUrlsFromRows(newRows);
          return newUrls.length > 0 && newUrls[0] !== beforeFirst;
        }, { timeoutMs: 20000, label: `page ${pageNum + 1} to load` });
      } catch (e) {
        send({ event: "pagination_warning", message: e.message });
        await sleep(2000);
      }
    }

    return Array.from(collected);
  }

  (async () => {
    send({ event: "scraper_started", url: location.href });
    try {
      const urls = await scrapeAllPages();
      send({ event: "scraper_complete", urls });
    } catch (e) {
      console.error("[GSC Scraper] FATAL", e);
      send({ event: "scraper_error", message: e.message, stack: e.stack });
    } finally {
      window.__gscPerfScraperRunning = false;
    }
  })();
})();
