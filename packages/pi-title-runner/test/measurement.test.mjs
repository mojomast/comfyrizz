import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeTitlePixels, measurementScope } from '../src/title-measurement.mjs';
import { freezeBrief, titleTools } from '../src/runner.mjs';

function pixels({ clipped = false, invisible = false, mismatched = false } = {}) {
  const width = 100, height = 80;
  const original = { width, height, data: Buffer.alloc(width * height * 3, 240) };
  const black = structuredClone(original), white = structuredClone(original);
  // Two title bands, plus a blue rule and dark decoration unchanged by the
  // diagnostic intervention. Their colors must not contaminate title bounds.
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const at = (y * width + x) * 3;
    if (y === 70 || x < 5) for (const img of [original, black, white]) img.data.set(y === 70 ? [0, 0, 255] : [0, 0, 0], at);
    if (x >= (clipped ? 0 : 20) && x < 80 && ((y >= 20 && y < 30) || (y >= 40 && y < 50))) {
      black.data.set([0, 0, 0], at); white.data.set([255, 255, 255], at); original.data.set(invisible ? [240, 240, 240] : mismatched ? [70, 70, 70] : [10, 10, 10], at);
    }
  }
  return { original, black, white, textRgb: invisible ? [240, 240, 240] : [10, 10, 10], backgroundRgb: [240, 240, 240], compositionWidth: 200, compositionHeight: 160, expectedLines: 2 };
}

test('differential mask excludes unchanged rule/background, maps half-resolution and matches composited pixels', () => {
  const { metrics } = analyzeTitlePixels(pixels());
  assert.deepEqual(metrics.bbox, { x: 20, y: 20, width: 60, height: 30 });
  assert.deepEqual(metrics.compositionBbox, { x: 40, y: 40, width: 120, height: 60 });
  assert.equal(metrics.widthFraction, 0.6); assert.equal(metrics.lineCountMatches, true);
  assert.equal(metrics.compositedAgreement.pass, true); assert.equal(metrics.visible, true);
});

test('clipping, invisible title, and disagreement cannot silently pass the geometric grader', () => {
  assert.equal(analyzeTitlePixels(pixels({ clipped: true })).metrics.clipped, true);
  assert.equal(analyzeTitlePixels(pixels({ invisible: true })).metrics.visible, false);
  assert.equal(analyzeTitlePixels(pixels({ mismatched: true })).metrics.compositedAgreement.pass, false);
});

test('font identity and ambiguous layers are explicit unsupported cases; width thresholds require structured input', () => {
  const pkg = { scenes: [{ layout: 'title', copy: { headline: 'ABC\nDEF' } }], assets: {}, theme: { font: 'Inter' } };
  assert.equal(measurementScope(pkg, []), null);
  assert.match(measurementScope({ ...pkg, theme: { font: 'OtherFont' } }, []), /Font identity/);
  assert.match(measurementScope({ ...pkg, scenes: [{ ...pkg.scenes[0], copy: { headline: 'ABC', kicker: 'Extra' } }] }, []), /Additional copy/);
  const brief = freezeBrief('Create exactly 12 seconds of native title at roughly sixty percent width. Silent.');
  assert.equal(brief.titleWidth, null);
  assert.throws(() => freezeBrief({ prompt: brief.prompt, titleWidth: { fraction: 0.6, tolerance: 0.5, expectedLines: 2 } }), /acceptance target/);
});

test('a measured-width correction can change only implicated size and preserves unrelated content', async () => {
  const state = { fonts: [], brief: freezeBrief('Create exactly 12 seconds of a native title. Silent.'), package: null };
  const commit = pkg => { state.package = pkg; };
  await titleTools({ state, commit }).find(t => t.name === 'storyboard.propose').execute('draft', { brief: state.brief.prompt, scenes: [{ id: 's1', layout: 'title', headline_size: 150, preferredFrames: 360, copy: { headline: 'ABC\nDEF' } }] });
  state.findings = { items: [{ code: 'rendered-title-width', status: 'fail', repairFields: ['headline_size'] }] };
  const before = structuredClone(state.package);
  const edit = titleTools({ state, commit, repair: true }).find(t => t.name === 'storyboard.edit');
  await assert.rejects(edit.execute('bad', { scene_id: 's1', patch: { copy: { headline: 'OTHER' }, headline_size: 440 } }), /implicated/);
  await edit.execute('repair', { scene_id: 's1', patch: { headline_size: 440 } });
  const after = structuredClone(state.package); after.revision = before.revision; after.scenes[0].headline_size = before.scenes[0].headline_size;
  assert.deepEqual(after, before);
});
