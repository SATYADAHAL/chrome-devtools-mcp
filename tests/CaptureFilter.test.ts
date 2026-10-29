/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {describe, it} from 'node:test';

import {parseArguments} from '../src/bin/chrome-devtools-mcp-cli-options.js';
import {CaptureFilter, loadCaptureFilter} from '../src/CaptureFilter.js';

function filter(config: object): CaptureFilter {
  return CaptureFilter.parse(JSON.stringify({version: 1, ...config}), 'test');
}

describe('CaptureFilter', () => {
  it('loads the built-in default', () => {
    const defaults = loadCaptureFilter();
    assert.strictEqual(defaults.version, 1);
    assert.ok(defaults.source.endsWith('capture-filter.default.json'));
    assert.strictEqual(
      defaults.hostRule('https://www.google-analytics.com/g/collect'),
      'block',
    );
  });

  it('loads a filter file and rejects an invalid one', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'filter-'));
    try {
      const good = path.join(dir, 'good.json');
      await fs.writeFile(good, JSON.stringify({version: 7, ignore: ['a.com']}));
      const loaded = loadCaptureFilter(good);
      assert.strictEqual(loaded.version, 7);
      assert.strictEqual(loaded.hostRule('https://a.com/x'), 'ignore');

      const bad = path.join(dir, 'bad.json');
      await fs.writeFile(bad, JSON.stringify({block: 'a.com'}));
      assert.throws(() => loadCaptureFilter(bad), /is invalid/);
    } finally {
      await fs.rm(dir, {recursive: true, force: true});
    }
  });

  it('lets allow win over block and ignore', () => {
    const rules = filter({
      block: ['example.com'],
      ignore: ['cdn.example.com'],
      allow: ['reviews.example.com'],
    });
    assert.strictEqual(rules.hostRule('https://example.com/'), 'block');
    assert.strictEqual(rules.hostRule('https://cdn.example.com/'), 'block');
    assert.strictEqual(
      rules.hostRule('https://reviews.example.com/api'),
      'allow',
    );
    assert.strictEqual(rules.hostRule('https://shop.com/'), undefined);
  });

  it('does not block in Chrome what overlaps an allow entry', () => {
    const rules = filter({
      block: ['example.com', 'tracker.com'],
      allow: ['reviews.example.com'],
    });
    assert.deepStrictEqual(rules.chromeBlockPatterns(), [
      '*://tracker.com/*',
      '*://*.tracker.com/*',
    ]);
  });

  it('blocks the filter hosts in --scrape mode', () => {
    const args = parseArguments('1.0.0', ['node', 'main.js', '--scrape'], {});
    assert.ok(args.blockedUrlPattern?.includes('*://*.google-analytics.com/*'));
  });
});
