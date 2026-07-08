/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {isUtf8} from 'node:buffer';

import {toPython, toPythonHttp} from 'curlconverter';
import {zod} from '../third_party/index.js';
import type {HTTPRequest, ResourceType} from '../third_party/index.js';

import {ToolCategory} from './categories.js';
import {definePageTool} from './ToolDefinition.js';

const FILTERABLE_RESOURCE_TYPES: readonly [ResourceType, ...ResourceType[]] = [
  'document',
  'stylesheet',
  'image',
  'media',
  'font',
  'script',
  'texttrack',
  'xhr',
  'fetch',
  'prefetch',
  'eventsource',
  'websocket',
  'manifest',
  'signedexchange',
  'ping',
  'cspviolationreport',
  'preflight',
  'fedcm',
  'other',
];

const SCRAPE_EXCLUDE_PATTERNS = [
  'https://*google-analytics*',
  'https://*analytics.google*',
  'https://*googletagmanager*',
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
];

export const listNetworkRequests = definePageTool(cliArgs => {
  const scrapeMode = cliArgs?.scrape ?? false;
  const defaultResourceTypes: ResourceType[] | undefined = scrapeMode
    ? ['document', 'xhr', 'fetch']
    : undefined;
  const defaultExcludePatterns: string[] | undefined = scrapeMode
    ? SCRAPE_EXCLUDE_PATTERNS
    : undefined;

  return {
    name: 'list_network_requests',
    description: `List all requests for the currently selected page since the last navigation.${
      scrapeMode
        ? ' In scrape mode, only document/xhr/fetch requests are shown by default with analytics/trackers excluded.'
        : ''
    }`,
    annotations: {
      category: ToolCategory.NETWORK,
      readOnlyHint: true,
    },
    schema: {
      pageSize: zod
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          'Maximum number of requests to return. When omitted, returns all requests.',
        ),
      pageIdx: zod
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
          'Page number to return (0-based). When omitted, returns the first page.',
        ),
      resourceTypes: zod
        .array(zod.enum(FILTERABLE_RESOURCE_TYPES))
        .optional()
        .describe(
          `Filter requests to only return requests of the specified resource types.${
            scrapeMode
              ? ' Defaults to document, xhr, fetch in scrape mode.'
              : ' When omitted or empty, returns all requests.'
          }`,
        ),
      excludeUrlPatterns: zod
        .array(zod.string())
        .optional()
        .describe(
          `URL patterns to exclude from the results.${
            scrapeMode
              ? ' In scrape mode, analytics/tracker domains are excluded by default.'
              : ''
          }`,
        ),
      includePreservedRequests: zod
        .boolean()
        .default(false)
        .optional()
        .describe(
          'Set to true to return the preserved requests over the last 3 navigations.',
        ),
    },
    blockedByDialog: false,
    verifyFilesSchema: [],
    handler: async (request, response, context) => {
      const data = await request.page.getDevToolsData();
      response.attachDevToolsData(data);
      const reqid = data?.cdpRequestId
        ? context.resolveCdpRequestId(request.page, data.cdpRequestId)
        : undefined;
      response.setIncludeNetworkRequests(true, {
        pageSize: request.params.pageSize,
        pageIdx: request.params.pageIdx,
        resourceTypes:
          request.params.resourceTypes ?? defaultResourceTypes,
        includePreservedRequests: request.params.includePreservedRequests,
        networkRequestIdInDevToolsUI: reqid,
        excludeUrlPatterns:
          request.params.excludeUrlPatterns ?? defaultExcludePatterns,
      });
    },
  };
});

export const getNetworkRequest = definePageTool({
  name: 'get_network_request',
  description: `Gets a network request by an optional reqid, if omitted returns the currently selected request in the DevTools Network panel.`,
  annotations: {
    category: ToolCategory.NETWORK,
    readOnlyHint: false,
  },
  schema: {
    reqid: zod
      .number()
      .optional()
      .describe(
        'The reqid of the network request. If omitted returns the currently selected request in the DevTools Network panel.',
      ),
    requestFilePath: zod
      .string()
      .optional()
      .describe(
        'The absolute or relative path to a .network-request file to save the request body to. If omitted, the body is returned inline.',
      ),
    responseFilePath: zod
      .string()
      .optional()
      .describe(
        'The absolute or relative path to a .network-response file to save the response body to. If omitted, the body is returned inline.',
      ),
  },
  blockedByDialog: true,
  verifyFilesSchema: ['requestFilePath', 'responseFilePath'],
  handler: async (request, response, context) => {
    if (request.params.reqid) {
      response.attachNetworkRequest(request.params.reqid, {
        requestFilePath: request.params.requestFilePath,
        responseFilePath: request.params.responseFilePath,
      });
    } else {
      const data = await request.page.getDevToolsData();
      response.attachDevToolsData(data);
      const reqid = data?.cdpRequestId
        ? context.resolveCdpRequestId(request.page, data.cdpRequestId)
        : undefined;
      if (reqid) {
        response.attachNetworkRequest(reqid, {
          requestFilePath: request.params.requestFilePath,
          responseFilePath: request.params.responseFilePath,
        });
      } else {
        response.appendResponseLine(
          `Nothing is currently selected in the DevTools Network panel.`,
        );
      }
    }
  },
});

