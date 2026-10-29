/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {logger} from './logger.js';
import {zod} from './third_party/index.js';

export const DEFAULT_CAPTURE_FILTER_PATH = fileURLToPath(
  new URL('./capture-filter.default.json', import.meta.url),
);

const configSchema = zod.object({
  version: zod.number(),
  block: zod.array(zod.string()).default([]),
  ignore: zod.array(zod.string()).default([]),
  allow: zod.array(zod.string()).default([]),
  ignore_paths: zod.array(zod.string()).default([]),
});

export type CaptureFilterConfig = zod.infer<typeof configSchema>;

/** What the filter says about a URL's host. */
export type HostRule = 'allow' | 'block' | 'ignore';

interface Entry {
  text: string;
  host: string;
  path: string;
}

function parseEntry(text: string): Entry {
  const slash = text.indexOf('/');
  const host = (slash === -1 ? text : text.slice(0, slash)).toLowerCase();
  return {text, host, path: slash === -1 ? '' : text.slice(slash)};
}

function hostMatches(entryHost: string, host: string): boolean {
  return host === entryHost || host.endsWith(`.${entryHost}`);
}

function entryMatches(entry: Entry, url: URL): boolean {
  return (
    hostMatches(entry.host, url.hostname.toLowerCase()) &&
    url.pathname.startsWith(entry.path)
  );
}

// Characters with a meaning in URLPattern syntax.
function escapePattern(text: string): string {
  return text.replace(/[\\:*?+(){}]/g, '\\$&');
}

/**
 * Which requests of a captured tab are data. Loaded from a JSON file:
 *
 * - `block`: Chrome refuses the request in --scrape mode (ads / analytics).
 * - `ignore`: the request loads but is labelled `ignored_host`.
 * - `allow`: always data for a data resource type; beats the other lists.
 * - `ignore_paths`: path pieces of beacons (`/collect`, `/pixel`).
 *
 * Host entries match the domain and its subdomains (`segment.com` matches
 * `cdn.segment.com`, not `mysegmentshop.com`); entries with a `/` also need
 * the URL path to start with the given path (`facebook.com/tr`).
 */
export class CaptureFilter {
  readonly version: number;
  readonly source: string;
  readonly ignorePaths: readonly string[];
  #block: Entry[];
  #ignore: Entry[];
  #allow: Entry[];

  constructor(config: CaptureFilterConfig, source: string) {
    this.version = config.version;
    this.source = source;
    this.ignorePaths = config.ignore_paths;
    this.#block = config.block.map(parseEntry);
    this.#ignore = config.ignore.map(parseEntry);
    this.#allow = config.allow.map(parseEntry);
  }

  static parse(json: string, source: string): CaptureFilter {
    let raw: unknown;
    try {
      raw = JSON.parse(json);
    } catch (error) {
      throw new Error(`Capture filter ${source} is not valid JSON: ${error}`);
    }
    const result = configSchema.safeParse(raw);
    if (!result.success) {
      throw new Error(
        `Capture filter ${source} is invalid: ${result.error.message}`,
      );
    }
    return new CaptureFilter(result.data, source);
  }

  /** The rule for a URL's host; `allow` wins over `block` and `ignore`. */
  hostRule(url: string): HostRule | undefined {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return undefined;
    }
    if (this.#allow.some(entry => entryMatches(entry, parsed))) {
      return 'allow';
    }
    if (this.#block.some(entry => entryMatches(entry, parsed))) {
      return 'block';
    }
    if (this.#ignore.some(entry => entryMatches(entry, parsed))) {
      return 'ignore';
    }
    return undefined;
  }

  /**
   * URLPatterns for Chrome's blocklist. Chrome cannot make exceptions, so a
   * block entry whose domain overlaps an allow entry is left out: its
   * requests load and are labelled by the capture instead.
   */
  chromeBlockPatterns(): string[] {
    const patterns: string[] = [];
    for (const entry of this.#block) {
      const overlaps = this.#allow.some(
        allow =>
          hostMatches(entry.host, allow.host) ||
          hostMatches(allow.host, entry.host),
      );
      if (overlaps) {
        logger?.(
          `Capture filter: "${entry.text}" overlaps an allow entry and is not blocked in Chrome`,
        );
        continue;
      }
      patterns.push(...this.#urlPatterns(entry));
    }
    return patterns;
  }

  /** URLPatterns of the block and ignore hosts, to hide them in listings. */
  excludePatterns(): string[] {
    return [...this.#block, ...this.#ignore].flatMap(entry =>
      this.#urlPatterns(entry),
    );
  }

  #urlPatterns(entry: Entry): string[] {
    const host = escapePattern(entry.host);
    const pathname = `${escapePattern(entry.path || '/')}*`;
    return [`*://${host}${pathname}`, `*://*.${host}${pathname}`];
  }
}

const loaded = new Map<string, CaptureFilter>();

/**
 * Loads a capture filter file, or the built-in default. Loaded once per path.
 */
export function loadCaptureFilter(file?: string): CaptureFilter {
  const source = path.resolve(file ?? DEFAULT_CAPTURE_FILTER_PATH);
  let filter = loaded.get(source);
  if (!filter) {
    filter = CaptureFilter.parse(fs.readFileSync(source, 'utf8'), source);
    loaded.set(source, filter);
  }
  return filter;
}
