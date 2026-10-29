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
    assert.strictEqual(typeof defaults.version, 'number');
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

  describe('default filter', () => {
    const defaults = loadCaptureFilter();
    const cases: Array<[string, 'allow' | 'block' | 'ignore' | undefined]> = [
      // ads and analytics are refused
      ['https://www.googletagmanager.com/gtag/js?id=G-1', 'block'],
      ['https://www.facebook.com/tr?id=1&ev=PageView', 'block'],
      ['https://gtm2.petcircle.com.au/gtag/js?id=G-1', 'block'],
      ['https://www.google.com.np/rmkt/collect/1/', 'block'],
      ['https://bat.bing.com/action/0', 'block'],
      // widgets that pages need load, but are not data
      ['https://www.google.com/recaptcha/api.js', 'ignore'],
      ['https://www.gstatic.com/recaptcha/releases/x/recaptcha.js', 'ignore'],
      ['https://connect.facebook.net/en_US/fbevents.js', 'ignore'],
      ['https://www.facebook.com/plugins/like.php', 'ignore'],
      ['https://shop.firebaseapp.com/__/auth/iframe', 'ignore'],
      ['https://challenges.cloudflare.com/turnstile/v0/api.js', 'ignore'],
      ['https://www.shop.com/cdn-cgi/challenge-platform/h/b/x', 'ignore'],
      ['https://cdn.cookielaw.org/consent/x.json', 'ignore'],
      ['https://www.paypal.com/sdk/js', 'ignore'],
      ['https://a.klaviyo.com/client/profiles/', 'ignore'],
      // review / search vendors and Shopify product data are always data
      ['https://api.bazaarvoice.com/data/batch.json?callback=cb', 'allow'],
      ['https://apps.bazaarvoice.com/deployments/x/bv.js', 'allow'],
      [
        'https://api-cdn.yotpo.com/v1/widget/x/products/1/reviews.json',
        'allow',
      ],
      ['https://abc-dsn.algolia.net/1/indexes/*/queries', 'allow'],
      ['https://shop.myshopify.com/products/red-shoe.json', 'allow'],
      ['https://ppm.stripe.com/config?amount=1', 'ignore'],
      ['https://cookie-cdn.cookiepro.com/consent/x/en.json', 'ignore'],
      ['https://www.kookai.com.au/cart.js', 'ignore'],
      ['https://c.ba.contentsquare.net/pageview', 'block'],
      // a review vendor's analytics host is not covered by allow
      ['https://analytics.searchspring.net/beacon/v2/x/pageview', undefined],
      ['https://m93bm6.a.searchspring.io/api/search/search.json', 'allow'],
      // real data stays data
      ['https://shop-default-rtdb.firebaseio.com/products.json', undefined],
      ['https://firestore.googleapis.com/v1/projects/x/documents', undefined],
      ['https://web.api.petcircle.com.au/v1_1/products?slug=x', undefined],
      ['https://www.google.com/maps/api/js', undefined],
      ['https://mysegmentshop.com.au/collections/all', undefined],
    ];
    for (const [url, expected] of cases) {
      it(`${expected ?? 'keeps'} ${url}`, () => {
        assert.strictEqual(defaults.hostRule(url), expected);
      });
    }

    it('leaves paths that real APIs use out of ignore_paths', () => {
      // Parcel tracking and log viewers are data; /track and /log are not
      // beacon paths by default.
      for (const url of [
        'https://shop.com/track/order/123',
        'https://shop.com/tracking?id=1',
        'https://shop.com/api/log/entries',
      ]) {
        assert.ok(!defaults.ignoredPath(url), url);
      }
      assert.ok(defaults.ignoredPath('https://shop.com/g/collect?v=2'));
    });

    it('blocks ads but not ignored widgets in Chrome', () => {
      const patterns = defaults
        .chromeBlockPatterns()
        .map(pattern => new URLPattern(pattern));
      const blocked = (url: string) =>
        patterns.some(pattern => pattern.test(url));
      assert.ok(blocked('https://www.google-analytics.com/g/collect'));
      assert.ok(!blocked('https://www.google.com/recaptcha/api.js'));
      assert.ok(!blocked('https://www.gstatic.com/x.js'));
      assert.ok(!blocked('https://connect.facebook.net/en_US/fbevents.js'));
    });
  });

  it('matches ignore_paths as whole path segments', () => {
    const rules = filter({ignore_paths: ['/log', '/collect', '/monorail/']});
    for (const url of [
      'https://shop.com/log',
      'https://shop.com/api/log/events',
      'https://shop.com/log.gif?x=1',
      'https://www.google.com/g/collect?v=2',
      'https://shop.com/.well-known/shopify/monorail/unstable/produce',
    ]) {
      assert.ok(rules.ignoredPath(url), url);
    }
    for (const url of [
      'https://shop.com/login',
      'https://shop.com/logo.png',
      'https://shop.com/blog/post',
      'https://shop.com/collections/all',
      'https://shop.com/products?log=1',
    ]) {
      assert.ok(!rules.ignoredPath(url), url);
    }
  });
});
