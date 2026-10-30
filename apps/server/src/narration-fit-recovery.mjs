import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertContained, productionPaths } from './productions/store.mjs';

// Only measured numeric fields are retained. In particular, neither subprocess
// output nor a provider message belongs in this durable record.
const sceneFields = ['fromFrame', 'sceneFrames', 'transitionOutFrames', 'measuredFrames', 'availableFrames', 'excessFrames', 'measuredSeconds', 'availableSeconds', 'words', 'targetWords'];
const detailFields = ['fps', 'minimumFrames', 'targetFrames', 'excessFrames', 'measuredSeconds', 'authoredSeconds'];
const digest = pkg => createHash('sha256').update(JSON.stringify(pkg)).digest('hex');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function sourcePath(runtimeDir, pkg) {
  return join(runtimeDir, 'narration-revision-context', `${pkg.id}.${pkg.revision}.json`);
}

function sourceSnapshot(runtimeDir, pkg, conversationId) {
  try {
    const bytes = readFileSync(sourcePath(runtimeDir, pkg));
    const source = JSON.parse(bytes);
    if (source.conversationId !== conversationId || typeof source.brief !== 'string' || !source.brief.trim()
      || typeof source.source !== 'string' || !source.source.trim() || !source.context || typeof source.context !== 'object') return null;
    return { digest: hash(bytes), brief: source.brief };
  } catch { return null; }
}

export function narrationApproval(store, productionId, packageId) {
  const production = store.read(productionId);
  if (!production || production.packageId !== packageId || production.intent !== 'active') return null;
  const events = store.readEvents(productionId);
  const proposed = events.filter(event => event.type === 'plan.proposed').at(-1);
  const accepted = events.findLast(event => (event.type === 'plan.approved' || event.type === 'plan.rejected')
    && event.sequence > proposed?.sequence && event.data?.planId === proposed?.data?.id
    && event.data?.planHash === proposed?.data?.planHash
    && event.data?.proposalRevision === proposed?.data?.revision);
  if (!proposed || accepted?.type !== 'plan.approved'
    || events.some(event => event.type === 'iteration.set' && event.sequence > proposed.sequence)) return null;
  return { planId: proposed.data.id, planHash: proposed.data.planHash, proposalSequence: proposed.sequence, approvalSequence: accepted.sequence,
    ...(Number.isSafeInteger(accepted.data.packageRevision) ? { packageRevision: accepted.data.packageRevision } : {}) };
}

function renderAdmitted(store, productionId, packageId, pin) {
  return store.readEvents(productionId).some(event => event.type === 'action.planned' && event.sequence > pin.approvalSequence
    && event.data?.path === '/api/render' && event.data?.packageId === packageId
    && event.data?.packageRevision === pin.packageRevision);
}

function recordPath(runtimeDir, productionId) {
  const paths = productionPaths(runtimeDir, productionId);
  return assertContained(paths.productionsRoot, join(paths.dir, 'narration-fit.json'));
}

function numericFields(value, fields) {
  const result = {};
  for (const field of fields) {
    if (Number.isFinite(value?.[field]) && value[field] >= 0) result[field] = value[field];
  }
  return result;
}

function pick(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
}

