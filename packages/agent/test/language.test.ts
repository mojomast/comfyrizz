import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyLanguageVariant,
  dictionaryTranslator,
  translateStrings,
  translatableStrings,
  translationPrompt,
  variantPackageId,
} from '../src/language.js';

const pkg = (): Record<string, any> => ({
  id: 'pkg_launchdemo0001',
  title: 'Comfyrizz launch demo',
  voice: { enabled: false, engine: 'none' },
  scenes: [
    {
      id: 's_title',
      layout: 'title',
      preferredFrames: 150,
      copy: { kicker: 'Agent-built package', headline: 'Comfyrizz', sub: 'Chat brief to MP4.' },
      narration: 'Comfyrizz turns a chat brief into a rendered package.',
    },
    {
      id: 's_list',
      layout: 'list',
      variant: 'bullets',
      copy: { headline: 'What it does', items: ['Routes SVG', 'Checks every vector'] },
    },
  ],
  brief: { key_message: 'Ship a video from a brief', audience: { who: 'developers', language: 'en' }, voice: { engine: 'kokoro', lang: 'en' } },
});

test('L1: translatableStrings lists copy strings, list items and narration', () => {
  const strings = translatableStrings(pkg());
  assert.deepEqual(strings.map(item => `${item.sceneId}:${item.path}`), [
    's_title:narration',
    's_title:copy.kicker',
    's_title:copy.headline',
    's_title:copy.sub',
    's_list:copy.headline',
    's_list:copy.items[0]',
    's_list:copy.items[1]',
  ]);
  assert.equal(strings[0].text, 'Comfyrizz turns a chat brief into a rendered package.');
});

test('L1: variantPackageId is stable and the dictionary translator marks misses', () => {
  assert.equal(variantPackageId('pkg_launchdemo0001', 'fr'), 'pkg_launchdemo0001-fr');
  assert.equal(variantPackageId('pkg_launchdemo0001-fr', 'fr'), 'pkg_launchdemo0001-fr');
  const translate = dictionaryTranslator({ Comfyrizz: 'Comfyrizz' }, 'fr');
  assert.equal(translate('Comfyrizz'), 'Comfyrizz');
  assert.equal(translate('Chat brief'), '[fr] Chat brief');
});

test('L1: translateStrings groups copy and list items by scene', () => {
  const translations = translateStrings(pkg(), 'fr', text => `<${text}>`);
  assert.equal(translations.s_title.narration, '<Comfyrizz turns a chat brief into a rendered package.>');
  assert.equal(translations.s_title.copy?.headline, '<Comfyrizz>');
  assert.deepEqual(translations.s_list.copy?.items, ['<Routes SVG>', '<Checks every vector>']);
});

test('L1: applyLanguageVariant translates copy, narration and voice without mutating the source', () => {
  const source = pkg();
  const translator = dictionaryTranslator({ Comfyrizz: 'Comfyrizz' }, 'fr');
  const translations = translateStrings(source, 'fr', translator);
  const variant = applyLanguageVariant(source, { language: 'fr', translations, title: 'Démo de lancement Comfyrizz' });

  assert.equal(variant.id, 'pkg_launchdemo0001-fr');
  assert.equal(variant.title, 'Démo de lancement Comfyrizz');
  assert.equal(variant.voice.language, 'fr-fr');
  assert.equal(variant.voice.enabled, true);
  assert.equal(variant.scenes[0].narration, '[fr] Comfyrizz turns a chat brief into a rendered package.');
  assert.equal(variant.scenes[0].copy.headline, 'Comfyrizz');
  // Untranslated structural keys survive the merge.
  assert.equal(variant.scenes[1].variant, 'bullets');
  assert.deepEqual(variant.scenes[1].copy.items, ['[fr] Routes SVG', '[fr] Checks every vector']);
  assert.equal(variant.brief.audience.language, 'fr');
  assert.equal(variant.brief.voice.lang, 'fr');

  // The source package is untouched.
  assert.equal(source.scenes[0].copy.headline, 'Comfyrizz');
  assert.equal(source.scenes[0].narration, 'Comfyrizz turns a chat brief into a rendered package.');
  assert.equal(source.voice.language, undefined);
});

test('L1: a scene with no translation keeps its source copy', () => {
  const variant = applyLanguageVariant(pkg(), { language: 'fr', translations: { s_title: { copy: { headline: 'Comfyrizz FR' } } } });
  assert.equal(variant.scenes[0].copy.headline, 'Comfyrizz FR');
  assert.equal(variant.scenes[0].copy.sub, 'Chat brief to MP4.');
  assert.equal(variant.scenes[1].copy.headline, 'What it does');
});

test('L1: translationPrompt asks for the target language and keeps the JSON shape', () => {
  const prompt = translationPrompt(translatableStrings(pkg()), 'fr');
  assert.match(prompt, /Translate each "text" into Français \(fr-FR\)/);
  assert.match(prompt, /Keep product names, URLs and numbers exact/);
  assert.match(prompt, /"scene":"s_title","path":"copy\.headline","text":"Comfyrizz"/);
});
