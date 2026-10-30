// PS10: a pending source still whose dimensions disagree with the package
// output is an actionable repair problem, not a silently accepted plan.

import assert from 'node:assert/strict';
import test from 'node:test';
import { generatedFilmCompletionProblems, repairPackageFacts } from '../src/agent-runner.mjs';

const INTENT = {
  requestedSeconds: 6,
  requiresNarrationCues: false,
  wordless: true,
  noCaptions: false,
};

const PROPOSAL = {
  logline: 'A paper flower opens on a quiet table.',
  look: 'Tactile paper craft with soft window light.',
  soundtrack: 'Paper rustle and quiet room tone.',
};

function packageWithStills(width, height, stillWidth, stillHeight) {
  return {
    $schema: 'https://comfyrizz.example/schema/package-v1.json',
    schemaVersion: 1,
    revision: 1,
    id: 'pkg_ps10_aspect',
    title: 'A Paper Flower',
    createdAt: '2026-10-28T12:00:00.000Z',
    format: { width, height, fps: 30 },
    duration: { mode: 'flexible', flexibleCeilingFrames: 2700 },
    theme: { palette: ['#0d0f14', '#1b2440', '#6d8cff', '#e6e8ee'], font: 'Inter' },
    voice: { enabled: false, engine: 'none' },
    datasets: {},
    proposal: PROPOSAL,
    scenes: [{ id: 'shot1', layout: 'hero', preferredFrames: 180, background: { asset: 'a_video' }, foreground: [] }],
    assets: {
      a_img: {
        kind: 'image',
        origin: 'generated',
        status: 'pending',
        license: { id: 'CC0-1.0' },
        redistributable: true,
        gen: {
          generator: 'flux3-klein',
          workflow: 'workflows/flux3_klein_t2i.api.json',
          model: 'flux-3-klein',
          inputs: { prompt: 'A paper flower on a clean table.', width: stillWidth, height: stillHeight, seed: 0 },
        },
      },
      a_video: {
        kind: 'video',
        origin: 'generated',
        status: 'pending',
        license: { id: 'LicenseRef-MiniMax-H3-Community' },
        redistributable: false,
        gen: {
          generator: 'fasth3-omni',
          workflow: 'workflows/fasth3_omni_ref2va.api.json',
          model: 'fasth3-omni',
          direction: { soundscape: 'Soft paper rustle.' },
          inputs: { image: 'a_img', reference: 'a_img', audio: 'a_audio' },
        },
      },
      a_audio: {
        kind: 'audio',
        origin: 'upload',
        status: 'ready',
        file: 'assets/a_audio.wav',
        sha256: 'b'.repeat(64),
        license: { id: 'CC0-1.0' },
        redistributable: true,
        notes: 'Deterministic digital silence for wordless FastH3 conditioning.',
      },
    },
    compliance: { open_weights_only: true },
    renders: [],
  };
}

test('PS10 generated-film completion flags a pending still whose dims disagree with the output', () => {
  const mismatched = generatedFilmCompletionProblems(packageWithStills(1080, 1920, 576, 1024), INTENT, 'auto');
  const problem = mismatched.find(line => /source still/i.test(line));
  assert.ok(problem, JSON.stringify(mismatched));
  assert.match(problem, /576x1024/);
  assert.match(problem, /1080x1920/);

  const aligned = generatedFilmCompletionProblems(packageWithStills(1080, 1920, 1080, 1920), INTENT, 'auto');
  assert.equal(aligned.some(line => /source still/i.test(line)), false, JSON.stringify(aligned));
});

test('PS10 a square still is not accepted for a landscape film', () => {
  const problems = generatedFilmCompletionProblems(packageWithStills(1920, 1080, 1024, 1024), INTENT, 'auto');
  assert.ok(problems.some(line => /source still/i.test(line) && /1024x1024/.test(line)), JSON.stringify(problems));
});

test('PS10 repair facts name the still size and the required output size', () => {
  // Current image tools align output size automatically; use a legacy package
  // with a shot-referenced mismatched source to exercise the repair facts.
  const pkg = packageWithStills(1920, 1080, 1024, 1024);
  const prompt = repairPackageFacts(pkg, INTENT, '16:9');
  assert.match(prompt, /Source aspect repair/i);
  assert.match(prompt, /1024x1024/);
  assert.match(prompt, /1920x1080/);
});
