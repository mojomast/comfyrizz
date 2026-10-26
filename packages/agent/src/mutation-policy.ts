// UX09: the one mutation policy for every tool that can change a bound
// production's work: ordinary project tools and production tools alike.
//
// This is the agent-side mirror of the UX00 contract in
// apps/server/src/productions/iteration-scope.mjs. The agent package cannot
// import outside its rootDir, so the rules are copied here and pinned to the
// shared fixture apps/server/test/fixtures/ux00/scope.json and to the server
// module's exports by packages/agent/test/ux09-mutation-policy.test.ts.
// A packet that needs a different rule files an amendment with UX00 and changes
// both sides together.

export const SCOPE_ID_PATTERNS = Object.freeze({
  package: /^pkg_[A-Za-z0-9_-]{4,64}$/,
  take: /^tk_[0-9a-f]{12}$/,
  character: /^chr_[0-9a-f]{16}$/,
  line: /^s[A-Za-z0-9_-]{0,63}:l[1-9][0-9]{0,3}$/,
  clip: /^s[A-Za-z0-9_-]{0,63}:a[A-Za-z0-9_-]{0,63}$/,
  shot: /^s[A-Za-z0-9_-]{0,63}$/,
  asset: /^a[A-Za-z0-9_-]{0,63}$/,
  cast: /^c[A-Za-z0-9_-]{0,63}$/,
});

export type ScopeIdKind = keyof typeof SCOPE_ID_PATTERNS;

export const SCOPE_ID_KINDS = Object.freeze(Object.keys(SCOPE_ID_PATTERNS)) as readonly ScopeIdKind[];

export const MUTATION_REFUSAL_CODES = Object.freeze([
  'READ_REQUIRED',
  'REVISION_CONFLICT',
  'PRODUCTION_NOT_ACTIVE',
  'SCOPE_EMPTY',
  'SCOPE_EXPANSION',
  'SCOPE_UNRESOLVED',
  'SCOPE_STALE',
  'PRESERVE_VIOLATION',
  'ITERATION_SHOT_LOCKED',
] as const);

export type MutationRefusalCode = (typeof MUTATION_REFUSAL_CODES)[number];

/**
 * A take or render beyond the iteration level's takes x rounds is an existing
 * server code (productions/contract.mjs `ITERATION_EXCEEDED`), not a scope
 * refusal. It is not in the UX00 mutation vocabulary yet; UX00 is asked to
 * adopt it. Until then it is the only code outside MUTATION_REFUSAL_CODES.
 */
export const ITERATION_EXCEEDED = 'ITERATION_EXCEEDED' as const;

export type RefusalCode = MutationRefusalCode | typeof ITERATION_EXCEEDED;

export const TARGET_SET_MODES = Object.freeze(['unscoped', 'empty', 'scoped'] as const);

export interface MutationRefusal {
  /** Absent for a malformed-argument refusal that is not a policy decision. */
  code?: RefusalCode;
  message: string;
}

export function refusal(code: RefusalCode, message: string): MutationRefusal {
  return { code, message };
}

const MAX_ID_CHARS = 256;

export function scopeIdKind(id: unknown): ScopeIdKind | null {
  if (typeof id !== 'string' || id === '' || id.length > MAX_ID_CHARS) return null;
  for (const kind of SCOPE_ID_KINDS) {
    if (SCOPE_ID_PATTERNS[kind].test(id)) return kind;
  }
  return null;
}

export interface TargetSet {
  mode: 'unscoped' | 'empty' | 'scoped';
  shotIds: readonly string[];
  lineIds: readonly string[];
}

export class TargetSetError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.name = 'TargetSetError';
    this.field = field;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function targetIds(raw: unknown, field: string, kind: ScopeIdKind): string[] {
  if (!Array.isArray(raw)) throw new TargetSetError(field, `${field} must be an array`);
  const seen = new Set<string>();
  raw.forEach((entry, index) => {
    const at = `${field}[${index}]`;
    if (scopeIdKind(entry) !== kind) throw new TargetSetError(at, `${at} must be a ${kind} id`);
    if (seen.has(entry as string)) throw new TargetSetError(at, `${at} is duplicated`);
    seen.add(entry as string);
  });
  return [...(raw as string[])];
}

