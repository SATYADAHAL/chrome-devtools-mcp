/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import {describe, it} from 'node:test';

import {takeSnapshot, waitFor} from '../../src/tools/snapshot.js';
import {html, withMcpContext} from '../utils.js';

describe('snapshot', () => {
  describe('browser_snapshot', () => {
    it('includes a snapshot', async () => {
      await withMcpContext(async (response, context) => {
        await takeSnapshot.handler(
          {params: {}, page: context.getSelectedMcpPage()},
          response,
          context,
        );
        assert.ok(response.includeSnapshot);
      });
    });
  });
  describe('browser_wait_for', () => {
    it('should work', async () => {
      await withMcpContext(async (response, context) => {
        const page = context.getSelectedPptrPage();

        await page.setContent(
          html`<main><span>Hello</span><span> </span><div>World</div></main>`,
        );
        await waitFor.handler(
          {
            params: {
              text: ['Hello'],
            },
            page: context.getSelectedMcpPage(),
          },
          response,
          context,
        );

        assert.equal(
          response.responseLines[0],
          'Element matching one of ["Hello"] found.',
        );
        assert.ok(response.includeSnapshot);
      });
    });

    it('should work with any-match array', async () => {
      await withMcpContext(async (response, context) => {
        const page = context.getSelectedPptrPage();

        await page.setContent(
          html`<main><span>Status</span><div>Error</div></main>`,
        );
        await waitFor.handler(
          {
            params: {
              text: ['Complete', 'Error'],
            },
            page: context.getSelectedMcpPage(),
          },
          response,
          context,
        );

        assert.equal(
          response.responseLines[0],
          'Element matching one of ["Complete","Error"] found.',
        );
        assert.ok(response.includeSnapshot);
      });
    });

    it('should work with any-match array when element shows up later', async () => {
      await withMcpContext(async (response, context) => {
        const page = context.getSelectedPptrPage();

        const handlePromise = waitFor.handler(
          {
            params: {
              text: ['Complete', 'Error'],
            },
            page: context.getSelectedMcpPage(),
          },
          response,
          context,
        );

        await page.setContent(
          html`<main
            ><span>Hello</span><span> </span><div>Complete</div></main
          >`,
        );

        await handlePromise;

        assert.equal(
          response.responseLines[0],
          'Element matching one of ["Complete","Error"] found.',
        );
        assert.ok(response.includeSnapshot);
      });
    });

    it('should work with element that show up later', async () => {
      await withMcpContext(async (response, context) => {
        const page = context.getSelectedPptrPage();

        const handlePromise = waitFor.handler(
          {
            params: {
              text: ['Hello World'],
            },
            page: context.getSelectedMcpPage(),
          },
          response,
          context,
        );

        await page.setContent(
          html`<main><span>Hello</span><span> </span><div>World</div></main>`,
        );

        await handlePromise;

        assert.equal(
          response.responseLines[0],
          'Element matching one of ["Hello World"] found.',
        );
        assert.ok(response.includeSnapshot);
      });
    });
    it('should work with aria elements', async () => {
      await withMcpContext(async (response, context) => {
        const page = context.getSelectedPptrPage();

        await page.setContent(
          html`<main><h1>Header</h1><div>Text</div></main>`,
        );

        await waitFor.handler(
          {
            params: {
              text: ['Header'],
            },
            page: context.getSelectedMcpPage(),
          },
          response,
          context,
        );

        assert.equal(
          response.responseLines[0],
          'Element matching one of ["Header"] found.',
        );
        assert.ok(response.includeSnapshot);
      });
    });

    it('should wait for networkidle', async () => {
      await withMcpContext(async (response, context) => {
        const page = context.getSelectedPptrPage();

        await page.setContent(
          html`<main><span>Loaded</span></main>`,
        );
        await waitFor.handler(
          {
            params: {waitUntil: 'networkidle'},
            page: context.getSelectedMcpPage(),
          },
          response,
          context,
        );

        assert.equal(
          response.responseLines[0],
          'Page reached "networkidle" state.',
        );
      });
    });

    it('should wait for load', async () => {
      await withMcpContext(async (response, context) => {
        const page = context.getSelectedPptrPage();

        await page.setContent(
          html`<main><span>Loaded</span></main>`,
        );
        await waitFor.handler(
          {
            params: {waitUntil: 'load'},
            page: context.getSelectedMcpPage(),
          },
          response,
          context,
        );

        assert.equal(
          response.responseLines[0],
          'Page reached "load" state.',
        );
      });
    });

    it('should wait for domcontentloaded', async () => {
      await withMcpContext(async (response, context) => {
        const page = context.getSelectedPptrPage();

        await page.setContent(
          html`<main><span>Loaded</span></main>`,
        );
        await waitFor.handler(
          {
            params: {waitUntil: 'domcontentloaded'},
            page: context.getSelectedMcpPage(),
          },
          response,
          context,
        );

        assert.equal(
          response.responseLines[0],
          'Page reached "domcontentloaded" state.',
        );
      });
    });

    it('should default to networkidle when no params provided', async () => {
      await withMcpContext(async (response, context) => {
        const page = context.getSelectedPptrPage();

        await page.setContent(
          html`<main><span>Loaded</span></main>`,
        );
        await waitFor.handler(
          {
            params: {},
            page: context.getSelectedMcpPage(),
          },
          response,
          context,
        );

        assert.equal(
          response.responseLines[0],
          'Page reached "networkidle" state.',
        );
      });
    });

    it('should work with iframe content', async () => {
      await withMcpContext(async (response, context) => {
        const page = context.getSelectedPptrPage();

        await page.setContent(
          html`<h1>Top level</h1>
            <iframe srcdoc="<p>Hello iframe</p>"></iframe>`,
        );

        await waitFor.handler(
          {
            params: {
              text: ['Hello iframe'],
            },
            page: context.getSelectedMcpPage(),
          },
          response,
          context,
        );

        assert.equal(
          response.responseLines[0],
          'Element matching one of ["Hello iframe"] found.',
        );
        assert.ok(response.includeSnapshot);
      });
    });
  });
});
