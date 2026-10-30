import { randomUUID } from '../../uuid.ts';

export type FilmTarget = { packageId: string; expectedRevision: number; renderId: string };
export type Finding = { check: string; status: string; sceneId?: string; limitation?: string; [key: string]: unknown };
export type FilmReport = {
  reviewId: string; packageId?: string; packageRevision: number; renderId?: string; videoSha256?: string;
  artifact?: { renderId: string; videoSha256: string }; findings: Finding[];
  capabilities?: Record<string, string>; speech?: { status: string; reason?: string }; acceptance?: string;
};
export type RepairRecord = {
  repairId: string; input: FilmTarget & { conversationId: string; maxRepairs: 1 | 2 };
  status: string; stage: string; reason?: string; currentRevision: number; observedRevision?: number;
  attempts: number; renders: number; reports: FilmReport[]; packageRoundsReserved?: number;
  checksSatisfied?: boolean; effectUncertain?: boolean; lastRenderId?: string;
  error?: { code?: string; message?: string };
};
type SavedRepair = { repairId: string; target: FilmTarget; maxRepairs: 1 | 2 };
type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>;
export type FilmReviewState = {
  target: FilmTarget | null; report: FilmReport | null; record: RepairRecord | null;
  saved: SavedRepair | null; busy: boolean; error: string | null;
};
const key = (id: string) => `comfyrizz.film-repair.v1:${id}`;
export function validFilmTarget(value: any): value is FilmTarget {
  return typeof value?.packageId === 'string' && value.packageId.length > 0
    && Number.isSafeInteger(value.expectedRevision) && value.expectedRevision >= 0
    && /^(?:r|run)_[a-f0-9]{12}$/.test(value.renderId);
}
export function readFilmRepair(storage: Storage | undefined, packageId: string): SavedRepair | null {
  try {
    const saved = JSON.parse(storage?.getItem(key(packageId)) ?? 'null');
    return validFilmTarget(saved?.target) && saved.target.packageId === packageId
      && /^repair_[A-Za-z0-9_-]{1,96}$/.test(saved.repairId) && [1, 2].includes(saved.maxRepairs) ? saved : null;
  } catch { return null; }
}
const same = (a: FilmTarget | null, b: FilmTarget | null) => a !== null && b !== null
  && a.packageId === b.packageId && a.expectedRevision === b.expectedRevision && a.renderId === b.renderId;
const message = (error: unknown) => error instanceof Error ? error.message : 'The request could not be completed.';

/** A POST is issued only by the explicit start gesture. Recovery is GET-only,
 * including after an ambiguous POST failure or an abandoned server operation. */
