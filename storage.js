// Per-URL status storage, keyed by domain.
// Record shape: {
//   status: "indexed" | "not_indexed",
//   checkedAt: ms,          // last time status was observed
//   requestedAt: ms | null, // last time indexing was requested
//   indexedAt: ms | null    // first time we observed "indexed" (after any non-indexed period)
// }

const Storage = {
  /**
   * Derive a storage key from any URL's hostname.
   * https://hipa.ai/... → "url_status_hipa_ai"
   */
  domainKey(url) {
    const hostname = new URL(url).hostname
      .replace(/^www\./, "")
      .replace(/\./g, "_");
    return `url_status_${hostname}`;
  },

  async getUrlStatuses(url) {
    const key = this.domainKey(url);
    const data = await chrome.storage.local.get(key);
    if (!data[key]) return {};

    // Backfill indexedAt on records saved before the field existed.
    let mutated = false;
    for (const u of Object.keys(data[key])) {
      const rec = data[key][u];
      if (rec.indexedAt === undefined) {
        rec.indexedAt = rec.status === "indexed" ? (rec.checkedAt || 0) : null;
        mutated = true;
      }
    }
    if (mutated) await chrome.storage.local.set({ [key]: data[key] });
    return data[key];
  },

  /**
   * Save or update a status record for one URL. `checkedAt` is stamped to now.
   * `requestedAt` is merged in only if provided; prior value is preserved otherwise.
   * `indexedAt` is stamped on the first transition into "indexed".
   */
  async saveUrlStatus(domainUrl, url, { status, requestedAt } = {}) {
    const key = this.domainKey(domainUrl);
    const data = await chrome.storage.local.get(key);
    const records = data[key] || {};
    this._applyStatus(records, url, { status, requestedAt });
    await chrome.storage.local.set({ [key]: records });
  },

  /**
   * Bulk variant: apply many status updates to a single domain with one
   * get + one set. `updates` is an array of { url, status, requestedAt }.
   * Used by the GSC importer to avoid 1000+ separate storage round-trips.
   */
  async saveUrlStatusesBulk(domainUrl, updates) {
    if (!updates || updates.length === 0) return;
    const key = this.domainKey(domainUrl);
    const data = await chrome.storage.local.get(key);
    const records = data[key] || {};
    for (const u of updates) {
      this._applyStatus(records, u.url, { status: u.status, requestedAt: u.requestedAt });
    }
    await chrome.storage.local.set({ [key]: records });
  },

  _applyStatus(records, url, { status, requestedAt } = {}) {
    const prev = records[url] || {};
    const now = Date.now();
    const nextStatus = status ?? prev.status ?? null;
    let indexedAt = prev.indexedAt ?? null;
    if (nextStatus === "indexed") {
      if (prev.status !== "indexed" || !indexedAt) indexedAt = now;
    }
    records[url] = {
      status: nextStatus,
      checkedAt: now,
      requestedAt: requestedAt !== undefined ? requestedAt : (prev.requestedAt ?? null),
      indexedAt,
    };
  },

  async clearUrlStatuses(url) {
    const key = this.domainKey(url);
    await chrome.storage.local.remove(key);
  },
};

if (typeof globalThis !== "undefined") {
  globalThis.Storage = Storage;
}
