/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import {detectAntibot} from './antibot.js';
import {type SniffedBody, sniffBody} from './bodyFormat.js';
import type {CaptureFilter} from './CaptureFilter.js';
import {logger} from './logger.js';
import type {HTTPRequest} from './third_party/index.js';

export const DEFAULT_CAPTURE_RESOURCE_TYPES = [
  'document',
  'xhr',
  'fetch',
  'script',
];
const MAX_BODY_BYTES = 20_000_000;
// Error pages are kept up to this size: a 403 challenge page is evidence of
// an anti-bot block.
const MAX_ERROR_BODY_BYTES = 200_000;
// A URL matching ignore_paths is a beacon unless it returns more JSON than
// this.
const MAX_BEACON_JSON_BYTES = 4_096;
// How much of a body is searched for anti-bot challenge text.
const ANTIBOT_BODY_BYTES = 50_000;
// capture.json is rewritten at most this often while a capture runs.
const MANIFEST_INTERVAL_MS = 1000;
// Static bundles are scripts too; only script requests that are not plain
// .js files (JSONP calls such as batch.json?callback=...) are data, unless a
// callback parameter marks a .js URL as JSONP (reviews.js?callback=cb).
const STATIC_SCRIPT_RE = /\.m?js$/i;
const JSONP_PARAMS = ['callback', 'jsonp', 'cb', 'jsoncallback'];
// Static files by extension, whatever the resource type (SVG icons fetched
// by XHR).
const STATIC_FILE_RE =
  /\.(?:css|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|eot|otf|mp4|webm|map)$/i;

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

function statusOf(request: HTTPRequest): string {
  const response = request.response();
  if (response) {
    return response.status().toString();
  }
  return request.failure()?.errorText ?? 'pending';
}

function isJsonp(url: URL): boolean {
  return JSONP_PARAMS.some(name => url.searchParams.has(name));
}

export interface CaptureSummary {
  pageId: number;
  dir: string;
  // Lines written to requests.jsonl, data or not.
  saved: number;
  data: number;
  dropped: Partial<Record<DropReason, number>>;
  blocked: number;
  duplicates: number;
  // Responses pointing at an anti-bot vendor, per vendor.
  antibot: Record<string, number>;
  // Version of the capture filter that labelled the requests.
  filter_version?: number;
  bytes: number;
  // Requests whose files could not be written.
  failed: number;
}

export interface CaptureOptions {
  resourceTypes?: string[];
  // Whether Chrome refuses this URL (the blocklist). Blocked requests fail
  // with a generic network error, so they are recognised by URL.
  isBlocked?: (url: string) => boolean;
  // Host rules: block / ignore / allow.
  filter?: CaptureFilter;
  // Whether the tab's HTTP cache is turned off for the capture.
  cacheDisabled?: boolean;
}

interface SavedBody {
  reqid: number;
  bodyFile?: string;
  requestBodyFile?: string;
}

/**
 * Resolves a capture directory against the capture root and refuses paths
 * outside of it.
 */
export function resolveCaptureDir(root: string, dir: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, dir);
  const relative = path.relative(resolvedRoot, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(
      `captureDir must be a folder inside the capture root ${resolvedRoot}: ${dir}`,
    );
  }
  return resolved;
}

/**
 * Writes every finished or failed request of one tab to a directory as soon
 * as it completes, labelled as data or not, so the bodies are saved before
 * Chrome evicts them and every filtering decision is visible on disk:
 *
 *   <dir>/capture.json              tab, start url, times and counts
 *   <dir>/<reqid>.json              request + response metadata
 *   <dir>/<reqid>.network-request   request body (POST), if any
 *   <dir>/<reqid>.network-response  raw response body (data and kept errors)
 *   <dir>/requests.jsonl            one line per request
 *
 * Each line has `data: true`, or `data: false` and a `drop` reason. Response
 * bodies are written only for data and for small HTML / JSON error pages.
 *
 * A request repeated with the same method, URL, request body and response
 * body (polling, double fetches) gets its own <reqid>.json and jsonl line,
 * but points at the first copy's body files (`duplicateOf`).
 */