/** Persist only a measured fit failure for the still-current approved package. */
export function saveNarrationFit({ runtimeDir, store, productionStore, productionId, pkg, error, expectedApproval, recoveryInputs }) {
  if (error?.code !== 'NARRATION_TOO_LONG' || !error.details || !Array.isArray(error.details.scenes)) return false;
  const current = store.read(pkg.id);
  const pin = narrationApproval(productionStore, productionId, pkg.id);
  if (!current || current.revision !== pkg.revision || digest(current) !== digest(pkg) || !pin
    || pin.packageRevision !== pkg.revision || renderAdmitted(productionStore, productionId, pkg.id, pin)
    || !expectedApproval || JSON.stringify(pin) !== JSON.stringify(expectedApproval)) return false;
  const sceneIds = new Set((pkg.scenes ?? []).map(scene => scene.id));
  const scenes = error.details.scenes.filter(scene => scene && sceneIds.has(scene.sceneId)).map(scene => ({
    sceneId: scene.sceneId, ...numericFields(scene, sceneFields),
  }));
  const details = { ...numericFields(error.details, detailFields), scenes };
  if (!Number.isFinite(details.measuredSeconds) || !Number.isFinite(details.authoredSeconds) || !scenes.length
    || scenes.some(scene => !Number.isFinite(scene.measuredSeconds) || !Number.isFinite(scene.availableSeconds) || !Number.isSafeInteger(scene.targetWords))) return false;
  const target = recordPath(runtimeDir, productionId);
  const temp = `${target}.${randomUUID()}.tmp`;
  const conversationId = productionStore.read(productionId)?.conversationId ?? null;
  const source = sourceSnapshot(runtimeDir, pkg, conversationId);
  const sourceDigest = source?.digest ?? null;
  // Recovery inputs are a bounded snapshot of the already-reviewed UI inputs,
  // never credentials or arbitrary request properties.
  let inputs = null;
  if (recoveryInputs && typeof recoveryInputs === 'object' && !Array.isArray(recoveryInputs)) {
    const state = recoveryInputs.state;
    const input = recoveryInputs.input;
    const expectedPrompt = typeof input?.basePrompt === 'string' && Array.isArray(input?.revisionNotes)
      ? (input.revisionNotes.length ? `${input.basePrompt}\n\nCreative revision requests (keep unrelated creative choices): ${input.revisionNotes.join(' | ')}` : input.basePrompt) : null;
    const briefMatches = typeof input?.basePrompt === 'string' && input.basePrompt.trim() !== ''
      && (source?.brief === input.basePrompt || source?.brief.startsWith(`${input.basePrompt} `));
    if (state && input && state.packageId === pkg.id && state.productionId === productionId
      && state.chatId === conversationId && state.compute === 'cpu'
      && typeof input.prompt === 'string' && typeof input.basePrompt === 'string'
      && Array.isArray(input.revisionNotes) && input.revisionNotes.every(note => typeof note === 'string')
      && state.idea?.text === expectedPrompt && briefMatches
      && JSON.stringify(recoveryInputs).length <= 100000) {
      const stateKeys = ['version', 'packageId', 'productionId', 'chatId', 'answers', 'questionsAsked', 'level', 'levelTouched', 'compute', 'motionModel', 'videoType', 'lyricsStyle', 'lyricsLrc', 'attachmentSignature', 'attachmentRevision', 'planHash', 'builtPackageInputsHash'];
      const inputKeys = ['prompt', 'basePrompt', 'revisionNotes', 'lengthS', 'compute', 'motionModel', 'videoType', 'conversationId', 'attachmentSignature', 'attachmentRevision', 'deepSeekNoThinking'];
      inputs = { state: { ...pick(state, stateKeys),
        idea: pick(state.idea, ['text', 'lengthS', 'aspect', 'look', 'sound']),
        narration: pick(state.narration, ['on', 'voiceId']),
        songTrim: state.songTrim === null ? null : pick(state.songTrim, ['startSeconds', 'endSeconds']),
        questions: Array.isArray(state.questions) ? state.questions.map(q => pick(q, ['id', 'field', 'prompt', 'options', 'decide'])) : [],
        cast: Array.isArray(state.cast) ? state.cast.map(c => pick(c, ['castId', 'characterId', 'name', 'role', 'voiceId', 'voiceLabel', 'imageUrl'])) : [],
        plan: pick(state.plan, ['status', 'wordsChanged']),
      }, input: pick(input, inputKeys) };
    }
  }
  try {
    writeFileSync(temp, JSON.stringify({ version: 1, packageId: pkg.id, packageRevision: pkg.revision, packageDigest: digest(pkg), approval: pin, details, conversationId, sourceDigest, inputs }), { mode: 0o600, flag: 'wx' });
    renameSync(temp, target);
  } finally {
    rmSync(temp, { force: true });
  }
  return true;
}

/** A stale package, new proposal, revoked approval or inactive production invalidates recovery. */
export function readNarrationFit({ runtimeDir, store, productionStore, productionId }) {
  let record;
  try { record = JSON.parse(readFileSync(recordPath(runtimeDir, productionId), 'utf8')); } catch { return null; }
  if (record?.version !== 1 || typeof record.packageId !== 'string') return null;
  const pkg = store.read(record.packageId);
  const pin = narrationApproval(productionStore, productionId, record.packageId);
  if (!pkg || pkg.revision !== record.packageRevision || digest(pkg) !== record.packageDigest
    || !pin || pin.packageRevision !== pkg.revision || renderAdmitted(productionStore, productionId, record.packageId, pin)
    || JSON.stringify(pin) !== JSON.stringify(record.approval)) return null;
  const conversationId = productionStore.read(productionId)?.conversationId ?? null;
  const source = conversationId === record.conversationId ? sourceSnapshot(runtimeDir, pkg, conversationId) : null;
  const sourceAvailable = Boolean(record.sourceDigest && source?.digest === record.sourceDigest);
  return { code: 'NARRATION_TOO_LONG', details: record.details, packageId: record.packageId, packageRevision: record.packageRevision,
    ...(sourceAvailable && record.inputs ? { inputs: record.inputs } : {}),
    ...(!sourceAvailable ? { blocked: 'The original source snapshot is missing or changed. Create a fresh proposal with the source before revising narration.' }
      : !record.inputs ? { blocked: 'The reviewed prompt inputs were not saved. Create a fresh proposal before revising narration.' } : {}) };
}
