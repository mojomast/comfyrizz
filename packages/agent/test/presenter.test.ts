import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PRESENTER_LABEL_DEFAULT,
  applyPresenterCoverage,
  applyPresenterPreset,
  applyPresenterScene,
  applyPresenterSet,
  coveredSceneIds,
  lintPresenter,
  presenterChips,
  presenterPortraitPrompt,
  presenterPresets,
  sceneShowsPresenter,
} from '../src/presenter.js';
import type { PresenterPackage } from '../src/presenter.js';
import { createToolset } from '../src/tools.js';

function fixture(): PresenterPackage {
  return {
    id: 'pkg_presentertest01',
    theme: { palette: ['#101018', '#203050', '#6d8cff', '#e8ecef'] },
    assets: { a_portrait: { kind: 'image', status: 'pending' } },
    scenes: [
      { id: 's_title', layout: 'title' },
      { id: 's_hero', layout: 'hero' },
      { id: 's_chart', layout: 'chart' },
      { id: 's_outro', layout: 'title' },
    ],
  };
}

function sceneOf(pkg: PresenterPackage, id: string) {
  return pkg.scenes!.find(scene => scene.id === id)!;
}

test('presenter chips and presets match the owner-facing vocabulary', () => {
  assert.deepEqual(presenterChips().map(chip => chip.id), ['none', 'bookends', 'all']);
  assert.deepEqual(presenterPresets().map(preset => preset.id), ['intro-outro', 'all', 'none']);
  assert.equal(PRESENTER_LABEL_DEFAULT, 'AI presenter');
});

test('the portrait prompt is fictional and follows the named preset', () => {
  const photoreal = presenterPortraitPrompt();
  assert.match(photoreal, /Fictional person/);
  assert.match(photoreal, /photoreal/);
  const clay = presenterPortraitPrompt({ preset: 'clay', backdrop: 'brand navy' });
  assert.notEqual(clay, photoreal);
  assert.match(clay, /brand navy/);
  assert.match(clay, /Fictional person/);
});

test('coverage turns the presenter on and off without mutating the input', () => {
  const pkg = fixture();
  const before = JSON.stringify(pkg);
  const bookends = applyPresenterCoverage(pkg, 'bookends');
  assert.equal(JSON.stringify(pkg), before, 'input untouched');
  assert.equal(bookends.package.presenter!.enabled, true);
  assert.equal(bookends.package.presenter!.scenes, 'bookends');
  const off = applyPresenterCoverage(bookends.package, 'none');
  assert.equal(off.package.presenter!.enabled, false);
  const all = applyPresenterCoverage(pkg, 'all');
  assert.equal(all.package.presenter!.scenes, 'all');
});

test('a per-scene value overrides coverage and null clears it', () => {
  const on = applyPresenterCoverage(fixture(), 'all').package;
  const off = applyPresenterScene(on, 's_chart', 'off');
  assert.equal(sceneOf(off.package, 's_chart').presenter, 'off');
  assert.equal(sceneShowsPresenter(off.package, 's_chart'), false);
  assert.equal(sceneShowsPresenter(off.package, 's_hero'), true);
  const cleared = applyPresenterScene(off.package, 's_chart', null);
  assert.equal(sceneOf(cleared.package, 's_chart').presenter, undefined);
  assert.equal(sceneShowsPresenter(cleared.package, 's_chart'), true, 'falls back to coverage');
});

test('bookends coverage is the first and last scene only', () => {
  const pkg = applyPresenterCoverage(fixture(), 'bookends').package;
  assert.deepEqual([...coveredSceneIds(pkg)].sort(), ['s_outro', 's_title']);
  assert.equal(sceneShowsPresenter(pkg, 's_hero'), false);
});

test('presets rewrite every scene value', () => {
  const introOutro = applyPresenterPreset(fixture(), 'intro-outro').package;
  assert.deepEqual(introOutro.scenes!.map(scene => scene.presenter), ['pip', 'off', 'off', 'pip']);
  assert.equal(introOutro.presenter!.enabled, true);
  const all = applyPresenterPreset(fixture(), 'all').package;
  assert.ok(all.scenes!.every(scene => scene.presenter === 'pip'));
  const none = applyPresenterPreset(fixture(), 'none').package;
  assert.ok(none.scenes!.every(scene => scene.presenter === 'off'));
  assert.equal(none.presenter!.enabled, false);
});

