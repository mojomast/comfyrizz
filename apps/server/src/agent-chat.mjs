import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { MODEL_CONTRIBUTION_PROMPT } from '../../../packages/jobs/src/model-contribution.mjs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { withConversationLock } from './conversation-lock.mjs';
import { runConversationTurn, brandTheme, conversationPlanSchema, CONVERSATION_PROMPT_VERSION, idMentions, manifestBlock as clipManifestBlock } from '../../../packages/agent/dist/src/index.js';
import { createOpenAICompatibleModel } from '../../../packages/llm/dist/src/index.js';
import { buildChatProject, chatPlanFromPackage, chatProjectResponse } from './chat-project.mjs';
import { rebaseChatPlans } from './chat-state.mjs';
import { createReferenceStore } from './references/store.mjs';
import { buildManifest, manifestBlock as referenceManifestBlock } from './references/manifest.mjs';
import { validateAssignment } from './references/assign.mjs';
import { listClips } from './takes/clips.mjs';
import { buildCorrection } from './takes/correction.mjs';
import { applyProceduralFinishingAudio } from './procedural-audio.mjs';
import { sceneAssetIds } from '../../../packages/agent/dist/src/scene-build.js';
import { InvalidPackageError } from './store.mjs';
import { validatePackage } from '../../../packages/schema/src/index.mjs';
import { deriveClipState, TAKES_SCHEMA, VERDICTS } from './takes/model.mjs';
import { selectTake } from './takes/select.mjs';
import { createTakeStore } from './takes/store.mjs';
import { createCharacterStore } from './characters/store.mjs';
import { addToProject, setCastOverrides } from './characters/cast.mjs';
import { buildCastManifest, manifestBlock as castManifestBlock } from './characters/manifest.mjs';
import { IterationScopeError, normalizeTargetSet, scopeIdKind, toPromptHint, validateIterationScope } from './productions/iteration-scope.mjs';
import { PACKAGE_EDIT_TOOL, applyChatPackageEdit } from './chat-package-edit.mjs';
import { guardOrdinaryMutation, runProductionTool } from '../../../packages/agent/dist/src/production-tools.js';
import { compilePackage } from './compile-package.mjs';

function fail(status, message, extra) { throw Object.assign(new Error(message), { status }, extra); }
const clone = value => (value === undefined ? value : JSON.parse(JSON.stringify(value)));

function correctionSceneId(pkg, proposal) {
  const scene = (pkg?.scenes ?? []).find(item => item?.id === proposal?.clipId
    || sceneAssetIds(item).includes(proposal?.assetId));
  return scene?.id ?? String(proposal?.clipId ?? '').split(':')[0];
}

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

// IP39W: rejecting is a durable decision on the proposal record, not a model
// turn. An unknown id is a caller error; a repeated rejection is an idempotent
// success so a retried request can never fail after it already landed.
function rejectProposalRecords(session, { rejectAssignments, rejectCastProposals }, turnId, now) {
  const referenceAssignments = Array.isArray(session?.referenceAssignments) ? clone(session.referenceAssignments) : [];
  const castProposals = Array.isArray(session?.castProposals) ? clone(session.castProposals) : [];
  const apply = (records, ids) => {
    for (const proposalId of ids ?? []) {
      const index = records.findIndex(record => record?.id === proposalId);
      if (index < 0) fail(404, 'UNKNOWN_PROPOSAL', { code: 'UNKNOWN_PROPOSAL' });
      const record = records[index];
      if (record.status === 'rejected') continue;
      if (record.status !== 'proposed') fail(409, 'PROPOSAL_CONFIRMED', { code: 'PROPOSAL_CONFIRMED' });
      records[index] = {
        ...record,
        status: 'rejected',
        rejectedAt: now,
        ...(turnId ? { turnId } : {}),
      };
    }
  };
  apply(referenceAssignments, rejectAssignments);
  apply(castProposals, rejectCastProposals);
  return { referenceAssignments, castProposals };
}

const CAST_SESSION_FIELDS = ['cast', 'castPlacements', 'castProposals'];

function sameExceptCastChanges(base, current) {
  const keys = new Set([...Object.keys(base ?? {}), ...Object.keys(current ?? {})]);
  for (const key of keys) {
    if (key === 'revision' || CAST_SESSION_FIELDS.includes(key)) continue;
    if (!isDeepStrictEqual(base?.[key], current?.[key])) return false;
  }
  return true;
}

