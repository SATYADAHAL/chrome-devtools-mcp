/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import fs from 'node:fs/promises';
import type {IncomingMessage, ServerResponse} from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {describe, it} from 'node:test';

import type {McpContext} from '../src/McpContext.js';
import type {McpResponse} from '../src/McpResponse.js';
import {stopCapture} from '../src/tools/network.js';
import {newPage} from '../src/tools/pages.js';

import {serverHooks} from './server.js';
import {html, withMcpContext} from './utils.js';

interface CapturedRow {
  reqid: number;
  url: string;
  bodyFile?: string;
  duplicateOf?: number;
}

async function readLines(dir: string): Promise<CapturedRow[]> {
  const text = await fs
    .readFile(path.join(dir, 'requests.jsonl'), 'utf8')
    .catch(() => '');
  return text
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

async function openCaptured(
  response: McpResponse,
  context: McpContext,
  url: string,
  captureDir: string,
  waitUntil: 'load' | 'networkidle0' = 'networkidle0',
) {
  const params = {url, captureDir, waitUntil};
  await newPage().handler({params}, response, context);
  return context.getSelectedMcpPage();
}

async function withCaptureRoot(
  cb: (
    root: string,
    response: McpResponse,
    context: McpContext,
  ) => Promise<void>,
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'capture-'));
  try {
    await withMcpContext((response, context) => cb(root, response, context), {
      captureRoot: root,
    });
  } finally {
    await fs.rm(root, {recursive: true, force: true});
  }
}

