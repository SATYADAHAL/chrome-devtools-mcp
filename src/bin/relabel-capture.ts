#!/usr/bin/env node

/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Re-applies the capture filter to saved capture folders:
//   npm run capture:relabel -- <capture-dir>... [--capture-filter file.json]

import {parseArgs} from 'node:util';

import {loadCaptureFilter} from '../CaptureFilter.js';
import {relabelCapture} from '../relabelCapture.js';

const {values, positionals} = parseArgs({
  allowPositionals: true,
  options: {'capture-filter': {type: 'string'}},
});

if (!positionals.length) {
  console.error(
    'Usage: npm run capture:relabel -- <capture-dir>... [--capture-filter file.json]',
  );
  process.exit(1);
}

const filter = loadCaptureFilter(values['capture-filter']);
let failed = 0;
for (const dir of positionals) {
  try {
    const result = await relabelCapture(dir, filter);
    const changes =
      Object.entries(result.changed)
        .map(([change, count]) => `${change}: ${count}`)
        .join(', ') || 'no label changed';
    console.log(
      `${dir}: filter v${result.fromVersion ?? '?'} -> v${result.toVersion}, ` +
        `${result.lines} line(s); ${changes}` +
        (result.bodyMissing
          ? `; ${result.bodyMissing} became data but their body was never saved (re-run to get it)`
          : ''),
    );
  } catch (error) {
    failed++;
    console.error(`${dir}: ${error instanceof Error ? error.message : error}`);
  }
}
process.exit(failed ? 1 : 0);
