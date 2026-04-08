# Chrome Web Store Listing

## Name
GSC URL Indexer

## Short Description (132 chars max)
Bulk check and request indexing for your sitemap URLs via Google Search Console. Tracks quota and remembers indexed URLs.

## Detailed Description

GSC URL Indexer automates the tedious process of checking and requesting indexing for your website URLs through Google Search Console.

HOW IT WORKS
1. Paste your sitemap URL (e.g. https://example.com/sitemap.xml)
2. Click Start
3. The extension opens Google Search Console, inspects each URL, and requests indexing for pages not yet on Google

FEATURES
- Automatic sitemap parsing (supports sitemap index files)
- GSC property auto-detection from sitemap domain
- Real-time progress tracking with badge counter
- Remembers already-indexed URLs — skips them on future runs
- Daily quota monitoring (checks and index requests)
- Sitemap history — see all sitemaps you've processed with dates
- Auto-stop on rate limits (429) and consecutive errors
- Remaining URLs list so you always know what's left
- Logs with timestamps for full transparency

WHY THIS EXISTS
Google Search Console lets you inspect and request indexing one URL at a time. If you have a sitemap with hundreds of pages, doing this manually is not practical. This extension automates the process using the same GSC web interface you already use.

REQUIREMENTS
- You must be logged into Google Search Console
- The GSC property for your domain must already be set up and verified
- Google limits indexing requests to approximately 10 per day per property

PRIVACY
- No data is sent to any third-party server
- All data (indexed URLs, quota counts, history) is stored locally in your browser
- The extension only interacts with Google Search Console pages

PERMISSIONS EXPLAINED
- "storage": Save indexed URLs and settings locally
- "tabs" & "scripting": Open and interact with the Google Search Console tab
- "host_permissions": Fetch your sitemap XML and access GSC pages

## Category
Developer Tools

## Language
English
