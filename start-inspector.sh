#!/usr/bin/env bash
set -e

cd "$(dirname "$0")"

npm run build

npx @modelcontextprotocol/inspector \
  node build/src/bin/chrome-devtools-mcp.js \
  --scrape --browserUrl http://127.0.0.1:9222
