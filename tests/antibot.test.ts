/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import {describe, it} from 'node:test';

import {detectAntibot} from '../src/antibot.js';

const page = 'https://www.shop.com/p/1';

describe('detectAntibot', () => {
  it('finds vendors from headers and cookies', () => {
    assert.strictEqual(
      detectAntibot({
        url: page,
        status: 403,
        headers: {'cf-mitigated': 'challenge'},
      }),
      'cloudflare',
    );
    assert.strictEqual(
      detectAntibot({
        url: page,
        status: 200,
        headers: {'x-datadome': 'protected'},
      }),
      'datadome',
    );
    assert.strictEqual(
      detectAntibot({url: page, status: 429, headers: {'x-kpsdk-ct': 'abc'}}),
      'kasada',
    );
    assert.strictEqual(
      detectAntibot({
        url: page,
        status: 200,
        headers: {'set-cookie': 'a=1\nincap_ses_123_456=xyz; path=/'},
      }),
      'imperva',
    );
    assert.strictEqual(
      detectAntibot({url: page, status: 403, headers: {server: 'AkamaiGHost'}}),
      'akamai',
    );
  });

  it('finds vendor scripts and challenge URLs', () => {
    for (const [url, vendor] of [
      ['https://client.perimeterx.net/PXabc/main.min.js', 'perimeterx'],
      ['https://geo.captcha-delivery.com/captcha/?x=1', 'datadome'],
      ['https://challenges.cloudflare.com/turnstile/v0/api.js', 'cloudflare'],
      [
        'https://www.shop.com/cdn-cgi/challenge-platform/h/b/orchestrate',
        'cloudflare',
      ],
    ]) {
      assert.strictEqual(detectAntibot({url, headers: {}}), vendor, url);
    }
  });

  it('reads the body of challenge responses only', () => {
    const body = '<html><title>Just a moment...</title></html>';
    assert.strictEqual(
      detectAntibot({url: page, status: 503, headers: {}, body}),
      'cloudflare',
    );
    assert.strictEqual(
      detectAntibot({url: page, status: 200, headers: {}, body}),
      undefined,
    );
    assert.strictEqual(
      detectAntibot({
        url: page,
        status: 403,
        headers: {},
        body: '<html><body>Access Denied. Reference #18.abc</body></html>',
      }),
      'akamai',
    );
    assert.strictEqual(
      detectAntibot({
        url: page,
        status: 403,
        headers: {},
        body: '<html><body>Forbidden</body></html>',
      }),
      'unknown',
    );
  });

  it('stays quiet on ordinary responses', () => {
    assert.strictEqual(
      detectAntibot({
        url: page,
        status: 200,
        headers: {server: 'cloudflare', 'cf-ray': 'x'},
        body: '<html>shop</html>',
      }),
      undefined,
    );
    assert.strictEqual(
      detectAntibot({
        url: page,
        status: 404,
        headers: {},
        body: '{"error": 1}',
      }),
      undefined,
    );
    assert.strictEqual(
      detectAntibot({
        url: page,
        status: 403,
        headers: {},
        body: '{"error": 1}',
      }),
      undefined,
    );
  });
});