export function createFilmReview(options: {
  packageId: string; fetch(path: string, init?: RequestInit): Promise<Response>; storage?: Storage;
  target(): FilmTarget | null; current(): boolean; chatId(): string | null;
  sync(record?: RepairRecord): Promise<void>; changed(state: FilmReviewState): void;
  owner: boolean; pollMs?: number;
}) {
  let state: FilmReviewState = { target: options.target(), report: null, record: null,
    saved: readFilmRepair(options.storage, options.packageId), busy: false, error: null };
  let closed = false, timer: ReturnType<typeof setTimeout> | undefined;
  const abort = new AbortController();
  const active = () => !closed && options.current();
  const publish = () => { if (active()) options.changed(state); };
  async function request(path: string, body?: unknown) {
    const response = await options.fetch(path, { signal: abort.signal,
      ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(value.message ?? value.error ?? `Request failed (${response.status}).`), { status: response.status });
    return value;
  }
  function guard() {
    if (!active()) throw new Error('This review belongs to an earlier project.');
    if (!options.owner) throw new Error('Review and repair is available to the project owner, not hosted invite guests.');
  }
  async function apply(record: RepairRecord) {
    guard();
    const saved = state.saved!;
    if (record.repairId !== saved.repairId || !same(record.input, saved.target)
      || record.input.maxRepairs !== saved.maxRepairs || !Array.isArray(record.reports)
      || !['running', 'completed', 'stopped', 'cancelled', 'interrupted', 'abandoned', 'failed'].includes(record.status)
      || !Number.isSafeInteger(record.currentRevision) || record.currentRevision < 0
      || ![record.attempts, record.renders].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 2)) throw new Error('Repair status does not match this project and authorization.');
    state = { ...state, record };
    publish();
    // Re-read the saved project even on failure: a tool can commit before failing.
    await options.sync(record);
  }
  function schedule() {
    if (active() && state.record?.status === 'running' && !state.error) timer = setTimeout(() => { void refresh(); }, options.pollMs ?? 1500);
  }
  async function refresh() {
    if (state.busy || !active() || !state.saved) return;
    clearTimeout(timer);
    state = { ...state, busy: true, error: null }; publish();
    try { guard(); await apply(await request(`/api/self-repairs/${encodeURIComponent(state.saved!.repairId)}`)); }
    catch (error) {
      if (!state.record && active() && options.owner) await options.sync().catch(() => {});
      state = { ...state, error: `${message(error)} Status can be checked again; no repair has been restarted.` };
    }
    finally { state = { ...state, busy: false }; publish(); schedule(); }
  }
  async function review() {
    if (state.busy || state.saved || !active()) return;
    state = { ...state, busy: true, error: null, report: null }; publish();
    try {
      guard();
      const target = options.target();
      if (!validFilmTarget(target)) throw new Error('A current, receipt-bound final video is required.');
      const report: FilmReport = await request('/api/render-reviews', target);
      guard();
      if (!same(target, options.target()) || report.packageId !== target.packageId
        || report.packageRevision !== target.expectedRevision || report.artifact?.renderId !== target.renderId
        || !/^rr_[a-f0-9]{64}$/.test(report.reviewId) || !/^[a-f0-9]{64}$/.test(report.artifact.videoSha256)
        || !Array.isArray(report.findings)) throw new Error('The review no longer matches the current finished film.');
      state = { ...state, target: { ...target }, report };
    } catch (error) { state = { ...state, error: message(error) }; }
    finally { state = { ...state, busy: false }; publish(); }
  }
  async function conversation(target: FilmTarget) {
    const id = options.chatId();
    if (id) {
      const view = await request(`/api/agent/chat/${encodeURIComponent(id)}`).catch(error => {
        if (error.status === 404) return null;
        throw error;
      });
      const chat = view?.conversation;
      if (!view?.recoveryConflict && (chat?.packageId === target.packageId || chat?.projectId === target.packageId)
        && [chat.packageId, chat.projectId].every(value => !value || value === target.packageId)) return id;
    }
    const created = await request('/api/conversations', { packageId: target.packageId });
    const next = created.chatId ?? created.id ?? created.conversation?.id;
    if (typeof next !== 'string' || !next) throw new Error('The project conversation could not be created.');
    return next;
  }
  async function start(maxRepairs: 1 | 2, authorized: boolean) {
    if (state.busy || state.saved || !active()) return;
    state = { ...state, busy: true, error: null }; publish();
    try {
      guard();
      if (!authorized || ![1, 2].includes(maxRepairs) || !state.report || !same(state.target, options.target())) {
        throw new Error('Review the current film and explicitly authorize existing-media repair first.');
      }
      const target = state.target!;
      const conversationId = await conversation(target);
      guard();
      if (!same(target, options.target())) throw new Error('The finished film changed. Review it again before authorizing repair.');
      // Store before POST. A lost response must never mint a second repair ID.
      const reserve = () => {
        guard();
        if (!same(target, options.target())) throw new Error('The finished film changed. Review it again before authorizing repair.');
        const existing = readFilmRepair(options.storage, options.packageId);
        if (existing) { state = { ...state, saved: existing }; throw new Error('An existing repair must be checked before any further work.'); }
        const saved = { repairId: `repair_${randomUUID().replaceAll('-', '')}`, target: { ...target }, maxRepairs };
        if (!options.storage) throw new Error('Browser storage is required to safely resume repair status.');
        options.storage.setItem(key(options.packageId), JSON.stringify(saved));
        return saved;
      };
      // Serialize the durable-ID reservation across tabs where Web Locks exist.
      const saved = globalThis.navigator?.locks
        ? await navigator.locks.request(key(options.packageId), reserve) : reserve();
      state = { ...state, saved }; publish();
      guard();
      await apply(await request('/api/self-repairs', { ...target, repairId: saved.repairId,
        conversationId, maxRepairs, authorizeExistingMediaRepair: true }));
    } catch (error) {
      if (state.saved && !state.record && active() && options.owner) await options.sync().catch(() => {});
      state = { ...state, error: `${message(error)}${state.saved ? ' Check this repair ID; do not start another repair.' : ''}` };
    }
    finally { state = { ...state, busy: false }; publish(); schedule(); }
  }
  return { review, start, refresh, state: () => state,
    close() { closed = true; clearTimeout(timer); abort.abort(); } };
}
