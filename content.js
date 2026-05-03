// Content script injected into Google Search Console pages.
// Handles all DOM interaction: URL inspection input, status detection, indexing requests.

const GSC = {
  // Status text patterns (lowercase)
  STATUS_INDEXED: "url is on google",
  STATUS_NOT_INDEXED: "url is not on google",
  INDEXING_COMPLETE: "indexing requested",

  // XPath for the URL inspection input
  URL_INPUT_XPATH:
    '//*[@id="gb"]/div[2]/div[2]/div[2]/form/div/div/div/div/div/div[1]/input[2]',

  /**
   * Wait for a condition to be true, polling at an interval.
   */
  waitFor(checkFn, timeoutMs = 60000, intervalMs = 500) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const timer = setInterval(() => {
        const result = checkFn();
        if (result) {
          clearInterval(timer);
          resolve(result);
        } else if (Date.now() - start > timeoutMs) {
          clearInterval(timer);
          reject(new Error("Timeout"));
        }
      }, intervalMs);
    });
  },

  /**
   * Find an element by XPath.
   */
  xpath(expression) {
    return document.evaluate(
      expression,
      document,
      null,
      XPathResult.FIRST_ORDERED_NODE_TYPE,
      null
    ).singleNodeValue;
  },

  /**
   * Find all elements containing specific text.
   */
  findByText(text) {
    const xpath = `//*[contains(text(), '${text}')]`;
    const result = document.evaluate(
      xpath,
      document,
      null,
      XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
      null
    );
    const nodes = [];
    for (let i = 0; i < result.snapshotLength; i++) {
      nodes.push(result.snapshotItem(i));
    }
    return nodes;
  },

  /**
   * Type a URL into the inspection input and submit.
   * Uses execCommand/InputEvent to simulate real keyboard input —
   * setting input.value directly doesn't work (GSC ignores it).
   */
  async submitUrl(url) {
    // Find the input field
    const input = this.xpath(this.URL_INPUT_XPATH);
    if (!input) {
      throw new Error("Could not find URL inspection input field");
    }

    // Click and focus
    input.click();
    await this.sleep(100);
    input.focus();
    await this.sleep(50);

    // Select all existing text and replace with URL
    // This simulates real user input that GSC's listeners recognize
    input.select();
    await this.sleep(50);

    // Use insertText which fires proper input events (like real typing)
    if (!document.execCommand("insertText", false, url)) {
      // Fallback: use InputEvent directly
      input.value = url;
      input.dispatchEvent(new InputEvent("input", {
        bubbles: true, inputType: "insertText", data: url
      }));
    }
    await this.sleep(150);

    // Submit with Enter key
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true })
    );
    input.dispatchEvent(
      new KeyboardEvent("keypress", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true })
    );
    input.dispatchEvent(
      new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true })
    );
    await this.sleep(50);

    // Also try clicking the search button
    const searchBtn = document.querySelector('button[aria-label="Search"]');
    if (searchBtn) {
      searchBtn.click();
    }
  },

  /**
   * Wait for indexing status to appear on page.
   * Returns "indexed", "not_indexed", or null on timeout.
   */
  async waitForStatus(timeoutMs = 60000) {
    try {
      const status = await this.waitFor(() => {
        const text = document.body.innerText.toLowerCase();
        if (text.includes(this.STATUS_INDEXED) && !text.includes(this.STATUS_NOT_INDEXED)) {
          return "indexed";
        }
        if (text.includes(this.STATUS_NOT_INDEXED)) {
          return "not_indexed";
        }
        return false;
      }, timeoutMs, 500);
      return status;
    } catch {
      return null;
    }
  },

  /**
   * Click the "Request indexing" button.
   */
  async clickRequestIndexing(timeoutMs = 30000) {
    try {
      await this.waitFor(() => {
        const buttons = this.findByText("Request indexing");
        for (const btn of buttons) {
          if (btn.offsetParent !== null) {
            btn.click();
            return true;
          }
        }
        return false;
      }, timeoutMs, 1000);
      return true;
    } catch {
      return false;
    }
  },

  /**
   * Wait for indexing request to complete.
   * Returns "success", "quota_exceeded", or "timeout".
   */
  async waitForIndexingComplete(timeoutMs = 180000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const text = document.body.innerText.toLowerCase();

      if (text.includes("quota exceeded")) {
        return "quota_exceeded";
      }

      if (text.includes(this.INDEXING_COMPLETE)) {
        // Try to close modal
        await this.sleep(300);
        const okButtons = [
          ...this.findByText("OK"),
          ...this.findByText("Got it"),
        ];
        for (const btn of okButtons) {
          try {
            btn.click();
            break;
          } catch {}
        }
        return "success";
      }

      await this.sleep(500);
    }
    return "timeout";
  },

  /**
   * Inspect a single URL: check status only, never request indexing.
   */
  async inspectUrl(url) {
    const result = { url, is_indexed: null, status: null, action: null, error: null };

    try {
      const bodyText = document.body.innerText;
      if (bodyText.includes("429") && bodyText.includes("too many requests")) {
        result.action = "rate_limited";
        result.error = "429 Too Many Requests — rate limited by Google";
        return result;
      }

      await this.submitUrl(url);
      await this.sleep(1000);

      const status = await this.waitForStatus(60000);

      if (!status) {
        result.error = "Could not determine indexing status";
        return result;
      }

      result.status = status;

      if (status === "indexed") {
        result.is_indexed = true;
        result.action = "already_indexed";
      } else {
        result.is_indexed = false;
        result.action = "not_indexed";
      }
    } catch (e) {
      result.error = e.message;
    }

    return result;
  },

  /**
   * Process a single URL: inspect, check status, request indexing if needed.
   */
  async processUrl(url) {
    const result = { url, is_indexed: null, status: null, action: null, error: null };

    try {
      // Check for 429 rate limit page
      const bodyText = document.body.innerText;
      if (bodyText.includes("429") && bodyText.includes("too many requests")) {
        result.action = "rate_limited";
        result.error = "429 Too Many Requests — rate limited by Google";
        return result;
      }

      // Type URL and submit
      await this.submitUrl(url);
      await this.sleep(1000);

      // Wait for status
      const status = await this.waitForStatus(60000);

      if (!status) {
        result.error = "Could not determine indexing status";
        return result;
      }

      result.status = status;

      if (status === "indexed") {
        result.is_indexed = true;
        result.action = "already_indexed";
      } else if (status === "not_indexed") {
        result.is_indexed = false;

        const clicked = await this.clickRequestIndexing();
        if (!clicked) {
          result.action = "button_not_found";
          result.error = "Could not find Request Indexing button";
          return result;
        }

        const indexResult = await this.waitForIndexingComplete(180000);

        if (indexResult === "success") {
          result.action = "requested_indexing";
        } else if (indexResult === "quota_exceeded") {
          result.action = "quota_exceeded";
          result.error = "Daily quota exceeded";
        } else {
          result.action = "request_timeout";
          result.error = "Indexing request timed out";
        }
      }
    } catch (e) {
      result.error = e.message;
    }

    return result;
  },

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  },
};

// Listen for messages from background script
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "INSPECT_URL") {
    GSC.inspectUrl(msg.url).then(sendResponse);
    return true;
  }

  if (msg.type === "PROCESS_URL") {
    GSC.processUrl(msg.url).then(sendResponse);
    return true; // keep channel open for async response
  }

  if (msg.type === "PING") {
    sendResponse({ ready: true });
    return false;
  }
});
