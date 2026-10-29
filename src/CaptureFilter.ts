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
  block_subdomains: zod.array(zod.string()).default([]),
});

export type CaptureFilterConfig = zod.infer<typeof configSchema>;

/** What the filter says about a URL's host. */
export type HostRule = 'allow' | 'block' | 'ignore';

interface Entry {
  text: string;
  // Lower-case domain, without the trailing `.*` of an any-suffix entry.
  host: string;
  // `google.*`: the domain under any public suffix (.com, .com.au, .co.uk).
  anySuffix: boolean;
  path: string;
}

function parseEntry(text: string): Entry {
  const slash = text.indexOf('/');
  let host = (slash === -1 ? text : text.slice(0, slash)).toLowerCase();
  const anySuffix = host.endsWith('.*');
  if (anySuffix) {
    host = host.slice(0, -2);
  }
  return {text, host, anySuffix, path: slash === -1 ? '' : text.slice(slash)};
}

function isDomainOf(domain: string, host: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

function hostMatches(entry: Entry, host: string): boolean {
  if (!entry.host) {
    // A path-only entry (`/cdn-cgi/`) applies to every host.
    return true;
  }
  if (!entry.anySuffix) {
    return isDomainOf(entry.host, host);
  }
  // Strip a one- or two-label public suffix (com, com.au) and compare.
  const labels = host.split('.');
  for (const suffixLength of [1, 2]) {
    if (labels.length > suffixLength) {
      const rest = labels.slice(0, -suffixLength).join('.');
      if (isDomainOf(entry.host, rest)) {
        return true;
      }
    }
  }
  return false;
}

function entryMatches(entry: Entry, url: URL): boolean {
  return (
    hostMatches(entry, url.hostname.toLowerCase()) &&
    url.pathname.startsWith(entry.path)
  );
}

/**
 * Whether the host's first label is `name`, optionally followed by digits,
 * on a site's subdomain: `gtm` matches gtm.shop.com and gtm2.shop.com.au,
 * not gtmetrix.com or gtm.com.
 */
function subdomainMatches(name: string, host: string): boolean {
  const labels = host.split('.');
  if (labels.length < 3) {
    return false;
  }
  const first = labels[0];
  return (
    first === name ||
    (first.startsWith(name) && /^\d+$/.test(first.slice(name.length)))
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
 * the URL path to start with the given path (`facebook.com/tr`); `google.*`
 * matches the domain under any public suffix (`google.com.au`); an entry
 * starting with `/` is a path prefix on any host (`/cdn-cgi/`).
 * `block_subdomains` blocks first-party proxies by their first host label on
 * any site (`gtm` blocks gtm2.shop.com, the Google Tag Manager proxy).
 */
export class CaptureFilter {
  readonly version: number;
  readonly source: string;
  readonly ignorePaths: readonly string[];
  #block: Entry[];
  #ignore: Entry[];
  #allow: Entry[];
  #blockSubdomains: string[];

  constructor(config: CaptureFilterConfig, source: string) {
    this.version = config.version;
    this.source = source;
    this.ignorePaths = config.ignore_paths;
    this.#block = config.block.map(parseEntry);
    this.#ignore = config.ignore.map(parseEntry);
    this.#allow = config.allow.map(parseEntry);
    this.#blockSubdomains = config.block_subdomains.map(name =>
      name.toLowerCase(),
    );
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
    const host = parsed.hostname.toLowerCase();
    if (
      this.#block.some(entry => entryMatches(entry, parsed)) ||
      this.#blockSubdomains.some(name => subdomainMatches(name, host))
    ) {
      return 'block';
    }
    if (this.#ignore.some(entry => entryMatches(entry, parsed))) {
      return 'ignore';
    }
    return undefined;
  }

  /**
   * Whether the URL path contains an `ignore_paths` piece as whole path
   * segments: `/log` matches /log, /api/log/x and /log.gif, not /login,
   * /logo.png or /blog. A piece ending in a non-word character
   * (`/monorail/`, `/web-pixels@`) matches as is.
   */
  ignoredPath(url: string): boolean {
    let pathname: string;
    try {
      pathname = new URL(url).pathname.toLowerCase();
    } catch {
      return false;
    }
    return this.ignorePaths.some(piece => {
      const needle = piece.toLowerCase();
      for (
        let at = pathname.indexOf(needle);
        at !== -1;
        at = pathname.indexOf(needle, at + 1)
      ) {
        const next = pathname[at + needle.length];
        if (/\W$/.test(needle) || next === undefined || /[/.;]/.test(next)) {
          return true;
        }
      }
      return false;
    });
  }

  /**
   * URLPatterns for Chrome's blocklist. Chrome cannot make exceptions, so a
   * block entry whose domain overlaps an allow entry is left out: its
   * requests load and are labelled by the capture instead.
   */
  chromeBlockPatterns(): string[] {
    const patterns: string[] = [];
    for (const entry of this.#block) {
      // Path-only allow entries cannot be checked against hosts.
      const overlaps = this.#allow.some(
        allow =>
          allow.host !== '' &&
          (hostMatches(entry, allow.host) || hostMatches(allow, entry.host)),
      );
      if (overlaps) {
        logger?.(
          `Capture filter: "${entry.text}" overlaps an allow entry and is not blocked in Chrome`,
        );
        continue;
      }
      patterns.push(...this.#urlPatterns(entry));
    }
    for (const name of this.#blockSubdomains) {
      // Plain patterns, no regex groups: gtm.*.*, gtm0.*.* ... gtm9.*.*
      // (`.*.*` keeps a site domain after the label, as subdomainMatches).
      for (const digit of ['', ...'0123456789']) {
        patterns.push(`*://${escapePattern(name + digit)}.*.*`);
      }
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
    const pathname = `${escapePattern(entry.path || '/')}*`;
    if (!entry.host) {
      return [`*://*${pathname}`];
    }
    const host = escapePattern(entry.host) + (entry.anySuffix ? '.*' : '');
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
