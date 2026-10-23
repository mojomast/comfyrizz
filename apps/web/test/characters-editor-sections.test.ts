// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderCharacterEditor } from '../src/characters/editor.ts';

function character() {
  return {
    schema: 'comfyrizz.character/v1',
    id: 'chr_0123456789abcdef',
    revision: 2,
    name: 'Pip',
    handle: 'pip',
    role: 'mascot',
    kind: 'fictional',
    summary: 'Round, cheerful coffee-bean mascot',
    visual: {
      identityPrompt: 'small round coffee bean, glossy brown',
      negative: 'no human face',
      style: 'flat 3D',
      palette: ['#5b3a1e', '#f4e9dc'],
      wardrobe: [{ id: 'w1', label: 'barista apron', prompt: 'green apron', default: true }],
      expressions: [{ id: 'e1', label: 'delighted', prompt: 'wide smile' }],
      images: [],
      sheet: { status: 'none' },
      seed: null,
      identity: { method: 'klein_ref' },
    },
    voice: {
      engine: 'kokoro',
      voice: 'am_michael',
      speed: 0.98,
      chunking: 'paragraph',
      sampleLines: ['Morning! Fresh is best.'],
    },
    bible: {
      personality: 'upbeat',
      mannerisms: ['bounces when excited'],
      catchphrases: ['Fresh is best.'],
      speakingStyle: 'short sentences',
      do: ['smiles'],
      dont: ['drinks coffee'],
      notes: '',
    },
    tags: ['coffee'],
    createdAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-20T00:00:00.000Z',
  };
}

test('character editor wraps the six sections in details and opens only Identity', () => {
  const html = renderCharacterEditor(character());

  const details = html.match(/<details\b/g) ?? [];
  assert.equal(details.length, 6, 'Identity, Look, Wardrobe, Expressions, Voice and Bible are details');

  const open = html.match(/<details\b[^>]*\bopen\b[^>]*>/g) ?? [];
  assert.equal(open.length, 1, 'only one section is open');
  assert.match(open[0], /data-section="identity"/);

  for (const title of ['Identity', 'Look', 'Wardrobe', 'Expressions', 'Voice', 'Bible']) {
    assert.match(html, new RegExp(`<summary[^>]*>\\s*${title}\\s*</summary>`));
  }

  assert.match(html, /data-wardrobe-id="w1"/);
  assert.match(html, /data-expression-id="e1"/);
});