describe('NetworkCapture', () => {
  const server = serverHooks();

  it('saves the requests of a tab opened with captureDir', async () => {
    server.addRoute('/api', (req, res) => {
      let body = '';
      req.on('data', chunk => {
        body += chunk;
      });
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({items: [1, 2], echo: body}));
      });
    });
    server.addHtmlRoute(
      '/page',
      html`<main>page</main>
        <script>
          fetch('/api', {method: 'POST', body: 'q=shoes'});
        </script>`,
    );

    await withCaptureRoot(async (root, response, context) => {
      const page = await openCaptured(
        response,
        context,
        server.getRoute('/page'),
        'card/network',
      );
      const dir = path.join(root, 'card/network');
      assert.ok(
        response.responseLines.includes(
          `Capturing network traffic of page ${page.id} to ${dir}`,
        ),
      );

      await stopCapture.handler({params: {}, page}, response, context);
      const rows = await readLines(dir);
      assert.ok(
        rows.some(row => row.url.endsWith('/page')),
        'document saved',
      );
      const api = rows.find(row => row.url.endsWith('/api'));
      assert.ok(api, 'fetch request saved');

      const meta = JSON.parse(
        await fs.readFile(path.join(dir, 'capture.json'), 'utf8'),
      );
      assert.strictEqual(meta.pageId, page.id);
      assert.strictEqual(meta.saved, rows.length);
      assert.ok(meta.stoppedAt);

      const files = await fs.readdir(dir);
      const reqid = files
        .find(file => file.endsWith('.network-request'))
        ?.split('.')[0];
      assert.ok(reqid, 'POST body saved');
      assert.strictEqual(
        await fs.readFile(path.join(dir, `${reqid}.network-request`), 'utf8'),
        'q=shoes',
      );
      assert.deepStrictEqual(
        JSON.parse(
          await fs.readFile(
            path.join(dir, `${reqid}.network-response`),
            'utf8',
          ),
        ),
        {items: [1, 2], echo: 'q=shoes'},
      );
    });
  });

  it('stores repeated identical responses once', async () => {
    let calls = 0;
    server.addRoute('/stock', (_req, res) => {
      calls++;
      res.setHeader('Content-Type', 'application/json');
      // The third call answers differently and must get its own body.
      res.end(JSON.stringify({inStock: calls < 3}));
    });
    server.addHtmlRoute(
      '/repeat',
      html`<script>
        (async () => {
          for (let i = 0; i < 3; i++) {
            await (await fetch('/stock')).text();
          }
        })();
      </script>`,
    );

    await withCaptureRoot(async (root, response, context) => {
      const page = await openCaptured(
        response,
        context,
        server.getRoute('/repeat'),
        'repeat',
      );
      await stopCapture.handler({params: {}, page}, response, context);
      const dir = path.join(root, 'repeat');
      // Lines are appended as writes finish, not in reqid order.
      const rows = (await readLines(dir))
        .filter(row => row.url.endsWith('/stock'))
        .sort((a, b) => a.reqid - b.reqid);
      assert.strictEqual(rows.length, 3);
      const [first, second, third] = rows;
      assert.strictEqual(second.duplicateOf, first.reqid);
      assert.strictEqual(second.bodyFile, first.bodyFile);
      assert.strictEqual(third.duplicateOf, undefined);
      assert.notStrictEqual(third.bodyFile, first.bodyFile);
      const meta = JSON.parse(
        await fs.readFile(path.join(dir, 'capture.json'), 'utf8'),
      );
      assert.strictEqual(meta.duplicates, 1);
    });
  });

  it('updates capture.json while the capture runs', async () => {
    server.addHtmlRoute('/live', html`<main>live</main>`);
    await withCaptureRoot(async (root, response, context) => {
      await openCaptured(response, context, server.getRoute('/live'), 'live');
      const file = path.join(root, 'live', 'capture.json');
      let meta = {saved: 0, stoppedAt: undefined};
      for (let i = 0; i < 30 && !meta.saved; i++) {
        await new Promise(resolve => setTimeout(resolve, 100));
        meta = JSON.parse(await fs.readFile(file, 'utf8'));
      }
      assert.strictEqual(meta.saved, 1);
      assert.strictEqual(meta.stoppedAt, undefined);
    });
  });

  it('saves nothing for a tab opened without captureDir', async () => {
    server.addHtmlRoute('/plain', html`<main>plain</main>`);
    await withCaptureRoot(async (root, response, context) => {
      await newPage().handler(
        {params: {url: server.getRoute('/plain')}},
        response,
        context,
      );
      assert.deepStrictEqual(await fs.readdir(root), []);
    });
  });

  it('keeps two tabs in separate folders', async () => {
    server.addHtmlRoute('/one', html`<main>one</main>`);
    server.addHtmlRoute('/two', html`<main>two</main>`);
    await withCaptureRoot(async (root, response, context) => {
      const one = await openCaptured(
        response,
        context,
        server.getRoute('/one'),
        'one',
      );
      const two = await openCaptured(
        response,
        context,
        server.getRoute('/two'),
        'two',
      );
      await stopCapture.handler({params: {}, page: one}, response, context);
      await stopCapture.handler({params: {}, page: two}, response, context);
      const urlsOne = (await readLines(path.join(root, 'one'))).map(
        row => row.url,
      );
      const urlsTwo = (await readLines(path.join(root, 'two'))).map(
        row => row.url,
      );
      assert.deepStrictEqual(urlsOne, [server.getRoute('/one')]);
      assert.deepStrictEqual(urlsTwo, [server.getRoute('/two')]);
    });
  });

  it('refuses folders outside the root and non-empty folders', async () => {
    server.addHtmlRoute('/refuse', html`<main>refuse</main>`);
    await withCaptureRoot(async (root, response, context) => {
      const url = server.getRoute('/refuse');
      await assert.rejects(
        openCaptured(response, context, url, '../escape'),
        /inside the capture root/,
      );
      await fs.mkdir(path.join(root, 'used'));
      await fs.writeFile(path.join(root, 'used', '1.json'), '{}');
      await assert.rejects(
        openCaptured(response, context, url, 'used'),
        /not empty/,
      );
    });
  });

  it('saves JSONP scripts but not static bundles', async () => {
    const script = (body: string) => {
      return (_req: IncomingMessage, res: ServerResponse) => {
        res.setHeader('Content-Type', 'application/javascript');
        res.end(body);
      };
    };
    server.addRoute('/reviews.js?callback=cb', script('cb({"reviews": 2});'));
    server.addRoute('/batch.json?callback=cb', script('cb({"batch": 1});'));
    server.addRoute('/bundle.js', script('function cb() {}'));
    server.addHtmlRoute(
      '/jsonp',
      html`<script src="/bundle.js"></script>
        <script src="/reviews.js?callback=cb"></script>
        <script src="/batch.json?callback=cb"></script>`,
    );

    await withCaptureRoot(async (root, response, context) => {
      const page = await openCaptured(
        response,
        context,
        server.getRoute('/jsonp'),
        'jsonp',
      );
      await stopCapture.handler({params: {}, page}, response, context);
      const paths = (await readLines(path.join(root, 'jsonp'))).map(
        row => new URL(row.url).pathname,
      );
      assert.ok(paths.includes('/reviews.js'));
      assert.ok(paths.includes('/batch.json'));
      assert.ok(!paths.includes('/bundle.js'));
    });
  });
});
