/**
 * K1 acceptance (c): the word caption styles render on the real CPU path, at the
 * frames the timeline says. The suite has no eyes, so this reads pixels back:
 * `karaoke` paints only the spoken word in the accent gold, and the gold's
 * centroid marches left-to-right through the sentence; `word-pop` adds each
 * spoken word to the band, so the white ink grows. A black background and a
 * one-character headline keep the frame to the caption alone.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderPackage } from '../scripts/render-package-lib.mjs';
import { checkVideo } from '../scripts/frame-qa.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, 'fixtures', 'tiny');
const WORDS = [
  { text: 'Meet', start: 0, end: 0.6 },
  { text: 'Orbit', start: 0.6, end: 1.4 },
  { text: 'today.', start: 1.4, end: 2 },
];

/** Render the one-sentence fixture in `style` and return the MP4 path. */
function renderStyle(work, style) {
  const packageDir = join(work, style);
  cpSync(fixture, packageDir, { recursive: true });
  const pkg = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
  pkg.id = `pkg_k1${style.replace('-', '')}01`;
  pkg.format = { width: 1920, height: 1080, fps: 30 };
  pkg.captions = { style };
  pkg.scenes = [
    {
      id: 's_title',
      layout: 'title',
      variant: 'centered',
      preferredFrames: 60,
      copy: { headline: '.' },
      background: { procedural: { pattern: 'gradient', palette: ['#000000', '#000000'], seed: 1 } },
    },
  ];
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify(pkg, null, 2));
  mkdirSync(join(packageDir, 'audio'), { recursive: true });
  writeFileSync(join(packageDir, 'audio', 'durations.json'), JSON.stringify({
    gapSeconds: 0.15,
    paddingSeconds: 0.25,
    scenes: { s_title: { chunks: [{ text: 'Meet Orbit today.', seconds: 2, words: WORDS }] } },
  }));
  const out = join(work, `${style}.mp4`);
  const rendered = renderPackage(join(packageDir, 'package.json'), out);
  assert.equal(rendered.timeline.captions[0].words.length, 3, `${style}: the render compiled the word cues`);
  return { out, timeline: rendered.timeline, pkg: rendered.package };
}

/** Gold (karaoke highlight) and white pixel stats of one full frame. */
function frameStats(file, frame) {
  const result = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', `select=eq(n\\,${frame}),format=rgb24`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1024 * 1024 * 64 });
  assert.equal(result.status, 0, `ffmpeg stats failed: ${result.stderr}`);
  const bytes = result.stdout;
  const width = 1920;
  let gold = 0;
  let goldX = 0;
  let white = 0;
  for (let i = 0; i < bytes.length; i += 3) {
    const r = bytes[i];
    const g = bytes[i + 1];
    const b = bytes[i + 2];
    if (r > 200 && g > 170 && b < 190 && r - b > 40) {
      gold += 1;
      goldX += (i / 3) % width;
    }
    if (r > 200 && g > 200 && b > 200) white += 1;
  }
  return { gold, goldX: gold > 0 ? goldX / gold : -1, white };
}

test('K1: karaoke highlights the spoken word and the highlight moves through the sentence', { timeout: 300_000 }, () => {
  const work = mkdtempSync(join(tmpdir(), 'comfyrizz-k1karaoke-'));
  try {
    const { out, timeline, pkg } = renderStyle(work, 'karaoke');
    const frames = [8, 30, 55].map(frame => frameStats(out, frame));
    assert.ok(frames.every(item => item.gold > 0), `every spoken word should be highlighted: ${JSON.stringify(frames)}`);
    assert.ok(frames[1].goldX > frames[0].goldX, `word 2's highlight is right of word 1's (${frames[1].goldX} vs ${frames[0].goldX})`);
    assert.ok(frames[2].goldX > frames[1].goldX, `word 3's highlight is right of word 2's (${frames[2].goldX} vs ${frames[1].goldX})`);
    // Acceptance (e): the frame-QA safe-area/contrast checks stay clean for the word styles.
    const report = checkVideo({ mp4: out, timeline, pkg });
    const bad = report.findings.filter(item => item.code === 'QA_CONTRAST' || item.code === 'QA_SAFE_AREA');
    assert.deepEqual(bad, [], `karaoke should pass safe-area/contrast: ${JSON.stringify(bad)}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('K1: word-pop adds each spoken word to the caption band', { timeout: 300_000 }, () => {
  const work = mkdtempSync(join(tmpdir(), 'comfyrizz-k1wordpop-'));
  try {
    const { out } = renderStyle(work, 'word-pop');
    const frames = [8, 30, 55].map(frame => frameStats(out, frame));
    assert.ok(frames[0].white > 0, `word 1 should be drawn at frame 8, ink=${frames[0].white}`);
    assert.ok(frames[1].white > frames[0].white, `two words should out-ink one (${frames[1].white} vs ${frames[0].white})`);
    assert.ok(frames[2].white > frames[1].white, `three words should out-ink two (${frames[2].white} vs ${frames[1].white})`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