async function generateCurlViaDevToolsSdk(
  page: import('./ToolDefinition.js').ContextPage,
  cdpRequestId: string,
  context: import('./ToolDefinition.js').Context,
): Promise<string | undefined> {
  const mcpPage = context.getSelectedMcpPage();
  const devtoolsPage = mcpPage.devToolsPage;
  if (!devtoolsPage) {
    return undefined;
  }

  try {
    return await devtoolsPage.evaluate(async (reqId: string) => {
      async function escapeStringPosix(str: string): Promise<string> {
        function escapeCharacter(x: string): string {
          const code = x.charCodeAt(0);
          let hexString = code.toString(16);
          while (hexString.length < 4) {
            hexString = '0' + hexString;
          }
          return '\\u' + hexString;
        }

        if (/[\0-\x1F\x7F-\x9F!]|\'/.test(str)) {
          return '$\'' +
            str.replace(/\\/g, '\\\\')
              .replace(/\'/g, '\\\'')
              .replace(/\n/g, '\\n')
              .replace(/\r/g, '\\r')
              .replace(/[\0-\x1F\x7F-\x9F!]/g, escapeCharacter) +
            '\'';
        }
        return '\'' + str + '\'';
      }

      const SDK = await import('/bundled/core/sdk/' + 'sdk.js');
      const networkManager = SDK.NetworkManager.NetworkManager.forAllTargets();
      if (!networkManager) {
        throw new Error('No network manager available');
      }
      const networkRequest = networkManager.requestForId(reqId);
      if (!networkRequest) {
        throw new Error('Request not found in DevTools SDK');
      }

      const command: string[] = [];
      const ignoredHeaders = new Set([
        'accept-encoding', 'host', 'method', 'path', 'scheme',
        'version', 'authority', 'protocol',
      ]);

      const validUrl = networkRequest.url();
      command.push('--url ' + (await escapeStringPosix(validUrl)).replace(/[[{}\]]/g, '\\$&'));

      let inferredMethod = 'GET';
      const data: string[] = [];
      const formData = await networkRequest.requestFormData();
      if (formData) {
        data.push('--data-raw ' + (await escapeStringPosix(formData)));
        ignoredHeaders.add('content-length');
        inferredMethod = 'POST';
      }

      if (networkRequest.requestMethod !== inferredMethod) {
        command.push('-X ' + (await escapeStringPosix(networkRequest.requestMethod)));
      }

      const requestHeaders = networkRequest.requestHeaders();
      for (let i = 0; i < requestHeaders.length; i++) {
        const header = requestHeaders[i];
        const name = header.name.replace(/^:/, '');
        if (ignoredHeaders.has(name.toLowerCase())) {
          continue;
        }
        const value = header.value;
        if (!value.trim()) {
          command.push('-H ' + (await escapeStringPosix(name + ';')));
        } else if (name.toLowerCase() === 'cookie' && value.includes('=')) {
          command.push('-b ' + (await escapeStringPosix(value)));
        } else {
          command.push('-H ' + (await escapeStringPosix(name + ': ' + value)));
        }
      }

      for (const d of data) {
        command.push(d);
      }

      return 'curl ' + command.join(command.length >= 3 ? ' \\\n  ' : ' ');
    }, cdpRequestId);
  } catch {
    return undefined;
  }
}

