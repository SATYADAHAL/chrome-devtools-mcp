# Chrome DevTools MCP — Web Scraping Setup

## Quick start (recommended)

```bash
node build/src/bin/chrome-devtools-mcp.js --scrape
```

Blocks analytics/trackers, exposes only scraping-relevant tools, and filters network requests to show only document/xhr/fetch by default. Browser stays visible so you can watch what the AI does.

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
