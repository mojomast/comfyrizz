import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runConversationTurn, brandTheme, CONVERSATION_PROMPT_VERSION, manifestBlock as clipManifestBlock } from '../../../packages/agent/dist/src/index.js';
import { createOpenAICompatibleModel } from '../../../packages/llm/dist/src/index.js';
import { buildChatProject, chatProjectResponse } from './chat-project.mjs';
import { rebaseChatPlans } from './chat-state.mjs';
import { createReferenceStore } from './references/store.mjs';
import { buildManifest, manifestBlock as referenceManifestBlock } from './references/manifest.mjs';
import { validateAssignment } from './references/assign.mjs';
import { listClips } from './takes/clips.mjs';
import { buildCorrection } from './takes/correction.mjs';
import { deriveClipState, TAKES_SCHEMA } from './takes/model.mjs';
import { selectTake } from './takes/select.mjs';
import { createTakeStore } from './takes/store.mjs';
import { createCharacterStore } from './characters/store.mjs';
import { addToProject, setCastOverrides } from './characters/cast.mjs';
import { buildCastManifest, manifestBlock as castManifestBlock } from './characters/manifest.mjs';

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

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function activeTakes(entry) {
  return Array.isArray(entry?.takes)
    ? entry.takes.filter(take => isPlainObject(take) && take.purged !== true)
    : [];
}

function effectiveSelected(entry) {
  const takes = activeTakes(entry);
  if (typeof entry?.selected === 'string' && takes.some(take => take.takeId === entry.selected)) {
    return entry.selected;
  }
  let best = null;
  for (const take of takes) {
    const n = Number.isSafeInteger(take.n) ? take.n : 0;
    const bestN = Number.isSafeInteger(best?.n) ? best.n : -1;
    if (!best || n >= bestN) best = take;
  }
  return best?.takeId ?? null;
}

function clipView(pkg, clip, doc) {
  const entry = isPlainObject(doc?.clips?.[clip.assetId]) ? doc.clips[clip.assetId] : null;
  const takes = activeTakes(entry);
  const selectedId = effectiveSelected(entry);
  const selected = takes.find(take => take.takeId === selectedId) ?? null;
  const asset = pkg.assets?.[clip.assetId];
  const state = deriveClipState({
    clip: isPlainObject(asset) ? asset : clip,
    takes: entry ?? { selected: null, takes: [] },
    assetGen: isPlainObject(asset?.gen) ? asset.gen : undefined,
  });
  const gen = isPlainObject(asset?.gen) ? asset.gen : {};
  return {
    clipId: clip.clipId,
    scene: clip.sceneId,
    sceneId: clip.sceneId,
    assetId: clip.assetId,
    slot: clip.slot,
    kind: clip.kind,
    state,
    takes,
    selected: selectedId,
    selectedN: Number.isSafeInteger(selected?.n) ? selected.n : null,
    prompt: gen.prompt,
    negative: gen.negative,
    seed: gen.seed,
    inputs: isPlainObject(gen.inputs) ? gen.inputs : undefined,
  };
}

function lastCorrection(entry) {
  const takes = activeTakes(entry);
  for (let index = takes.length - 1; index >= 0; index -= 1) {
    const note = takes[index]?.correction?.note;
    if (typeof note === 'string' && note.trim()) return note.trim().slice(0, 160);
  }
  return null;
}

function compactClip(view, entry) {
  return {
    clip_id: view.clipId,
    scene: view.scene,
    slot: view.slot,
    kind: view.kind,
    state: view.state,
    takes: activeTakes(entry).length,
    selected_n: view.selectedN,
    last_correction: lastCorrection(entry),
  };
}

function emptyTakesDoc(pkgId) {
  return { schema: TAKES_SCHEMA, packageId: pkgId, clips: {}, overrides: [] };
}

function publishEvent(events, payload) {
  const target = typeof events === 'function' ? events : events?.publish;
  if (typeof target !== 'function') return;
  try {
    target.call(events, payload);
  } catch {
    void payload;
  }
}