export const copyAsCurl = definePageTool({
  name: 'copy_as_curl',
  description: `Converts a network request to a cURL command, Python requests code, or Python http.client code. By default, returns Python requests code. Uses the currently selected request in the DevTools Network panel unless reqid is specified.`,
  annotations: {
    category: ToolCategory.NETWORK,
    readOnlyHint: true,
  },
  schema: {
    reqid: zod
      .number()
      .optional()
      .describe(
        'The reqid of the network request. If omitted returns the currently selected request in the DevTools Network panel.',
      ),
    format: zod
      .enum(['python', 'python-http', 'curl'])
      .default('python')
      .optional()
      .describe(
        'Output format: python (requests), python-http (http.client stdlib), or curl. Defaults to python.',
      ),
  },
  blockedByDialog: true,
  verifyFilesSchema: [],
  handler: async (request, response, context) => {
    let reqid: number;

    if (request.params.reqid) {
      reqid = request.params.reqid;
    } else {
      const data = await request.page.getDevToolsData();
      response.attachDevToolsData(data);
      const resolvedReqid = data?.cdpRequestId
        ? context.resolveCdpRequestId(request.page, data.cdpRequestId)
        : undefined;
      if (resolvedReqid !== undefined) {
        reqid = resolvedReqid;
      } else {
        response.appendResponseLine(
          'Nothing is currently selected in the DevTools Network panel.',
        );
        return;
      }
    }

    const httpRequest = context.getNetworkRequestById(request.page, reqid);
    // @ts-expect-error access Puppeteer internal CDP request ID
    const cdpRequestId: string = httpRequest.id;

    let curlCommand: string | undefined;
    if (cdpRequestId) {
      curlCommand = await generateCurlViaDevToolsSdk(
        request.page,
        cdpRequestId,
        context,
      );
    }

    if (curlCommand === undefined) {
      curlCommand = await buildCurlCommandFallback(httpRequest);
    }

    const stripPyComments = (code: string): string =>
      code
        .split('\n')
        .filter(line => !line.trimStart().startsWith('#'))
        .join('\n');

    const format = request.params.format ?? 'python';
    if (format === 'curl') {
      response.appendResponseLine(curlCommand);
    } else if (format === 'python') {
      response.appendResponseLine(stripPyComments(toPython(curlCommand)));
    } else {
      response.appendResponseLine(stripPyComments(toPythonHttp(curlCommand)));
    }
  },
});

async function buildCurlCommandFallback(request: HTTPRequest): Promise<string> {
  const parts: string[] = [];

  const method = request.method();
  const url = request.url();
  const headers = request.headers();

  function escapeShellSingleQuote(value: string): string {
    return `'${value.replace(/'/g, "'\\''")}'`;
  }

  parts.push(`curl ${escapeShellSingleQuote(url)}`);

  if (method !== 'GET') {
    parts.push(`  -X ${method}`);
  }

  for (const [name, value] of Object.entries(headers)) {
    if (name.startsWith(':')) {
      continue;
    }
    parts.push(`  -H ${escapeShellSingleQuote(`${name}: ${value}`)}`);
  }

  if (request.hasPostData()) {
    let postData: string | undefined;
    try {
      postData = request.postData() ?? undefined;
    } catch {
      // ignore
    }
    if (postData === undefined) {
      try {
        postData = await request.fetchPostData();
      } catch {
        // ignore
      }
    }
    if (postData) {
      parts.push(`  --data-raw ${escapeShellSingleQuote(postData)}`);
    }
  }

  return parts.join(' \\\n');
}

const SNIPPET_CONTEXT = 60;

function findSnippet(text: string, matchIndex: number, matchLength: number): string {
  const start = Math.max(0, matchIndex - SNIPPET_CONTEXT);
  const end = Math.min(text.length, matchIndex + matchLength + SNIPPET_CONTEXT);
  const prefix = start > 0 ? '...' : '';
  const suffix = end < text.length ? '...' : '';
  return prefix + text.slice(start, end) + suffix;
}

function normalizeUnicodeEscapes(text: string): string {
  return text.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16)),
  );
}

function searchBody(
  body: string,
  pattern: string,
): {matched: boolean; snippet: string} | undefined {
  body = normalizeUnicodeEscapes(body);
  try {
    const regex = new RegExp(pattern, 'gs');
    const match = regex.exec(body);
    if (match) {
      return {
        matched: true,
        snippet: findSnippet(body, match.index, match[0].length),
      };
    }
  } catch {
    if (body.includes(pattern)) {
      const idx = body.indexOf(pattern);
      return {
        matched: true,
        snippet: findSnippet(body, idx, pattern.length),
      };
    }
  }
  return undefined;
}

