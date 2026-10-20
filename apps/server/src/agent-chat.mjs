import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runConversationTurn, brandTheme, CONVERSATION_PROMPT_VERSION } from '../../../packages/agent/dist/src/index.js';
import { createOpenAICompatibleModel } from '../../../packages/llm/dist/src/index.js';
import { buildChatProject, chatProjectResponse } from './chat-project.mjs';
import { rebaseChatPlans } from './chat-state.mjs';
import { createReferenceStore } from './references/store.mjs';
import { buildManifest, manifestBlock } from './references/manifest.mjs';
import { validateAssignment } from './references/assign.mjs';

function fail(status, message) { throw Object.assign(new Error(message), { status }); }
const clone = value => (value === undefined ? value : JSON.parse(JSON.stringify(value)));

/** The reference store mirrors confirmed placements only; proposals stay in the session. */
function confirmedAssignments(assignments, refs) {
  const known = new Set(refs.map(ref => ref.id));
  return assignments
    .filter(assignment => assignment && assignment.status === 'confirmed'
      && assignment.action !== 'unassign' && known.has(assignment.refId))
    .map(assignment => clone(assignment));
}

const sameTarget = (assignment, target) => Boolean(assignment && assignment.action !== 'unassign'
  && assignment.refId === target.refId && assignment.sceneId === target.sceneId
  && assignment.slot === target.slot);
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
    if (input.confirmAssignments !== undefined && (!Array.isArray(input.confirmAssignments)
      || input.confirmAssignments.some(assignmentId => typeof assignmentId !== 'string' || !assignmentId || assignmentId.length > 80))) {
      fail(400, 'confirmAssignments must be a list of assignment IDs');
    }
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

    // References are opt-in: a conversation without a library keeps the exact
    // prompt and tool list it had before this feature existed.
    const referenceStore = existsSync(join(runtimeDir, 'references', id, 'refs.json'))
      ? createReferenceStore({ rootDir: runtimeDir, chatId: id })
      : null;
    let referenceAssignments = Array.isArray(session.referenceAssignments)
      ? clone(session.referenceAssignments)
      : [];
    const syncReferenceAssignments = () => {
      if (!referenceStore) return;
      referenceStore.setAssignments(confirmedAssignments(referenceAssignments, referenceStore.list()));
    };
    // The UI confirms proposals by ID on the next turn (a text "yes" works the same way).
    if (referenceStore && input.confirmAssignments?.length) {
      const confirmedIds = new Set(input.confirmAssignments);
      const removals = referenceAssignments.filter(assignment => assignment
        && confirmedIds.has(assignment.id) && assignment.status === 'proposed' && assignment.action === 'unassign');
      referenceAssignments = referenceAssignments.filter(assignment => !(assignment
        && confirmedIds.has(assignment.id) && assignment.status === 'proposed' && assignment.action === 'unassign'));
      const confirmedAt = new Date().toISOString();
      referenceAssignments = referenceAssignments.map(assignment => (assignment
        && confirmedIds.has(assignment.id) && assignment.status === 'proposed')
        ? { ...assignment, status: 'confirmed', confirmedAt }
        : assignment);
      for (const removal of removals) {
        referenceAssignments = referenceAssignments.filter(assignment => !sameTarget(assignment, removal));
      }
      syncReferenceAssignments();
    }
    const references = (() => {
      if (!referenceStore) return undefined;
      const refs = referenceStore.list();
      if (!refs.length) return undefined;
      const propose = assignment => {
        try {
          validateAssignment({
            refId: assignment.refId,
            sceneId: assignment.sceneId,
            slot: assignment.slot,
            ...(assignment.frameIndex !== undefined ? { frameIndex: assignment.frameIndex } : {}),
          }, { refs, scenes: [{ id: assignment.sceneId }], assignments: referenceAssignments });
        } catch (error) {
          return { ok: false, error: error.message };
        }
        const now = new Date().toISOString();
        const existing = referenceAssignments.find(item => sameTarget(item, assignment));
        if (existing) {
          if (existing.status !== 'confirmed') {
            existing.status = 'proposed';
            existing.reason = assignment.reason;
            existing.proposedAt = now;
            if (assignment.frameIndex === undefined) delete existing.frameIndex;
            else existing.frameIndex = assignment.frameIndex;
          }
          try { syncReferenceAssignments(); } catch (error) { return { ok: false, error: error.message }; }
          return { ok: true, id: existing.id, status: existing.status };
        }
        const record = {
          id: `as_${randomUUID().replaceAll('-', '').slice(0, 16)}`,
          refId: assignment.refId,
          sceneId: assignment.sceneId,
          slot: assignment.slot,
          status: 'proposed',
          reason: assignment.reason,
          proposedAt: now,
          ...(assignment.frameIndex !== undefined ? { frameIndex: assignment.frameIndex } : {}),
        };
        referenceAssignments.push(record);
        try { syncReferenceAssignments(); } catch (error) {
          referenceAssignments = referenceAssignments.filter(item => item !== record);
          return { ok: false, error: error.message };
        }
        return { ok: true, id: record.id, status: 'proposed' };
      };
      const unassign = target => {
        const matches = referenceAssignments.filter(item => sameTarget(item, target));
        if (!matches.length) return { ok: false, error: 'no assignment to remove' };
        if (matches.every(item => item.status !== 'confirmed')) {
          referenceAssignments = referenceAssignments.filter(item => !matches.includes(item));
          try { syncReferenceAssignments(); } catch (error) { return { ok: false, error: error.message }; }
          return { ok: true, id: matches[0].id, status: 'proposed' };
        }
        const pending = referenceAssignments.find(item => item && item.action === 'unassign'
          && item.status === 'proposed' && item.refId === target.refId
          && item.sceneId === target.sceneId && item.slot === target.slot);
        if (pending) return { ok: true, id: pending.id, status: 'proposed' };
        const record = {
          id: `as_${randomUUID().replaceAll('-', '').slice(0, 16)}`,
          refId: target.refId, sceneId: target.sceneId, slot: target.slot,
          status: 'proposed', action: 'unassign', reason: 'requested removal',
          proposedAt: new Date().toISOString(),
        };
        referenceAssignments.push(record);
        try { syncReferenceAssignments(); } catch (error) {
          referenceAssignments = referenceAssignments.filter(item => item !== record);
          return { ok: false, error: error.message };
        }
        return { ok: true, id: record.id, status: 'proposed' };
      };
      const manifest = buildManifest(refs, referenceAssignments);
      return {
        block: manifestBlock(manifest),
        manifest,
        getRef: refId => referenceStore.get(refId),
        propose,
        unassign,
        ask: () => ({ ok: true }),
      };
    })();

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
        const candidate = await buildChatProject({ plan, previous: current, previousPlan: rebased.previousPlan ?? session.plan, brand, runtimeDir, signal, ...(referenceStore ? { references: referenceStore } : {}) });
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
        references,
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
        ...(referenceStore || Array.isArray(session.referenceAssignments) ? { referenceAssignments } : {}),
        ...(builtPackage ? { projectId: builtPackage.id, projectRevision: builtPackage.revision, previousPlan: result.plan } : {}),
      };
      write(session);
      appendFileSync(join(dir, `${id}.turns.jsonl`), `${JSON.stringify({ turnId: input.turnId, revision: session.revision, provider: input.provider, model: config.model, ...session.trace })}\n`, { mode: 0o600 });
      return response(session, result.built);
    } finally { active.delete(id); }
  }
  return { get, send };
}