function isBusyResult(result) {
  return result?.status === 409 || result?.error === 'run busy';
}

function isBusyError(error) {
  return error?.status === 409 || error?.code === 'RUN_BUSY' || /run busy/i.test(error?.message ?? '');
}

function recordQueued(takeStore, pkgId, assetId, correction, planHash, backendId) {
  const doc = takeStore.read(pkgId) ?? emptyTakesDoc(pkgId);
  if (!isPlainObject(doc.clips)) doc.clips = {};
  if (!isPlainObject(doc.clips[assetId])) doc.clips[assetId] = { selected: null, takes: [] };
  const queued = { correction };
  if (typeof planHash === 'string' && /^[0-9a-f]{64}$/i.test(planHash)) queued.planHash = planHash;
  if (typeof backendId === 'string' && backendId) queued.backendId = backendId;
  doc.clips[assetId].queued = queued;
  takeStore.write(pkgId, doc);
  return doc;
}

function recordStarted(takeStore, pkgId, assetId, result) {
  const doc = takeStore.read(pkgId) ?? emptyTakesDoc(pkgId);
  if (!isPlainObject(doc.clips)) doc.clips = {};
  if (!isPlainObject(doc.clips[assetId])) doc.clips[assetId] = { selected: null, takes: [] };
  const entry = doc.clips[assetId];
  const runId = typeof result?.runId === 'string' && result.runId.trim() ? result.runId : null;
  if (runId) entry.lastJob = { runId, state: result.status ?? 'starting' };
  delete entry.queued;
  takeStore.write(pkgId, doc);
  return doc;
}

