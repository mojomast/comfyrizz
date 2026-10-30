import assert from 'node:assert/strict';
import test from 'node:test';
import { createToolset } from '../src/tools.js';
import {
  applyStyle,
  loadStyleRecipes,
  styleCatalog,
  suggestStyles,
} from '../src/style-recipes.js';
import { BUNDLED_SKILL_IDS, SKILL_CATALOG_VERSION } from '../src/skills/index.js';

async function loadFirst(paths: string[]): Promise<any> {
  let lastError: unknown;
  for (const path of paths) {
    try {
      return await import(new URL(path, import.meta.url).href);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

const schema = () => loadFirst(['../../../schema/src/index.mjs', '../../../../packages/schema/src/index.mjs']);
const recipeSchema = () => loadFirst(['../../../../scripts/motionkit/recipe-schema.mjs', '../../../scripts/motionkit/recipe-schema.mjs']);

test('style.list loads all 24 recipes as a compact catalog card', () => {
  const recipes = loadStyleRecipes();
  assert.equal(recipes.length, 24);
  assert.equal(new Set(recipes.map(recipe => recipe.id)).size, 24);
  const catalog = styleCatalog(recipes);
  const lines = catalog.split('\n');
  assert.equal(lines.length, 24);
  for (const line of lines) {
    assert.ok(line.length <= 120, `${line.length} chars: ${line}`);
    assert.ok(!/https?:\/\//.test(line), 'catalog lines carry no URLs');
  }
  assert.match(catalog, /swiss-grid/);
  assert.match(catalog, /documentary-archive/);
});

test('style.suggest returns three distinct recipe ids with reasons, deterministically', async () => {
  const input = { tone: ['editorial', 'serious'], goal: 'explain', energy: 'medium' };
  const first = await suggestStyles(input);
  const second = await suggestStyles(input);
  assert.deepEqual(second, first);
  assert.equal(first.suggestions.length, 3);
  assert.equal(first.recipeIds.length, 3);
  assert.equal(new Set(first.recipeIds).size, 3);
  const ids = new Set(loadStyleRecipes().map(recipe => recipe.id));
  for (const suggestion of first.suggestions) {
    assert.ok(ids.has(suggestion.id), `${suggestion.id} is a real recipe`);
    assert.equal(suggestion.recipeId, suggestion.id);
    assert.ok(suggestion.reason.length > 0);
  }
});

test('style.suggest honours history without repeating recent looks', async () => {
  const history = ['swiss-grid', 'editorial-serif', 'mono-terminal', 'blueprint'];
  const result = await suggestStyles({ tone: ['serious'], goal: 'explain', history, seed: 11 });
  assert.equal(result.suggestions.length, 3);
  assert.deepEqual(result.recipeIds.filter(id => history.includes(id)), []);
});

test('style.apply compiles a standalone package that validatePackage accepts', async () => {
  const result = await applyStyle(undefined, { recipeId: 'swiss-grid', seed: 7 });
  const { validatePackage } = await schema();
  const report = validatePackage(result.package);
  assert.equal(report.valid, true, JSON.stringify(report.errors));
  const blocking = report.motion.filter((finding: any) => finding.severity === 'error' || finding.severity === 'warning');
  assert.deepEqual(blocking, []);
  assert.equal(result.recipeId, 'swiss-grid');
  assert.equal(result.look.recipeId, 'swiss-grid');
  assert.equal(result.package.theme.palette.join(','), result.recipe.palette.map(entry => entry.hex).join(','));
  assert.ok(result.score >= 0 && result.score <= 100);
  assert.equal(result.score, result.lookScore.score);
  const { validateLook } = await recipeSchema();
  assert.deepEqual(validateLook(result.look), { ok: true, errors: [] });
});

test('style.apply is deterministic and uses the current draft when one exists', async () => {
  const tools = createToolset({ now: () => '2026-10-20T00:00:00.000Z' });
  const proposed = await tools['storyboard.propose'].run({ brief: 'A launch explainer', title: 'Launch' }) as any;
  const first = await tools['style.apply'].run({ recipeId: 'cinematic-noir', seed: 21 }) as any;
  const second = await tools['style.apply'].run({ recipeId: 'cinematic-noir', seed: 21 }) as any;
  assert.deepEqual(second.package, first.package);
  assert.equal(first.package.id, proposed.package.id);
  assert.equal(first.package.theme.palette.length, first.recipe.palette.length);
  const { validatePackage } = await schema();
  assert.equal(validatePackage(first.package).valid, true);
});

test('style.apply rejects an unknown recipe before touching the draft', async () => {
  const tools = createToolset();
  await assert.rejects(async () => tools['style.apply'].run({ recipeId: 'not-a-recipe' }), /unknown style recipe/);
});

test('the three style tools are registered and motion-style is a bundled skill', () => {
  const tools = createToolset();
  for (const name of ['style.list', 'style.suggest', 'style.apply']) {
    assert.ok(tools[name], `${name} is registered`);
    assert.equal(tools[name].definition.name, name);
  }
  assert.ok(BUNDLED_SKILL_IDS.includes('motion-style'));
  assert.equal(SKILL_CATALOG_VERSION, '1.6.0');
});
