import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runConversationTurn, brandTheme, CONVERSATION_PROMPT_VERSION } from '../../../packages/agent/dist/src/index.js';
import { createOpenAICompatibleModel } from '../../../packages/llm/dist/src/index.js';
import { buildChatProject, chatProjectResponse } from './chat-project.mjs';
import { rebaseChatPlans } from './chat-state.mjs';

function fail(status, message) { throw Object.assign(new Error(message), { status }); }
const validId = id => typeof id === 'string' && /^chat_[A-Za-z0-9_-]{8,80}$/.test(id);
export function createProjectChat({ runtimeDir, store, providerSettings, prepareBrand, skillsEnabled = true }) {
  const dir = join(runtimeDir, 'conversations');
  mkdirSync(dir, { recursive: true });
  const active = new Set();
  function read(id) {
    if (!validId(id)) fail(400, 'Invalid conversation ID');
    const file = join(dir, `${id}.json`);
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
  }
  function write(session) {
    const file = join(dir, `${session.id}.json`);
    const temp = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temp, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, file);
  }
  function response(session, built = false) {
    const pkg = session.projectId ? store.read(session.projectId) : null;
    const { lastTurnId, lastTurnBuilt, previousPlan, brand, ...conversation } = session;
    return {
      conversation,
      reply: session.messages.at(-1)?.role === 'assistant' ? session.messages.at(-1).content : '',
      built,
      ...(pkg ? { project: chatProjectResponse(pkg, runtimeDir) } : {}),
    };
  }
  function get(id) {
    const session = read(id);
    if (!session) fail(404, 'Conversation not found');
    return response(session);
  }
  async function send(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail(400, 'A chat message is required');
    const id = input.conversationId ?? `chat_${randomUUID()}`;
    if (!validId(id)) fail(400, 'Invalid conversation ID');
    if (typeof input.message !== 'string' || !input.message.trim() || input.message.length > 8000) fail(400, 'Message must contain 1–8000 characters');
    if (input.action !== undefined && input.action !== 'build') fail(400, 'Unknown conversation action');
    if (input.turnId !== undefined && (typeof input.turnId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(input.turnId))) fail(400, 'Invalid turn ID');
    if (!input.provider || input.provider === 'none' || !providerSettings) fail(400, 'Choose a live provider and model in Agent settings to chat');
    if (active.has(id)) fail(409, 'This conversation already has a turn in progress');
    let session = read(id) ?? { id, revision: 0, messages: [], plan: null, phase: 'chatting', projectId: null, projectRevision: null };
    if (input.turnId && input.turnId === session.lastTurnId) return response(session, Boolean(session.lastTurnBuilt));
    if (input.baseRevision !== undefined && input.baseRevision !== session.revision) fail(409, 'Conversation changed in another tab. Reload before continuing.');
    if (session.messages.length >= 1000 || JSON.stringify(session.messages).length > 4000000) fail(400, 'This conversation is full. Start a new chat to continue.');
    // Manual storyboard edits are authoritative and intentionally picked up by
    // the next turn, so only the conversation revision is a concurrency lock.
    const current = session.projectId ? store.read(session.projectId) : null;
    const rebased = rebaseChatPlans(session.plan, session.previousPlan, current);
    const config = providerSettings.resolve(input.provider, input.model);
    const model = createOpenAICompatibleModel(config);
    const brand = input.brand ? prepareBrand(input.brand, { assetsDir: join(runtimeDir, 'packages', 'assets') }) : session.brand ?? null;
    if (input.action === 'build' && !session.plan) fail(400, 'Write a draft before building');
    active.add(id);
    try {
      let builtPackage;
      const user = { role: 'user', content: input.message.trim() };
      const signal = AbortSignal.timeout(120000);
      const build = async plan => {
        const candidate = await buildChatProject({ plan, previous: current, previousPlan: rebased.previousPlan ?? session.plan, brand, runtimeDir, signal });
        signal.throwIfAborted();
        // Save with the revision captured before the model ran; intervening edits conflict.
        try {
          builtPackage = current ? store.save(current.id, candidate, current.revision) : store.write(candidate);
        } catch (error) {
          if (error.currentRevision !== undefined) fail(409, 'The project was edited while the agent was working. Reload before retrying.');
          throw error;
        }
        return { packageId: builtPackage.id, revision: builtPackage.revision, execution: {
          scenes: builtPackage.scenes.length, narration: 'script only', audioSynthesized: false, mp4Exported: false,
          visualDirections: 'notes, not executable custom animation',
          assets: Object.values(builtPackage.assets ?? {}).reduce((counts, asset) => { const key = `${asset.kind}:${asset.status}`; counts[key] = (counts[key] ?? 0) + 1; return counts; }, {}),
        } };
      };
      // The explicit UI action applies the reviewed draft without another creative generation.
      const result = input.action === 'build' ? await (async () => {
        await build(rebased.plan);
        return { plan: rebased.plan, built: true, reply: `Built “${rebased.plan.title}” into the project. You can preview it or keep chatting to revise it. Narration is a script; audio, GPU generation and export are separate steps.`, trace: { promptVersion: CONVERSATION_PROMPT_VERSION, skills: [], steps: 0, repairs: 0, usage: { input: 0, output: 0 }, tools: [{ name: 'project_build', ok: true }], omittedMessages: 0, elapsedMs: 0, stop: 'explicit-build' } };
      })() : await runConversationTurn({
        model, sessionId: id, signal, skillsEnabled,
        mode: input.mode, messages: [...session.messages, user], plan: rebased.plan,
        brandContext: brand?.kit,
        palette: brandTheme(brand?.kit ?? {}).palette,
        projectPalette: current?.theme?.palette,
        projectContext: current ? {
          id: current.id, revision: current.revision, title: current.title, format: current.format,
          theme: current.theme, manuallyEditedSinceLastBuild: current.revision !== session.projectRevision,
          scenes: current.scenes.map(scene => ({ id: scene.id, layout: scene.layout, copy: scene.copy, narration: scene.narration, visual: scene.notes, locked: scene.locked, seconds: scene.preferredFrames / current.format.fps, motion: scene.motion, transitionOut: scene.transitionOut, foreground: scene.foreground })),
        } : null,
        build,
      });
      const draftChanged = JSON.stringify(result.plan) !== JSON.stringify(rebased.plan);
      session = {
        ...session, revision: session.revision + 1,
        messages: [...session.messages, user, { role: 'assistant', content: providerSettings.redact(result.reply) }],
        plan: result.plan, phase: result.built ? 'built' : draftChanged && result.plan ? 'draft' : session.phase,
        provider: input.provider, model: config.model,
        brand, trace: JSON.parse(providerSettings.redact(JSON.stringify(result.trace))),
        warning: result.warning ? providerSettings.redact(result.warning) : null,
        lastTurnId: input.turnId ?? null, lastTurnBuilt: result.built,
        ...(builtPackage ? { projectId: builtPackage.id, projectRevision: builtPackage.revision, previousPlan: result.plan } : {}),
      };
      write(session);
      appendFileSync(join(dir, `${id}.turns.jsonl`), `${JSON.stringify({ turnId: input.turnId, revision: session.revision, provider: input.provider, model: config.model, ...session.trace })}\n`, { mode: 0o600 });
      return response(session, result.built);
    } finally { active.delete(id); }
  }
  return { get, send };
}