export function createProjectChat({
  runtimeDir,
  store,
  providerSettings,
  prepareBrand,
  skillsEnabled = true,
  takeStore = null,
  runs = null,
  events = null,
  measuredFor = null,
  characterStore = null,
}) {
  const dir = join(runtimeDir, 'conversations');
  mkdirSync(dir, { recursive: true });
  const takes = takeStore ?? createTakeStore({ runtimeDir, packageDir: store.dir });
  const active = new Set();
  let characterStoreCache = null;
  let characterStoreProbed = false;
  const charactersFor = () => {
    if (characterStore) return characterStore;
    if (!characterStoreProbed) {
      characterStoreProbed = true;
      // The library is optional: without library.json the chat keeps the exact
      // pre-character prompt and tool surface.
      if (existsSync(join(runtimeDir, 'characters', 'library.json'))) {
        try { characterStoreCache = createCharacterStore({ rootDir: runtimeDir }); } catch { characterStoreCache = null; }
      }
    }
    return characterStoreCache;
  };
  const measured = async pkg => {
    if (typeof measuredFor !== 'function') return {};
    const value = await measuredFor(pkg);
    return isPlainObject(value) ? value : {};
  };
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

  /** Clip review is opt-in and derived from the same timeline/takes as the HTTP routes. */
  async function buildClipContext(pkg, proposals) {
    if (!pkg) return undefined;
    let clips;
    try {
      clips = listClips(pkg, await measured(pkg));
    } catch {
      return undefined;
    }
    if (!clips.length) return undefined;
    try {
      if (typeof takes.adoptInitial === 'function') takes.adoptInitial(pkg);
    } catch {
      void pkg;
    }
    const doc = takes.read(pkg.id) ?? emptyTakesDoc(pkg.id);
    const views = clips.map(clip => clipView(pkg, clip, doc));
    const byId = new Map(views.map(view => [view.clipId, view]));
    const rows = views.map(view => compactClip(view, doc.clips?.[view.assetId]));
    const gate = () => {
      const blocking = views
        .filter(view => view.state !== 'approved')
        .map(view => ({ clipId: view.clipId, state: view.state }));
      return {
        ok: views.length > 0 && blocking.length === 0,
        approved: views.length - blocking.length,
        total: views.length,
        blocking,
      };
    };

    const record = (entry) => {
      const proposal = {
        id: `cp_${randomUUID().replaceAll('-', '').slice(0, 16)}`,
        status: 'proposed',
        createdAt: new Date().toISOString(),
        ...entry,
      };
      proposals.push(proposal);
      return proposal;
    };

    const proposeCorrection = correction => {
      const view = byId.get(correction?.clipId);
      if (!view) return { ok: false, error: `unknown clip: ${String(correction?.clipId)}` };
      const change = { by: 'agent' };
      for (const key of ['note', 'promptAppend', 'promptReplace', 'negativeAppend', 'seed', 'inputs']) {
        if (correction[key] !== undefined) change[key] = clone(correction[key]);
      }
      let built;
      try {
        const entry = doc.clips?.[view.assetId];
        built = buildCorrection(pkg, view.assetId, change, { takesCount: activeTakes(entry).length });
      } catch (error) {
        return { ok: false, error: error.message };
      }
      const proposal = record({
        kind: 'correction',
        clipId: view.clipId,
        assetId: view.assetId,
        note: change.note,
        change,
        correction: built.correction,
        diff: built.diff,
      });
      return { ok: true, proposalId: proposal.id, diff: built.diff };
    };

    const proposeSelect = selection => {
      const view = byId.get(selection?.clipId);
      if (!view) return { ok: false, error: `unknown clip: ${String(selection?.clipId)}` };
      const take = activeTakes(doc.clips?.[view.assetId])
        .find(item => Number.isSafeInteger(item.n) && item.n === selection.takeN);
      if (!take) return { ok: false, error: `take_n ${selection.takeN} is outside the clip's takes` };
      const proposal = record({
        kind: 'select',
        clipId: view.clipId,
        assetId: view.assetId,
        takeId: take.takeId,
        takeN: take.n,
        reason: selection.reason,
      });
      return { ok: true, proposalId: proposal.id };
    };

    const proposeVerdict = verdict => {
      const view = byId.get(verdict?.clipId);
      if (!view) return { ok: false, error: `unknown clip: ${String(verdict?.clipId)}` };
      if (!view.selected) return { ok: false, error: 'clip has no take to review' };
      const proposal = record({
        kind: 'verdict',
        clipId: view.clipId,
        assetId: view.assetId,
        takeId: view.selected,
        verdict: verdict.verdict,
        reason: verdict.reason,
      });
      return { ok: true, proposalId: proposal.id };
    };

    return {
      block: clipManifestBlock(rows),
      manifest: rows,
      clips: views,
      getClip: clipId => byId.get(clipId),
      proposeCorrection,
      proposeSelect,
      proposeVerdict,
      readiness: gate,
    };
  }
  function characterFilesForBuild(libraryStore, cast) {
    const files = {};
    if (!libraryStore || typeof libraryStore.imagesDir !== 'function') return files;
    for (const entry of Array.isArray(cast) ? cast : []) {
      const images = Array.isArray(entry?.snapshot?.visual?.images) ? entry.snapshot.visual.images : [];
      const image = images.find(item => item && item.primary === true) ?? images.find(item => item && item.imgId);
      if (!image?.imgId || typeof entry.characterId !== 'string') continue;
      try {
        const names = readdirSync(libraryStore.imagesDir(entry.characterId));
        const name = names.find(item => item.startsWith(`${image.imgId}.`));
        if (name) files[image.imgId] = { path: join(libraryStore.imagesDir(entry.characterId), name) };
      } catch {
        // A missing library image is reported in characters.json by applyCast.
      }
    }
    return files;
  }

  const samePlacement = (placement, castId, sceneId) => Boolean(placement
    && placement.castId === castId && placement.sceneId === sceneId);

  function confirmCastProposal(proposal, { cast, placements, libraryStore, now }) {
    const state = { cast, placements };
    if (!proposal || proposal.status !== 'proposed') return state;
    if (proposal.action === 'cast') {
      const character = libraryStore?.get(proposal.characterId)
        ?? state.cast.find(entry => entry.characterId === proposal.characterId)?.snapshot
        ?? null;
      if (!character) throw new Error(`character ${proposal.characterId} is not in the library`);
      const overrides = {};
      if (proposal.role) overrides.role = proposal.role;
      if (proposal.wardrobeId) overrides.wardrobeId = proposal.wardrobeId;
      const added = addToProject(state.cast, character, Object.keys(overrides).length ? { overrides } : {});
      state.cast = clone(added);
      if (!added.added && Object.keys(overrides).length) {
        state.cast = clone(setCastOverrides(state.cast, added.castId, overrides));
      }
      for (const sceneId of proposal.scenes ?? []) {
        const existing = state.placements.find(item => samePlacement(item, added.castId, sceneId));
        if (existing) {
          existing.status = 'confirmed';
          existing.confirmedAt = now;
          if (proposal.wardrobeId) existing.wardrobeId = proposal.wardrobeId;
          else delete existing.wardrobeId;
          if (proposal.role) existing.role = proposal.role;
          else delete existing.role;
          continue;
        }
        state.placements.push({
          castId: added.castId,
          sceneId,
          status: 'confirmed',
          confirmedAt: now,
          ...(proposal.wardrobeId ? { wardrobeId: proposal.wardrobeId } : {}),
          ...(proposal.role ? { role: proposal.role } : {}),
        });
      }
      proposal.status = 'confirmed';
      proposal.confirmedAt = now;
      proposal.castId = added.castId;
      proposal.pinnedRevision = added.entry?.pinnedRevision ?? null;
      state.changed = true;
      return state;
    }
    if (proposal.action === 'uncast') {
      const scenes = new Set(Array.isArray(proposal.scenes) ? proposal.scenes : []);
      const before = state.placements.length;
      state.placements = state.placements.filter(item => !(item.castId === proposal.castId && (scenes.size === 0 || scenes.has(item.sceneId))));
      proposal.removed = before - state.placements.length;
    } else if (proposal.action === 'voice') {
      const index = state.cast.findIndex(entry => entry.castId === proposal.castId);
      if (index < 0) throw new Error(`cast member ${proposal.castId} is not in this project`);
      const entry = state.cast[index];
      state.cast[index] = {
        ...entry,
        snapshot: { ...entry.snapshot, voice: clone(proposal.voice) },
      };
      state.changed = true;
    }
    proposal.status = 'confirmed';
    proposal.confirmedAt = now;
    return state;
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
    if (input.confirmClipProposals !== undefined && (!Array.isArray(input.confirmClipProposals)
      || input.confirmClipProposals.some(proposalId => typeof proposalId !== 'string' || !proposalId || proposalId.length > 80))) {
      fail(400, 'confirmClipProposals must be a list of proposal IDs');
    }
    if (input.confirmCastProposals !== undefined && (!Array.isArray(input.confirmCastProposals)
      || input.confirmCastProposals.some(proposalId => typeof proposalId !== 'string' || !proposalId || proposalId.length > 80))) {
      fail(400, 'confirmCastProposals must be a list of proposal IDs');
    }
    if (!input.provider || input.provider === 'none' || !providerSettings) fail(400, 'Choose a live provider and model in Agent settings to chat');
    if (active.has(id)) fail(409, 'This conversation already has a turn in progress');
    let session = read(id) ?? { id, revision: 0, messages: [], plan: null, phase: 'chatting', projectId: null, projectRevision: null };
    if (input.turnId && input.turnId === session.lastTurnId) return response(session, Boolean(session.lastTurnBuilt));
    if (input.baseRevision !== undefined && input.baseRevision !== session.revision) fail(409, 'Conversation changed in another tab. Reload before continuing.');
    if (session.messages.length >= 1000 || JSON.stringify(session.messages).length > 4000000) fail(400, 'This conversation is full. Start a new chat to continue.');
    // Manual storyboard edits are authoritative and intentionally picked up by
    // the next turn, so only the conversation revision is a concurrency lock.
    let current = session.projectId ? store.read(session.projectId) : null;
    let rebased = rebaseChatPlans(session.plan, session.previousPlan, current);
    let clipProposals = Array.isArray(session.clipProposals) ? clone(session.clipProposals) : [];
    let cast = Array.isArray(session.cast) ? clone(session.cast) : [];
    let castPlacements = Array.isArray(session.castPlacements) ? clone(session.castPlacements) : [];
    let castProposals = Array.isArray(session.castProposals) ? clone(session.castProposals) : [];
    let packageChanged = false;

    // Clip proposals are proposals until the user confirms them by ID (a text "yes"
    // trusts the model and still goes through the same take functions as the routes).
    if (input.confirmClipProposals?.length) {
      const confirmed = new Set(input.confirmClipProposals);
      for (const proposal of clipProposals) {
        if (!confirmed.has(proposal?.id) || proposal.status !== 'proposed') continue;
        const now = new Date().toISOString();
        try {
          if (proposal.kind === 'select') {
            if (!current) throw new Error('no project to apply this selection to');
            const doc = takes.read(current.id);
            if (!doc) throw new Error('takes document does not exist');
            const next = selectTake(current, doc, proposal.assetId, proposal.takeId);
            const saved = store.save(current.id, next, current.revision);
            takes.write(current.id, doc);
            publishEvent(events, {
              type: 'clip.take.selected', packageId: current.id, clipId: proposal.clipId,
              assetId: proposal.assetId, takeId: proposal.takeId,
            });
            proposal.status = 'confirmed';
            proposal.confirmedAt = now;
            proposal.revision = saved.revision ?? null;
            packageChanged = true;
            // A later proposal in this batch must save against the revision we just wrote.
            current = store.read(current.id);
          } else if (proposal.kind === 'verdict') {
            if (!current) throw new Error('no project to apply this verdict to');
            takes.setVerdict(current.id, proposal.assetId, proposal.takeId, proposal.verdict, proposal.reason);
            publishEvent(events, {
              type: 'clip.verdict', packageId: current.id, clipId: proposal.clipId,
              assetId: proposal.assetId, takeId: proposal.takeId, verdict: proposal.verdict,
              ...(typeof proposal.reason === 'string' ? { note: proposal.reason } : {}),
            });
            proposal.status = 'confirmed';
            proposal.confirmedAt = now;
          } else if (proposal.kind === 'correction') {
            if (!current) throw new Error('no project to regenerate');
            if (typeof runs?.start !== 'function') throw new Error('clip regeneration is not available in chat');
            const entry = takes.read(current.id)?.clips?.[proposal.assetId];
            const built = buildCorrection(current, proposal.assetId, proposal.change, { takesCount: activeTakes(entry).length });
            proposal.diff = built.diff;
            proposal.correction = built.correction;
            let result;
            try {
              result = await runs.start({
                backendId: 'colab',
                pkg: built.package,
                assets: [proposal.assetId],
                includeReady: true,
                mode: 'take',
                corrections: { [proposal.assetId]: built.correction },
                approved: false,
              });
            } catch (error) {
              if (!isBusyError(error)) throw error;
              result = { error: 'run busy', status: 409 };
            }
            if (isBusyResult(result)) {
              recordQueued(takes, current.id, proposal.assetId, built.correction, result?.planHash, 'colab');
              publishEvent(events, {
                type: 'clip.queued', packageId: current.id, clipId: proposal.clipId,
                assetId: proposal.assetId, backendId: 'colab',
                ...(typeof result?.planHash === 'string' ? { planHash: result.planHash } : {}),
              });
              proposal.status = 'confirmed';
              proposal.confirmedAt = now;
              proposal.queued = true;
            } else if (result?.approvalRequired || (result?.requiresApproval && result?.approved === false)) {
              proposal.status = 'approval_required';
              proposal.planHash = result.planHash ?? null;
              proposal.estimate = result.estimate ?? null;
            } else if (result?.refused) {
              throw new Error('the backend refused this regeneration');
            } else {
              recordStarted(takes, current.id, proposal.assetId, result);
              publishEvent(events, {
                type: 'clip.job', packageId: current.id, clipId: proposal.clipId,
                assetId: proposal.assetId, runId: result?.runId,
                state: result?.status ?? 'starting', progress: 0,
              });
              proposal.status = 'confirmed';
              proposal.confirmedAt = now;
              proposal.runId = result?.runId ?? null;
            }
          }
        } catch (error) {
          proposal.lastError = String(error?.message ?? 'the proposal could not be applied').slice(0, 300);
        }
      }
      if (packageChanged && current) {
        current = store.read(current.id);
        rebased = rebaseChatPlans(session.plan, session.previousPlan, current);
      }
    }

    // Cast proposals are proposals until the user confirms them by ID. Confirmed
    // membership and placements are persisted in the chat session; the library
    // stays untouched (project cast entries are pinned snapshots).
    if (input.confirmCastProposals?.length) {
      const confirmedIds = new Set(input.confirmCastProposals);
      const libraryStore = charactersFor();
      for (const proposal of castProposals) {
        if (!confirmedIds.has(proposal?.id) || proposal.status !== 'proposed') continue;
        const now = new Date().toISOString();
        try {
          const state = confirmCastProposal(proposal, { cast, placements: castPlacements, libraryStore, now });
          cast = state.cast;
          castPlacements = state.placements;
        } catch (error) {
          proposal.lastError = String(error?.message ?? 'the proposal could not be applied').slice(0, 300);
        }
      }
    }

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
        block: referenceManifestBlock(manifest),
        manifest,
        getRef: refId => referenceStore.get(refId),
        propose,
        unassign,
        ask: () => ({ ok: true }),
      };
    })();

    // Clips are opt-in too: no reviewable generated clips keeps the previous prompt/tools.
    const clips = await buildClipContext(current, clipProposals);

    // Characters are opt-in: an empty library and cast keep the exact prompt/tools.
    const libraryStore = charactersFor();
    const library = libraryStore ? libraryStore.list() : [];
    const sceneIds = current?.scenes?.map(scene => scene.id)
      ?? (Array.isArray(rebased.plan?.scenes) ? rebased.plan.scenes.map(scene => scene.id) : []);
    const recordCastProposal = proposal => {
      const record = {
        id: `cc_${randomUUID().replaceAll('-', '').slice(0, 16)}`,
        status: 'proposed',
        createdAt: new Date().toISOString(),
        ...clone(proposal),
      };
      castProposals.push(record);
      return { ok: true, proposalId: record.id, status: 'proposed' };
    };
    let characters;
    if (library.length || cast.length) {
      const manifest = buildCastManifest(cast, { placements: castPlacements, latestRevisions: library });
      characters = {
        block: castManifestBlock(manifest),
        manifest,
        cast,
        library,
        sceneIds,
        getCharacter: id => (libraryStore ? libraryStore.get(id) : null),
        propose: recordCastProposal,
        ask: () => ({ ok: true }),
      };
    }

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
        const castBuild = cast.length ? {
          cast,
          placements: castPlacements,
          files: characterFilesForBuild(libraryStore, cast),
        } : null;
        const candidate = await buildChatProject({ plan, previous: current, previousPlan: rebased.previousPlan ?? session.plan, brand, runtimeDir, signal, ...(referenceStore ? { references: referenceStore } : {}), ...(castBuild ? { characters: castBuild } : {}) });
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
        clips,
        characters,
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
        ...(clipProposals.length || Array.isArray(session.clipProposals) ? { clipProposals } : {}),
        ...(cast.length || Array.isArray(session.cast) ? { cast } : {}),
        ...(castPlacements.length || Array.isArray(session.castPlacements) ? { castPlacements } : {}),
        ...(castProposals.length || Array.isArray(session.castProposals) ? { castProposals } : {}),
        ...(builtPackage ? { projectId: builtPackage.id, projectRevision: builtPackage.revision, previousPlan: result.plan } : {}),
      };
      write(session);
      appendFileSync(join(dir, `${id}.turns.jsonl`), `${JSON.stringify({ turnId: input.turnId, revision: session.revision, provider: input.provider, model: config.model, ...session.trace })}\n`, { mode: 0o600 });
      return response(session, result.built);
    } finally { active.delete(id); }
  }
  return { get, send };
}
