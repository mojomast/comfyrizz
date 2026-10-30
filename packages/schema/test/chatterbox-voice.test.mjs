import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePackage } from '../src/index.mjs';

const base = { $schema: 'https://comfyrizz.dev/schema/package-v1.json', schemaVersion: 1, revision: 1, id: 'pkg_chatterbox', title: 'cb', createdAt: '2026-10-30T23:00:00Z',
  format: { width: 1920, height: 1080, fps: 30 }, duration: { mode: 'flexible', flexibleCeilingFrames: 2700 },
  theme: { palette: ['#000000', '#111111', '#222222', '#ffffff'], font: 'Inter', text: '#ffffff', text_muted: '#cccccc', text_on_accent: '#000000' },
  scenes: [{ id: 's1', layout: 'title', preferredFrames: 90, copy: { headline: 'Hi' }, background: { procedural: { pattern: 'mesh', seed: 1, palette: ['#000000', '#111111', '#222222'] } }, narration: 'Hello there.' }],
  assets: {}, compliance: { open_weights_only: true, llm: { provider: 'local-agent', model: 'hand-written', weights: 'open' }, backends_used: [], closed_apis_used: [], warnings: [] } };

test('SPW integration: a chatterbox voice validates; an unknown engine does not', () => {
  const ok = validatePackage({ ...base, voice: { enabled: true, engine: 'chatterbox', voice: 'en', language: 'English (en)' } });
  assert.equal(ok.valid, true, JSON.stringify(ok.errors));
  const bad = validatePackage({ ...base, voice: { enabled: true, engine: 'other', voice: 'en' } });
  assert.equal(bad.valid, false);
});
