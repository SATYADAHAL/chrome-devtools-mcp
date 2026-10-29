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

  describe('matcher', () => {
    const rules = filter({
      block: [
        'segment.com',
        'facebook.com/tr',
        'google.*/pagead',
        'google-analytics.com',
      ],
      block_subdomains: ['gtm', 'sgtm'],
    });
    const cases: Array<[string, 'block' | undefined]> = [
      // a domain matches itself and its subdomains, not a longer name
      ['https://segment.com/v1/t', 'block'],
      ['https://cdn.segment.com/analytics.js', 'block'],
      ['https://mysegmentshop.com.au/products', undefined],
      ['https://segment.com.evil.net/', undefined],
      ['https://api.shop.com/customer-segments', undefined],
      // an entry with a path needs that path prefix
      ['https://www.facebook.com/tr?id=1&ev=PageView', 'block'],
      ['https://www.facebook.com/shop/products', undefined],
      // google.* is any public suffix
      ['https://www.google.com/pagead/1p-user-list/1', 'block'],
      ['https://www.google.com.au/pagead/landing', 'block'],
      ['https://google.co.uk/pagead/x', 'block'],
      ['https://www.google.com/maps/api/js', undefined],
      ['https://notgoogle.com/pagead/x', undefined],
      // first-party Tag Manager proxies, by first label on any site
      ['https://gtm.petcircle.com.au/gtag/js?id=G-1', 'block'],
      ['https://gtm2.petcircle.com.au/gtag/js?id=G-1', 'block'],
      ['https://sgtm.shop.com/g/collect', 'block'],
      ['https://gtmetrix.com/reports/x', undefined],
      ['https://www.gtmhub.com/', undefined],
      ['https://gtm.com/', undefined],
      // case does not matter
      ['https://WWW.Google-Analytics.COM/g/collect', 'block'],
    ];
    for (const [url, expected] of cases) {
      it(`${expected ?? 'keeps'} ${url}`, () => {
        assert.strictEqual(rules.hostRule(url), expected);
      });
    }

    it('gives Chrome patterns that match the same URLs', () => {
      const patterns = rules
        .chromeBlockPatterns()
        .map(pattern => new URLPattern(pattern));
      for (const [url, expected] of cases) {
        // Chrome patterns are case-sensitive on purpose-built lower-case hosts
        if (url !== url.toLowerCase()) {
          continue;
        }
        const blocked = patterns.some(pattern => pattern.test(url));
        assert.strictEqual(blocked, expected === 'block', url);
      }
    });
  });
});
