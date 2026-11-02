import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chainProgress, novelContent } from '../src/chain-progress.mjs';

const ROSA = 'Nana Rosa, a tiny white-haired grandma with big round pink glasses, a purple velour tracksuit and a pearl necklace';
const LOOK = 'bright sunny colours, slapstick comedy adventure, cinematic, photoreal, 35mm film still, open countryside, no text, no signs, no logos';
const gc1 = `${ROSA} roars after the goat on a vintage green ride-on lawnmower through a golden sunflower field, petals flying, ${LOOK}.`;
const gc2 = `${ROSA} on her green ride-on lawnmower launches off a hay bale ramp high into the air above the sunflower field, pearls flying, fists raised in triumph, ${LOOK}.`;
const gc3 = `${ROSA} on her green ride-on lawnmower crash-lands into a muddy farm pond with a giant brown splash, ducks scattering, ${LOOK}.`;

test('Goat Getaway: the hay-bale jump and the pond crash are new beats, so they re-anchor on their own stills', () => {
  const jump = chainProgress({ previousPrompt: gc1, prompt: gc2 });
  assert.equal(jump.reanchor, true, jump.reason);
  assert.ok(jump.novel.includes('ramp'));
  const crash = chainProgress({ previousPrompt: gc2, prompt: gc3 });
  assert.equal(crash.reanchor, true);
  assert.ok(crash.novel.includes('pond'));
});

test('a continuation of the same moment keeps last-frame chaining', () => {
  const next = `${ROSA} roars after the goat on a vintage green ride-on lawnmower through a golden sunflower field, petals flying everywhere, ${LOOK}.`;
  assert.equal(chainProgress({ previousPrompt: gc1, prompt: next }).reanchor, false);
  assert.deepEqual(novelContent(gc1, next), ['everywhere']);
});

test('chain mode overrides the heuristic both ways', () => {
  assert.equal(chainProgress({ previousPrompt: gc1, prompt: gc2, mode: 'lastFrame' }).reanchor, false);
  assert.equal(chainProgress({ previousPrompt: gc1, prompt: gc1, mode: 'reanchor' }).reanchor, true);
});

test('planJobs marks the Goat Getaway jump and crash plates as re-anchored, and chainMode lastFrame keeps the chain', async () => {
  const { readFileSync } = await import('node:fs');
  const { planJobs } = await import('../src/index.mjs');
  const pkg = JSON.parse(readFileSync(new URL('./fixtures/goat-getaway.package.json', import.meta.url), 'utf8'));
  const plates = (doc) => Object.fromEntries(doc.jobs.filter((j) => j.kind === 'plate').map((j) => [j.id, j.shot ?? null]));
  const shots = plates(planJobs(pkg));
  const chainedPairs = Object.entries(shots).filter(([, s]) => s && s.index > 0 && !s.cut);
  assert.ok(chainedPairs.length >= 2, JSON.stringify(shots));
  assert.match(shots['a_gc2_plate.plate'].reanchor ?? '', /new beat/);
  assert.match(shots['a_gc3_plate.plate'].reanchor ?? '', /new beat/);
  const pinned = structuredClone(pkg);
  pinned.assets.a_gc2_plate.gen.chainMode = 'lastFrame';
  assert.equal(plates(planJobs(pinned))['a_gc2_plate.plate'].reanchor, undefined);
});
