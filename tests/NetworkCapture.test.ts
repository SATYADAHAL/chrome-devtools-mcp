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

import {CaptureFilter} from '../src/CaptureFilter.js';
import type {McpContext} from '../src/McpContext.js';
import type {McpResponse} from '../src/McpResponse.js';
import {stopCapture} from '../src/tools/network.js';
import {newPage} from '../src/tools/pages.js';

import {serverHooks} from './server.js';
import {html, withMcpContext} from './utils.js';

interface CapturedRow {
  reqid: number;
  url: string;
  status: string;
  bodyFile?: string;
  duplicateOf?: number;
  data: boolean;
  drop?: string;
  format?: string;
  fromCache?: boolean;
  antibot?: string;
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

async function dataLines(dir: string): Promise<CapturedRow[]> {
  return (await readLines(dir)).filter(row => row.data);
}

function byPath(rows: CapturedRow[], pathname: string): CapturedRow {
  const row = rows.find(row => new URL(row.url).pathname === pathname);
  assert.ok(row, `no line for ${pathname}`);
  return row;
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
  options: {blockedUrlPattern?: string[]; captureFilter?: CaptureFilter} = {},
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'capture-'));
  try {
    await withMcpContext((response, context) => cb(root, response, context), {
      ...options,
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
      const urlsOne = (await dataLines(path.join(root, 'one'))).map(
        row => row.url,
      );
      const urlsTwo = (await dataLines(path.join(root, 'two'))).map(
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
      const rows = await readLines(path.join(root, 'jsonp'));
      assert.strictEqual(byPath(rows, '/reviews.js').data, true);
      assert.strictEqual(byPath(rows, '/batch.json').data, true);
      const bundle = byPath(rows, '/bundle.js');
      assert.strictEqual(bundle.data, false);
      assert.strictEqual(bundle.drop, 'static');
      assert.strictEqual(bundle.bodyFile, undefined);
    });
  });

  it('labels requests that are not data instead of dropping them', async () => {
    const reply = (status: number, type: string, body: string) => {
      return (_req: IncomingMessage, res: ServerResponse) => {
        res.statusCode = status;
        res.setHeader('Content-Type', type);
        res.end(body);
      };
    };
    server.addRoute('/logo.png', reply(200, 'image/png', 'png'));
    server.addRoute('/site.css', reply(200, 'text/css', 'body {}'));
    server.addRoute(
      '/challenge',
      reply(403, 'text/html', '<html><body>Access Denied</body></html>'),
    );
    server.addRoute(
      '/huge-error',
      reply(404, 'text/html', `<html>${'x'.repeat(300_000)}</html>`),
    );
    server.addRoute('/oops', reply(500, 'text/plain', 'boom'));
    server.addRoute('/tracker', reply(200, 'application/json', '{}'));
    server.addHtmlRoute(
      '/labels',
      html`<link
          rel="stylesheet"
          href="/site.css"
        />
        <img src="/logo.png" />
        <script>
          for (const url of [
            '/challenge',
            '/huge-error',
            '/oops',
            '/tracker',
            'http://localhost:1/refused',
          ]) {
            fetch(url).catch(() => {});
          }
        </script>`,
    );

    await withCaptureRoot(
      async (root, response, context) => {
        const page = await openCaptured(
          response,
          context,
          server.getRoute('/labels'),
          'labels',
        );
        const summary = await context.stopCapture(page);
        const rows = await readLines(path.join(root, 'labels'));
        const drop = (pathname: string) => byPath(rows, pathname).drop;

        assert.strictEqual(byPath(rows, '/labels').data, true);
        assert.strictEqual(drop('/logo.png'), 'static');
        assert.strictEqual(drop('/site.css'), 'static');
        assert.strictEqual(drop('/challenge'), 'http_error');
        assert.ok(byPath(rows, '/challenge').bodyFile, '403 page kept');
        assert.strictEqual(drop('/huge-error'), 'http_error');
        assert.strictEqual(byPath(rows, '/huge-error').bodyFile, undefined);
        assert.strictEqual(byPath(rows, '/oops').bodyFile, undefined);
        assert.strictEqual(drop('/tracker'), 'tracker');
        assert.strictEqual(drop('/refused'), 'failed');
        for (const row of rows.filter(row => !row.data)) {
          if (row.drop !== 'http_error') {
            assert.strictEqual(row.bodyFile, undefined, row.url);
          }
        }

        assert.ok(summary);
        assert.strictEqual(summary.data, 1);
        assert.strictEqual(summary.blocked, 1);
        assert.strictEqual(summary.dropped.http_error, 3);
        assert.strictEqual(summary.saved, rows.length);
      },
      {blockedUrlPattern: [server.getRoute('/tracker')]},
    );
  });

  it('labels hosts with the capture filter', async () => {
    const json = (_req: IncomingMessage, res: ServerResponse) => {
      res.setHeader('Content-Type', 'application/json');
      res.end('{"ok": true}');
    };
    server.addRoute('/blocked/collect', json);
    server.addRoute('/blocked/reviews', json);
    server.addRoute('/ignored/consent', json);
    server.addHtmlRoute(
      '/hosts',
      html`<script>
        for (const url of [
          '/blocked/collect',
          '/blocked/reviews',
          '/ignored/consent',
        ]) {
          fetch(url);
        }
      </script>`,
    );
    const captureFilter = CaptureFilter.parse(
      JSON.stringify({
        version: 3,
        block: ['localhost/blocked'],
        ignore: ['localhost/ignored'],
        allow: ['localhost/blocked/reviews'],
      }),
      'test-filter.json',
    );

    await withCaptureRoot(
      async (root, response, context) => {
        const page = await openCaptured(
          response,
          context,
          server.getRoute('/hosts'),
          'hosts',
        );
        await context.stopCapture(page);
        const dir = path.join(root, 'hosts');
        const rows = await readLines(dir);
        assert.strictEqual(byPath(rows, '/blocked/collect').drop, 'tracker');
        assert.strictEqual(byPath(rows, '/blocked/reviews').data, true);
        assert.ok(byPath(rows, '/blocked/reviews').bodyFile);
        assert.strictEqual(
          byPath(rows, '/ignored/consent').drop,
          'ignored_host',
        );
        assert.strictEqual(
          byPath(rows, '/ignored/consent').bodyFile,
          undefined,
        );
        const meta = JSON.parse(
          await fs.readFile(path.join(dir, 'capture.json'), 'utf8'),
        );
        assert.strictEqual(meta.filter_version, 3);
        assert.strictEqual(meta.filter_source, 'test-filter.json');
      },
      {captureFilter},
    );
  });

  it('labels responses from their body', async () => {
    const reply = (status: number, type: string, body: string | Buffer) => {
      return (_req: IncomingMessage, res: ServerResponse) => {
        res.statusCode = status;
        res.setHeader('Content-Type', type);
        res.end(body);
      };
    };
    const bigJson = JSON.stringify({entries: 'x'.repeat(10_000)});
    server.addRoute('/nothing', reply(204, 'text/plain', ''));
    server.addRoute('/collect', reply(200, 'text/plain', 'ok'));
    server.addRoute('/track', reply(200, 'application/json', '{"ok":1}'));
    server.addRoute('/api/log', reply(200, 'application/json', bigJson));
    server.addRoute('/photo', reply(200, 'image/png', Buffer.from([1, 2, 3])));
    server.addRoute('/plain-json', reply(200, 'text/plain', '{"price": 5}'));
    server.addRoute(
      '/xssi',
      reply(
        200,
        'application/json',
        `)]}'
[1]`,
      ),
    );
    server.addHtmlRoute(
      '/bodies',
      html`<script>
        fetch('/nothing');
        fetch('/collect', {method: 'POST', body: 'e=view'});
        fetch('/track', {method: 'POST', body: 'e=view'});
        fetch('/api/log');
        fetch('/photo');
        fetch('/plain-json');
        fetch('/xssi');
      </script>`,
    );
    const captureFilter = CaptureFilter.parse(
      JSON.stringify({
        version: 1,
        ignore_paths: ['/collect', '/track', '/log'],
      }),
      'test',
    );

    await withCaptureRoot(
      async (root, response, context) => {
        const page = await openCaptured(
          response,
          context,
          server.getRoute('/bodies'),
          'bodies',
        );
        await context.stopCapture(page);
        const rows = await readLines(path.join(root, 'bodies'));
        const row = (pathname: string) => byPath(rows, pathname);
        assert.strictEqual(row('/nothing').drop, 'empty');
        assert.strictEqual(row('/collect').drop, 'beacon');
        assert.strictEqual(row('/track').drop, 'beacon');
        assert.strictEqual(row('/api/log').data, true, 'big JSON stays data');
        assert.strictEqual(row('/api/log').format, 'json');
        assert.strictEqual(row('/photo').drop, 'static');
        assert.strictEqual(row('/plain-json').data, true);
        assert.strictEqual(row('/plain-json').format, 'json');
        assert.strictEqual(row('/xssi').format, 'json');
        assert.strictEqual(row('/bodies').format, 'html');
        for (const pathname of ['/nothing', '/collect', '/track', '/photo']) {
          assert.strictEqual(row(pathname).bodyFile, undefined, pathname);
        }
      },
      {captureFilter},
    );
  });

  it('turns the HTTP cache off on captured tabs', async () => {
    let served = 0;
    server.addRoute('/cached', (_req, res) => {
      served++;
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'max-age=3600');
      res.end('{"price": 5}');
    });
    const page = html`<script>
      fetch('/cached');
    </script>`;
    server.addHtmlRoute('/warm', page);
    server.addHtmlRoute('/cold', page);
    server.addHtmlRoute('/kept', page);

    await withCaptureRoot(async (root, response, context) => {
      const waitUntil: 'networkidle0' | 'load' = 'networkidle0';
      await newPage().handler(
        {params: {url: server.getRoute('/warm'), waitUntil}},
        response,
        context,
      );
      assert.strictEqual(served, 1);

      const cold = await openCaptured(
        response,
        context,
        server.getRoute('/cold'),
        'cold',
      );
      await context.stopCapture(cold);
      assert.strictEqual(served, 2, 'fetched again, not from the cache');
      const row = byPath(await readLines(path.join(root, 'cold')), '/cached');
      assert.strictEqual(row.data, true);
      assert.ok(row.bodyFile);

      const keptParams = {
        url: server.getRoute('/kept'),
        captureDir: 'kept',
        keepCache: true,
        waitUntil,
      };
      await newPage().handler({params: keptParams}, response, context);
      await context.stopCapture(context.getSelectedMcpPage());
      assert.strictEqual(served, 2, 'keepCache uses the cache');
      const kept = byPath(await readLines(path.join(root, 'kept')), '/cached');
      assert.strictEqual(kept.fromCache, true);
    });
  });

  it('marks responses that point at an anti-bot vendor', async () => {
    server.addRoute('/blocked-page', (_req, res) => {
      res.statusCode = 403;
      res.setHeader('Content-Type', 'text/html');
      res.setHeader('cf-mitigated', 'challenge');
      res.end('<html><title>Just a moment...</title></html>');
    });
    server.addRoute('/fine', (_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end('{"ok": true}');
    });
    server.addHtmlRoute(
      '/antibot',
      html`<script>
        fetch('/blocked-page');
        fetch('/fine');
      </script>`,
    );

    await withCaptureRoot(async (root, response, context) => {
      const page = await openCaptured(
        response,
        context,
        server.getRoute('/antibot'),
        'antibot',
      );
      const summary = await context.stopCapture(page);
      const rows = await readLines(path.join(root, 'antibot'));
      const blocked = byPath(rows, '/blocked-page');
      assert.strictEqual(blocked.antibot, 'cloudflare');
      assert.strictEqual(blocked.drop, 'http_error');
      assert.ok(blocked.bodyFile, 'challenge page kept as evidence');
      assert.strictEqual(byPath(rows, '/fine').antibot, undefined);
      assert.deepStrictEqual(summary?.antibot, {cloudflare: 1});
    });
  });

  it('counts every label in capture.json and stop_capture', async () => {
    const reply = (status: number, type: string, body: string) => {
      return (_req: IncomingMessage, res: ServerResponse) => {
        res.statusCode = status;
        res.setHeader('Content-Type', type);
        res.end(body);
      };
    };
    server.addRoute('/c/data', reply(200, 'application/json', '{"a":1}'));
    server.addRoute('/c/again', reply(200, 'application/json', '{"a":1}'));
    server.addRoute('/c/missing', reply(404, 'application/json', '{}'));
    server.addRoute('/c/pixel.png', reply(200, 'image/png', 'png'));
    server.addRoute('/c/blocked', reply(200, 'application/json', '{}'));
    server.addHtmlRoute(
      '/counts',
      html`<img src="/c/pixel.png" />
        <script>
          (async () => {
            await fetch('/c/data');
            await fetch('/c/data');
            await fetch('/c/missing');
            await fetch('/c/blocked').catch(() => {});
          })();
        </script>`,
    );

    await withCaptureRoot(
      async (root, response, context) => {
        const page = await openCaptured(
          response,
          context,
          server.getRoute('/counts'),
          'counts',
        );
        response.resetResponseLineForTesting();
        await stopCapture.handler({params: {}, page}, response, context);
        const dir = path.join(root, 'counts');
        const rows = await readLines(dir);
        const meta = JSON.parse(
          await fs.readFile(path.join(dir, 'capture.json'), 'utf8'),
        );

        const dropped: Record<string, number> = {};
        for (const row of rows) {
          if (row.drop) {
            dropped[row.drop] = (dropped[row.drop] ?? 0) + 1;
          }
        }
        assert.strictEqual(meta.saved, rows.length);
        assert.strictEqual(meta.data, rows.filter(row => row.data).length);
        assert.deepStrictEqual(meta.dropped, dropped);
        assert.strictEqual(meta.data, 3, 'page + two /c/data');
        assert.strictEqual(meta.duplicates, 1);
        assert.strictEqual(meta.blocked, 1);
        assert.strictEqual(dropped.http_error, 1);
        assert.strictEqual(dropped.tracker, 1);
        // The image, and the favicon when Chrome asks for one.
        assert.ok((dropped.static ?? 0) >= 1);
        assert.strictEqual(typeof meta.filter_version, 'number');
        assert.ok(meta.stoppedAt);

        assert.ok(
          response.responseLines[0].includes(
            `${rows.length} request(s), 3 data`,
          ),
          response.responseLines[0],
        );
        // Reasons are listed in the order they first occurred.
        const droppedLine = response.responseLines[1];
        assert.ok(droppedLine.startsWith('Dropped: '), droppedLine);
        for (const part of ['static ', 'http_error 1', 'tracker 1']) {
          assert.ok(droppedLine.includes(part), droppedLine);
        }
      },
      {blockedUrlPattern: [server.getRoute('/c/blocked')]},
    );
  });
});
