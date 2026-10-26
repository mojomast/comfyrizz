// UX20: drive the mounted `/api/agent/chat` route for a production-bound project.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './app-fixture.mjs';

const clone = value => JSON.parse(JSON.stringify(value));

/** Scenes with stable named ids; each narration has two lines so `<scene>:l2` resolves. */
export function namedScenePackage(packageId, sceneIds = ['s_intro', 's_outro']) {
  const fixture = JSON.parse(readFileSync(join(REPO_ROOT, 'packages', 'schema', 'fixtures', 'valid', 'variants.json'), 'utf8'));
  const pkg = clone(fixture);
  pkg.id = packageId;
  pkg.title = 'QA scoped chat';
  pkg.scenes = sceneIds.map(id => {
    const scene = { ...clone(fixture.scenes[0]), id, narration: `First line for ${id}. Second line for ${id}.` };
    delete scene.transitionOut;
    return scene;
  });
  return pkg;
}

/** Seed the conversation session the chat route continues (bound, already built). */
export function seedConversation(qa, { conversationId, pkg }) {
  mkdirSync(join(qa.runtimeDir, 'packages', 'assets'), { recursive: true });
  writeFileSync(join(qa.runtimeDir, 'packages', 'assets', 'a_logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#0d0f14"/></svg>');
  mkdirSync(join(qa.runtimeDir, 'conversations'), { recursive: true });
  writeFileSync(join(qa.runtimeDir, 'conversations', `${conversationId}.json`), `${JSON.stringify({
    id: conversationId,
    revision: 1,
    messages: [{ role: 'user', content: 'Show me the cut.' }, { role: 'assistant', content: 'Here is the current cut.' }],
    plan: null,
    phase: 'built',
    projectId: pkg.id,
    projectRevision: pkg.revision,
  }, null, 2)}\n`);
}

let turn = 0;
const revisions = new WeakMap();
/**
 * POST one chat turn through the real route. `scope` is the viewer's iterationScope; `chips` are turnContext.
 * The conversation revision is tracked per app so consecutive turns do not hit the "changed in another tab" guard.
 */
export async function sendChat(qa, { conversationId, message, chips, scope, mode = 'plan' }) {
  turn += 1;
  const known = revisions.get(qa) ?? new Map();
  revisions.set(qa, known);
  const result = await qa.json('/api/agent/chat', {
    conversationId,
    baseRevision: known.get(conversationId) ?? 1,
    turnId: `qa-turn-${String(turn).padStart(4, '0')}`,
    message,
    provider: 'custom',
    model: 'scripted',
    mode,
    ...(chips ? { turnContext: chips } : {}),
    ...(scope ? { iterationScope: scope } : {}),
  });
  const revision = result.body?.conversation?.revision;
  if (Number.isSafeInteger(revision)) known.set(conversationId, revision);
  return result;
}

/** A complete, valid initial draft for the named scenes (project_update_plan arguments). */
export function draftPlanArgs(sceneIds, headline = 'Meet Orbit') {
  return {
    title: 'QA scoped chat', brief: 'Named scenes for scoped-edit acceptance', audience: 'testers', aspect: '16:9', stylePreset: 'cinematic-dark',
    scenes: sceneIds.map(id => ({ id, layout: 'title', headline, narration: `First line for ${id}. Second line for ${id}.`, seconds: 4, visual: 'procedural backdrop' })),
  };
}

export const lineChip = lineId => [{ id: `clip:${lineId}`, kind: 'clip', label: lineId, value: lineId }];
export const proposal = (shotId, lineId, summary = `Improve ${lineId}.`) => ({ edits: [{ shotId, lineId, instruction: summary }], actions: [], summary });