// A cast route may advance the conversation while the model is running. That
// revision is compatible with the turn as long as nothing outside the cast
// fields moved: keep the newer cast, and only let the turn win a cast field the
// snapshot did not also change.
function mergeCastOnlyCommit(base, current, next) {
  if (!base || !current) return null;
  if (!CAST_SESSION_FIELDS.some(field => !isDeepStrictEqual(base[field], current[field]))) return null;
  if (!sameExceptCastChanges(base, current)) return null;
  const merged = { ...next };
  for (const field of CAST_SESSION_FIELDS) {
    if (!isDeepStrictEqual(next[field], base[field])) {
      if (!isDeepStrictEqual(current[field], base[field])) return null;
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(current, field)) merged[field] = current[field];
    else delete merged[field];
  }
  merged.revision = (Number.isSafeInteger(current.revision) ? current.revision : 0) + 1;
  return merged;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// AV13: the viewer's element-scoped request is application data. Validation
// happens before any turn starts, and the deterministic hint is the only part
// that becomes a generation directive; the note stays in the user's text.
function normalizedIterationScope(raw) {
  if (raw === undefined) return null;
  try {
    return validateIterationScope(raw);
  } catch (error) {
    if (error instanceof IterationScopeError) {
      fail(400, 'Invalid iteration scope', { code: 'INVALID_ITERATION_SCOPE', field: error.field });
    }
    throw error;
  }
}

// UX09: the explicit requested target set (UX00). Absent means unscoped, an
// empty list means nothing may change, and anything malformed is refused before
// a turn starts. The host omits `targets` when no chips are selected.
function normalizedTargets(raw) {
  if (raw === undefined || raw === null) return undefined;
  try {
    const set = normalizeTargetSet(raw);
    return { shotIds: [...set.shotIds], lineIds: [...set.lineIds] };
  } catch (error) {
    if (error instanceof IterationScopeError) {
      fail(400, 'Invalid targets', { code: 'INVALID_TARGETS', field: error.field });
    }
    throw error;
  }
}

function iterationScopeBlock(scope) {
  const payload = {
    target: scope.target,
    element: scope.element,
    ...(scope.elementRef !== undefined ? { elementRef: scope.elementRef } : {}),
    ...(scope.region !== undefined ? { region: scope.region } : {}),
    ...(scope.time !== undefined ? { time: scope.time } : {}),
    preserve: scope.preserve,
    hint: toPromptHint(scope),
  };
  return `<iteration_scope>\n${JSON.stringify(payload)}\n</iteration_scope>`;
}

function iterationUserText(message, scope) {
  const text = message.trim();
  if (!scope || text.includes(scope.note)) return text;
  return `${text}\n\nQuoted note: ${JSON.stringify(scope.note)}`;
}

function scopeTargetsClip(scope, proposal) {
  const target = scope?.target ?? {};
  if (typeof target.clipId === 'string') return target.clipId === proposal?.clipId;
  if (typeof target.assetId === 'string') return target.assetId === proposal?.assetId;
  return false;
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

const PRODUCTION_COPY_LINE_KEYS = ['headline', 'sub', 'body', 'footnote'];

function productionTextLines(value) {
  if (typeof value !== 'string') return [];
  return value
    .split(/\r?\n|(?<=[.!?])\s+/u)
    .map(part => part.trim())
    .filter(Boolean);
}

// A shot's lines are the real script sentences and on-screen copy the bound
// package already carries. The line count is exactly that content: an empty or
// single-line shot never gains a synthetic line id.
function productionLinesForShot(shotId, scene) {
  const texts = [];
  if (Array.isArray(scene?.lines)) {
    for (const line of scene.lines) if (typeof line === 'string' && line.trim()) texts.push(line.trim());
  }
  texts.push(...productionTextLines(scene?.narration));
  if (isPlainObject(scene?.copy)) {
    for (const key of PRODUCTION_COPY_LINE_KEYS) {
      if (typeof scene.copy[key] === 'string' && scene.copy[key].trim()) texts.push(scene.copy[key].trim());
    }
    if (Array.isArray(scene.copy.items)) {
      for (const item of scene.copy.items) if (typeof item === 'string' && item.trim()) texts.push(item.trim());
    }
  }
  const unique = [...new Set(texts)];
  return unique.map((_, index) => `${shotId}:l${index + 1}`);
}

// Shot ids come from the production journal; the package supplies the lines
// those shots contain. A shot the package does not carry keeps an empty line
// list rather than inventing ids.
function productionShotsFor(snapshot, pkg) {
  const scenes = Array.isArray(pkg?.scenes) ? pkg.scenes : [];
  const shotIds = Array.isArray(snapshot?.shotIds)
    ? snapshot.shotIds.filter(id => typeof id === 'string' && id !== '')
    : [];
  return shotIds.map(shotId => ({
    id: shotId,
    lines: productionLinesForShot(shotId, scenes.find(scene => scene?.id === shotId) ?? null),
  }));
}

const CHIP_ID_FIELDS = ['sceneId', 'shotId', 'lineId', 'targetId'];
const CHIP_TEXT_FIELDS = ['value', 'id', 'label'];
const CHIP_PREFIX = /^(?:clip|shot|line|scene|target):/u;

// Explicit turnContext chips are the only chip source of a requested scope. There
// is deliberately no last-selected fallback. A chip names a target by a canonical
// id (`s_intro:l2`, `s_intro`, or a clip `s_intro:a_logo`, which means its shot)
// or by numeric prose ("shot 2 line 1"). Free text only counts when it is a real
// shot or line of the production, so a label such as "Sunset" never becomes a
// target. A chip that names nothing is ignored; no chip naming a target at all
// leaves the turn unscoped (undefined), never an empty list.
function requestedTargetsFromChips(turnContext, shots) {
  const knownShots = new Set(shots.map(shot => shot.id));
  const knownLines = new Set(shots.flatMap(shot => shot.lines));
  const shotIds = new Set();
  const lineIds = new Set();
  const add = id => {
    if (scopeIdKind(id) === 'line') lineIds.add(id);
    else if (scopeIdKind(id) === 'clip') shotIds.add(id.split(':')[0]);
    else if (scopeIdKind(id) === 'shot') shotIds.add(id);
  };
  for (const chip of Array.isArray(turnContext) ? turnContext : []) {
    if (!isPlainObject(chip)) continue;
    for (const field of CHIP_ID_FIELDS) {
      const text = chip[field];
      if (typeof text === 'string') add(text.replace(CHIP_PREFIX, ''));
    }
    for (const field of CHIP_TEXT_FIELDS) {
      const text = chip[field];
      if (typeof text !== 'string') continue;
      const bare = text.replace(CHIP_PREFIX, '');
      if (knownLines.has(bare) || knownShots.has(bare)) add(bare);
      else if (scopeIdKind(bare) === 'clip') add(bare);
      else for (const id of idMentions(text)) add(id);
    }
  }
  if (shotIds.size === 0 && lineIds.size === 0) return undefined;
  return { shotIds: [...shotIds], lineIds: [...lineIds] };
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
  hooks = null,
  modelFactory = null,
  production = null,
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
  // IP66: the binding is resolved from the production journal for the package
  // the conversation is actually working on. A production context is only
  // built with productionState and a real user turn, so live chat never reaches
  // the unguarded IP35 dispatch path and never invents an attribution.
  function productionContextFor(pkg, input, { iterationScope = null, targets, builtPlan } = {}) {
    if (!production
      || typeof production.findBound !== 'function'
      || typeof production.read !== 'function'
      || typeof production.command !== 'function'
      || !pkg?.id) return null;
    const turnId = typeof input?.turnId === 'string' && input.turnId !== '' ? input.turnId : null;
    if (!turnId) return null;
    const bound = production.findBound(pkg.id);
    if (!isPlainObject(bound) || typeof bound.id !== 'string' || bound.id === '') return null;
    const snapshot = production.read(bound.id);
    if (!isPlainObject(snapshot)) return null;
    const intent = typeof snapshot.intent === 'string' ? snapshot.intent : 'active';
    const shots = productionShotsFor(snapshot, pkg);
    const requested = targets ?? requestedTargetsFromChips(input?.turnContext, shots);
    const lockedShotIds = Array.isArray(snapshot.lockedShotIds)
      ? snapshot.lockedShotIds.filter(id => typeof id === 'string' && id !== '')
      : [];
    const pinned = iterationScope?.sourceRevision?.packageRevision;
    const scopeStale = Number.isSafeInteger(pinned) && Number.isSafeInteger(pkg.revision) && pinned !== pkg.revision
      ? `the iteration scope was authored against package revision ${pinned} but the project is at revision ${pkg.revision}; ask the user to select the target again`
      : undefined;
    return {
      productionId: bound.id,
      userEventId: `ue_${turnId}`,
      turnId,
      read: productionId => production.read(productionId),
      command: (envelope, attribution) => production.command(envelope, attribution),
      capabilities: { read: true, proposePlan: true, commands: true },
      productionState: {
        intent,
        shots,
        ...(requested ? { targets: requested } : {}),
        ...(lockedShotIds.length ? { lockedShotIds } : {}),
      },
      ...(iterationScope ? { iterationScope } : {}),
      ...(scopeStale ? { scopeStale } : {}),
      ...(builtPlan ? { builtPlan } : {}),
    };
  }
  function read(id) {
    if (!validId(id)) fail(400, 'Invalid conversation ID');
    const file = join(dir, `${id}.json`);
    if (!existsSync(file)) return null;
    const session = JSON.parse(readFileSync(file, 'utf8'));
    // Attachment conversations are created before project chat and have no
    // chat revision or plan yet. Treat them as revision zero, including on GET
    // and CAS, while retaining their existing metadata.
    return { revision: 0, plan: null, phase: 'chatting', projectId: null, projectRevision: null, ...session,
      revision: Number.isSafeInteger(session.revision) && session.revision >= 0 ? session.revision : 0 };
  }
  function writeAtomic(file, text) {
    const temp = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temp, text, { mode: 0o600 });
    renameSync(temp, file);
  }
  function write(session) {
    writeAtomic(join(dir, `${session.id}.json`), `${JSON.stringify(session, null, 2)}\n`);
  }
  const sourceDir = join(runtimeDir, 'narration-revision-context');
  function sourceContextFor(pkg, session) {
    if (!pkg) return null;
    try { return JSON.parse(readFileSync(join(sourceDir, `${pkg.id}.${pkg.revision}.json`), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    return session.sourceContext ?? null;
  }
  function preserveSourceContext(session, pkg) {
    if (!session?.sourceContext || !pkg) return;
    mkdirSync(sourceDir, { recursive: true });
    writeAtomic(join(sourceDir, `${pkg.id}.${pkg.revision}.json`), JSON.stringify(session.sourceContext));
  }
  const intentPath = id => join(dir, `${id}.commit.json`);
  const journalPath = id => join(dir, `${id}.turns.jsonl`);
  const packageHash = pkg => createHash('sha256').update(JSON.stringify(pkg)).digest('hex');

  function readIntent(id) {
    try {
      return JSON.parse(readFileSync(intentPath(id), 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }
  function writeIntent(intent) {
    writeAtomic(intentPath(intent.conversationId), `${JSON.stringify(intent, null, 2)}\n`);
  }
  function deleteIntent(id) {
    try { unlinkSync(intentPath(id)); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }

  // The journal is append-only in spirit but repaired in place: a torn tail is
  // dropped and a missing line for the committed snapshot is restored.
  function readJournal(id) {
    const file = journalPath(id);
    if (!existsSync(file)) return { entries: [], text: '' };
    const raw = readFileSync(file, 'utf8');
    const entries = [];
    const kept = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line));
        kept.push(line);
      } catch {
        break;
      }
    }
    return { entries, text: kept.length ? `${kept.join('\n')}\n` : '' };
  }
  function appendJournal(id, session, built) {
    const { entries, text } = readJournal(id);
    const trace = isPlainObject(session.trace) ? session.trace : {};
    const entry = {
      ...trace,
      turnId: session.lastTurnId ?? null,
      revision: session.revision,
      built: Boolean(built ?? session.lastTurnBuilt),
      provider: session.provider ?? null,
      model: session.model ?? null,
    };
    const duplicate = entries.some(item => item?.type !== 'recovery'
      && ((entry.turnId && item.turnId === entry.turnId)
        || (Number.isSafeInteger(item.revision) && item.revision === entry.revision)));
    writeAtomic(journalPath(id), duplicate ? text : `${text}${JSON.stringify(entry)}\n`);
  }
  // A recovery decision is an audit line, not a turn: it never advances the
  // conversation and must never make the failed turn replayable.
  function appendRecoveryJournal(id, { choice, turnId }) {
    const { text } = readJournal(id);
    const entry = { type: 'recovery', choice, turnId: turnId ?? null, at: new Date().toISOString() };
    writeAtomic(journalPath(id), `${text}${JSON.stringify(entry)}\n`);
  }
  const repairJournal = (id, session) => appendJournal(id, session, session.lastTurnBuilt);
  function committedTurn(id, turnId) {
    if (!turnId) return null;
    const { entries } = readJournal(id);
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      if (entries[index]?.type === 'recovery') continue;
      if (entries[index]?.turnId === turnId) return entries[index];
    }
    return null;
  }

  function withLock(id, fn) {
    return withConversationLock(dir, id, fn);
  }
  function writeCas(session, expectedRevision) {
    const current = read(session.id);
    const currentRevision = current ? current.revision : 0;
    if (currentRevision !== expectedRevision) {
      fail(409, 'Conversation changed in another tab. Reload before continuing.', { currentRevision });
    }
    write(session);
  }
  function applyTakeOps(ops) {
    for (const op of Array.isArray(ops) ? ops : []) {
      try {
        if (op?.op === 'select') takes.setSelected(op.packageId, op.assetId, op.takeId);
        else if (op?.op === 'verdict') takes.setVerdict(op.packageId, op.assetId, op.takeId, op.verdict, op.reason);
      } catch { /* the package effect is already proven; keep recovery moving */ }
    }
  }
  // A turn is rolled forward only when the package is exactly at the revision
  // and content hash the intent recorded. Anything else is a real conflict.
  function recoveryConflict(intent, pkg) {
    return {
      turnId: intent.turnId ?? null,
      projectId: intent.package?.projectId ?? null,
      expected: intent.package?.afterRevision ?? intent.package?.expectedRevision ?? null,
      found: pkg ? pkg.revision : null,
    };
  }
  function recoverLocked(id) {
    const intent = readIntent(id);
    const session = read(id);
    if (!intent) {
      if (session) repairJournal(id, session);
      return null;
    }
    if (session && session.revision >= intent.revision) {
      repairJournal(id, session);
      deleteIntent(id);
      return null;
    }
    const ref = isPlainObject(intent.package) ? intent.package : null;
    const projectId = ref?.projectId ?? null;
    const pkg = projectId ? store.read(projectId) : null;
    const expected = ref?.expectedRevision ?? null;
    const proven = ref?.afterRevision !== undefined && ref?.hash
      && pkg && pkg.revision === ref.afterRevision && packageHash(pkg) === ref.hash;
    if (proven && intent.session) {
      preserveSourceContext(intent.session, pkg);
      applyTakeOps(intent.takesOps);
      const latest = read(id);
      const latestRevision = latest ? latest.revision : 0;
      if (latestRevision === intent.baseRevision) {
        write(intent.session);
        appendJournal(id, intent.session, intent.session.lastTurnBuilt);
        deleteIntent(id);
        return null;
      }
      return recoveryConflict(intent, pkg);
    }
    if (ref?.afterRevision === undefined || !ref?.hash) {
      if (!projectId) { deleteIntent(id); return null; }
      const moved = pkg ? pkg.revision !== expected : expected !== null;
      if (!moved) { deleteIntent(id); return null; }
      return recoveryConflict(intent, pkg);
    }
    return recoveryConflict(intent, pkg);
  }
  function response(session, built = false) {
    const pkg = session.projectId ? store.read(session.projectId) : null;
    const { lastTurnId, lastTurnBuilt, previousPlan, adoptionPending, brand, sourceContext, ...conversation } = session;
    if (Array.isArray(conversation.clipProposals)) {
      conversation.clipProposals = conversation.clipProposals.map(proposal => proposal?.status === 'approval_required' && !proposal?.planHash
        ? { ...proposal, status: 'proposed' }
        : proposal);
    }
    return {
      conversation,
      reply: session.messages.at(-1)?.role === 'assistant' ? session.messages.at(-1).content : '',
      built,
      ...(pkg ? { project: chatProjectResponse(pkg, runtimeDir) } : {}),
    };
  }
  function get(id) {
    const conflict = withLock(id, () => recoverLocked(id));
    const session = read(id);
    if (!session) fail(404, 'Conversation not found');
    const body = response(session);
    return conflict ? { ...body, recoveryConflict: conflict } : body;
  }

  /**
   * IP40R: a RECOVERY_CONFLICT is a user decision, never a bricked chat.
   * `discard` (the safe default) only reverts the exact unproven partial
   * package write; `retry` clears the intent and lets the client run a fresh
   * turn with a new turnId. Neither touches takes documents or paid artifacts.
   */
  function resolveRecovery(id, options) {
    if (!validId(id)) fail(400, 'Invalid conversation ID');
    const choice = options?.choice;
    if (choice !== 'discard' && choice !== 'retry') fail(400, "choice must be 'discard' or 'retry'");
    const expected = options?.expected;
    return withLock(id, () => {
      const conflict = recoverLocked(id);
      const session = read(id);
      if (!conflict) {
        if (!session) fail(404, 'Conversation not found');
        return { resolved: 'none', ...response(session) };
      }
      if (!session) fail(404, 'Conversation not found');
      if (expected !== undefined && expected !== null) {
        if (!Number.isSafeInteger(expected) || expected !== conflict.found) {
          fail(409, 'RECOVERY_CHANGED', { code: 'RECOVERY_CHANGED', recoveryConflict: conflict });
        }
      }
      const intent = readIntent(id);
      if (!intent) return { resolved: 'none', ...response(session) };
      const ref = isPlainObject(intent.package) ? intent.package : null;
      let restored = false;
      if (choice === 'discard' && ref?.before && ref.projectId) {
        const pkg = store.read(ref.projectId);
        // Only the exactly-identified partial write is ours to undo. Any later
        // save (an editor, another writer) is already the last good save.
        if (pkg && pkg.revision === ref.predictedRevision) {
          try {
            store.save(ref.projectId, { ...clone(ref.before) }, pkg.revision);
            restored = true;
          } catch (error) {
            if (error.currentRevision !== undefined) {
              fail(409, 'RECOVERY_CHANGED', {
                code: 'RECOVERY_CHANGED',
                recoveryConflict: recoveryConflict(intent, store.read(ref.projectId)),
              });
            }
            throw error;
          }
        }
      }
      const turnId = intent.turnId ?? null;
      const retry = choice === 'retry'
        ? (isPlainObject(intent.request)
          ? {
            message: intent.request.message ?? null,
            action: intent.request.action ?? null,
            mode: intent.request.mode ?? null,
            ...(intent.request.iterationScope ? { iterationScope: intent.request.iterationScope } : {}),
          }
          : null)
        : null;
      deleteIntent(id);
      appendRecoveryJournal(id, { choice, turnId });
      if (choice === 'retry') return { resolved: 'retry', retry, ...response(session) };
      return { resolved: 'discarded', restored, ...response(session) };
    });
  }

  /** Clip review is opt-in and derived from the same timeline/takes as the HTTP routes. */
  async function buildClipContext(pkg, proposals, docOverride = null) {
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
    const doc = docOverride ?? takes.read(pkg.id) ?? emptyTakesDoc(pkg.id);
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

    const proposeAudio = input => {
      const note = String(input?.note ?? '').trim();
      const plan = String(input?.plan ?? '').trim();
      if (!note || !plan) return { ok: false, error: 'note and plan are required' };
      const proposal = record({
        kind: 'audio', clipId: 'soundtrack', note,
        change: { by: 'agent', note, plan },
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
      proposeAudio,
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

  async function authorizeClipProposals(input, id) {
    const ids = new Set(input.confirmClipProposals ?? []);
    if (!ids.size) fail(400, 'Choose at least one generation to authorize');
    let session;
    let proposals;
    let baseRevision;
    withLock(id, () => {
      const conflict = recoverLocked(id);
      if (conflict) fail(409, 'RECOVERY_CONFLICT', { code: 'RECOVERY_CONFLICT', recoveryConflict: conflict });
      session = read(id);
      if (!session) fail(404, 'Conversation not found');
      if (input.expectedPackageId && session.projectId !== input.expectedPackageId) {
        fail(409, 'The conversation belongs to a different project.', { code: 'EDIT_PACKAGE_MISMATCH' });
      }
      if (input.turnId && input.turnId === session.lastTurnId) {
        baseRevision = -1;
        return;
      }
      if (input.expectedPackageId && store.read(session.projectId)?.revision !== input.expectedPackageRevision) {
        fail(409, 'The project changed before the edit. Reload before continuing.', { code: 'EDIT_PACKAGE_STALE' });
      }
      if (input.baseRevision !== undefined && input.baseRevision !== session.revision) {
        fail(409, 'Conversation changed in another tab. Reload before continuing.', { currentRevision: session.revision });
      }
      baseRevision = session.revision;
      proposals = clone(session.clipProposals ?? []);
    });
    if (baseRevision === -1) return response(session, Boolean(session.lastTurnBuilt));
    const selected = proposals.filter(proposal => ids.has(proposal?.id));
    if (!selected.length) fail(404, 'No matching generation proposals remain');
    const started = [];
    const queued = [];
    for (const proposal of selected) {
      try {
        if (proposal.kind !== 'correction' || proposal.status !== 'approval_required') {
          throw new Error('this proposal is not waiting for spend approval');
        }
        if (typeof proposal.planHash !== 'string' || !proposal.planHash) throw new Error('the generation plan is missing; prepare it again');
        if (typeof runs?.approve !== 'function' || typeof runs?.start !== 'function') throw new Error('clip regeneration is not available in chat');
        const pkg = store.read(session.projectId);
        if (!pkg) throw new Error('the project no longer exists');
        const entry = takes.read(pkg.id)?.clips?.[proposal.assetId];
        const built = buildCorrection(pkg, proposal.assetId, proposal.change, { takesCount: activeTakes(entry).length });
        proposal.diff = built.diff;
        proposal.correction = built.correction;
        runs.approve(proposal.planHash);
        let result;
        try {
          result = await runs.start({
            backendId: 'colab', pkg: built.package, assets: [proposal.assetId], includeReady: true,
            mode: 'take', corrections: { [proposal.assetId]: built.correction }, approved: false,
          });
        } catch (error) {
          if (!isBusyError(error)) throw error;
          result = { error: 'run busy', status: 409, planHash: proposal.planHash };
        }
        if (isBusyResult(result)) {
          recordQueued(takes, pkg.id, proposal.assetId, built.correction, result?.planHash ?? proposal.planHash, 'colab');
          proposal.status = 'confirmed';
          proposal.queued = true;
          proposal.confirmedAt = new Date().toISOString();
          queued.push(proposal.clipId);
        } else if (result?.approvalRequired || (result?.requiresApproval && result?.approved === false)) {
          proposal.planHash = result.planHash ?? proposal.planHash;
          proposal.estimate = result.estimate ?? proposal.estimate;
          throw new Error('the plan changed after review; authorize the updated plan');
        } else if (result?.refused) {
          throw new Error(result.message ?? 'the backend refused this regeneration');
        } else {
          recordStarted(takes, pkg.id, proposal.assetId, result);
          proposal.status = 'confirmed';
          proposal.queued = false;
          proposal.runId = result?.runId ?? null;
          proposal.confirmedAt = new Date().toISOString();
          started.push(proposal.clipId);
        }
        publishEvent(events, {
          type: proposal.queued ? 'clip.queued' : 'clip.job', packageId: pkg.id, clipId: proposal.clipId,
          assetId: proposal.assetId, backendId: 'colab', runId: result?.runId,
          state: result?.status ?? 'starting', progress: 0,
        });
      } catch (error) {
        proposal.lastError = String(error?.message ?? 'the generation could not be authorized').slice(0, 300);
      }
    }
    const reply = [
      started.length ? `Started generation for ${started.join(', ')}.` : '',
      queued.length ? `Queued generation for ${queued.join(', ')}.` : '',
      !started.length && !queued.length ? 'No generation started. Review the proposal errors and try again.' : '',
    ].filter(Boolean).join(' ');
    let committed;
    withLock(id, () => {
      const latest = read(id);
      if (!latest || latest.revision !== baseRevision) {
        fail(409, 'Conversation changed in another tab. Reload before continuing.', { currentRevision: latest?.revision ?? null });
      }
      const now = new Date().toISOString();
      committed = {
        ...latest, revision: baseRevision + 1, clipProposals: proposals,
        messages: [...latest.messages,
          { role: 'user', content: String(input.message ?? 'Authorize the reviewed generations.'), at: now },
          { role: 'assistant', content: reply, at: now }],
        lastTurnId: input.turnId ?? null, lastTurnBuilt: false,
      };
      writeCas(committed, baseRevision);
      appendJournal(id, committed, false);
    });
    return response(committed);
  }

  async function send(input, turnHooks = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail(400, 'A chat message is required');
    const id = input.conversationId ?? `chat_${randomUUID()}`;
    if (!validId(id)) fail(400, 'Invalid conversation ID');
    if (input.action !== undefined && !['build', 'authorizeClipProposals'].includes(input.action)) fail(400, 'Unknown conversation action');
    if (input.turnId !== undefined && (typeof input.turnId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(input.turnId))) fail(400, 'Invalid turn ID');
    if (input.adoptPackageId !== undefined && (typeof input.adoptPackageId !== 'string'
      || !/^[A-Za-z0-9_.-]{1,128}$/.test(input.adoptPackageId))) {
      fail(400, 'adoptPackageId must be a valid package ID', { code: 'INVALID_ADOPT_PACKAGE_ID' });
    }
    if (input.expectedPackageId !== undefined && (typeof input.expectedPackageId !== 'string'
      || !/^[A-Za-z0-9_.-]{1,128}$/.test(input.expectedPackageId)
      || !Number.isSafeInteger(input.expectedPackageRevision) || input.expectedPackageRevision < 0)) {
      fail(400, 'An edit needs a valid package ID and revision.', { code: 'INVALID_EDIT_CONTEXT' });
    }
    if (input.expectedPackageRevision !== undefined && input.expectedPackageId === undefined) {
      fail(400, 'An edit revision needs its package ID.', { code: 'INVALID_EDIT_CONTEXT' });
    }
    const iterationScope = normalizedIterationScope(input.iterationScope);
    const requestedTargets = normalizedTargets(input.targets);
    if (input.rejectAssignments !== undefined && (!Array.isArray(input.rejectAssignments)
      || input.rejectAssignments.some(assignmentId => typeof assignmentId !== 'string' || !assignmentId || assignmentId.length > 80))) {
      fail(400, 'rejectAssignments must be a list of assignment IDs');
    }
    if (input.rejectCastProposals !== undefined && (!Array.isArray(input.rejectCastProposals)
      || input.rejectCastProposals.some(proposalId => typeof proposalId !== 'string' || !proposalId || proposalId.length > 80))) {
      fail(400, 'rejectCastProposals must be a list of proposal IDs');
    }
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
    const hasMessage = typeof input.message === 'string' && Boolean(input.message.trim());
    const decisionOnly = !hasMessage
      && (Boolean(input.rejectAssignments?.length) || Boolean(input.rejectCastProposals?.length))
      && input.action === undefined
      && !input.confirmAssignments?.length
      && !input.confirmClipProposals?.length
      && !input.confirmCastProposals?.length;
    if (!decisionOnly && (typeof input.message !== 'string' || !input.message.trim() || input.message.length > 8000)) {
      fail(400, 'Message must contain 1–8000 characters');
    }
    if (decisionOnly) {
      if (input.adoptPackageId !== undefined) fail(400, 'A proposal decision cannot adopt a package', { code: 'PACKAGE_ADOPTION_NOT_ALLOWED' });
      if (!Number.isSafeInteger(input.baseRevision) || input.baseRevision < 0) fail(400, 'A rejection needs the conversation base revision');
      if (!input.turnId) fail(400, 'A rejection needs a fresh turn ID');
    } else if (!input.provider || input.provider === 'none' || !providerSettings) {
      fail(400, 'Choose a live provider and model in Agent settings to chat');
    }
    if (active.has(id)) fail(409, 'This conversation already has a turn in progress');
    active.add(id);
    try {
      if (input.action === 'authorizeClipProposals') return await authorizeClipProposals(input, id);
      // A rejection-only request is a decision, not a conversation turn: it
      // commits under the same lock and journal, but never resolves a provider
      // or calls the model.
      if (decisionOnly) {
        let decided = null;
        let replay = null;
        withLock(id, () => {
          const conflict = recoverLocked(id);
          if (conflict) fail(409, 'RECOVERY_CONFLICT', { code: 'RECOVERY_CONFLICT', recoveryConflict: conflict });
          const session = read(id) ?? { id, revision: 0, messages: [], plan: null, phase: 'chatting', projectId: null, projectRevision: null };
          if (input.turnId === session.lastTurnId) {
            replay = response(session, Boolean(session.lastTurnBuilt));
            return;
          }
          const committed = committedTurn(id, input.turnId);
          if (committed) {
            replay = response(session, Boolean(committed.built));
            return;
          }
          if (input.baseRevision !== session.revision) {
            fail(409, 'Conversation changed in another tab. Reload before continuing.', { currentRevision: session.revision });
          }
          const now = new Date().toISOString();
          const { referenceAssignments, castProposals } = rejectProposalRecords(
            session,
            { rejectAssignments: input.rejectAssignments, rejectCastProposals: input.rejectCastProposals },
            input.turnId,
            now,
          );
          const nextSession = {
            ...session,
            revision: session.revision + 1,
            lastTurnId: input.turnId,
            lastTurnBuilt: false,
            ...(referenceAssignments.length || Array.isArray(session.referenceAssignments) ? { referenceAssignments } : {}),
            ...(castProposals.length || Array.isArray(session.castProposals) ? { castProposals } : {}),
          };
          writeCas(nextSession, session.revision);
          appendJournal(id, nextSession, false);
          decided = nextSession;
        });
        if (replay) return replay;
        return response(decided ?? read(id));
      }

      // Phase A: one short lock covers recovery and the read-modify snapshot of
      // the conversation. The model call never runs under this lock.
      let session = null;
      let replay = null;
      let baseRevision = 0;
      let current = null;
      let capturedPackageRevision = null;
      let simCurrent = null;
      let simDoc = null;
      let packageChanged = false;
      let rebased = { plan: null, previousPlan: null };
      let clipProposals = [];
      let cast = [];
      let castPlacements = [];
      let castProposals = [];
      let rejectionAt = null;
      let rejectedReferenceIds = new Set();
      let corrections = [];
      const selectOps = [];
      const verdictOps = [];
      withLock(id, () => {
        const conflict = recoverLocked(id);
        if (conflict) fail(409, 'RECOVERY_CONFLICT', { code: 'RECOVERY_CONFLICT', recoveryConflict: conflict });
        session = read(id) ?? { id, revision: 0, messages: [], plan: null, phase: 'chatting', projectId: null, projectRevision: null };
        if (input.expectedPackageId && ((session.projectId && session.projectId !== input.expectedPackageId)
          || (input.adoptPackageId && input.adoptPackageId !== input.expectedPackageId))) {
          fail(409, 'The conversation belongs to a different project.', { code: 'EDIT_PACKAGE_MISMATCH' });
        }
        if (input.turnId && input.turnId === session.lastTurnId) {
          replay = response(session, Boolean(session.lastTurnBuilt));
          return;
        }
        if (input.turnId) {
          // A turn recorded in the journal stays idempotent even when a later
          // turn has already advanced lastTurnId.
          const committed = committedTurn(id, input.turnId);
          if (committed) {
            replay = response(session, Boolean(committed.built));
            return;
          }
        }
        if (input.baseRevision !== undefined && input.baseRevision !== session.revision) {
          fail(409, 'Conversation changed in another tab. Reload before continuing.', { currentRevision: session.revision });
        }
        if (session.messages.length >= 1000 || JSON.stringify(session.messages).length > 4000000) fail(400, 'This conversation is full. Start a new chat to continue.');
        baseRevision = session.revision;
        const adoptionId = input.adoptPackageId ?? (!session.projectId ? input.expectedPackageId : undefined);
        if (adoptionId !== undefined) {
          // Adoption is a one-way binding for a new or still-unbound conversation.
          // Replay is handled above, so a retried committed turn remains idempotent.
          if (session.projectId) {
            fail(409, 'This conversation is already bound to a package.', { code: 'PACKAGE_ADOPTION_NOT_ALLOWED' });
          }
          const adopted = store.read(adoptionId);
          if (!adopted) fail(404, 'The package to adopt was not found.', { code: 'PACKAGE_NOT_FOUND' });
          session = {
            ...session,
            projectId: adopted.id,
            projectRevision: adopted.revision,
            // There is no last-built chat plan yet. The first complete plan that
            // builds successfully becomes previousPlan on the commit below.
            adoptionPending: true,
          };
          delete session.previousPlan;
        }
        // Manual storyboard edits are authoritative and intentionally picked up by
        // the next turn, so only the conversation revision is a concurrency lock.
        // PackageStore.save still compare-and-swaps capturedPackageRevision below.
        current = session.projectId ? store.read(session.projectId) : null;
        if (session.projectId && !current) {
          fail(404, 'The bound package was not found; an edit cannot create a replacement.', { code: 'PACKAGE_NOT_FOUND' });
        }
        if (input.expectedPackageId && current?.revision !== input.expectedPackageRevision) {
          fail(409, 'The project changed before the edit. Reload before continuing.', {
            code: 'EDIT_PACKAGE_STALE', currentRevision: current?.revision,
          });
        }
        capturedPackageRevision = current ? current.revision : null;
        const sourceContext = sourceContextFor(current, session);
        if (sourceContext) session.sourceContext = sourceContext;
        simCurrent = current;
        clipProposals = Array.isArray(session.clipProposals)
          ? clone(session.clipProposals).map(proposal => proposal?.status === 'approval_required' && !proposal?.planHash
            ? { ...proposal, status: 'proposed' }
            : proposal)
          : [];
        cast = Array.isArray(session.cast) ? clone(session.cast) : [];
        castPlacements = Array.isArray(session.castPlacements) ? clone(session.castPlacements) : [];
        castProposals = Array.isArray(session.castProposals) ? clone(session.castProposals) : [];

        // IP39W: rejecting is settled before any confirmation is considered, so
        // a rejected id in the same turn's confirm list is refused rather than
        // quietly ignored by the status check.
        rejectionAt = new Date().toISOString();
        const rejection = rejectProposalRecords(
          session,
          { rejectAssignments: input.rejectAssignments, rejectCastProposals: input.rejectCastProposals },
          input.turnId ?? null,
          rejectionAt,
        );
        castProposals = rejection.castProposals;
        rejectedReferenceIds = new Set(rejection.referenceAssignments
          .filter(record => record?.status === 'rejected' && typeof record.id === 'string')
          .map(record => record.id));
        const rejectedCastIds = new Set(castProposals
          .filter(record => record?.status === 'rejected' && typeof record.id === 'string')
          .map(record => record.id));
        if (input.confirmAssignments?.some(assignmentId => rejectedReferenceIds.has(assignmentId))
          || input.confirmCastProposals?.some(proposalId => rejectedCastIds.has(proposalId))) {
          fail(409, 'PROPOSAL_REJECTED', { code: 'PROPOSAL_REJECTED' });
        }

        // Clip proposals are proposals until the user confirms them by ID (a text "yes"
        // trusts the model and still goes through the same take functions as the routes).
        // Selects change the package candidate; their disk write is deferred to the commit.
        if (input.confirmClipProposals?.length) {
          const confirmed = new Set(input.confirmClipProposals);
          for (const proposal of clipProposals) {
            if (!confirmed.has(proposal?.id) || proposal.status !== 'proposed') continue;
            const now = new Date().toISOString();
            try {
              if (proposal.kind === 'select') {
                if (!simCurrent) throw new Error('no project to apply this selection to');
                if (!simDoc) simDoc = takes.read(simCurrent.id);
                if (!simDoc) throw new Error('takes document does not exist');
                const next = selectTake(simCurrent, simDoc, proposal.assetId, proposal.takeId);
                simCurrent = next;
                packageChanged = true;
                proposal.status = 'confirmed';
                proposal.confirmedAt = now;
                selectOps.push({
                  op: 'select', proposalId: proposal.id, clipId: proposal.clipId,
                  packageId: simCurrent.id, assetId: proposal.assetId, takeId: proposal.takeId,
                });
              } else if (proposal.kind === 'verdict') {
                if (!simCurrent) throw new Error('no project to apply this verdict to');
                if (!VERDICTS.includes(proposal.verdict)) throw new Error('invalid verdict');
                if (!simDoc) simDoc = takes.read(simCurrent.id);
                if (!simDoc) throw new Error('takes document does not exist');
                const entry = simDoc.clips?.[proposal.assetId];
                const take = Array.isArray(entry?.takes)
                  ? entry.takes.find(item => item?.takeId === proposal.takeId) : null;
                if (!take) throw new Error('take is not in this clip');
                take.verdict = proposal.verdict;
                if (typeof proposal.reason === 'string') take.verdictNote = proposal.reason;
                proposal.status = 'confirmed';
                proposal.confirmedAt = now;
                verdictOps.push({
                  op: 'verdict', proposalId: proposal.id, clipId: proposal.clipId,
                  packageId: simCurrent.id, assetId: proposal.assetId, takeId: proposal.takeId,
                  verdict: proposal.verdict, reason: proposal.reason,
                });
              } else if (proposal.kind === 'correction' || proposal.kind === 'audio') {
                if (!simCurrent) throw new Error(proposal.kind === 'audio' ? 'no project to score' : 'no project to regenerate');
                if (iterationScope && scopeTargetsClip(iterationScope, proposal)) {
                  proposal.change = {
                    ...(isPlainObject(proposal.change) ? proposal.change : {}),
                    promptAppend: toPromptHint(iterationScope),
                  };
                }
                corrections.push(proposal);
              }
            } catch (error) {
              proposal.lastError = String(error?.message ?? 'the proposal could not be applied').slice(0, 300);
            }
          }
        }

        // Cast proposals stay in the session; the library is untouched.
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

        rebased = rebaseChatPlans(session.plan, session.previousPlan, simCurrent);
        if (!rebased.plan && simCurrent) {
          // Saved proposals can be bound before a chat draft exists. Projection
          // is optional: video-only scenes need not satisfy draft copy rules.
          // Never invent brief/audience metadata to force a full replan.
          const projected = chatPlanFromPackage(simCurrent, session.plan);
          const parsed = conversationPlanSchema.safeParse(projected);
          if (parsed.success) rebased.plan = parsed.data;
          if (!session.previousPlan) session.adoptionPending = true;
        }
      });
      if (replay) return replay;

      const lastBuiltPlan = session.adoptionPending ? null : (rebased.previousPlan ?? session.plan);
      const adoptionBaseline = session.adoptionPending && simCurrent
        ? chatPlanFromPackage(simCurrent, rebased.plan ?? session.plan)
        : null;

      // Corrections start their run before the model sees the conversation, as
      // they did before the commit split. Phase C contains no await.
      const boundCorrections = [];
      for (const proposal of corrections) {
        const now = new Date().toISOString();
        try {
          if (proposal.kind === 'audio') {
            const applied = applyProceduralFinishingAudio(simCurrent, {
              plan: proposal.change?.plan,
              assetsDir: join(runtimeDir, 'packages', 'assets'),
            });
            simCurrent = applied.package;
            packageChanged = true;
            proposal.assetId = applied.assetId;
            proposal.durationSeconds = applied.durationSeconds;
            proposal.status = 'confirmed';
            proposal.confirmedAt = now;
            continue;
          }
          if (typeof runs?.start !== 'function') throw new Error('clip regeneration is not available in chat');
          const entry = takes.read(simCurrent.id)?.clips?.[proposal.assetId];
          const built = buildCorrection(simCurrent, proposal.assetId, proposal.change, { takesCount: activeTakes(entry).length });
          proposal.diff = built.diff;
          proposal.correction = built.correction;
          const bound = production?.findBound?.(simCurrent) ?? null;
          if (bound && typeof production?.proposeCorrection === 'function') {
            proposal.status = 'plan_pending';
            boundCorrections.push({ proposal, productionId: bound.id, staged: built.package, baseline: simCurrent });
            continue;
          }
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
            recordQueued(takes, simCurrent.id, proposal.assetId, built.correction, result?.planHash, 'colab');
            publishEvent(events, {
              type: 'clip.queued', packageId: simCurrent.id, clipId: proposal.clipId,
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
            recordStarted(takes, simCurrent.id, proposal.assetId, result);
            publishEvent(events, {
              type: 'clip.job', packageId: simCurrent.id, clipId: proposal.clipId,
              assetId: proposal.assetId, runId: result?.runId,
              state: result?.status ?? 'starting', progress: 0,
            });
            proposal.status = 'confirmed';
            proposal.confirmedAt = now;
            proposal.runId = result?.runId ?? null;
          }
        } catch (error) {
          proposal.lastError = String(error?.message ?? 'the proposal could not be applied').slice(0, 300);
        }
      }
      if (boundCorrections.length) {
        const productionId = boundCorrections[0].productionId;
        try {
          const planned = await production.proposeCorrection({
            productionId,
            pkg: boundCorrections[0].staged,
            baseline: boundCorrections[0].baseline,
            sceneIds: boundCorrections.map(item => correctionSceneId(simCurrent, item.proposal)),
            corrections: boundCorrections.map(item => ({ assetId: item.proposal.assetId, correction: item.proposal.correction })),
            commandId: `cmd_chat_${input.turnId ?? randomUUID()}`,
            userEventId: `ue_${input.turnId ?? randomUUID()}`,
          });
          for (const { proposal } of boundCorrections) {
            proposal.status = 'plan_ready';
            proposal.productionId = productionId;
            proposal.planId = planned.plan?.id ?? null;
            proposal.planHash = planned.plan?.planHash ?? null;
            proposal.estimate = planned.plan ?? null;
            delete proposal.lastError;
          }
        } catch (error) {
          for (const { proposal } of boundCorrections) {
            proposal.status = 'plan_error';
            proposal.lastError = String(error?.message ?? 'the production plan could not be created').slice(0, 300);
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
      if (rejectedReferenceIds.size) {
        referenceAssignments = referenceAssignments.map(assignment => (assignment
          && assignment.status !== 'rejected' && rejectedReferenceIds.has(assignment.id))
          ? {
            ...assignment,
            status: 'rejected',
            rejectedAt: rejectionAt,
            ...(input.turnId ? { turnId: input.turnId } : {}),
          }
          : assignment);
      }
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
      const clips = await buildClipContext(simCurrent, clipProposals, simDoc);

      // Characters are opt-in: an empty library and cast keep the exact prompt/tools.
      const libraryStore = charactersFor();
      const library = libraryStore ? libraryStore.list() : [];
      const sceneIds = simCurrent?.scenes?.map(scene => scene.id)
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
      const model = typeof modelFactory === 'function'
        ? modelFactory({ id, config, input })
        : createOpenAICompatibleModel(config);
      const brand = input.brand ? prepareBrand(input.brand, { assetsDir: join(runtimeDir, 'packages', 'assets') }) : session.brand ?? null;
      if (input.action === 'build' && !session.plan && !session.packageEdit) fail(400, 'Stage package edits or write a draft before building');

      let pendingBuild = null;
      const drawingEdits = new Map();
      const drawing = simCurrent?.scenes?.some(scene => scene.drawing) ? {
        read(sceneId) {
          const scene = simCurrent.scenes.find(item => item.id === sceneId);
          if (!scene?.drawing) throw new Error(`Scene ${sceneId} has no procedural drawing`);
          return { sceneId, preferredFrames: scene.preferredFrames, drawing: clone(drawingEdits.get(sceneId) ?? scene.drawing) };
        },
        edit(sceneId, replacements) {
          const scene = simCurrent.scenes.find(item => item.id === sceneId);
          if (!scene?.drawing) throw new Error(`Scene ${sceneId} has no procedural drawing`);
          if (scene.locked) throw new Error(`Scene ${sceneId} is locked`);
          // A drawing element is not yet mapped to the viewer's spatial, time,
          // or preserve constraints. Refuse rather than broaden that scope.
          if (iterationScope) throw new Error('Drawing edits are not available with an element-scoped request; remove the scope or use an unscoped chat.');
          if (production?.findBound?.(simCurrent.id) && !productionContext) throw new Error('A production-bound drawing edit requires an available production and a turn ID');
          if (requestedTargets && !requestedTargets.shotIds.includes(sceneId)) throw new Error(`Scene ${sceneId} is outside the requested shot targets`);
          const next = clone(drawingEdits.get(sceneId) ?? scene.drawing);
          const seen = new Set();
          for (const { index, element } of replacements) {
            if (seen.has(index)) throw new Error(`Duplicate drawing element index ${index}`);
            seen.add(index);
            const old = next.elements[index];
            if (!old) throw new Error(`Drawing element ${index} does not exist`);
            if (!element || element.type !== old.type) throw new Error(`Drawing element ${index} must retain its type`);
            next.elements[index] = clone(element);
          }
          const candidate = clone(simCurrent);
          candidate.scenes.find(item => item.id === sceneId).drawing = next;
          const validation = validatePackage(candidate);
          if (!validation.valid) throw new InvalidPackageError(validation.errors);
          drawingEdits.set(sceneId, next);
          return { ok: true, staged: true, sceneId, indices: [...seen], instruction: 'Call project_build to apply these changes.' };
        },
      } : null;
      const predictedRevision = () => (simCurrent ? simCurrent.revision + 1 : ((pendingBuild?.revision ?? 1)));
      const user = {
        role: 'user',
        content: iterationUserText(input.message, iterationScope),
        ...(iterationScope ? { iterationScope } : {}),
      };
      const scopeMessage = iterationScope
        ? { role: 'user', content: iterationScopeBlock(iterationScope) }
        : null;
      const signal = AbortSignal.timeout(120000);
      let packageEdit = session.packageEdit ?? null;
      let packageEditApplied = false;
      const validatePackageEditTiming = candidate => {
        const timing = pkg => {
          const timeline = compilePackage(pkg, join(runtimeDir, 'packages'));
          return { fps: timeline.fps, frames: timeline.durationInFrames,
            scenes: timeline.scenes.map(scene => [scene.id, scene.from, scene.durationInFrames, scene.transitionInFrames, scene.transitionOutFrames]) };
        };
        if (!isDeepStrictEqual(timing(simCurrent), timing(candidate))) throw new Error('These focused package edits would change the compiled shot timing. Review timing separately before applying.');
      };
      const guardPackageEdit = async (candidate, tool) => {
        if (iterationScope) throw new Error('Saved-package edits require shot targets or an unscoped request; element-scoped playback edits are not supported.');
        if (production?.findBound?.(simCurrent.id) && !productionContext) throw new Error('A production-bound package edit requires an available production and a turn ID.');
        if (requestedTargets) {
          const changedScenes = candidate.scenes.filter(scene => !isDeepStrictEqual(scene, simCurrent.scenes.find(old => old.id === scene.id)));
          if (changedScenes.some(scene => !requestedTargets.shotIds.includes(scene.id)) || !isDeepStrictEqual(candidate.voice, simCurrent.voice)) throw new Error('The package edit is outside the requested shot targets.');
        }
        // Keep the shared production read memory on this same context, but use
        // the real package baseline for its structural/global/shot diff.
        if (productionContext) {
          const prior = productionContext.builtPlan;
          productionContext.builtPlan = simCurrent;
          try {
            const refusal = await guardOrdinaryMutation(productionContext, { tool, before: simCurrent, after: candidate, turnStart: simCurrent });
            if (refusal) throw Object.assign(new Error(refusal.message), { code: refusal.code, policyRefusal: true });
          } finally { productionContext.builtPlan = prior; }
        }
      };
      const packageEditor = simCurrent ? {
        tool: PACKAGE_EDIT_TOOL,
        pending: Boolean(packageEdit),
        build: () => build(null),
        stage: async args => {
          const edited = applyChatPackageEdit(simCurrent, args);
          await guardPackageEdit(edited.package, 'project_patch_plan');
          validatePackageEditTiming(edited.package);
          packageEdit = { request: clone(args), diff: edited.diff };
          return { ok: true, staged: true, packageId: simCurrent.id, expectedRevision: simCurrent.revision, diff: edited.diff, instruction: 'Review this exact diff. Call project_build only when the user requested applying/saving the changes; otherwise leave it staged for review.' };
        },
      } : null;
      const build = async plan => {
        if (packageEdit) {
          const edited = applyChatPackageEdit(simCurrent, packageEdit.request);
          if (input.action === 'build' && productionContext) {
            const read = await runProductionTool({ id: 'reviewed_package_read', name: 'production_read', args: { production_id: productionContext.productionId } }, productionContext);
            if (!read.ok) throw new Error(read.error);
          }
          await guardPackageEdit(edited.package, 'project_build');
          validatePackageEditTiming(edited.package);
          pendingBuild = edited.package;
          packageEditApplied = true;
          return { packageId: pendingBuild.id, revision: predictedRevision(), diff: edited.diff, preserved: ['assets', 'generation inputs', 'format', 'duration', 'source context'] };
        }
        const castBuild = cast.length ? {
          cast,
          placements: castPlacements,
          files: characterFilesForBuild(libraryStore, cast),
        } : null;
        // A drawing-only edit must not recompile the draft: doing so can
        // normalize an existing package's duration and unrelated metadata.
        const candidate = drawingEdits.size && simCurrent && isDeepStrictEqual(plan, rebased.plan) ? clone(simCurrent) : await buildChatProject({
          plan,
          previous: simCurrent,
          previousPlan: lastBuiltPlan,
          adoptPackage: Boolean(adoptionBaseline),
          brand,
          runtimeDir,
          signal,
          ...(referenceStore ? { references: referenceStore } : {}),
          ...(castBuild ? { characters: castBuild } : {}),
        });
        for (const [sceneId, editedDrawing] of drawingEdits) {
          const scene = candidate.scenes.find(item => item.id === sceneId);
          if (!scene?.drawing || scene.locked) throw new Error(`Drawing scene ${sceneId} is missing or locked`);
          scene.drawing = clone(editedDrawing);
        }
        if (simCurrent && candidate.id !== simCurrent.id) {
          fail(409, 'An edit cannot replace the bound package.', { code: 'EDIT_PACKAGE_MISMATCH' });
        }
        signal.throwIfAborted();
        // The store validates on write; validate the candidate here so an invalid
        // package fails inside the turn instead of after the model reports success.
        const validation = validatePackage(candidate);
        if (!validation.valid) throw new InvalidPackageError(validation.errors);
        pendingBuild = candidate;
        const revision = predictedRevision();
        return {
          packageId: candidate.id,
          revision,
          execution: {
            scenes: candidate.scenes.length, narration: 'script only', audioSynthesized: false, mp4Exported: false,
            visualDirections: 'notes, not executable custom animation',
            assets: Object.values(candidate.assets ?? {}).reduce((counts, asset) => { const key = `${asset.kind}:${asset.status}`; counts[key] = (counts[key] ?? 0) + 1; return counts; }, {}),
          },
        };
      };
      const productionContext = productionContextFor(simCurrent, input, {
        iterationScope,
        targets: requestedTargets,
        builtPlan: adoptionBaseline ?? lastBuiltPlan ?? undefined,
      });
      // The explicit UI action applies the reviewed draft without another creative generation.
      const result = input.action === 'build' ? await (async () => {
        await build(rebased.plan);
        return { plan: rebased.plan, built: true, reply: packageEditApplied ? 'Applied the reviewed package edits. Existing media and timing were preserved.' : `Built “${rebased.plan.title}” into the project. You can preview it or keep chatting to revise it. Narration is a script; audio, GPU generation and export are separate steps.`, trace: { promptVersion: CONVERSATION_PROMPT_VERSION, skills: [], steps: 0, repairs: 0, usage: { input: 0, output: 0 }, tools: [{ name: 'project_build', ok: true }], omittedMessages: 0, elapsedMs: 0, stop: 'explicit-build' } };
      })() : await runConversationTurn({
        systemSuffix: MODEL_CONTRIBUTION_PROMPT + (simCurrent ? ' The current saved package is authoritative, including when draft is null. For native source audio, disabling detached voiceover, removing narration, exact copy/kicker/lower-third edits or removing foreground placements use project_edit_package, then project_build when asked to save/apply. Never create a fresh draft to repair missing chat context. Preserve existing timing/fps and all generated media/conditioning. Unsupported edits must be reported rather than silently omitted. Production-bound edits still require production_read before build. Show the changed fields in your summary.' : ' In project_update_plan/project_patch_plan, use mediaType:image with a relevant visual direction for at least one visible scene/plate.') + ' A draft/build is not approved GPU generation or a final export.',
        model, sessionId: id, signal, skillsEnabled,
        mode: input.mode, messages: [...session.messages, ...(scopeMessage ? [scopeMessage] : []), user], plan: rebased.plan,
        brandContext: brand?.kit,
        palette: brandTheme(brand?.kit ?? {}).palette,
        projectPalette: simCurrent?.theme?.palette,
        references,
        clips,
        characters,
        drawing,
        packageEditor,
        ...(productionContext ? { production: productionContext } : {}),
        projectContext: simCurrent ? {
          id: simCurrent.id, revision: simCurrent.revision, title: simCurrent.title, format: simCurrent.format,
          theme: simCurrent.theme, datasets: simCurrent.datasets ?? {},
          duration: simCurrent.duration, voice: simCurrent.voice, audio: simCurrent.audio,
          assets: simCurrent.assets, proposal: simCurrent.proposal,
          pendingPackageEdit: packageEdit,
          originalSourceContext: session.sourceContext ?? null,
          manuallyEditedSinceLastBuild: simCurrent.revision !== session.projectRevision,
          scenes: simCurrent.scenes.map(scene => ({
            id: scene.id, layout: scene.layout, copy: scene.copy, narration: scene.narration,
            visual: scene.notes, locked: scene.locked, seconds: scene.preferredFrames / simCurrent.format.fps,
            data: scene.data, code: scene.code, media: scene.media, background: scene.background,
            motion: scene.motion, transitionOut: scene.transitionOut, foreground: scene.foreground, lower_third: scene.lower_third,
            ...(scene.drawing ? { drawing: { renderedInsteadOfLayoutCopy: true, labels: (scene.drawing.elements ?? []).filter(element => element.type === 'text').map(element => element.text) } } : {}),
          })),
        } : null,
        build,
        onEvent: event => turnHooks.onEvent?.(event),
      });
      const draftChanged = JSON.stringify(result.plan) !== JSON.stringify(rebased.plan);
      const finalPackage = pendingBuild ?? (packageChanged ? simCurrent : null);
      const nextSession = {
        ...session, revision: baseRevision + 1,
        messages: [...session.messages, user, { role: 'assistant', content: providerSettings.redact(result.reply) }],
        plan: result.plan, phase: result.built ? 'built' : packageEdit || (draftChanged && result.plan) ? 'draft' : session.phase,
        packageEdit: packageEditApplied ? null : packageEdit,
        ...(packageEditApplied ? { lastPackageEdit: { ...packageEdit, appliedRevision: predictedRevision() } } : {}),
        provider: input.provider, model: config.model,
        brand, trace: JSON.parse(providerSettings.redact(JSON.stringify(result.trace))),
        warning: result.warning ? providerSettings.redact(result.warning) : null,
        lastTurnId: input.turnId ?? null, lastTurnBuilt: result.built,
        ...(referenceStore || Array.isArray(session.referenceAssignments) ? { referenceAssignments } : {}),
        ...(clipProposals.length || Array.isArray(session.clipProposals) ? { clipProposals } : {}),
        ...(cast.length || Array.isArray(session.cast) ? { cast } : {}),
        ...(castPlacements.length || Array.isArray(session.castPlacements) ? { castPlacements } : {}),
        ...(castProposals.length || Array.isArray(session.castProposals) ? { castProposals } : {}),
        ...(pendingBuild ? { projectId: pendingBuild.id, projectRevision: predictedRevision(), ...(!packageEditApplied ? { previousPlan: result.plan } : {}) } : {}),
      };
      if (pendingBuild) delete nextSession.adoptionPending;

      // Phase C: a short, fully synchronous commit. Every effect after the intent
      // is recorded is either proven by the intent or rolled back on error.
      const commitFor = currentSession => {
        const currentRevision = currentSession ? currentSession.revision : 0;
        if (currentRevision === baseRevision) return { session: nextSession, baseRevision };
        const merged = mergeCastOnlyCommit(session, currentSession, nextSession);
        if (!merged) fail(409, 'Conversation changed in another tab. Reload before continuing.', { currentRevision });
        return { session: merged, baseRevision: currentRevision };
      };
      let committedSession = nextSession;
      const takesOps = [...selectOps, ...verdictOps];
      const hasPackageEffect = Boolean(finalPackage);
      if (!hasPackageEffect && !takesOps.length) {
        withLock(id, () => {
          const commit = commitFor(read(id));
          committedSession = commit.session;
          write(committedSession);
          appendJournal(id, committedSession, result.built);
        });
        return response(committedSession, result.built);
      }
      withLock(id, () => {
        const commit = commitFor(read(id));
        const commitBaseRevision = commit.baseRevision;
        const commitSession = commit.session;
        committedSession = commitSession;
        const projectId = finalPackage ? (finalPackage.id ?? pendingBuild?.id ?? null) : null;
        let intent = {
          type: 'chat.intent/v1',
          conversationId: id,
          turnId: input.turnId ?? null,
          baseRevision: commitBaseRevision,
          revision: commitSession.revision,
          createdAt: new Date().toISOString(),
          // IP40R: the user's own turn, so a retry can be re-run exactly. Confirm
          // lists and provider credentials are deliberately never recorded.
          request: {
            message: input.message.trim(),
            action: input.action ?? null,
            mode: input.mode ?? null,
            ...(iterationScope ? { iterationScope } : {}),
          },
          package: projectId ? {
            projectId,
            expectedRevision: capturedPackageRevision,
            predictedRevision: capturedPackageRevision === null ? 1 : capturedPackageRevision + 1,
            ...(isPlainObject(current) ? { before: clone(current) } : {}),
          } : null,
          takesOps,
        };
        writeIntent(intent);
        const hookContext = { store, projectId, expectedRevision: capturedPackageRevision, package: finalPackage, session: commitSession };
        // A throwing test seam models a crash: the intent must survive it.
        if (typeof hooks?.beforePackageSave === 'function') hooks.beforePackageSave(hookContext);
        let packageWritten = false;
        let writtenPackage = null;
        try {
          if (hasPackageEffect) {
            if (projectId && capturedPackageRevision !== null) {
              try {
                writtenPackage = store.save(projectId, finalPackage, capturedPackageRevision);
              } catch (error) {
                if (error.currentRevision !== undefined) {
                  fail(409, 'The project was edited while the agent was working. Reload before retrying.', { currentRevision: error.currentRevision });
                }
                throw error;
              }
            } else {
              writtenPackage = store.write(finalPackage);
            }
            packageWritten = true;
            preserveSourceContext(commitSession, writtenPackage);
          }
          // The intent becomes complete as soon as the package effect is proven,
          // before any secondary side effect. Recovery can then roll it forward.
          intent = {
            ...intent,
            ...(hasPackageEffect ? {
              package: {
                ...intent.package,
                afterRevision: writtenPackage.revision,
                hash: packageHash(writtenPackage),
              },
            } : {}),
            session: commitSession,
          };
          writeIntent(intent);
          // Takes are side effects of the package commit: apply them after the
          // single package write and record them for idempotent recovery.
          for (const op of takesOps) {
            if (op.op === 'select') {
              takes.setSelected(op.packageId, op.assetId, op.takeId);
              publishEvent(events, {
                type: 'clip.take.selected', packageId: op.packageId, clipId: op.clipId,
                assetId: op.assetId, takeId: op.takeId,
              });
            } else if (op.op === 'verdict') {
              takes.setVerdict(op.packageId, op.assetId, op.takeId, op.verdict, op.reason);
              publishEvent(events, {
                type: 'clip.verdict', packageId: op.packageId, clipId: op.clipId,
                assetId: op.assetId, takeId: op.takeId, verdict: op.verdict,
                ...(typeof op.reason === 'string' ? { note: op.reason } : {}),
              });
            }
            const proposal = clipProposals.find(item => item?.id === op.proposalId);
            if (proposal && writtenPackage) proposal.revision = writtenPackage.revision;
          }
          if (typeof hooks?.beforeSnapshotWrite === 'function') hooks.beforeSnapshotWrite({ id, store, projectId, package: writtenPackage, session: commitSession });
          writeCas(commitSession, commitBaseRevision);
          appendJournal(id, commitSession, result.built);
          deleteIntent(id);
        } catch (error) {
          // Before the package write there is no effect to preserve: dropping the
          // intent keeps a handled 409/400 from becoming a permanent recovery
          // conflict. After it, the intent is complete and recovery rolls forward.
          if (!packageWritten) deleteIntent(id);
          throw error;
        }
      });
      return response(committedSession, result.built);
    } finally { active.delete(id); }
  }

  return { get, send, resolveRecovery };
}
