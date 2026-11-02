// judge-loop v2: package characters reach the jobs so the reference watch can judge identity.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { planJobs } from '../src/index.mjs';

const pkg = JSON.parse(readFileSync(new URL('./fixtures/clawpocalypse.package.json', import.meta.url), 'utf8'));

test('gen.characters become identity locks on still and plate jobs, outside the cache key', () => {
  const { jobs, errors } = planJobs(pkg);
  assert.equal(errors?.length ?? 0, 0);
  const still = jobs.find((job) => job.id === 'a_o2_still.still');
  assert.deepEqual(still.characters.map((c) => c.characterId), ['gus', 'claw']);
  assert.match(still.characters[0].wardrobeState, /orange hoodie/);
  const bare = structuredClone(pkg);
  for (const asset of Object.values(bare.assets)) delete asset.gen.characters;
  delete bare.characters;
  const plain = planJobs(bare).jobs.find((job) => job.id === 'a_o2_still.still');
  assert.equal(plain.characters, undefined);
  assert.equal(plain.cacheKey, still.cacheKey);
});

test('package refWatch.framingGiveUp reaches the jobs doc only when opted in', async () => {
  const { readFileSync } = await import('node:fs');
  const { planJobs } = await import('../src/index.mjs');
  const pkg = JSON.parse(readFileSync(new URL('./fixtures/clawpocalypse.package.json', import.meta.url), 'utf8'));
  const off = planJobs(pkg);
  assert.equal(off.refWatchPolicy, undefined);
  const on = planJobs({ ...pkg, refWatch: { framingGiveUp: true } });
  assert.deepEqual(on.refWatchPolicy, { framingGiveUp: true });
});
