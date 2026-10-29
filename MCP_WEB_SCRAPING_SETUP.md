# Chrome DevTools MCP — Web Scraping Setup

## Quick start (recommended)

```bash
node build/src/bin/chrome-devtools-mcp.js --scrape
```

Blocks analytics/trackers, exposes only scraping-relevant tools, and filters network requests to show only document/xhr/fetch by default. Headless mode is not changed: with `--browserUrl` it uses your running Chrome, so you can watch what the AI does.

## Manual start (custom toolset)

```bash
node build/src/bin/chrome-devtools-mcp.js \
  --tool-allowlist "navigate_page,new_page,wait_for,take_snapshot,evaluate_script,click,fill,press_key,list_network_requests,get_network_request" \
  --blocked-url-pattern "*google-analytics*" --blocked-url-pattern "*clarity.ms*" --blocked-url-pattern "*firebase*"
```

## Filter network requests (reduce context waste)

Pass `resourceTypes` to only get meaningful API calls:

```json
{
  "resourceTypes": ["document", "xhr", "fetch"]
}
```

Excludes CSS, fonts, images, JS files.

## Scraping workflow

1. **Navigate** → `navigate_page` (url)
2. **Wait** → `wait_for` (text/content to appear)
3. **Snapshot** → `take_snapshot` (get interactive elements)
4. **Click / Fill** → trigger pagination, filters, load-more
5. **List network** → `list_network_requests` with `resourceTypes: ["xhr", "fetch"]`
6. **Get network** → `get_network_request` (full payload/response)
7. **Evaluate** → `evaluate_script` (extract data from DOM/JS variables)

## Save a tab's network traffic to disk

Start the server with a capture root. Only folders inside it can be written:

```bash
node build/src/bin/chrome-devtools-mcp.js --scrape \
  --browserUrl http://127.0.0.1:9222 \
  --capture-root /path/to/runs
```

Open the tab with a `captureDir` (relative to the root). Capture starts before the URL loads, so the main document and the first XHRs are saved too:

```json
{"url": "https://example.com/p/123", "captureDir": "example_p123/network"}
```

The `new_page` reply contains the absolute folder in `structuredContent.capture.dir`.

- Without `captureDir`, nothing is saved (capture is opt-in per tab).
- The folder must not exist yet or must be empty. Reqids restart at 1 in every tab, so a reused folder would get overwritten files.
- A `captureDir` outside the root (`../x`, `/etc`) is refused.
- Navigations inside the tab (clicks, next page, redirects) stay in the same capture.

Call `stop_capture` before reading the files. It waits for the last bodies to be written and returns `{pageId, dir, saved, bytes, failed}`. Closing the tab also stops its capture.

### Folder layout

```
<captureDir>/
  capture.json              pageId, start url, start/stop time, counts (updated every second while running)
  requests.jsonl            one line per saved request: reqid, method, url, status, resourceType, contentType, bytes
  <reqid>.json              method, url, status, request/response headers, redirect chain, frame
  <reqid>.network-response  raw response body, exactly as received
  <reqid>.network-request   request body (POST), when there is one
```

Reqids are the same as in `list_network_requests` / `get_network_request` / `search_network` for that tab.

Lines in `requests.jsonl` are appended as each body finishes writing, so they are not always in reqid order.

### Duplicates

A request repeated with the same method, URL, request body **and** response body (polling, a call made twice) still gets its own `<reqid>.json` and `requests.jsonl` line, but its body is not written again: `bodyFile` / `requestBodyFile` point at the first copy and `duplicateOf` holds that copy's reqid. If the response changed (e.g. stock went from in to out), it is a separate body. `capture.json` and `stop_capture` report the count as `duplicates`.

### What is saved

A request is written when it **finishes** (a stream or long-poll that never ends is never written, and nothing waits for it) and:

- its resource type is `document`, `xhr` or `fetch`, or
- it is a `script` that is JSONP: the path is not a plain `.js`/`.mjs` file (`batch.json?callback=`), or the query has a `callback`, `jsonp`, `cb` or `jsoncallback` parameter (`reviews.js?callback=cb`).

Not saved: images, stylesheets, fonts, media, JS bundles, websockets, server-sent events, beacons, preflights, `data:`/`blob:` URLs, failed or blocked requests. Bodies over 20 MB are skipped (the `.json` metadata is still written). 4xx/5xx responses are saved. Change the types with `--capture-resource-types "xhr,fetch"`.

With `--scrape`, tracker and marketing hosts are blocked in the browser, so they never load and are never saved. The list is in `src/scrapeTrackers.ts` (Google Analytics / Tag Manager including first-party `gtm*.` / `sgtm*.` proxies, Criteo, VWO, Braze, Cloudflare Insights, Hotjar, Segment, Sentry, Google Ads remarketing such as `www.google.com/rmkt/collect` and `/pagead/`, ...). Most patterns match on the hostname for any path; the Google Ads ones match `google.<tld>` plus the ads path, so Maps and other Google APIs still load. Trackers not on the list are saved; filter them when you read `requests.jsonl`.

### Try it in the MCP Inspector

```bash
npx @modelcontextprotocol/inspector node build/src/bin/chrome-devtools-mcp.js \
  --scrape --experimentalStructuredContent \
  --browserUrl http://127.0.0.1:9222 --capture-root /tmp/mcp-capture
```

Run `new_page` with `captureDir: "test1"`, click around, run `stop_capture`, then look at `/tmp/mcp-capture/test1/`.
