# GSC URL Indexer

Chrome extension that bulk-checks and requests indexing for URLs through Google Search Console.

Instead of inspecting URLs one by one in GSC, provide a sitemap URL or paste URLs directly and let it run.

## What it does

1. Fetches your sitemap XML (handles sitemap index files)
2. Opens Google Search Console for the correct property
3. For each URL: inspects it, checks if it's on Google, requests indexing if not
4. Tracks everything — which URLs are done, daily quota usage, errors

## Install

1. Download or clone this repo
2. Open `chrome://extensions` (or `edge://extensions`)
3. Enable Developer mode
4. Click "Load unpacked" → select this folder

Works in Chrome and Edge.

## Usage

1. Click the extension icon
2. Choose input mode:
   - **Sitemap** — enter a sitemap URL (e.g. `https://hipa.ai/sitemap.xml`)
   - **Paste URLs** — paste URLs directly (one per line, or mixed in text — they'll be extracted automatically. Example: `https://hipa.ai/paid-clinical-trials-ca`)
3. Click Start
4. The extension opens GSC and begins processing

You need to be logged into Google Search Console with access to the property.

## Features

- **Remembers indexed URLs** — skips them on future runs, per domain
- **Daily quota tracking** — shows today's check count and index requests (limit: ~10/day)
- **Auto-stop** — stops on 429 rate limits, quota exceeded, or 3 consecutive errors
- **Paste URLs mode** — paste URLs directly instead of providing a sitemap (single domain only)
- **Inspect mode** — check indexing status without requesting indexing
- **Pause/resume** — pause and resume processing at any time
- **Sitemap history** — tracks all sitemaps you've processed with dates and run counts
- **Progress badge** — shows processed count on the extension icon
- **Remaining URLs tab** — see exactly what's left in the queue

## Limits

Google Search Console enforces daily limits:
- ~10 indexing requests per property per day
- URL inspections are also rate-limited (you'll hit 429 errors if you go too fast)

The extension tracks these and stops automatically when limits are reached.

## How it works

The extension uses a content script injected into the GSC page to interact with the URL inspection tool — the same UI you'd use manually. It types each URL into the inspection bar, reads the status, and clicks "Request indexing" when needed.

This means it's subject to the same GSC UI changes Google makes. If Google changes the Search Console interface, the selectors may need updating.

## Privacy

- No data leaves your browser
- No external servers, no analytics, no accounts
- Everything is stored in `chrome.storage.local`

## License

MIT

## Other
Find a copy of this repo on GitLab here https://gitlab.com/o_gamaniuk/GSC-URL-Indexer