/**
 * Requested target set for one turn. Absent (undefined or null) is `unscoped`.
 * `{ shotIds: [], lineIds: [] }` is `empty`: nothing may be mutated. Anything
 * else is `scoped`: a shot id permits the whole shot, a line id only that line.
 */
export function normalizeTargetSet(raw: unknown): TargetSet {
  if (raw === undefined || raw === null) return { mode: 'unscoped', shotIds: [], lineIds: [] };
  if (!isPlainObject(raw)) throw new TargetSetError('targets', 'targets must be an object');
  for (const key of Object.keys(raw)) {
    if (key !== 'shotIds' && key !== 'lineIds') throw new TargetSetError(`targets.${key}`, `targets.${key} is not allowed`);
  }
  if (!Object.hasOwn(raw, 'shotIds') && !Object.hasOwn(raw, 'lineIds')) {
    throw new TargetSetError('targets', 'targets must name shotIds or lineIds; omit targets for an unscoped turn');
  }
  const shotIds = Object.hasOwn(raw, 'shotIds') ? targetIds(raw.shotIds, 'targets.shotIds', 'shot') : [];
  const lineIds = Object.hasOwn(raw, 'lineIds') ? targetIds(raw.lineIds, 'targets.lineIds', 'line') : [];
  return { mode: shotIds.length === 0 && lineIds.length === 0 ? 'empty' : 'scoped', shotIds, lineIds };
}

export function targetSetAllows(set: TargetSet, target: { shotId: string; lineId?: string | null }): boolean {
  if (!isPlainObject(set) || !isPlainObject(target) || typeof target.shotId !== 'string') return false;
  if (set.mode === 'unscoped') return true;
  if (set.mode !== 'scoped') return false;
  if (set.shotIds.includes(target.shotId)) return true;
  return typeof target.lineId === 'string' && set.lineIds.includes(target.lineId);
}

export function shotOfId(id: string): string {
  return id.split(':')[0] ?? id;
}

const EMPTY_SET: TargetSet = Object.freeze({ mode: 'empty', shotIds: Object.freeze([]), lineIds: Object.freeze([]) }) as TargetSet;
const UNSCOPED_SET: TargetSet = Object.freeze({ mode: 'unscoped', shotIds: Object.freeze([]), lineIds: Object.freeze([]) }) as TargetSet;

export { EMPTY_SET, UNSCOPED_SET };

/** The comfyrizz.iteration-scope/v1 fields the policy reads. */
export interface IterationScopeLike {
  target?: { packageId?: string; clipId?: string; takeId?: string; assetId?: string; shotId?: string };
  element?: string;
  elementRef?: { lineId?: string; characterId?: string };
  note?: string;
  preserve?: readonly string[];
}

/**
 * The target set a viewer iteration scope authorizes. A line reference permits
 * only that line, a shot permits the whole shot and a clip resolves to its
 * shot. A scope that names no resolvable shot, or whose line belongs to another
 * shot than its target, authorizes nothing and says which field failed.
 */
export function targetSetFromIterationScope(scope: IterationScopeLike): { set: TargetSet; unresolved?: string } {
  const unresolved = (field: string) => ({ set: EMPTY_SET, unresolved: field });
  const target = scope.target ?? {};
  const shotId = typeof target.shotId === 'string' ? target.shotId : undefined;
  const lineId = scope.element === 'voice_line' && typeof scope.elementRef?.lineId === 'string' ? scope.elementRef.lineId : undefined;

  if (lineId !== undefined) {
    if (scopeIdKind(lineId) !== 'line') return unresolved('elementRef.lineId');
    if (shotId !== undefined && shotOfId(lineId) !== shotId) return unresolved('elementRef.lineId');
    return { set: { mode: 'scoped', shotIds: [], lineIds: [lineId] } };
  }
  if (shotId !== undefined) {
    return scopeIdKind(shotId) === 'shot' ? { set: { mode: 'scoped', shotIds: [shotId], lineIds: [] } } : unresolved('target.shotId');
  }
  if (typeof target.clipId === 'string') {
    return scopeIdKind(target.clipId) === 'clip'
      ? { set: { mode: 'scoped', shotIds: [shotOfId(target.clipId)], lineIds: [] } }
      : unresolved('target.clipId');
  }
  return unresolved('target');
}

