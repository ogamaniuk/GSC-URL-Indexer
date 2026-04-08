// Storage helper for tracking indexed URLs per domain

const Storage = {
  /**
   * Derive a storage key from a sitemap URL domain.
   * https://hipa.ai/news/... → "indexed_urls_hipa_ai"
   */
  domainKey(sitemapUrl) {
    const hostname = new URL(sitemapUrl).hostname
      .replace(/^www\./, "")
      .replace(/\./g, "_");
    return `indexed_urls_${hostname}`;
  },

  /**
   * Get the set of already-indexed URLs for a domain.
   */
  async getIndexedUrls(sitemapUrl) {
    const key = this.domainKey(sitemapUrl);
    const data = await chrome.storage.local.get(key);
    return new Set(data[key] || []);
  },

  /**
   * Save a single URL as indexed.
   */
  async saveIndexedUrl(sitemapUrl, url) {
    const key = this.domainKey(sitemapUrl);
    const data = await chrome.storage.local.get(key);
    const urls = data[key] || [];
    if (!urls.includes(url)) {
      urls.push(url);
      await chrome.storage.local.set({ [key]: urls });
    }
  },

  /**
   * Clear all indexed URLs for a domain.
   */
  async clearIndexedUrls(sitemapUrl) {
    const key = this.domainKey(sitemapUrl);
    await chrome.storage.local.remove(key);
  },
};

// Make available in both content script and module contexts
if (typeof globalThis !== "undefined") {
  globalThis.Storage = Storage;
}
