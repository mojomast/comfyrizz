// @ts-nocheck
// UR32: the Export step's pure render functions.

import test from 'node:test';
import assert from 'node:assert/strict';

import { COPY } from '../src/easy/copy.ts';
import {
  exportFileName,
  renderExportDone,
  renderExportError,
  renderExportStale,
  renderExportWorking,
} from '../src/easy/steps/export.ts';

test('the working state has a progressbar', () => {
  const html = renderExportWorking(40);
  assert.match(html, /role="progressbar"/);
  assert.match(html, /aria-valuenow="40"/);
  assert.match(html, new RegExp(COPY.export.working));
});

test('the done state has the heading, video, download link and QA text', () => {
  const html = renderExportDone({
    name: 'Crumb & Co',
    blobUrl: 'blob:https://example.test/123',
    durationS: 30,
    aspect: '16:9',
    sizeBytes: 3_000_000,
    qa: { passed: true, notes: 0 },
    narration: true,
    captionsUrl: '/api/export/x/captions.vtt',
  });
  assert.match(html, new RegExp(COPY.export.doneHeading));
  assert.match(html, /<video\b[^>]*controls/);
  assert.match(html, /<track\b[^>]*kind="captions"/);
  assert.match(html, /src="\/api\/export\/x\/captions\.vtt"/);
  assert.match(html, /Crumb &amp; Co · 0:30 · 16:9 · 3\.0 MB/);
  assert.match(html, /<a\b[^>]*download="crumb-co\.mp4"[^>]*href="blob:https:\/\/example\.test\/123"/);
  assert.match(html, new RegExp(COPY.export.download));
  assert.match(html, new RegExp(COPY.export.qaPass));
});

test('the failure state has role=alert with the reason and both actions', () => {
  const html = renderExportError('the server said no');
  assert.match(html, /role="alert"/);
  assert.match(html, /the server said no/);
  assert.match(html, new RegExp(COPY.export.retry));
  assert.match(html, new RegExp(COPY.shell.openEditor));
});

test('the stale text shows when the file is older than the latest changes', () => {
  const html = renderExportDone({
    name: 'Crumb & Co',
    blobUrl: 'blob:https://example.test/123',
    stale: true,
  });
  assert.match(html, new RegExp(COPY.export.stale));
  assert.match(html, new RegExp(COPY.export.again));

  const staleOnly = renderExportStale();
  assert.match(staleOnly, new RegExp(COPY.export.stale));
  assert.match(staleOnly, new RegExp(COPY.export.again));
});

test('the download file name is slugified', () => {
  assert.equal(exportFileName('Crumb & Co'), 'crumb-co.mp4');
  assert.equal(exportFileName('  Crumb & Co  '), 'crumb-co.mp4');
  assert.equal(exportFileName(''), 'video.mp4');
});
