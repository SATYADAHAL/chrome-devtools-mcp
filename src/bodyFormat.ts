/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export type BodyFormat =
  | 'json'
  | 'jsonp'
  | 'html'
  | 'xml'
  | 'js'
  | 'text'
  | 'binary'
  | 'empty';

export interface SniffedBody {
  format: BodyFormat;
  // JSONP callback name.
  callback?: string;
  // Anti-JSON-hijacking prefix before the JSON, e.g. `)]}'`.
  xssiPrefix?: string;
}

// Anti-JSON-hijacking prefixes some APIs put before their JSON.
const XSSI_RE = /^\s*(\)\]\}'?,?|for\s*\(;;\);|while\s*\(1\);|&&&START&&&)\s*/;
// callback({...});  /**/ cb(...)  typeof cb === 'function' && cb(...)
const JSONP_RE =
  /^\s*(?:\/\*\*\/\s*)?(?:typeof\s+[\w$.]+\s*===?\s*['"]function['"]\s*&&\s*)?([\w$.[\]'"]+)\s*\(\s*([[{][\s\S]*[\]}])\s*\)\s*;?\s*$/;

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * What a response body really is, from the body itself: servers often send
 * JSON as text/plain or text/html.
 */
export function sniffBody(buffer: Uint8Array, contentType = ''): SniffedBody {
  let text: string;
  try {
    // ignoreBOM: false strips a UTF-8 byte order mark.
    text = new TextDecoder('utf-8', {fatal: true}).decode(buffer);
  } catch {
    return {format: contentType.includes('text') ? 'text' : 'binary'};
  }
  let body = text.trim();
  const type = contentType.toLowerCase();
  if (!body) {
    return {format: 'empty'};
  }
  const xssi = XSSI_RE.exec(body);
  if (xssi) {
    const rest = body.slice(xssi[0].length);
    if (isJson(rest)) {
      return {format: 'json', xssiPrefix: xssi[1]};
    }
    body = rest;
  }
  if ((body.startsWith('{') || body.startsWith('[')) && isJson(body)) {
    return {format: 'json'};
  }
  const jsonp = JSONP_RE.exec(body);
  if (jsonp && isJson(jsonp[2])) {
    return {format: 'jsonp', callback: jsonp[1]};
  }
  const head = body.slice(0, 1000).toLowerCase();
  if (
    head.startsWith('<!doctype html') ||
    head.startsWith('<html') ||
    /<(head|body)[\s>]/.test(head)
  ) {
    return {format: 'html'};
  }
  if (
    body.startsWith('<') &&
    (head.startsWith('<?xml') || type.includes('xml') || type.includes('rss'))
  ) {
    return {format: 'xml'};
  }
  if (type.includes('javascript') || type.includes('ecmascript')) {
    return {format: 'js'};
  }
  return {
    format: body.startsWith('<') && type.includes('html') ? 'html' : 'text',
  };
}
