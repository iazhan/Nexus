// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  createTempDir,
  launchElectronApp,
  type ElectronAppInstance
} from './smoke-harness.js';
import { createPdf } from './fixtures/documents.js';

const CTRL = 2;

describe('P3-11 PDF citation loop', () => {
  let activeApp: ElectronAppInstance | null = null;

  afterEach(async () => {
    if (activeApp) {
      await activeApp.close();
      activeApp = null;
    }
  });

  it('writes a selected PDF quote to Markdown and follows it back to the cited page', async () => {
    const workspace = createTempDir('nexus-p3-11-');
    const pdfPath = path.join(workspace, 'spec.pdf');
    const notePath = path.join(workspace, 'notes.md');
    fs.writeFileSync(pdfPath, createPdf(['Page 1', 'Page 2']));
    fs.writeFileSync(notePath, '# Notes\n\n', 'utf-8');

    activeApp = await launchElectronApp({ filePath: notePath });
    const app = activeApp;
    await app.waitForSelector('.cm-content', 20000);

    await app.evaluate(`window.nexusLocale.setLocale('en-US')`);
    await app.evaluate(`window.nexusSession.dispatch({
      changes: [{ from: 0, to: window.nexusSession.getSnapshot().source.length,
        insert: '# Notes\\n\\n[Open PDF](./spec.pdf#page=1)\\n' }]
    })`);
    await app.evaluate(`window.nexus.writeFile(${JSON.stringify(notePath)},
      window.nexusSession.getSnapshot().source)`);
    await app.click('.nexus-surface-toggle');
    await app.waitForSelector('[data-surface-kind="visual"]', 15000);
    await app.mouseClick('.cm-visual-link', CTRL);

    await app.waitForSelector('.nexus-pdf-canvas', 30000);
    await app.waitForFunction(
      `() => document.querySelector('.nexus-pdf-page')?.dataset.pageNumber === '1'`,
      15000
    );
    await app.waitForFunction(
      `() => document.querySelectorAll('.nexus-pdf-page-button')[1]?.disabled === false`,
      15000
    );
    await app.click('[data-page-nav="next"]');
    await app.waitForFunction(
      `() => document.querySelector('.nexus-pdf-page')?.dataset.pageNumber === '2'`,
      15000
    );
    await app.waitForFunction(
      `() => document.querySelector('.nexus-pdf-text-layer')?.textContent?.includes('Page 2')`,
      15000
    );

    const selectedText = await app.evaluate<string>(`(() => {
      const layer = document.querySelector('.nexus-pdf-text-layer');
      if (!layer || !layer.textContent?.includes('Page 2')) return '';
      const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        if (node.textContent?.includes('Page 2')) {
          const range = document.createRange();
          range.selectNodeContents(node);
          const selection = window.getSelection();
          selection?.removeAllRanges();
          selection?.addRange(range);
          document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
          return selection?.toString() ?? '';
        }
      }
      return '';
    })()`);
    expect(selectedText).toContain('Page 2');
    await app.waitForSelector('.nexus-pdf-citation', 5000);

    const citation = await app.getText('.nexus-pdf-citation-text');
    expect(citation).toContain('> Page 2');
    expect(citation).toContain('[spec](spec.pdf#page=2)');
    await app.click('.nexus-pdf-copy-button');
    await app.waitForFunction(
      `() => document.querySelector('.nexus-pdf-citation')?.getAttribute('data-copy-state') === 'copied'`,
      5000
    );

    const markdownWithCitation = `# Notes\n\n${citation}\n`;
    await app.click('.nexus-tab[title*="notes.md"]');
    await app.waitForSelector('.cm-content', 15000);
    await app.evaluate(`(() => {
      const session = window.nexusSession;
      const source = session.getSnapshot().source;
      session.dispatch({ changes: [{ from: 0, to: source.length,
        insert: ${JSON.stringify(markdownWithCitation)} }] });
      return window.nexus.writeFile(${JSON.stringify(notePath)}, session.getSnapshot().source);
    })()`);
    await app.click('.nexus-surface-toggle');
    await app.waitForSelector('[data-surface-kind="source"]', 10000);
    await app.click('.nexus-surface-toggle');
    await app.waitForSelector('[data-surface-kind="visual"]', 10000);
    await app.waitForSelector('.cm-visual-link', 10000);
    await app.waitForFunction(
      `() => window.nexusSession?.getSnapshot().source.includes('[spec](spec.pdf#page=2)')`,
      10000
    );
    const renderedHref = await app.evaluate<string>(
      `document.querySelector('.cm-visual-link')?.getAttribute('data-safe-href') ?? ''`
    );
    expect(renderedHref).toContain('spec.pdf#page=2');
    await app.mouseClick('.cm-visual-link', CTRL);

    try {
      await app.waitForFunction(
        `() => document.querySelector('.nexus-pdf-page')?.dataset.pageNumber === '2'`,
        15000
      );
    } catch (error) {
      const state = await app.evaluate(`(() => ({
        hrefs: Array.from(document.querySelectorAll('.cm-visual-link')).map((link) =>
          link.getAttribute('data-safe-href')
        ),
        page: document.querySelector('.nexus-pdf-page')?.getAttribute('data-page-number') ?? null,
        activeTab: document.querySelector('.nexus-tab-active .nexus-tab-name')?.textContent ?? null,
        activeKind: document.querySelector('.nexus-tab-active')?.getAttribute('data-document-kind') ?? null
      }))()`);
      throw new Error(`${error instanceof Error ? error.message : String(error)}; state=${JSON.stringify(state)}`);
    }
    expect(await app.getText('.nexus-pdf-name')).toBe('spec.pdf');
    expect(await app.evaluate<string>(
      `document.querySelector('.nexus-tab-active')?.getAttribute('data-document-kind') ?? ''`
    )).toBe('viewer');
    expect(fs.readFileSync(notePath, 'utf-8')).toContain('[spec](spec.pdf#page=2)');
  }, 90000);
});
