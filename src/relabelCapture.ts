/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import {detectAntibot} from './antibot.js';
import {type BodyFormat, sniffBody} from './bodyFormat.js';
import type {CaptureFilter} from './CaptureFilter.js';
import {
  bodyDestination,
  DEFAULT_CAPTURE_RESOURCE_TYPES,
  type DropReason,
  labelRequest,
  labelResponse,
} from './captureLabels.js';
import {zod} from './third_party/index.js';

// What is read from requests.jsonl and <reqid>.json; other keys are kept as
// they are.
const lineSchema = zod
  .object({
    reqid: zod.number(),
    method: zod.string(),
    url: zod.string(),
    status: zod.string(),
    resourceType: zod.string(),
    contentType: zod.string().optional(),
    bytes: zod.number().optional(),
    format: zod.string().optional(),
    bodyFile: zod.string().optional(),
    evidenceFile: zod.string().optional(),
    bodyError: zod.string().optional(),
    drop: zod.string().optional(),
    antibot: zod.string().optional(),
    duplicateOf: zod.number().optional(),
    responseHeaders: zod.record(zod.string(), zod.string()).optional(),
  })
  .passthrough();

type Line = zod.infer<typeof lineSchema>;

const manifestSchema = zod
  .object({
    resourceTypes: zod.array(zod.string()).optional(),
    filter_version: zod.number().optional(),
  })
  .passthrough();

const FORMATS: readonly BodyFormat[] = [
  'json',
  'jsonp',
  'html',
  'xml',
  'js',
  'text',
  'binary',
  'empty',
];

function asFormat(value: string | undefined): BodyFormat | undefined {
  return FORMATS.find(format => format === value);
}

async function exists(file: string): Promise<boolean> {
  return fs
    .stat(file)
    .then(() => true)
    .catch(() => false);
}

export interface RelabelResult {
  dir: string;
  fromVersion?: number;
  toVersion: number;
  lines: number;
  // "old -> new" label transitions, e.g. {"beacon -> data": 2}.
  changed: Record<string, number>;
  // Lines that became data, but whose body was never read in the run.
  bodyMissing: number;
}

interface Relabelled {
  drop?: DropReason;
  format?: BodyFormat;
  bodyFile?: string;
  evidenceFile?: string;
  antibot?: string;
  bodyMissing?: boolean;
}

async function relabelLine(
  dir: string,
  line: Line,
  meta: Line,
  filter: CaptureFilter,
  resourceTypes: ReadonlySet<string>,
): Promise<Relabelled> {
  const rules = {filter, resourceTypes};
  const status = /^\d+$/.test(line.status) ? Number(line.status) : undefined;
  const failed = status === undefined;
  let drop = labelRequest(
    {
      method: line.method,
      url: line.url,
      resourceType: line.resourceType,
      failed,
      // Requests Chrome refused never loaded, whatever the filter says now.
      blocked: failed && line.drop === 'tracker',
    },
    rules,
  );

  const file = meta.bodyFile ?? meta.evidenceFile;
  const body =
    file && (await exists(path.join(dir, file)))
      ? await fs.readFile(path.join(dir, file))
      : undefined;
  const contentType = line.contentType ?? '';
  const format =
    asFormat(meta.format) ??
    (body ? sniffBody(body, contentType).format : undefined);
  const bytes = meta.bytes ?? body?.length ?? 0;
  // The run read the body if it saved it, sniffed it or found none.
  const bodyRead =
    body !== undefined ||
    format !== undefined ||
    meta.bodyError !== undefined ||
    line.drop === 'too_large';

  let bodyMissing = false;
  if (drop === undefined && status !== undefined) {
    if (bodyRead) {
      drop = labelResponse(
        {
          url: line.url,
          status,
          contentType,
          bytes,
          format,
          hasBody: body !== undefined || (format !== undefined && bytes > 0),
        },
        rules,
      );
    } else {
      // Dropped before its body was read; only a new run can get it.
      bodyMissing = true;
    }
  }

  // Nothing is deleted: a saved body is data (bodyFile) or evidence.
  const destination = bodyDestination(drop, format, bytes);
  const saved = body ? file : undefined;
  const antibot =
    detectAntibot({
      url: line.url,
      status,
      headers: meta.responseHeaders ?? {},
      body: body?.subarray(0, 50_000).toString('utf8'),
    }) ?? line.antibot;
  return {
    drop,
    format,
    bodyFile: destination === 'body' ? saved : undefined,
    evidenceFile: destination === 'body' ? undefined : saved,
    antibot,
    bodyMissing: bodyMissing || undefined,
  };
}

