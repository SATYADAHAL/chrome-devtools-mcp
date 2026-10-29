/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tracker, analytics and marketing hosts blocked in --scrape mode. Each
 * pattern matches on the hostname, for any path.
 */
export const SCRAPE_TRACKER_PATTERNS = [
  'https://*google-analytics*',
  'https://*analytics.google*',
  'https://*googletagmanager*',
  // First-party Google Tag Manager proxies (gtm2.shop.com, sgtm.shop.com).
  'https://gtm*',
  'https://sgtm*',
  'https://*doubleclick*',
  'https://*clarity.ms*',
  'https://*facebook*',
  'https://*recaptcha*',
  'https://*firebase*',
  'https://*gstatic*',
  'https://*hotjar*',
  'https://*mouseflow*',
  'https://*fullstory*',
  'https://*crazyegg*',
  'https://*amplitude*',
  'https://*mixpanel*',
  'https://*segment*',
  'https://*sentry*',
  'https://*criteo*',
  'https://*visualwebsiteoptimizer*',
  'https://*braze*',
  'https://*cfjump*',
  'https://*cloudflareinsights*',
  'https://*google.np*',
  // Google Ads remarketing and conversion pings on google.<tld> itself, which
  // cannot be blocked by host (www.google.com/rmkt/collect, /pagead/1p-user-list).
  'https://*google.*/rmkt/*',
  'https://*google.*/pagead/*',
  'https://*google.*/ccm/*',
  'https://*google.*/ads/*',
  'https://*googleadservices*',
  'https://*googlesyndication*',
];