export class NetworkCapture {
  #dir: string;
  #pageId: number;
  #startUrl: string;
  #startedAt = new Date().toISOString();
  #resourceTypes: Set<string>;
  #isBlocked: (url: string) => boolean;
  #filter?: CaptureFilter;
  readonly cacheDisabled: boolean;
  #pending = new Set<Promise<void>>();
  #stopped = false;
  #saved = 0;
  #data = 0;
  #dropped: Partial<Record<DropReason, number>> = {};
  #blocked = 0;
  #duplicates = 0;
  #antibot: Record<string, number> = {};
  #bytes = 0;
  #failed = 0;
  #bodies = new Map<string, SavedBody>();
  #manifestTimer?: ReturnType<typeof setTimeout>;
  #manifestWrites: Promise<void> = Promise.resolve();

  private constructor(
    dir: string,
    pageId: number,
    startUrl: string,
    options: CaptureOptions,
  ) {
    this.#dir = dir;
    this.#pageId = pageId;
    this.#startUrl = startUrl;
    this.#resourceTypes = new Set(
      options.resourceTypes?.length
        ? options.resourceTypes
        : DEFAULT_CAPTURE_RESOURCE_TYPES,
    );
    this.#isBlocked = options.isBlocked ?? (() => false);
    this.#filter = options.filter;
    this.cacheDisabled = options.cacheDisabled ?? false;
  }

  /**
   * Creates the capture directory. Refuses a non-empty one: reqids restart at
   * 1 in every tab, so a second capture would overwrite the first.
   */
  static async create(
    dir: string,
    pageId: number,
    startUrl: string,
    options: CaptureOptions = {},
  ): Promise<NetworkCapture> {
    const existing = await fs.readdir(dir).catch(() => []);
    if (existing.length) {
      throw new Error(`Capture directory is not empty: ${dir}`);
    }
    await fs.mkdir(dir, {recursive: true});
    const capture = new NetworkCapture(dir, pageId, startUrl, options);
    await capture.#writeManifest();
    logger?.(`Capturing network traffic of page ${pageId} to ${dir}`);
    return capture;
  }

  get dir(): string {
    return this.#dir;
  }

  /**
   * Stops recording, waits for the bodies still being written and returns
   * the counts.
   */
  async stop(): Promise<CaptureSummary> {
    if (!this.#stopped) {
      this.#stopped = true;
      clearTimeout(this.#manifestTimer);
      await Promise.all(this.#pending);
      await this.#queueManifest(new Date().toISOString());
    }
    return this.#summary();
  }

  #queueManifest(stoppedAt?: string): Promise<void> {
    // Writes run one after another so capture.json is never half-written.
    this.#manifestWrites = this.#manifestWrites
      .then(() => this.#writeManifest(stoppedAt))
      .catch(error => {
        logger?.('Failed to write capture.json', error);
      });
    return this.#manifestWrites;
  }

  #scheduleManifest(): void {
    if (this.#manifestTimer || this.#stopped) {
      return;
    }
    this.#manifestTimer = setTimeout(() => {
      this.#manifestTimer = undefined;
      void this.#queueManifest();
    }, MANIFEST_INTERVAL_MS);
    this.#manifestTimer.unref();
  }

  #summary(): CaptureSummary {
    return {
      pageId: this.#pageId,
      dir: this.#dir,
      saved: this.#saved,
      data: this.#data,
      dropped: {...this.#dropped},
      blocked: this.#blocked,
      duplicates: this.#duplicates,
      antibot: {...this.#antibot},
      bytes: this.#bytes,
      failed: this.#failed,
      filter_version: this.#filter?.version,
    };
  }

  async #writeManifest(stoppedAt?: string): Promise<void> {
    const manifest = {
      ...this.#summary(),
      startUrl: this.#startUrl,
      startedAt: this.#startedAt,
      stoppedAt,
      resourceTypes: [...this.#resourceTypes],
      cacheDisabled: this.cacheDisabled,
      filter_source: this.#filter?.source,
    };
    await fs.writeFile(
      path.join(this.#dir, 'capture.json'),
      JSON.stringify(manifest, null, 1),
    );
  }

  /**
   * Labels a request from what is known before its body is read: method,
   * failure, resource type and URL. Undefined means it may be data.
   */
  #labelRequest(request: HTTPRequest): DropReason | undefined {
    const type = request.resourceType();
    if (request.method() === 'OPTIONS' || type === 'preflight') {
      return 'preflight';
    }
    const hostRule = this.#filter?.hostRule(request.url());
    // Chrome also reports some answered requests as failed (a 204 to fetch,
    // a stream cut short); when there is a status, the status decides.
    if (request.failure() && !request.response()) {
      return this.#isBlocked(request.url()) || hostRule === 'block'
        ? 'tracker'
        : 'failed';
    }
    if (type === 'ping') {
      return 'beacon';
    }
    if (!this.#resourceTypes.has(type)) {
      return 'static';
    }
    let url: URL;
    try {
      url = new URL(request.url());
    } catch {
      return 'static';
    }
    if (STATIC_FILE_RE.test(url.pathname)) {
      return 'static';
    }
    if (
      type === 'script' &&
      !isJsonp(url) &&
      STATIC_SCRIPT_RE.test(url.pathname)
    ) {
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
  #labelResponse(
    request: HTTPRequest,
    status: number,
    body: {
      contentType: string;
      bytes: number;
      sniffed?: SniffedBody;
      hasBody: boolean;
    },
  ): DropReason | undefined {
    if (status >= 400) {
      return 'http_error';
    }
    // 204, redirects and responses Chrome kept no body for.
    if (status === 204 || !body.hasBody || body.sniffed?.format === 'empty') {
      return 'empty';
    }
    // Images and media fetched by scripts are still static files.
    if (/^(image|video|audio|font)\//i.test(body.contentType)) {
      return 'static';
    }
    const url = request.url();
    if (
      this.#filter?.ignoredPath(url) &&
      this.#filter.hostRule(url) !== 'allow'
    ) {
      // Never drop a sizeable JSON body: /log or /metrics can be real APIs.
      const json =
        body.sniffed?.format === 'json' || body.sniffed?.format === 'jsonp';
      if (!json || body.bytes < MAX_BEACON_JSON_BYTES) {
        return 'beacon';
      }
    }
    return undefined;
  }

  /** Whether an error response's body is worth keeping as evidence. */
  #keepErrorBody(sniffed: SniffedBody | undefined, bytes: number): boolean {
    const format = sniffed?.format;
    return (
      bytes <= MAX_ERROR_BODY_BYTES &&
      (format === 'html' || format === 'json' || format === 'jsonp')
    );
  }

  record(request: HTTPRequest, reqid: number): void {
    const url = request.url();
    if (this.#stopped || url.startsWith('data:') || url.startsWith('blob:')) {
      return;
    }
    const pending = this.#save(request, reqid)
      .catch(error => {
        this.#failed++;
        logger?.(`Failed to capture request ${reqid}`, error);
      })
      .finally(() => this.#scheduleManifest());
    this.#pending.add(pending);
    void pending.finally(() => this.#pending.delete(pending));
  }

  async #save(request: HTTPRequest, reqid: number): Promise<void> {
    const response = request.response();
    const base = path.join(this.#dir, String(reqid));
    const contentType = response?.headers()['content-type'] ?? '';
    let drop = this.#labelRequest(request);

    const postData = request.hasPostData()
      ? await request.fetchPostData().catch(() => undefined)
      : undefined;

    // Bodies are read only when they may be saved: data, or an error page.
    let buffer: Buffer | undefined;
    let bodyError: string | undefined;
    if (response && drop === undefined) {
      try {
        buffer = await response.buffer();
      } catch {
        // Redirects and some cached responses have no body.
        bodyError = 'response body not available';
      }
    }
    const bytes = buffer?.length ?? 0;
    if (buffer && buffer.length > MAX_BODY_BYTES) {
      bodyError = `body too large (${buffer.length} bytes)`;
      buffer = undefined;
      drop ??= 'too_large';
    }
    const sniffed = buffer ? sniffBody(buffer, contentType) : undefined;
    // Before a dropped body is let go: a challenge page names its vendor.
    const antibot = detectAntibot({
      url: request.url(),
      status: response?.status(),
      headers: response?.headers() ?? {},
      body: buffer?.subarray(0, ANTIBOT_BODY_BYTES).toString('utf8'),
    });
    if (antibot) {
      this.#antibot[antibot] = (this.#antibot[antibot] ?? 0) + 1;
    }
    if (drop === undefined && response) {
      drop = this.#labelResponse(request, response.status(), {
        contentType,
        bytes,
        sniffed,
        hasBody: buffer !== undefined,
      });
      // Only data and error pages kept as evidence have their body saved.
      const keep =
        drop === undefined ||
        (drop === 'http_error' && this.#keepErrorBody(sniffed, bytes));
      if (!keep) {
        buffer = undefined;
      }
    }

    // Looked up and claimed without an await in between, so two copies
    // finishing at the same time cannot both be written.
    const key = createHash('sha1')
      .update(`${request.method()} ${request.url()}\n`)
      .update(postData ?? '')
      .update('\n')
      .update(buffer ?? '')
      .digest('hex');
    const first =
      postData !== undefined || buffer ? this.#bodies.get(key) : undefined;

    let bodyFile: string | undefined;
    let requestBodyFile: string | undefined;
    if (first) {
      bodyFile = first.bodyFile;
      requestBodyFile = first.requestBodyFile;
      this.#duplicates++;
    } else {
      if (postData !== undefined) {
        requestBodyFile = `${reqid}.network-request`;
      }
      if (buffer) {
        bodyFile = `${reqid}.network-response`;
      }
      this.#bodies.set(key, {reqid, bodyFile, requestBodyFile});
      if (postData !== undefined) {
        await fs.writeFile(`${base}.network-request`, postData);
      }
      if (buffer) {
        await fs.writeFile(`${base}.network-response`, buffer);
        this.#bytes += bytes;
      }
    }

    const data = drop === undefined;
    const frame = request.frame();
    const meta = {
      reqid,
      requestId: reqid,
      method: request.method(),
      url: request.url(),
      status: statusOf(request),
      resourceType: request.resourceType(),
      data,
      drop,
      antibot,
      isNavigationRequest: request.isNavigationRequest(),
      frameUrl: frame?.url(),
      isMainFrame: frame ? frame.parentFrame() === null : undefined,
      finishedAt: new Date().toISOString(),
      requestHeaders: request.headers(),
      responseHeaders: response?.headers(),
      redirectChain: request.redirectChain().map(r => {
        return {method: r.method(), url: r.url(), status: statusOf(r)};
      }),
      bytes,
      fromCache: response?.fromCache() || undefined,
      ...sniffed,
      bodyFile,
      bodyError,
      requestBodyFile,
      duplicateOf: first?.reqid,
    };
    await fs.writeFile(`${base}.json`, JSON.stringify(meta, null, 1));
    const line = {
      reqid,
      method: meta.method,
      url: meta.url,
      status: meta.status,
      resourceType: meta.resourceType,
      contentType,
      bytes,
      format: sniffed?.format,
      fromCache: meta.fromCache,
      bodyFile,
      requestBodyFile,
      duplicateOf: first?.reqid,
      finishedAt: meta.finishedAt,
      data,
      drop,
      antibot,
    };
    await fs.appendFile(
      path.join(this.#dir, 'requests.jsonl'),
      JSON.stringify(line) + '\n',
    );
    this.#saved++;
    if (data) {
      this.#data++;
    } else if (drop) {
      this.#dropped[drop] = (this.#dropped[drop] ?? 0) + 1;
      if (drop === 'tracker' && request.failure()) {
        this.#blocked++;
      }
    }
  }
}