test('presenter.set accepts scene ids or 1-based indices and returns the portrait prompt', () => {
  const result = applyPresenterSet(fixture(), {
    coverage: 'bookends',
    scenes: { '2': 'pip', s_chart: 'off' },
    placement: 'pip-bl',
    size: 0.5,
  });
  assert.equal(sceneOf(result.package, 's_hero').presenter, 'pip');
  assert.equal(sceneOf(result.package, 's_chart').presenter, 'off');
  assert.equal(result.package.presenter!.placement, 'pip-bl');
  assert.equal(result.package.presenter!.size, 0.32, 'size clamps to the schema range');
  assert.match(result.portrait_prompt!, /Fictional person/);
});

test('the lint keeps the presenter off chart scenes and asks for a portrait', () => {
  const on = applyPresenterCoverage(fixture(), 'all').package;
  const findings = lintPresenter(on);
  const codes = findings.map(finding => finding.code).sort();
  assert.deepEqual(codes, ['PRESENTER_NO_PORTRAIT', 'PRESENTER_ON_READ_ONLY_SCENE']);
  const chartFinding = findings.find(finding => finding.code === 'PRESENTER_ON_READ_ONLY_SCENE')!;
  assert.equal(chartFinding.sceneId, 's_chart');
  assert.deepEqual(chartFinding.fix, { sceneId: 's_chart', presenter: 'off' });
  const withPortrait = { ...on, presenter: { ...on.presenter, portrait: 'a_portrait' } };
  assert.ok(!lintPresenter(withPortrait).some(finding => finding.code === 'PRESENTER_NO_PORTRAIT'));
});

test('split on a non-hero scene is flagged but not an error', () => {
  const pkg = applyPresenterCoverage(fixture(), 'all').package;
  pkg.scenes![0].presenter = 'split';
  const finding = lintPresenter(pkg).find(entry => entry.code === 'PRESENTER_SPLIT_ON_NON_HERO');
  assert.ok(finding);
  assert.equal(finding!.sceneId, 's_title');
});

test('unknown scenes and values are rejected with their HTTP status', () => {
  assert.throws(() => applyPresenterScene(fixture(), 'nope', 'pip'), error => (error as { status?: number }).status === 404);
  assert.throws(() => applyPresenterScene(fixture(), 's_title', 'float' as never), error => (error as { status?: number }).status === 400);
  assert.throws(() => applyPresenterSet(fixture(), { scenes: { nope: 'pip' } }), error => (error as { status?: number }).status === 404);
});

test('the presenter.set tool mutates the draft and reports presenter_fixes', async () => {
  const tools = createToolset();
  await tools['storyboard.propose'].run({
    brief: 'A presenter demo for the team.',
    datasets: { d_x: { unit: 'x', label: 'Example', values: [{ label: 'a', value: 1 }], source: 'example', approved: true } },
    scenes: [
      { id: 's_title', layout: 'title', copy: { headline: 'Presenter demo' } },
      { id: 's_chart', layout: 'chart', variant: 'bar', copy: { headline: 'Example data' }, data: { dataset: 'd_x', display: 'bar' } },
    ],
  });
  const result = (await tools['presenter.set'].run({ coverage: 'all', placement: 'pip-br' })) as {
    package: { presenter: { enabled: boolean; scenes: string; placement: string } };
    summary: string;
    portrait_prompt: string;
    presenter_fixes?: string[];
  };
  assert.equal(result.package.presenter.enabled, true);
  assert.equal(result.package.presenter.scenes, 'all');
  assert.equal(result.package.presenter.placement, 'pip-br');
  assert.match(result.portrait_prompt, /Fictional person/);
  assert.ok(result.presenter_fixes?.some(line => line.includes('s_chart')));
  // The agent can then turn the presenter off on the flagged chart scene.
  const cleared = (await tools['presenter.set'].run({ scenes: { s_chart: 'off' } })) as { package: { scenes: Array<{ id: string; presenter?: string }> } };
  assert.equal(cleared.package.scenes.find(scene => scene.id === 's_chart')?.presenter, 'off');
});
