import assert from 'node:assert/strict';
import test from 'node:test';
import { authoredThemeSchema, createToolset } from '../src/tools.js';

const theme = { palette: ['#f4efe6', '#111111', '#1f4fd8', '#111111'], text: '#111111', text_muted: '#333333', text_on_accent: '#ffffff' };

test('planner theme tokens reach package and compact model result; prose is not styling', async () => {
  const tools = createToolset();
  const tool = tools['storyboard.propose'];
  const definition = tool.definition.parameters as any;
  assert.deepEqual(definition.properties.theme.properties.font.enum, ['Inter']);
  assert.equal(definition.properties.theme.additionalProperties, false);
  const result: any = await tool.run(tool.schema.parse({
    brief: 'A silent native title', theme,
    proposal: { logline: 'A title', look: 'A different prose color', soundtrack: 'Silence' },
    scenes: [{ id: 's1', layout: 'title', copy: { headline: 'STAY\nCURIOUS' } }],
  }));
  assert.deepEqual(result.package.theme, { ...theme, font: 'Inter' });
  assert.deepEqual((tool.modelResult!(result) as any).package.theme, result.package.theme);
  assert.equal(result.package.scenes[0].copy.headline, 'STAY\nCURIOUS');
  const updated: any = await tools['storyboard.theme'].run({ text: '#222222' });
  assert.equal(updated.package.theme.text, '#222222');
  assert.deepEqual(updated.package.theme.palette, theme.palette);
  assert.equal(updated.revision, result.revision + 1);
  await assert.rejects(async () => tools['storyboard.edit'].run({ scene_id: 's1', patch: { theme } }), /package-level.*storyboard.theme/);
  await assert.rejects(async () => tools['storyboard.propose'].run({ brief: 'A title', scenes: [{ id: 's1', layout: 'title', theme }] }), /package-level.*storyboard.propose.theme/);
});

test('theme authoring rejects files, CSS, unsupported type scale and unavailable fonts without changing draft', async () => {
  for (const invalid of [{ palette: ['red', '#ffffff'] }, { palette: ['#ffffff'] }, { palette: Array(9).fill('#ffffff') }, { text: 'url(https://example.test)' }, { fonts: [] }, { fontSize: 400 }, { scale: 3 }, { css: 'body{}' }]) {
    assert.equal(authoredThemeSchema.safeParse(invalid).success, false, JSON.stringify(invalid));
  }
  const tools = createToolset();
  const proposed: any = await tools['storyboard.propose'].run({ brief: 'A title', theme });
  for (const font of ['Oswald', 'https://example.test/font.ttf', 'Inter; color:red']) {
    await assert.rejects(async () => tools['storyboard.theme'].run({ font }), /Unsupported font/);
  }
  const result: any = await tools['storyboard.theme'].run({});
  assert.equal(result.revision, proposed.revision + 1);
  assert.deepEqual(result.package.theme, proposed.package.theme);
});

test('authenticated brand palette and uploaded font bytes/identity survive authoring and reproposal', async () => {
  const uploaded = { family: 'UploadedFont123', file: 'assets/font_123.ttf', weight: 400, license: { id: 'User-Upload', approved_by_user: true } };
  const tools = createToolset({
    initialPackage: { theme: { font: 'Inter', fonts: [uploaded, { ...uploaded, weight: 700 }] }, assets: {}, scenes: [] },
    brand: { palette: ['#123456', '#abcdef'], fonts: [{ family: 'BrandFace', file: 'assets/brand.ttf', license: 'OFL-1.1' }] },
  });
  assert.deepEqual((tools['storyboard.propose'].definition.parameters as any).properties.theme.properties.font.enum, ['UploadedFont123']);
  const result: any = await tools['storyboard.propose'].run({ brief: 'A branded title', theme: { ...theme, font: uploaded.family } });
  assert.deepEqual(result.package.theme.palette, ['#123456', '#abcdef']);
  assert.equal(result.package.theme.text, theme.text);
  assert.equal(result.package.theme.font, uploaded.family);
  assert.deepEqual(result.package.theme.fonts[0], uploaded);
  assert.deepEqual(result.package.theme.fonts[1], { ...uploaded, weight: 700 });
  assert.equal(result.package.theme.fonts[2].family, 'BrandFace');
  const again: any = await tools['storyboard.propose'].run({ brief: 'Revised title' });
  assert.deepEqual(again.package.theme, result.package.theme);
  await assert.rejects(async () => tools['storyboard.theme'].run({ font: 'Inter' }), /Unsupported font/);
});
