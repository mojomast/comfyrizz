// AV19: main.ts is the mount seam. The shell is a top-level script, so this
// pins its wiring directly: rows use the AV07 renderer, thumbs hydrate through
// the AV05 client, list clicks and timeline chips open the AV10 viewer, the
// AV12 iterate panel is mounted from the viewer, and submit either sends one
// scoped chat turn (bound) or pre-fills the composer (unbound) without sending.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const MAIN = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');

function functionBody(name: string): string {
  const start = MAIN.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `main.ts must define ${name}`);
  const candidates = [
    MAIN.indexOf('\nfunction ', start + 1),
    MAIN.indexOf('\nasync function ', start + 1),
  ].filter(index => index >= 0);
  const end = candidates.length > 0 ? Math.min(...candidates) : MAIN.length;
  return MAIN.slice(start, end);
}

test('the asset list renders AV07 rows and hydrates only that page through the thumbs client', () => {
  assert.match(
    MAIN,
    /import\s*\{[^}]*assetRowHtml[^}]*hydrateAssetThumbs[^}]*\}\s*from\s*'\.\/assets\/asset-row\.ts'/,
  );
  assert.match(MAIN, /createThumbsClient\(\{\s*fetch:\s*apiFetch\s*\}\)/);

  const body = functionBody('renderAssets');
  assert.match(body, /assetRowHtml\(id, asset, \{ pkg \}\)/);
  assert.match(body, /hydrateAssetThumbs\(host, assetThumbsClient, \{/);
  assert.match(body, /packageId/);
  assert.match(MAIN, /const packageId = String\(pkg\.id \?\? ''\)/);
  assert.match(body, /observerFactory/);
  assert.doesNotMatch(body, /<div class="asset job-row rail-row/);
});

test('clicking a row thumb opens the viewer over the filtered list and returns focus to it', () => {
  assert.match(MAIN, /closest<HTMLButtonElement>\('button\[data-asset-open\]'\)/);
  assert.match(MAIN, /openAssetListViewer\(entries, index, open\)/);

  const body = functionBody('openAssetListViewer');
  assert.match(body, /showViewer\(items, index, opener/);
  const viewer = functionBody('showViewer');
  assert.match(viewer, /mountAssetViewer\(/);
  assert.match(viewer, /items/);
  assert.match(viewer, /index/);
  assert.match(viewer, /opener/);
  assert.match(viewer, /onIterate/);
});

test('the timeline receives thumbs and onClipOpen; the review drawer gets onOpenViewer', () => {
  assert.match(MAIN, /mountSceneTimeline\(timelineHost, editorStore, timelineHooks\)/);
  assert.match(MAIN, /thumbs:\s*assetThumbsClient/);
  assert.match(MAIN, /onClipOpen:\s*chip\s*=>\s*openClipChip\(chip\)/);
  assert.match(MAIN, /onOpenViewer/);
  assert.match(MAIN, /data-review-open-viewer/);
  assert.match(MAIN, /document\.addEventListener\('click', onReviewViewerClick, true\)/);
  assert.match(MAIN, /timelineHost\.addEventListener\('dblclick', onTimelineClipActivate\)/);
  assert.match(MAIN, /timelineHost\.addEventListener\('keydown', onTimelineClipActivate, true\)/);
  assert.match(MAIN, /openClipViewer\(/);
});

test('the viewer iterate action mounts the AV12 panel with the viewer annotation state', () => {
  const body = functionBody('showIteratePanel');
  assert.match(body, /mountIteratePanel\(/);
  assert.match(body, /host/);
  assert.match(body, /target/);
  assert.match(body, /viewer:\s*viewer\.state/);
  assert.match(body, /productionId:\s*lookupBoundProductionId\(\) \?\? ''/);
  assert.match(body, /onSubmit:\s*scope\s*=>\s*submitIteration\(scope\)/);

  const viewer = functionBody('showViewer');
  assert.match(viewer, /onIterate/);
  assert.match(viewer, /showIteratePanel\(payload, handle\)/);
});

test('submit on a bound production sends exactly one scoped chat turn and starts nothing', () => {
  const body = functionBody('submitIteration');
  assert.match(body, /const bound = lookupBoundProductionId\(\)/);
  assert.match(body, /if \(bound\)/);
  assert.match(body, /pendingIterationScope = \{ scope, note: scope\.note/);
  assert.match(body, /projectChat\.send\(scope\.note, 'plan'\)/);
  assert.equal((body.match(/projectChat\.send\(/g) ?? []).length, 1);

  const chat = functionBody('chatApiFetch');
  assert.match(chat, /iterationScope:\s*pending\.scope/);
  assert.match(MAIN, /apiFetch:\s*chatApiFetch/);

  assert.doesNotMatch(body, /regenerate|approve|reserve|plan\.approve/);
});

test('submit on an unbound project pre-fills the composer with the scope hint and sends nothing', () => {
  const body = functionBody('submitIteration');
  const elseStart = body.indexOf('} else {');
  assert.ok(elseStart >= 0, 'submitIteration needs an explicit bound/unbound branch');
  const unbound = body.slice(elseStart);
  assert.match(unbound, /prompt\.value\s*=/);
  assert.match(unbound, /toPromptHint\(scope\)/);
  assert.match(unbound, /prompt\.focus\(\)/);
  assert.doesNotMatch(unbound, /projectChat\.send\(/);
  assert.doesNotMatch(unbound, /requestSubmit\(/);
  assert.doesNotMatch(unbound, /fetch\(/);
});

test('opening and iterating never write a take selection, verdict or approval', () => {
  const source = [
    functionBody('openClipViewer'),
    functionBody('showIteratePanel'),
    functionBody('submitIteration'),
  ].join('\n');
  assert.doesNotMatch(source, /\.regenerate\(/);
  assert.doesNotMatch(source, /\.verdict\(/);
  assert.doesNotMatch(source, /\.select\(/);
  assert.doesNotMatch(source, /plan\.approve/);
  assert.doesNotMatch(source, /reserve/i);
});