/**
 * What two target sets both permit. Unscoped permits everything, so it is the
 * identity. The result is `empty` when they share nothing.
 */
export function intersectTargetSets(a: TargetSet, b: TargetSet): TargetSet {
  if (a.mode === 'unscoped') return b;
  if (b.mode === 'unscoped') return a;
  if (a.mode === 'empty' || b.mode === 'empty') return EMPTY_SET;
  const shotIds = a.shotIds.filter(shotId => b.shotIds.includes(shotId));
  const lineIds: string[] = [];
  const keep = (lineId: string, other: TargetSet) => {
    if (shotIds.includes(shotOfId(lineId)) || lineIds.includes(lineId)) return;
    if (targetSetAllows(other, { shotId: shotOfId(lineId), lineId })) lineIds.push(lineId);
  };
  for (const lineId of a.lineIds) keep(lineId, b);
  for (const lineId of b.lineIds) keep(lineId, a);
  return shotIds.length === 0 && lineIds.length === 0 ? EMPTY_SET : { mode: 'scoped', shotIds, lineIds };
}

export interface PolicyShot {
  id: string;
  lines?: string[];
}

export interface PolicyState {
  intent?: string;
  shots: PolicyShot[];
  targets: TargetSet;
  lockedShotIds?: readonly string[];
}

/** Scoped ids that are not a shot or line of the production. */
export function unresolvedTargets(set: TargetSet, shots: readonly PolicyShot[]): string[] {
  if (set.mode !== 'scoped') return [];
  const known = new Map(shots.map(shot => [shot.id, new Set(shot.lines ?? [])]));
  const missing: string[] = [];
  for (const shotId of set.shotIds) if (!known.has(shotId)) missing.push(shotId);
  for (const lineId of set.lineIds) {
    if (!known.get(shotOfId(lineId))?.has(lineId)) missing.push(lineId);
  }
  return missing;
}

export function intentRefusal(intent: string | undefined): MutationRefusal | undefined {
  if (intent !== undefined && intent !== 'active') {
    return refusal('PRODUCTION_NOT_ACTIVE', `the production is ${intent}; do not propose, edit or build until the user changes that intent`);
  }
  return undefined;
}

export function targetSetRefusal(state: Pick<PolicyState, 'shots' | 'targets'>): MutationRefusal | undefined {
  if (state.targets.mode === 'empty') {
    return refusal('SCOPE_EMPTY', 'the requested target list is empty, so nothing may change this turn; ask which shot or line to change');
  }
  const missing = unresolvedTargets(state.targets, state.shots);
  if (missing.length) {
    return refusal('SCOPE_UNRESOLVED', `the requested target ${missing[0]} is not a shot or line of this production; it is outside the production state or the requested scope`);
  }
  return undefined;
}

export interface DraftChange {
  shotIds: string[];
  /** A scene was added, removed or reordered. */
  structural: boolean;
  /** A project-wide field (title, brief, theme, datasets, ...) changed. */
  global: boolean;
}

/**
 * Check a change to the draft or the built package against the one policy:
 * intent, then the requested target set, then locks. Draft edits and builds
 * are whole-shot changes, so a line-only scope cannot authorize them.
 */
