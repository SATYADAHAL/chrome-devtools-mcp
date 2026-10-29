/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import {describe, it} from 'node:test';

import {sniffBody} from '../src/bodyFormat.js';

function sniff(body: string | Uint8Array, contentType = '') {
  const bytes =
    typeof body === 'string' ? new TextEncoder().encode(body) : body;
  return sniffBody(bytes, contentType);
}

describe('sniffBody', () => {
  it('finds JSON whatever the content type says', () => {
    assert.deepStrictEqual(sniff('{"a": 1}', 'text/plain'), {format: 'json'});
    assert.deepStrictEqual(sniff(' [1, 2] ', 'text/html'), {format: 'json'});
    assert.deepStrictEqual(sniff('﻿{"bom": true}'), {format: 'json'});
  });

  it('strips XSSI prefixes', () => {
    assert.deepStrictEqual(sniff(`)]}'\n{"a": 1}`), {
      format: 'json',
      xssiPrefix: `)]}'`,
    });
    assert.deepStrictEqual(sniff('for(;;);{"a": 1}'), {
      format: 'json',
      xssiPrefix: 'for(;;);',
    });
    assert.deepStrictEqual(sniff('while(1);[1]'), {
      format: 'json',
      xssiPrefix: 'while(1);',
    });
  });

  it('finds JSONP and its callback', () => {
    assert.deepStrictEqual(sniff('cb({"a": 1});', 'application/javascript'), {
      format: 'jsonp',
      callback: 'cb',
    });
    assert.deepStrictEqual(sniff('/**/ bv_1_2([{"r": 1}])'), {
      format: 'jsonp',
      callback: 'bv_1_2',
    });
    assert.deepStrictEqual(
      sniff(`typeof jQuery1 === 'function' && jQuery1({"a": 1});`),
      {format: 'jsonp', callback: 'jQuery1'},
    );
  });

  it('tells html, xml, js, text, binary and empty apart', () => {
    assert.strictEqual(sniff('<!DOCTYPE html><html></html>').format, 'html');
    assert.strictEqual(sniff('<div><body>x</body></div>').format, 'html');
    assert.strictEqual(sniff('<p>hi</p>', 'text/html').format, 'html');
    assert.strictEqual(sniff('<?xml version="1.0"?><a/>').format, 'xml');
    assert.strictEqual(
      sniff('<rss></rss>', 'application/rss+xml').format,
      'xml',
    );
    assert.strictEqual(
      sniff('var a = 1;', 'application/javascript').format,
      'js',
    );
    assert.strictEqual(sniff('ok', 'text/plain').format, 'text');
    assert.strictEqual(sniff('{not json', 'text/plain').format, 'text');
    assert.strictEqual(
      sniff(new Uint8Array([0xff, 0xfe, 0x00])).format,
      'binary',
    );
    assert.strictEqual(sniff('  \n ').format, 'empty');
  });
});
