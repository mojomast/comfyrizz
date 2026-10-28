// PS01: harness regressions behind the planning-stress HTTP 500s.
// 1. The shared mascot must have bytes on disk, not just a declared file.
// 2. A CPU slice below the four-SVG floor returns draft + problems, never a naked throw.
// 3. generateSvg and inlineGeneratedAssets share pkg.theme.palette and report a
//    typed 422 with the asset id when the palette or render check fails.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createToolset } from '../src/tools.js';
import { runCpuSlice } from '../src/cpu-slice.js';
import { createScriptedModel } from '../src/scripted-model.js';

const renderPackageLib: any = await import(new URL('../../../../apps/renderer/scripts/render-package-lib.mjs', import.meta.url).href);
const { inlineGeneratedAssets } = renderPackageLib;

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><rect width="512" height="512" fill="#0d0f14"/><circle cx="256" cy="256" r="120" fill="#6d8cff"/></svg>';
const RED_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><rect width="512" height="512" fill="#ff0000"/></svg>';

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test('PS01 mascot: propose persists a_cast_pip.svg before packaging inlines it', async () => {
  const dir = tempDir('ps01-mascot-');
  try {
    const persisted: string[] = [];
    const tools = createToolset({
      generateSvg: () => ({ svg: SVG }),
      persistSvg: (assetId: string, svg: string) => {
        mkdirSync(join(dir, 'assets'), { recursive: true });
        writeFileSync(join(dir, 'assets', `${assetId}.svg`), svg);
        persisted.push(assetId);
        return `assets/${assetId}.svg`;
      },
    });
    const proposed = await tools['storyboard.propose'].run({
      brief: 'use the same mascot in every scene',
      title: 'Pip',
      scenes: [{ id: 's_title', layout: 'title', copy: { headline: 'Meet Pip' } }],
    }) as any;

    assert.equal(proposed.package.assets.a_cast_pip.file, 'assets/a_cast_pip.svg');
    assert.deepEqual(persisted, ['a_cast_pip']);
    assert.ok(existsSync(join(dir, 'assets/a_cast_pip.svg')), 'a_cast_pip.svg must exist on disk');

    const inlined = inlineGeneratedAssets(proposed.package, dir);
    assert.ok(inlined.a_cast_pip, 'the persisted mascot must inline without ENOENT');
    assert.match(inlined.a_cast_pip.svg, /<svg/);
    assert.equal(inlined.a_cast_pip.width, 512);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('PS01 cpu-slice: fewer than four ready llm-svg assets returns draft + problems', async () => {
  const model = createScriptedModel([
    {
      name: 'storyboard.propose',
      args: {
        brief: 'A two-icon launch',
        title: 'Two Icons',
        scenes: [
          { id: 's_title', layout: 'title', copy: { headline: 'Two Icons' } },
          { id: 's_hero', layout: 'hero', copy: { headline: 'Two' } },
        ],
      },
    },
    { name: 'assets.generate_svg', args: { scene_id: 's_title', kind: 'icon', intent: 'a check icon', seed: 1 } },
    { name: 'assets.generate_svg', args: { scene_id: 's_hero', kind: 'diagram', intent: 'a two-step diagram', seed: 2 } },
  ]);
  const slice = await runCpuSlice({
    brief: 'A two-icon launch',
    model,
    now: () => '2026-10-28T00:00:00.000Z',
    generateSvg: () => ({
      svg: SVG,
      renderCheck: { ok: true, version: '1.0.0', width: 512, height: 512, opaqueFraction: 0.9, outOfPaletteFraction: 0 },
    }),
  });

  assert.equal(slice.svgAssets.length, 2);
  assert.equal(slice.ok, false);
  const problems = (slice as any).problems;
  assert.ok(Array.isArray(problems) && problems.length > 0, 'the slice must report structured problems');
  const codes = problems.map((problem: any) => typeof problem === 'string' ? problem : problem.code);
  assert.ok(codes.includes('SVG_ASSET_FLOOR'), `expected SVG_ASSET_FLOOR, got ${codes.join(', ')}`);
  assert.equal(slice.package.scenes.length, 2);
});

test('PS01 palette: generateSvg follows pkg.theme.palette and types mismatches with the asset id', async () => {
  const calls: Array<string[] | undefined> = [];
  let outOfPaletteFraction = 0.9;
  const tools = createToolset({
    generateSvg: (intent: any) => {
      calls.push(intent.palette);
      return {
        svg: SVG,
        sanitizerVersion: '1.0.0',
        renderCheck: { ok: true, version: '1.0.0', width: 512, height: 512, opaqueFraction: 0.9, outOfPaletteFraction },
      };
    },
  });
  const proposed = await tools['storyboard.propose'].run({
    brief: 'A dark launch',
    title: 'Dark Launch',
    scenes: [{ id: 's_title', layout: 'title', copy: { headline: 'Dark Launch' } }],
  }) as any;
  const themePalette = proposed.package.theme.palette;

  await assert.rejects(
    () => tools['assets.generate_svg'].run({ scene_id: 's_title', kind: 'icon', intent: 'a rocket', palette: ['#ff0000'] }) as Promise<any>,
    (error: any) => {
      assert.equal(error.status, 422);
      assert.equal(error.code, 'SVG_PALETTE_MISMATCH');
      assert.match(error.assetId, /^a_svg_/);
      assert.match(error.message, /a_svg_/);
      return true;
    },
  );
  assert.deepEqual(calls[0], themePalette, 'the tool must render with the package theme palette, not a model palette');

  outOfPaletteFraction = 0;
  const accepted = await tools['assets.generate_svg'].run({
    scene_id: 's_title',
    kind: 'icon',
    intent: 'a rocket',
    palette: ['#ff0000'],
  }) as any;
  assert.equal(accepted.asset.status, 'ready');
  assert.deepEqual(calls[1], themePalette);
});

test('PS01 palette: a failed render check is typed 422 with the asset id', async () => {
  const tools = createToolset({
    generateSvg: () => ({
      svg: SVG,
      renderCheck: { ok: false, version: '1.0.0', width: 0, height: 0, opaqueFraction: 0, outOfPaletteFraction: null },
    }),
  });
  await tools['storyboard.propose'].run({
    brief: 'A dark launch',
    title: 'Dark Launch',
    scenes: [{ id: 's_title', layout: 'title', copy: { headline: 'Dark Launch' } }],
  }) as any;

  await assert.rejects(
    () => tools['assets.generate_svg'].run({ scene_id: 's_title', kind: 'icon', intent: 'a rocket' }) as Promise<any>,
    (error: any) => {
      assert.equal(error.status, 422);
      assert.equal(error.code, 'SVG_RENDER_CHECK_FAILED');
      assert.match(error.assetId, /^a_svg_/);
      return true;
    },
  );
});

test('PS01 inline: an out-of-palette generated SVG is a typed 422 with the asset id', () => {
  const dir = tempDir('ps01-inline-');
  try {
    mkdirSync(join(dir, 'assets'), { recursive: true });
    writeFileSync(join(dir, 'assets', 'a_bad.svg'), RED_SVG);
    const pkg = {
      theme: { palette: ['#000000'] },
      assets: {
        a_bad: { kind: 'svg', file: 'assets/a_bad.svg', gen: { generator: 'llm-svg' } },
      },
    };
    assert.throws(
      () => inlineGeneratedAssets(pkg, dir),
      (error: any) => {
        assert.equal(error.status, 422);
        assert.equal(error.code, 'SVG_PALETTE_MISMATCH');
        assert.equal(error.assetId, 'a_bad');
        assert.match(error.message, /a_bad/);
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('PS01 inline: a missing generated SVG is a typed 422 with the asset id', () => {
  const dir = tempDir('ps01-missing-');
  try {
    const pkg = {
      theme: { palette: ['#0d0f14', '#6d8cff'] },
      assets: {
        a_missing: { kind: 'svg', file: 'assets/a_missing.svg', gen: { generator: 'llm-svg' } },
      },
    };
    assert.throws(
      () => inlineGeneratedAssets(pkg, dir),
      (error: any) => {
        assert.equal(error.status, 422);
        assert.equal(error.code, 'SVG_ASSET_MISSING');
        assert.equal(error.assetId, 'a_missing');
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
