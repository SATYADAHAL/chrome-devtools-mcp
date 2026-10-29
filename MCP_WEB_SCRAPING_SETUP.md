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

Call `stop_capture` before reading the files. It waits for the last bodies to be written and returns the counts (see below). Closing the tab also stops its capture.

The tab's HTTP cache is off while it is captured, because a response served from the cache can come without a body. Pass `keepCache: true` to `new_page` to keep it on; cached responses are marked `fromCache: true`.

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

### What is saved, and how requests are labelled

Every request of the tab that **finishes or fails** gets a `requests.jsonl` line and a `<reqid>.json`. Nothing is dropped silently: each line says whether it is data, and if not, why.

| Key            | Meaning                                                                                                                                                                                                                                                                                 |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `data`         | `true` for a request that can carry page data                                                                                                                                                                                                                                           |
| `drop`         | why it is not data (absent when `data` is true), see below                                                                                                                                                                                                                              |
| `format`       | what the body really is, from the body itself: `json`, `jsonp`, `html`, `xml`, `js`, `text`, `binary`, `empty`. JSON sent as `text/plain`, an XSSI prefix such as `)]}'` before JSON, and `callback({...})` JSONP are all recognised; `<reqid>.json` also has `callback` / `xssiPrefix` |
| `antibot`      | the anti-bot vendor this response points at (detection only), see below                                                                                                                                                                                                                 |
| `fromCache`    | `true` when the response came from the HTTP cache                                                                                                                                                                                                                                       |
| `evidenceFile` | body of a request that is **not** data but was kept anyway: an `ignored_host` or `beacon` response up to 16 KB. Kept so a wrong filter rule loses nothing for good; data readers should use `bodyFile` only                                                                             |

Response bodies (`<reqid>.network-response`) are written for data (`bodyFile`), for HTML / JSON error pages up to 200 KB (`bodyFile` too, as a 403 challenge page is evidence of a block), and for `ignored_host` / `beacon` responses up to 16 KB (`evidenceFile`). Other bodies are not written. Request bodies are written as before.

| `drop`         | When                                                                                                                                                                                                       |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `static`       | image, stylesheet, font, media or other non-data resource type; a `.js` bundle without a JSONP callback parameter (`callback`, `jsonp`, `cb`, `jsoncallback`); an image / media / font fetched by a script |
| `tracker`      | a `block` host of the filter, or a URL Chrome refused (`--blocked-url-pattern`, `--scrape`)                                                                                                                |
| `ignored_host` | an `ignore` host of the filter: it loaded, but is not data                                                                                                                                                 |
| `http_error`   | status 4xx / 5xx                                                                                                                                                                                           |
| `failed`       | no response at all (connection error, aborted)                                                                                                                                                             |
| `empty`        | 204, a redirect, or an empty body                                                                                                                                                                          |
| `preflight`    | an `OPTIONS` / CORS preflight                                                                                                                                                                              |
| `beacon`       | a `ping` / sendBeacon, or a URL matching `ignore_paths` whose body is not JSON or is JSON under 4 KB (`/log` or `/metrics` returning real JSON stays data)                                                 |
| `too_large`    | a body over 20 MB                                                                                                                                                                                          |

Script requests count as data only for JSONP: a path that is not a plain `.js`/`.mjs` file (`batch.json?callback=`), or a `.js` URL with a callback parameter (`reviews.js?callback=cb`). Change the data resource types with `--capture-resource-types "xhr,fetch"`. `data:` / `blob:` URLs are not recorded.

### The capture filter

Which hosts are data is decided by a JSON file, `--capture-filter <file.json>`. The default is `src/capture-filter.default.json` (copied to `build/src/`):

```json
{
  "version": 2,
  "block": [
    "google-analytics.com",
    "facebook.com/tr",
    "google.*/pagead",
    "..."
  ],
  "block_subdomains": ["gtm", "sgtm"],
  "ignore": [
    "gstatic.com",
    "google.*/recaptcha",
    "/cdn-cgi/",
    "onetrust.com",
    "paypal.com",
    "..."
  ],
  "allow": [
    "bazaarvoice.com",
    "yotpo.com",
    "algolia.net",
    "/products/",
    "/search",
    "..."
  ],
  "ignore_paths": ["/collect", "/pixel", "/beacon", "/track", "/log", "..."]
}
```

- `block`: ads and analytics that never carry page data. In `--scrape` mode Chrome refuses them, so they never load (`drop: "tracker"`, counted as `blocked`).
- `block_subdomains`: first-party proxies by their first host label on any site: `gtm` blocks `gtm.shop.com` and `gtm2.shop.com.au`, not `gtmetrix.com`.
- `ignore`: widgets the page needs (recaptcha, consent banners, payments / BNPL, monitoring, feature flags, A/B testing, anti-fraud, Cloudflare challenges). They load, the page keeps working, they are labelled `ignored_host`, and only bodies up to 16 KB are kept, as `evidenceFile`.
- `allow`: review, search and product-data vendors. Always data for a data resource type; beats `block`, `ignore` and `ignore_paths`. A `block` entry that overlaps an `allow` domain is not sent to Chrome.
- `ignore_paths`: path pieces of beacons, matched as whole path segments (`/log` matches `/log` and `/api/log/x`, not `/login` or `/blog`).

Entry syntax: `segment.com` matches the domain and its subdomains (`cdn.segment.com`), never a longer name (`mysegmentshop.com.au`); `facebook.com/tr` also needs that path prefix; `google.*` is the domain under any public suffix (`google.com.au`); `/cdn-cgi/` is a path prefix on any host. Firebase Realtime Database and Firestore are deliberately not listed: they can be the page's data.

`capture.json` records `filter_version` and `filter_source`, so a run can be traced back to the rules that labelled it.

### Anti-bot hints

A line gets `antibot: "<vendor>"` (`cloudflare`, `datadome`, `perimeterx`, `kasada`, `imperva`, `akamai`, `aws_waf`, `queue-it`) from vendor headers (`cf-mitigated`, `x-datadome`, `x-kpsdk-*`, `x-iinfo`, `x-amzn-waf-action`), cookies (`datadome`, `_px*`, `incap_ses_*`, `aws-waf-token`), vendor script or challenge URLs, `server: AkamaiGHost` on a 403 / 429 / 503, or challenge text in a 403 / 429 / 503 body. Such an HTML error page with no known vendor is `unknown`. Detection only: nothing tries to get around it.

### Counts

`capture.json` (updated every second while running) and `stop_capture` report:

| Count            | Meaning                                                       |
| ---------------- | ------------------------------------------------------------- |
| `saved`          | lines in `requests.jsonl`, data or not                        |
| `data`           | lines with `data: true`                                       |
| `dropped`        | lines per `drop` reason, e.g. `{"static": 40, "tracker": 12}` |
| `blocked`        | requests Chrome refused                                       |
| `duplicates`     | requests sharing an earlier copy's body                       |
| `antibot`        | lines per anti-bot vendor                                     |
| `bytes`          | response body bytes written                                   |
| `failed`         | requests whose files could not be written                     |
| `filter_version` | the capture filter's version                                  |

### Try it in the MCP Inspector

```bash
npx @modelcontextprotocol/inspector node build/src/bin/chrome-devtools-mcp.js \
  --scrape --experimentalStructuredContent \
  --browserUrl http://127.0.0.1:9222 --capture-root /tmp/mcp-capture
```

Run `new_page` with `captureDir: "test1"`, click around, run `stop_capture`, then look at `/tmp/mcp-capture/test1/`.
