import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bibleLockForShot } from '../../src/ref-watch/bible-lock.mjs';

const wordCount = (value) => value.trim().split(/\s+/).filter(Boolean).length;

const mira = {
  id: 'mira',
  name: 'Mira',
  summary: 'Lighthouse keeper who has watched the northern coast through every winter storm.',
  visual: {
    identityPrompt: 'copper hair, green eyes, weathered build, freckles across both cheeks',
    wardrobe: [
      { id: 'w1', label: 'harbour coat', prompt: 'yellow oilskin coat, dry', default: true },
      { id: 'w2', label: 'storm gear', prompt: 'navy storm oilskin, soaked with salt spray' },
    ],
  },
  bible: {
    appearance: {
      age: 'thirty-eight years old',
      hair: 'shoulder-length copper hair with a centre part',
      eyes: 'green eyes flecked with amber',
      build: 'weathered, compact build',
      marks: 'freckles across both cheeks and a pale scar over the left brow',
    },
    personality: 'quiet, practical, and fiercely protective of the harbour',
  },
};

const theo = {
  id: 'theo',
  name: 'Theo',
  summary: 'Retired ferry pilot who knows every safe channel along the northern reach.',
  visual: {
    identityPrompt: 'short black hair, brown eyes, broad build, anchor tattoo',
    wardrobe: [
      { id: 't1', label: 'shore coat', prompt: 'grey trench coat, buttoned', default: true },
      { id: 't2', label: 'storm coat', prompt: 'black storm coat with a high collar' },
    ],
  },
  bible: {
    appearance: {
      age: 'fifty-one years old',
      hair: 'short black hair, silver at the temples',
      eyes: 'deep brown eyes',
      build: 'broad, sturdy build',
      marks: 'a faded anchor tattoo on the right forearm',
    },
    personality: 'steady, wry, and never hurried',
  },
};

const MIRA_LOCK = 'Mira: thirty-eight years old, shoulder-length copper hair with a centre part, green eyes flecked with amber, weathered, compact build, freckles across both cheeks and a pale scar over the left brow';
const THEO_LOCK = 'Theo: fifty-one years old, short black hair, silver at the temples, deep brown eyes, broad, sturdy build, a faded anchor tattoo on the right forearm';

test('RW07: two characters plus a mid-film wardrobe change give the right per-shot lock', () => {
  const earlyShot = { id: 's01', wardrobe: { mira: 'w1', theo: 't1' } };
  const lateShot = { id: 's08', wardrobe: { mira: 'w2', theo: 't1' } };

  assert.deepEqual(bibleLockForShot({ characters: [mira, theo], shot: earlyShot }), [
    { characterId: 'mira', identityLock: MIRA_LOCK, wardrobeState: 'yellow oilskin coat, dry' },
    { characterId: 'theo', identityLock: THEO_LOCK, wardrobeState: 'grey trench coat, buttoned' },
  ]);

  assert.deepEqual(bibleLockForShot({ characters: [mira, theo], shot: lateShot }), [
    { characterId: 'mira', identityLock: MIRA_LOCK, wardrobeState: 'navy storm oilskin, soaked with salt spray' },
    { characterId: 'theo', identityLock: THEO_LOCK, wardrobeState: 'grey trench coat, buttoned' },
  ]);
});

test('RW07: the identity string is identical across shots', () => {
  const first = bibleLockForShot({ characters: [mira, theo], shot: { id: 's01', wardrobe: { mira: 'w1' } } });
  const second = bibleLockForShot({ characters: [mira, theo], shot: { id: 's12', wardrobe: { mira: 'w2' } } });

  assert.equal(first[0].identityLock, second[0].identityLock);
  assert.equal(first[1].identityLock, second[1].identityLock);
  assert.equal(first[0].identityLock, MIRA_LOCK);
  assert.equal(first[1].identityLock, THEO_LOCK);
});

test('RW07: a shot with no wardrobe state falls back to the character default', () => {
  assert.deepEqual(bibleLockForShot({ characters: [mira, theo], shot: { id: 's00' } }), [
    { characterId: 'mira', identityLock: MIRA_LOCK, wardrobeState: 'yellow oilskin coat, dry' },
    { characterId: 'theo', identityLock: THEO_LOCK, wardrobeState: 'grey trench coat, buttoned' },
  ]);
});

test('RW07: a cast snapshot honours the cast wardrobe override', () => {
  const castMira = { characterId: 'mira', snapshot: mira, overrides: { wardrobeId: 'w2' } };

  assert.deepEqual(bibleLockForShot({ characters: [castMira], shot: { id: 's01' } }), [
    { characterId: 'mira', identityLock: MIRA_LOCK, wardrobeState: 'navy storm oilskin, soaked with salt spray' },
  ]);
});

test('RW07: an identity prompt is rebuilt in age, hair, eyes, build, marks order', () => {
  const vega = {
    id: 'vega',
    name: 'Vega',
    summary: 'a patient archivist who catalogues the coastal maps of the northern reach',
    visual: {
      identityPrompt: 'violet eyes, a crescent scar on the chin, silver braided hair, tall slender build, thirty years old',
      wardrobe: [{ id: 'v1', label: 'archive coat', prompt: 'ink-stained archive coat', default: true }],
    },
    bible: { personality: 'precise and unhurried' },
  };

  const [lock] = bibleLockForShot({ characters: [vega], shot: { id: 's02', wardrobe: { vega: 'v1' } } });

  assert.equal(
    lock.identityLock,
    'Vega: thirty years old, silver braided hair, violet eyes, tall slender build, a crescent scar on the chin, a patient archivist who catalogues the coastal maps of the northern reach',
  );
  assert.ok(wordCount(lock.identityLock) >= 25, 'identity lock must reach the 25-word floor');
  assert.ok(wordCount(lock.identityLock) <= 45, 'identity lock must stay within the 45-word ceiling');
  assert.equal(lock.wardrobeState, 'ink-stained archive coat');
});

test('RW07: the lock is deterministic and keeps the 25-45 word bounds', () => {
  const nova = {
    id: 'nova',
    name: 'Nova',
    summary: 'a lighthouse historian who records every wreck along the northern coast',
    visual: {
      identityPrompt: 'silver eyes, an old rope scar across the palm, waist-length white hair, a tall and narrow build, forty-two years old',
      wardrobe: [{ id: 'n1', label: 'survey coat', prompt: 'navy survey coat with brass buttons', default: true }],
    },
    bible: {
      appearance: {
        age: 'forty-two years old and weathered by two decades of winter storms',
        hair: 'waist-length white hair braided with small brass rings and sea glass beads',
        eyes: 'silver eyes that catch the grey northern light',
        build: 'a tall and narrow build with long arms and careful hands',
        marks: 'an old rope scar across the left palm and ink stains on the fingers',
      },
      notes: 'Nova keeps a log of every vessel lost on the northern reef.',
    },
  };

  const input = { characters: [nova], shot: { id: 's04', wardrobe: { nova: 'n1' } } };
  const first = bibleLockForShot(input);
  const second = bibleLockForShot(input);

  assert.deepEqual(first, second);
  assert.equal(first.length, 1);
  assert.equal(first[0].characterId, 'nova');
  assert.equal(first[0].wardrobeState, 'navy survey coat with brass buttons');
  const count = wordCount(first[0].identityLock);
  assert.ok(count >= 25 && count <= 45, `identity lock word count ${count} is outside 25-45`);
});
