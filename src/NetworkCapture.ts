/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import {logger} from './logger.js';
import type {HTTPRequest} from './third_party/index.js';

export const DEFAULT_CAPTURE_RESOURCE_TYPES = [
  'document',
  'xhr',
  'fetch',
  'script',
];
const MAX_BODY_BYTES = 20_000_000;
// capture.json is rewritten at most this often while a capture runs.
const MANIFEST_INTERVAL_MS = 1000;
// Static bundles are scripts too; only script requests that are not plain
// .js files (JSONP calls such as batch.json?callback=...) are data, unless a
// callback parameter marks a .js URL as JSONP (reviews.js?callback=cb).
const STATIC_SCRIPT_RE = /\.m?js$/i;
const JSONP_PARAMS = ['callback', 'jsonp', 'cb', 'jsoncallback'];

function statusOf(request: HTTPRequest): string {
  const response = request.response();
  if (response) {
    return response.status().toString();
  }
  return request.failure()?.errorText ?? 'pending';
}

export interface CaptureSummary {
  pageId: number;
  dir: string;
  saved: number;
  duplicates: number;
  bytes: number;
  failed: number;
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
 * Writes every finished data request of one tab to a directory as soon as it
 * completes, so the bodies are saved before Chrome evicts them and without a
 * tool call:
 *
 *   <dir>/capture.json              tab, start url, times and counts
 *   <dir>/<reqid>.json              request + response metadata
 *   <dir>/<reqid>.network-request   request body (POST), if any
 *   <dir>/<reqid>.network-response  raw response body
 *   <dir>/requests.jsonl            one line per captured request
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
  #pending = new Set<Promise<void>>();
  #stopped = false;
  #saved = 0;
  #duplicates = 0;
  #bytes = 0;
  #failed = 0;
  #bodies = new Map<string, SavedBody>();
  #manifestTimer?: ReturnType<typeof setTimeout>;
  #manifestWrites: Promise<void> = Promise.resolve();

  private constructor(
    dir: string,
    pageId: number,
    startUrl: string,
    resourceTypes?: string[],
  ) {
    this.#dir = dir;
    this.#pageId = pageId;
    this.#startUrl = startUrl;
    this.#resourceTypes = new Set(
      resourceTypes?.length ? resourceTypes : DEFAULT_CAPTURE_RESOURCE_TYPES,
    );
  }

  /**
   * Creates the capture directory. Refuses a non-empty one: reqids restart at
   * 1 in every tab, so a second capture would overwrite the first.
   */
  static async create(
    dir: string,
    pageId: number,
    startUrl: string,
    resourceTypes?: string[],
  ): Promise<NetworkCapture> {
    const existing = await fs.readdir(dir).catch(() => []);
    if (existing.length) {
      throw new Error(`Capture directory is not empty: ${dir}`);
    }
    await fs.mkdir(dir, {recursive: true});
    const capture = new NetworkCapture(dir, pageId, startUrl, resourceTypes);
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
      duplicates: this.#duplicates,
      bytes: this.#bytes,
      failed: this.#failed,
    };
  }

  async #writeManifest(stoppedAt?: string): Promise<void> {
    const manifest = {
      ...this.#summary(),
      startUrl: this.#startUrl,
      startedAt: this.#startedAt,
      stoppedAt,
      resourceTypes: [...this.#resourceTypes],
    };
    await fs.writeFile(
      path.join(this.#dir, 'capture.json'),
      JSON.stringify(manifest, null, 1),
    );
  }

  #wanted(request: HTTPRequest): boolean {
    const type = request.resourceType();
    if (!this.#resourceTypes.has(type)) {
      return false;
    }
    const url = request.url();
    if (url.startsWith('data:') || url.startsWith('blob:')) {
      return false;
    }
    if (type === 'script') {
      try {
        const {pathname, searchParams} = new URL(url);
        if (JSONP_PARAMS.some(name => searchParams.has(name))) {
          return true;
        }
        return !STATIC_SCRIPT_RE.test(pathname);
      } catch {
        return false;
      }
    }
    return true;
  }

  record(request: HTTPRequest, reqid: number): void {
    if (this.#stopped || !this.#wanted(request)) {
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

    const postData = request.hasPostData()
      ? await request.fetchPostData().catch(() => undefined)
      : undefined;

    let buffer: Buffer | undefined;
    let bodyError: string | undefined;
    if (response) {
      try {
        buffer = await response.buffer();
        if (buffer.length > MAX_BODY_BYTES) {
          bodyError = `body too large (${buffer.length} bytes)`;
          buffer = undefined;
        }
      } catch {
        // Redirects and some cached responses have no body.
        bodyError = 'response body not available';
      }
    }
    const bytes = buffer?.length ?? 0;

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

    const frame = request.frame();
    const meta = {
      reqid,
      requestId: reqid,
      method: request.method(),
      url: request.url(),
      status: statusOf(request),
      resourceType: request.resourceType(),
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
      contentType: response?.headers()['content-type'] ?? '',
      bytes,
      bodyFile,
      requestBodyFile,
      duplicateOf: first?.reqid,
      finishedAt: meta.finishedAt,
    };
    await fs.appendFile(
      path.join(this.#dir, 'requests.jsonl'),
      JSON.stringify(line) + '\n',
    );
    this.#saved++;
  }
}