export const searchNetwork = definePageTool(cliArgs => {
  const scrapeMode = cliArgs?.scrape ?? false;
  const defaultResourceTypes: ResourceType[] | undefined = scrapeMode
    ? ['document', 'xhr', 'fetch']
    : undefined;

  return {
    name: 'search_network',
    description: `Searches network request and response bodies for a pattern. Checks URLs, request bodies, and response bodies of all captured requests.${
      scrapeMode
        ? ' In scrape mode, only document/xhr/fetch requests are searched by default.'
        : ''
    }`,
    annotations: {
      category: ToolCategory.NETWORK,
      readOnlyHint: true,
    },
    schema: {
      pattern: zod
        .string()
        .describe(
          'Text or regex pattern to search for in request/response bodies and URLs.',
        ),
      resourceTypes: zod
        .array(zod.enum(FILTERABLE_RESOURCE_TYPES))
        .optional()
        .describe(
          `Filter to only search requests of the specified resource types.${
            scrapeMode
              ? ' Defaults to document, xhr, fetch in scrape mode.'
              : ' When omitted or empty, searches all types.'
          }`,
        ),
      includePreservedRequests: zod
        .boolean()
        .default(false)
        .optional()
        .describe(
          'Set to true to search preserved requests from the last 3 navigations.',
        ),
      pageSize: zod
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          'Maximum number of matches to return. When omitted, returns all matches.',
        ),
      pageIdx: zod
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
          'Page number to return (0-based). When omitted, returns the first page.',
        ),
    },
    blockedByDialog: false,
    verifyFilesSchema: [],
    handler: async (request, response, context) => {
      const pattern = request.params.pattern;
      const includePreserved = request.params.includePreservedRequests ?? false;

      let requests = context.getNetworkRequests(
        request.page,
        includePreserved,
      );

      const typesFilter = request.params.resourceTypes ?? defaultResourceTypes;
      if (typesFilter?.length) {
        const types = new Set(typesFilter);
        requests = requests.filter(r => types.has(r.resourceType()));
      }

    interface Match {
      reqid: number;
      method: string;
      url: string;
      status: string;
      resourceType: string;
      matchSource: string;
      snippet: string;
    }

    const matches: Match[] = [];

    for (const req of requests) {
      const reqid = context.getNetworkRequestStableId(req);
      const method = req.method();
      const url = req.url();
      const resourceType = req.resourceType();
      const httpResponse = req.response();
      const status = httpResponse
        ? httpResponse.status().toString()
        : req.failure()?.errorText ?? 'pending';

      // Check URL
      const urlMatch = searchBody(url, pattern);
      if (urlMatch) {
        matches.push({
          reqid,
          method,
          url,
          status,
          resourceType,
          matchSource: 'url',
          snippet: urlMatch.snippet,
        });
        continue;
      }

      // Check request body
      if (req.hasPostData()) {
        let body: string | undefined;
        try {
          body = req.postData() ?? undefined;
        } catch {
          // ignore
        }
        if (body === undefined) {
          try {
            body = await req.fetchPostData();
          } catch {
            // ignore
          }
        }
        if (body) {
          const bodyMatch = searchBody(body, pattern);
          if (bodyMatch) {
            matches.push({
              reqid,
              method,
              url,
              status,
              resourceType,
              matchSource: 'requestBody',
              snippet: bodyMatch.snippet,
            });
            continue;
          }
        }
      }

      // Check response body
      if (httpResponse) {
        try {
          const buffer = await httpResponse.buffer();
          if (isUtf8(buffer)) {
            const text = buffer.toString('utf-8');
            const bodyMatch = searchBody(text, pattern);
            if (bodyMatch) {
              matches.push({
                reqid,
                method,
                url,
                status,
                resourceType,
                matchSource: 'responseBody',
                snippet: bodyMatch.snippet,
              });
            }
          }
        } catch {
          // Response body not available
        }
      }
    }

    if (matches.length === 0) {
      response.appendResponseLine(
        `No network requests matched pattern: ${pattern}`,
      );
      return;
    }

    response.appendResponseLine(
      `Found ${matches.length} network request(s) matching: ${pattern}`,
    );
    response.appendResponseLine('');

    for (const match of matches) {
      response.appendResponseLine(
        `reqid=${match.reqid} ${match.method} ${match.url} [${match.status}] (${match.resourceType})`,
      );
      response.appendResponseLine(`  matched in: ${match.matchSource}`);
      response.appendResponseLine(`  snippet: ${match.snippet}`);
      response.appendResponseLine('');
    }
  },
  };
});
