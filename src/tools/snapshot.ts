/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {zod} from '../third_party/index.js';

import {ToolCategory} from './categories.js';
import {definePageTool, timeoutSchema} from './ToolDefinition.js';

export const takeSnapshot = definePageTool({
  name: 'take_snapshot',
  description: `Take a text snapshot of the currently selected page based on the a11y tree. The snapshot lists page elements along with a unique
identifier (uid). Always use the latest snapshot. Prefer taking a snapshot over taking a screenshot. The snapshot indicates the element selected
in the DevTools Elements panel (if any).`,
  annotations: {
    category: ToolCategory.DEBUGGING,
    // Not read-only due to filePath param.
    readOnlyHint: false,
  },
  schema: {
    verbose: zod
      .boolean()
      .optional()
      .describe(
        'Whether to include all possible information available in the full a11y tree. Default is false.',
      ),
    filePath: zod
      .string()
      .optional()
      .describe(
        'The absolute path, or a path relative to the current working directory, to save the snapshot to instead of attaching it to the response.',
      ),
  },
  blockedByDialog: true,
  verifyFilesSchema: ['filePath'],
  handler: async (request, response) => {
    response.includeSnapshot({
      verbose: request.params.verbose ?? false,
      filePath: request.params.filePath,
    });
  },
});

export const waitFor = definePageTool({
  name: 'wait_for',
  description: `Wait for a condition on the selected page. Supports waiting for text to appear, or for lifecycle events like network idle.`,
  annotations: {
    category: ToolCategory.NAVIGATION,
    readOnlyHint: true,
  },
  schema: {
    text: zod
      .array(zod.string())
      .optional()
      .describe(
        'List of texts. Resolves when any value appears on the page.',
      ),
    waitUntil: zod
      .enum(['domcontentloaded', 'load', 'networkidle'])
      .optional()
      .describe(
        'Wait for the specified lifecycle event. Defaults to "networkidle" when text is not provided.',
      ),
    ...timeoutSchema,
  },
  blockedByDialog: true,
  verifyFilesSchema: [],
  handler: async (request, response, context) => {
    const page = request.page;
    if (request.params.text) {
      await context.waitForTextOnPage(
        request.params.text,
        request.params.timeout,
        page.pptrPage,
      );
      response.appendResponseLine(
        `Element matching one of ${JSON.stringify(request.params.text)} found.`,
      );
      response.includeSnapshot();
    } else {
      const condition = request.params.waitUntil ?? 'networkidle';
      await context.waitForCondition(
        condition,
        request.params.timeout,
        page.pptrPage,
      );
      response.appendResponseLine(
        `Page reached "${condition}" state.`,
      );
    }
  },
});
