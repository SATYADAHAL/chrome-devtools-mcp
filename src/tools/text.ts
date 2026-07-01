/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {zod} from '../third_party/index.js';

import {ToolCategory} from './categories.js';
import {definePageTool} from './ToolDefinition.js';

export const getPageVisibleTexts = definePageTool({
  name: 'get_page_visible_texts',
  description: `Get visible text content from the currently selected page. Returns the text rendered on the page, excluding hidden elements, scripts, and styles.`,
  annotations: {
    category: ToolCategory.DEBUGGING,
    readOnlyHint: true,
  },
  schema: {
    selector: zod
      .string()
      .optional()
      .describe(
        'A CSS selector to scope text extraction to a specific element. If omitted, extracts text from the entire page.',
      ),
    filePath: zod
      .string()
      .optional()
      .describe(
        'The absolute or relative path to a .txt file to save the extracted text to.',
      ),
  },
  blockedByDialog: true,
  verifyFilesSchema: ['filePath'],
  handler: async (request, response, context) => {
    const {selector, filePath} = request.params;
    const page = request.page.pptrPage;

    const visibleText = await page.evaluate((sel: string | undefined) => {
      const root = sel ? document.querySelector(sel) : document.body;
      if (!root || !(root instanceof HTMLElement)) return '';
      return root.innerText;
    }, selector);

    if (filePath) {
      const data = new TextEncoder().encode(visibleText);
      const {filename} = await context.saveFile(data, filePath, '.txt');
      response.appendResponseLine(`Visible text saved to ${filename}.`);
    } else {
      response.appendResponseLine(visibleText);
    }
  },
});
