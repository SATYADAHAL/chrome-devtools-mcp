/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {BodyFormat} from './bodyFormat.js';
import type {CaptureFilter} from './CaptureFilter.js';

/**
 * The labelling rules of a network capture, as pure functions over what is
 * known about a request, so a live capture and an offline relabel of saved
 * files apply exactly the same rules.
 */

/** Why a request is not data. */
export type DropReason =
  | 'static'
  | 'tracker'
  | 'ignored_host'
  | 'http_error'
  | 'failed'
  | 'empty'
  | 'preflight'
  | 'beacon'
  | 'too_large';

export const DEFAULT_CAPTURE_RESOURCE_TYPES = [
  'document',
  'xhr',
  'fetch',
  'script',
];
export const MAX_BODY_BYTES = 20_000_000;
// Error pages are kept up to this size: a 403 challenge page is evidence of
// an anti-bot block.
const MAX_ERROR_BODY_BYTES = 200_000;
// Bodies of ignored hosts and beacons are kept up to this size, so a wrong
// ignore rule does not lose data for good.
const MAX_EVIDENCE_BYTES = 16_384;
// A URL matching ignore_paths is a beacon unless it returns more JSON than
// this.
const MAX_BEACON_JSON_BYTES = 4_096;
// Static bundles are scripts too; only script requests that are not plain
// .js files (JSONP calls such as batch.json?callback=...) are data, unless a
// callback parameter marks a .js URL as JSONP (reviews.js?callback=cb).
const STATIC_SCRIPT_RE = /\.m?js$/i;
const JSONP_PARAMS = ['callback', 'jsonp', 'cb', 'jsoncallback'];
// Static files by extension, whatever the resource type (SVG icons fetched
// by XHR).
const STATIC_FILE_RE =
  /\.(?:css|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|eot|otf|mp4|webm|map)$/i;

export interface LabelRules {
  filter?: CaptureFilter;
  resourceTypes: ReadonlySet<string>;
}

export interface RequestFacts {
  method: string;
  url: string;
  resourceType: string;
  // No response at all: connection error, abort, refused by Chrome.
  failed: boolean;
  // Refused by Chrome's blocklist.
  blocked: boolean;
}

export interface ResponseFacts {
  url: string;
  status: number;
  contentType: string;
  bytes: number;
  format?: BodyFormat;
  // Whether Chrome returned a body.
  hasBody: boolean;
}

/**
 * Labels a request from what is known before its body is read: method,
 * failure, resource type and URL. Undefined means it may be data.
 */
export function labelRequest(
  facts: RequestFacts,
  rules: LabelRules,
): DropReason | undefined {
  const type = facts.resourceType;
  if (facts.method === 'OPTIONS' || type === 'preflight') {
    return 'preflight';
  }
  const hostRule = rules.filter?.hostRule(facts.url);
  if (facts.failed) {
    return facts.blocked || hostRule === 'block' ? 'tracker' : 'failed';
  }
  if (type === 'ping') {
    return 'beacon';
  }
  if (!rules.resourceTypes.has(type)) {
    return 'static';
  }
  let url: URL;
  try {
    url = new URL(facts.url);
  } catch {
    return 'static';
  }
  if (STATIC_FILE_RE.test(url.pathname)) {
    return 'static';
  }
  const jsonp = JSONP_PARAMS.some(name => url.searchParams.has(name));
  if (type === 'script' && !jsonp && STATIC_SCRIPT_RE.test(url.pathname)) {
    return 'static';
  }
  // An allowed host is data whatever the other lists say.
  if (hostRule === 'block') {
    return 'tracker';
  }
  if (hostRule === 'ignore') {
    return 'ignored_host';
  }
  return undefined;
}

/**
 * Labels a response from its status and body. Undefined means it is data.
 */
export function labelResponse(
  facts: ResponseFacts,
  rules: LabelRules,
): DropReason | undefined {
  if (facts.status >= 400) {
    return 'http_error';
  }
  if (facts.bytes > MAX_BODY_BYTES) {
    return 'too_large';
  }
  // 204, redirects and responses Chrome kept no body for.
  if (facts.status === 204 || !facts.hasBody || facts.format === 'empty') {
    return 'empty';
  }
  // Images and media fetched by scripts are still static files.
  if (/^(image|video|audio|font)\//i.test(facts.contentType)) {
    return 'static';
  }
  const filter = rules.filter;
  if (
    filter?.ignoredPath(facts.url) &&
    filter.hostRule(facts.url) !== 'allow'
  ) {
    // Never drop a sizeable JSON body: /log or /metrics can be real APIs.
    const json = facts.format === 'json' || facts.format === 'jsonp';
    if (!json || facts.bytes < MAX_BEACON_JSON_BYTES) {
      return 'beacon';
    }
  }
  return undefined;
}

/**
 * Where a read body goes: `body` (bodyFile, the data the Python side reads),
 * `evidence` (evidenceFile, kept so a wrong rule loses nothing for good) or
 * nowhere.
 */
export function bodyDestination(
  drop: DropReason | undefined,
  format: BodyFormat | undefined,
  bytes: number,
): 'body' | 'evidence' | undefined {
  if (drop === undefined) {
    return 'body';
  }
  if (
    drop === 'http_error' &&
    bytes <= MAX_ERROR_BODY_BYTES &&
    (format === 'html' || format === 'json' || format === 'jsonp')
  ) {
    return 'body';
  }
  if ((drop === 'ignored_host' || drop === 'beacon') && bytes > 0) {
    return bytes <= MAX_EVIDENCE_BYTES ? 'evidence' : undefined;
  }
  return undefined;
}

/** Whether the body of a request with this pre-body label is worth reading. */
export function readsBody(drop: DropReason | undefined): boolean {
  return drop === undefined || drop === 'ignored_host';
}
