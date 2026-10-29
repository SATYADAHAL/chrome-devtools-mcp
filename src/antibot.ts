/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export interface AntibotInput {
  url: string;
  status?: number;
  // Response headers, lower-case names; several Set-Cookie joined by '\n'.
  headers: Record<string, string>;
  // The start of the response body, when it was read.
  body?: string;
}

interface VendorRule {
  vendor: string;
  hosts?: string[];
  paths?: string[];
  headers?: RegExp;
  cookies?: RegExp;
  // Only looked for in the body of a 403 / 429 / 503 response.
  body?: RegExp;
}

// Detection only: which vendor protects the site, so a missing response can
// be explained. Nothing here tries to get around it.
const RULES: VendorRule[] = [
  {
    vendor: 'cloudflare',
    hosts: ['challenges.cloudflare.com'],
    paths: ['/cdn-cgi/challenge-platform/'],
    headers: /^cf-mitigated$/,
    body: /just a moment|attention required|cf-chl|challenge-platform|cf_chl_opt/i,
  },
  {
    vendor: 'datadome',
    hosts: ['captcha-delivery.com', 'datadome.co'],
    headers: /^x-datadome|^x-dd-b$/,
    cookies: /(^|\n|;\s*)datadome=/i,
    body: /captcha-delivery\.com|datadome/i,
  },
  {
    vendor: 'perimeterx',
    hosts: [
      'perimeterx.net',
      'px-cdn.net',
      'px-cloud.net',
      'px-client.net',
      'pxchk.net',
    ],
    cookies: /(^|\n|;\s*)_px\w*=/,
    body: /px-captcha|_pxappid|perimeterx|press & hold/i,
  },
  {
    vendor: 'kasada',
    headers: /^x-kpsdk-/,
    body: /kpsdk/i,
  },
  {
    vendor: 'imperva',
    headers: /^x-iinfo$/,
    cookies: /(^|\n|;\s*)(incap_ses_|visid_incap_|reese84=)/i,
    body: /_incapsula_resource|incapsula incident id/i,
  },
  {
    vendor: 'akamai',
    body: /errors\.edgesuite\.net|reference #\d|access denied.{0,200}akamai/is,
  },
  {
    vendor: 'aws_waf',
    hosts: ['awswaf.com'],
    headers: /^x-amzn-waf-action$/,
    cookies: /(^|\n|;\s*)aws-waf-token=/,
    body: /aws-waf-token|awswaf/i,
  },
  {
    vendor: 'queue-it',
    hosts: ['queue-it.net'],
    body: /queue-it/i,
  },
];

const CHALLENGE_STATUSES = new Set([403, 429, 503]);

function onHost(host: string, domains: string[] | undefined): boolean {
  return (
    domains?.some(domain => host === domain || host.endsWith(`.${domain}`)) ??
    false
  );
}

/**
 * The anti-bot vendor a response points at, `unknown` for a challenge-like
 * HTML error page of no known vendor, or undefined.
 */
export function detectAntibot(input: AntibotInput): string | undefined {
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    return undefined;
  }
  const host = url.hostname.toLowerCase();
  const headerNames = Object.keys(input.headers);
  const cookies = input.headers['set-cookie'] ?? '';
  const challenged =
    input.status !== undefined && CHALLENGE_STATUSES.has(input.status);
  const server = input.headers['server'] ?? '';

  for (const rule of RULES) {
    if (
      onHost(host, rule.hosts) ||
      rule.paths?.some(piece => url.pathname.startsWith(piece)) ||
      (rule.headers && headerNames.some(name => rule.headers?.test(name))) ||
      (rule.cookies && rule.cookies.test(cookies)) ||
      (challenged && input.body && rule.body?.test(input.body))
    ) {
      return rule.vendor;
    }
  }
  if (challenged && /akamaighost/i.test(server)) {
    return 'akamai';
  }
  if (challenged && /<html|<body|<!doctype/i.test(input.body ?? '')) {
    return 'unknown';
  }
  return undefined;
}