/**
 * Re-applies a capture filter to a saved capture folder: rewrites the labels
 * in requests.jsonl and <reqid>.json and the counts in capture.json. The
 * previous requests.jsonl is kept as requests.v<version>.jsonl. Body files
 * are never deleted, only referenced as bodyFile or evidenceFile.
 */
export async function relabelCapture(
  dir: string,
  filter: CaptureFilter,
): Promise<RelabelResult> {
  const jsonlPath = path.join(dir, 'requests.jsonl');
  const manifestPath = path.join(dir, 'capture.json');
  const manifest = manifestSchema.parse(
    JSON.parse(await fs.readFile(manifestPath, 'utf8')),
  );
  const resourceTypes = new Set(
    manifest.resourceTypes?.length
      ? manifest.resourceTypes
      : DEFAULT_CAPTURE_RESOURCE_TYPES,
  );
  const text = await fs.readFile(jsonlPath, 'utf8');
  const lines = text
    .split('\n')
    .filter(Boolean)
    .map(raw => lineSchema.parse(JSON.parse(raw)));

  const result: RelabelResult = {
    dir,
    fromVersion: manifest.filter_version,
    toVersion: filter.version,
    lines: lines.length,
    changed: {},
    bodyMissing: 0,
  };
  const counts = {data: 0, blocked: 0, duplicates: 0};
  const dropped: Partial<Record<DropReason, number>> = {};
  const antibots: Record<string, number> = {};
  const output: string[] = [];

  for (const line of lines) {
    const metaPath = path.join(dir, `${line.reqid}.json`);
    const meta = (await exists(metaPath))
      ? lineSchema.parse(JSON.parse(await fs.readFile(metaPath, 'utf8')))
      : line;
    const label = await relabelLine(dir, line, meta, filter, resourceTypes);
    const data = label.drop === undefined;
    const update = {
      data,
      drop: label.drop,
      format: label.format,
      bodyFile: label.bodyFile,
      evidenceFile: label.evidenceFile,
      antibot: label.antibot,
      bodyMissing: label.bodyMissing,
    };

    const before = line.drop ?? 'data';
    const after = label.drop ?? 'data';
    if (before !== after) {
      const key = `${before} -> ${after}`;
      result.changed[key] = (result.changed[key] ?? 0) + 1;
    }
    if (label.bodyMissing) {
      result.bodyMissing++;
    }
    if (data) {
      counts.data++;
    } else if (label.drop) {
      dropped[label.drop] = (dropped[label.drop] ?? 0) + 1;
      if (label.drop === 'tracker' && !/^\d+$/.test(line.status)) {
        counts.blocked++;
      }
    }
    if (line.duplicateOf !== undefined) {
      counts.duplicates++;
    }
    if (label.antibot) {
      antibots[label.antibot] = (antibots[label.antibot] ?? 0) + 1;
    }

    output.push(JSON.stringify({...line, ...update}));
    if (meta !== line) {
      await fs.writeFile(
        metaPath,
        JSON.stringify({...meta, ...update}, null, 1),
      );
    }
  }

  const backup = path.join(
    dir,
    `requests.v${manifest.filter_version ?? 'unknown'}.jsonl`,
  );
  if (!(await exists(backup))) {
    await fs.writeFile(backup, text);
  }
  await fs.writeFile(jsonlPath, output.map(row => `${row}\n`).join(''));
  await fs.writeFile(
    manifestPath,
    JSON.stringify(
      {
        ...manifest,
        saved: lines.length,
        ...counts,
        dropped,
        antibot: antibots,
        filter_version: filter.version,
        filter_source: filter.source,
        relabeledFrom: manifest.filter_version,
        relabeledAt: new Date().toISOString(),
      },
      null,
      1,
    ),
  );
  return result;
}
