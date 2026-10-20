/**
 * Editor e2e package. Built from the committed short fixture, plus narration
 * takes the script panel can split. MIT, same as the repo. No media binaries.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePackage } from '../../../packages/schema/src/index.mjs';
import { compileTimeline, frameProjection, measuredFromReport } from '../../../packages/planner/dist/src/browser.js';
import { narrationInputFingerprint, textFingerprint } from '../src/editor/audio/speech.ts';
import { measuredFor } from '../src/editor/store.ts';

const here = dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ID = 'pkg_editor_e2e_1';

const OPEN = 'one two three four. And a second sentence.';
const BODY = 'The middle beat stays fresh.';
const CLOSE = 'A closing line.';

function chunk(text, seconds, words) {
  return words ? { text, seconds, words } : { text, seconds };
}

export function buildFixture() {
  const base = JSON.parse(readFileSync(join(here, '../test/fixtures/editor/short/package.json'), 'utf8'));
  const pkg = structuredClone(base);
  pkg.id = PACKAGE_ID;
  pkg.revision = 1;
  pkg.title = 'Editor e2e fixture';
  const narration = { s_open: OPEN, s_body: BODY, s_close: CLOSE };
  for (const scene of pkg.scenes) scene.narration = narration[scene.id];

  const openWords = [
    { text: 'one', start: 0, end: 0.1 },
    { text: 'two', start: 0.1, end: 0.2 },
    { text: 'three', start: 0.2, end: 0.3 },
    { text: 'four.', start: 0.3, end: 0.5 },
  ];
  const secondWords = [
    { text: 'And', start: 0, end: 0.1 },
    { text: 'a', start: 0.1, end: 0.2 },
    { text: 'second', start: 0.2, end: 0.35 },
    { text: 'sentence.', start: 0.35, end: 0.5 },
  ];
  const scenes = {
    s_open: [
      chunk('one two three four.', 0.5, openWords),
      chunk('And a second sentence.', 0.5, secondWords),
    ],
    s_body: [chunk(BODY, 0.4)],
    s_close: [chunk(CLOSE, 0.4)],
  };
  const durations = {
    version: 1,
    engine: 'qwen3-tts',
    voice: 'hermes',
    speed: 1,
    sampleRate: 8000,
    gapSeconds: 0.15,
    paddingSeconds: 0.25,
    scenes: Object.fromEntries(Object.entries(scenes).map(([id, chunks]) => [id, { chunks }])),
  };

  const voice = pkg.voice;
  const takes = {};
  const alignment = {};
  for (const scene of pkg.scenes) {
    const chunks = scenes[scene.id];
    const take = {
      takeId: `take-${scene.id}`,
      assetId: 'a_plate',
      sourceHash: `hash-${scene.id}`,
      inputFingerprint: narrationInputFingerprint(scene, voice),
      sampleRate: 8000,
      sampleCount: 8000,
      range: { inSample: 0, outSample: 8000 },
    };
    takes[scene.id] = take;
    alignment[scene.id] = {
      sourceHash: take.sourceHash,
      textFingerprint: textFingerprint(scene.narration),
      chunks,
    };
  }
  const editor = { version: 1, captionOverrides: [], takes, alignment, presenterClips: {} };
  const validation = validatePackage(pkg);
  if (!validation.valid) {
    throw new Error(`e2e fixture is not a valid package: ${JSON.stringify(validation.errors)}`);
  }
  const doc = { package: pkg, editor, editSequence: 0 };
  const fromSidecar = frameProjection(compileTimeline(doc, measuredFor(doc, {})));
  const fromReport = frameProjection(compileTimeline(doc, measuredFromReport(durations)));
  if (JSON.stringify(fromSidecar) !== JSON.stringify(fromReport)) {
    throw new Error('e2e fixture sidecar and durations.json do not compile to the same timeline');
  }
  return { package: pkg, editor, durations, projection: fromSidecar };
}