export function checkDraftChange(
  state: PolicyState,
  change: DraftChange,
  options: { build?: boolean } = {},
): MutationRefusal | undefined {
  const noop = !options.build && change.shotIds.length === 0 && !change.structural && !change.global;
  if (noop) return undefined;
  const intent = intentRefusal(state.intent);
  if (intent) return intent;
  const targets = targetSetRefusal(state);
  if (targets) return targets;

  if (state.targets.mode === 'scoped') {
    if (change.global) {
      return refusal('SCOPE_EXPANSION', 'this change touches project-wide fields, which are outside the requested shots; change only the requested shots');
    }
    if (change.structural) {
      return refusal('SCOPE_EXPANSION', 'adding, removing or reordering shots is outside the requested scope');
    }
    for (const shotId of change.shotIds) {
      if (!targetSetAllows(state.targets, { shotId })) {
        const lineOnly = state.targets.shotIds.length === 0;
        return refusal('SCOPE_EXPANSION', lineOnly
          ? `shot ${shotId} is outside the requested scope; a draft edit changes a whole shot, so a single requested line goes through production_propose_plan`
          : `shot ${shotId} is outside the requested scope; name only the requested shots`);
      }
    }
  }
  const locked = new Set(state.lockedShotIds ?? []);
  for (const shotId of change.shotIds) {
    if (locked.has(shotId)) return refusal('ITERATION_SHOT_LOCKED', `shot ${shotId} is locked and cannot be changed`);
  }
  return undefined;
}

interface DraftLike {
  scenes?: Array<Record<string, unknown> & { id?: unknown }>;
  [key: string]: unknown;
}

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(entry => (entry === undefined ? 'null' : stable(entry))).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).filter(key => record[key] !== undefined).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`;
}

/** Which shots a draft or build would change relative to a baseline draft. */
export function diffDraft(before: DraftLike | null | undefined, after: DraftLike | null | undefined): DraftChange {
  const afterScenes = Array.isArray(after?.scenes) ? after!.scenes! : [];
  if (!before) return { shotIds: afterScenes.map(scene => String(scene.id)), structural: true, global: true };
  const beforeScenes = Array.isArray(before.scenes) ? before.scenes : [];
  const beforeById = new Map(beforeScenes.map(scene => [String(scene.id), scene]));
  const afterById = new Map(afterScenes.map(scene => [String(scene.id), scene]));
  const shotIds: string[] = [];
  for (const [id, scene] of afterById) {
    const prior = beforeById.get(id);
    if (!prior || stable(prior) !== stable(scene)) shotIds.push(id);
  }
  for (const id of beforeById.keys()) if (!afterById.has(id)) shotIds.push(id);
  const common = (list: Map<string, unknown>, other: Map<string, unknown>) => [...list.keys()].filter(id => other.has(id));
  const added = [...afterById.keys()].some(id => !beforeById.has(id)) || [...beforeById.keys()].some(id => !afterById.has(id));
  const reordered = stable(common(beforeById, afterById)) !== stable(common(afterById, beforeById));
  const { scenes: _b, ...beforeRest } = before;
  const { scenes: _a, ...afterRest } = after ?? {};
  return { shotIds, structural: added || reordered, global: stable(beforeRest) !== stable(afterRest) };
}

interface StagePolicyLike {
  stages?: Record<string, { takes?: number; rounds?: number } | undefined>;
  shotOverrides?: Record<string, { stages?: Record<string, { takes?: number; rounds?: number } | undefined> } | undefined>;
}

/** takes x rounds for one stage of one shot, honouring that shot's override. */
export function effectiveStageLimit(policy: StagePolicyLike | null | undefined, shotId: string, stage: string): number {
  const override = policy?.shotOverrides?.[shotId];
  const stagePolicy = override?.stages?.[stage] ?? policy?.stages?.[stage];
  const takes = typeof stagePolicy?.takes === 'number' ? stagePolicy.takes : 1;
  const rounds = typeof stagePolicy?.rounds === 'number' ? stagePolicy.rounds : 1;
  return takes * rounds;
}

/**
 * Slots still available for a stage: the limit minus slots already used. The
 * planner and the tool guard both read this, so a proposal the planner builds
 * is never one the guard then refuses.
 */
export function remainingStageCapacity(
  policy: StagePolicyLike | null | undefined,
  used: Record<string, Record<string, number>> | undefined,
  shotId: string,
  stage: string,
): number {
  const count = used?.[shotId]?.[stage];
  const spent = typeof count === 'number' && Number.isFinite(count) ? count : 0;
  return Math.max(0, effectiveStageLimit(policy, shotId, stage) - spent);
}
