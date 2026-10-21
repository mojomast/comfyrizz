import type { CastEntry, Character, CharacterRole } from './api.ts';

export const MENTION_HANDLE_RE = /^[a-z0-9_-]{1,32}$/;
export const MENTION_TOKEN_RE = /(^|[^A-Za-z0-9_-])@([A-Za-z0-9_-]{1,32})(?![A-Za-z0-9_-])/g;
export const ACTIVE_MENTION_RE = /(^|[^A-Za-z0-9_-])@([A-Za-z0-9_-]{0,32})$/;

export type MentionSource = {
  castId?: string;
  characterId?: string;
  id?: string;
  handle?: string;
  name?: string;
  role?: CharacterRole | string;
  detached?: boolean;
  orphaned?: boolean;
  snapshot?: {
    id?: string;
    handle?: string;
    name?: string;
    role?: CharacterRole | string;
  };
};

export type MentionCandidate = {
  castId: string;
  characterId: string;
  handle: string;
  name: string;
  role: string;
  detached: boolean;
  orphaned: boolean;
};

export type MentionMatch = {
  handle: string;
  token: string;
  start: number;
  end: number;
  castId: string | null;
  characterId: string | null;
  name: string | null;
  role: string | null;
  known: boolean;
};

export type MentionSuggestion = {
  handle: string;
  token: string;
  castId: string;
  characterId: string;
  name: string;
  role: string;
};

export type MentionOptions = {
  caret?: number;
  limit?: number;
  allowSubstring?: boolean;
  suggest?: boolean;
  excludeHandles?: readonly string[];
  excludeCastIds?: readonly string[];
  includeDetached?: boolean;
};

export type MentionResult = {
  text: string;
  mentions: MentionMatch[];
  castIds: string[];
  unknown: string[];
  query: string;
  start: number;
  end: number;
  suggestions: MentionSuggestion[];
};

export type CompleteMentionResult = {
  text: string;
  query: string;
  start: number;
  end: number;
  suggestions: MentionSuggestion[];
  castIds: string[];
};

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function normalizeMentionHandle(value: unknown): string | null {
  const handle = textOf(value).trim().replace(/^@/, '').toLowerCase();
  return MENTION_HANDLE_RE.test(handle) ? handle : null;
}

function candidateOf(source: MentionSource, index: number): (MentionCandidate & { order: number }) | null {
  if (!source || typeof source !== 'object') return null;
  const snapshot = source.snapshot && typeof source.snapshot === 'object' ? source.snapshot : undefined;
  const handle = normalizeMentionHandle(snapshot?.handle ?? source.handle);
  if (!handle) return null;
  const rawCastId = textOf(source.castId);
  const castId = /^c[A-Za-z0-9_-]{0,63}$/.test(rawCastId) ? rawCastId : `c_${handle}`;
  const characterId = textOf(snapshot?.id) || textOf(source.characterId) || textOf(source.id);
  const name = textOf(snapshot?.name).trim() || textOf(source.name).trim() || handle;
  return {
    castId,
    characterId,
    handle,
    name,
    role: textOf(snapshot?.role) || textOf(source.role) || 'supporting',
    detached: source.detached === true,
    orphaned: source.orphaned === true,
    order: index,
  };
}

export function mentionCandidates(
  cast: readonly (CastEntry | Character | MentionSource)[] | null | undefined,
): MentionCandidate[] {
  if (!Array.isArray(cast)) return [];
  const byId = new Map<string, MentionCandidate & { order: number }>();
  const byHandle = new Map<string, string>();
  cast.forEach((source, index) => {
    const candidate = candidateOf(source as MentionSource, index);
    if (!candidate) return;
    const existingHandle = byHandle.get(candidate.handle);
    if (existingHandle !== undefined && existingHandle !== candidate.castId) return;
    if (byId.has(candidate.castId)) return;
    byHandle.set(candidate.handle, candidate.castId);
    byId.set(candidate.castId, candidate);
  });
  return [...byId.values()]
    .sort((left, right) => left.order - right.order)
    .map(({ order: _order, ...candidate }) => candidate);
}

export function resolveMentionHandle(
  handle: string,
  cast: readonly (CastEntry | Character | MentionSource)[] | null | undefined,
): MentionCandidate | null {
  const normalized = normalizeMentionHandle(handle);
  if (!normalized) return null;
  return mentionCandidates(cast).find(candidate => candidate.handle === normalized) ?? null;
}

export function findActiveMention(
  text: string,
  caret: number = text.length,
): { query: string; start: number; end: number } | null {
  const source = String(text ?? '');
  const position = Math.max(0, Math.min(Number.isFinite(caret) ? caret : source.length, source.length));
  const prefix = source.slice(0, position);
  const match = ACTIVE_MENTION_RE.exec(prefix);
  if (!match) return null;
  const token = `@${match[2] ?? ''}`;
  const start = position - token.length;
  return { query: (match[2] ?? '').toLowerCase(), start, end: position };
}

function limitOf(value: unknown): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return 8;
  return Math.max(1, Math.min(Math.trunc(number), 32));
}

function suggestionOf(candidate: MentionCandidate): MentionSuggestion {
  return {
    handle: candidate.handle,
    token: `@${candidate.handle}`,
    castId: candidate.castId,
    characterId: candidate.characterId,
    name: candidate.name,
    role: candidate.role,
  };
}

export function autocompleteMentions(
  input: string,
  cast: readonly (CastEntry | Character | MentionSource)[] | null | undefined,
  options: MentionOptions = {},
): MentionSuggestion[] {
  const source = String(input ?? '');
  const active = findActiveMention(source);
  const raw = active ? active.query : source.trim().replace(/^@/, '');
  const query = raw.toLowerCase();
  const excludedHandles = new Set(
    (options.excludeHandles ?? []).map(handle => normalizeMentionHandle(handle)).filter((handle): handle is string => Boolean(handle)),
  );
  const excludedIds = new Set(options.excludeCastIds ?? []);
  const candidates = mentionCandidates(cast).filter(candidate => {
    if (!options.includeDetached && candidate.detached) return false;
    if (excludedIds.has(candidate.castId)) return false;
    if (excludedHandles.has(candidate.handle)) return false;
    return true;
  });
  const matches = candidates.filter(candidate => {
    if (!query) return true;
    if (candidate.handle.startsWith(query)) return true;
    if (options.allowSubstring === true && candidate.handle.includes(query)) return true;
    return options.allowSubstring === true && candidate.name.toLowerCase().includes(query);
  });
  const rank = (candidate: MentionCandidate): number => {
    if (candidate.handle === query) return 0;
    if (candidate.handle.startsWith(query)) return 1;
    return 2;
  };
  return matches
    .sort((left, right) => {
      if (!query) return 0;
      const byRank = rank(left) - rank(right);
      if (byRank !== 0) return byRank;
      return left.name.localeCompare(right.name) || left.handle.localeCompare(right.handle);
    })
    .slice(0, limitOf(options.limit))
    .map(suggestionOf);
}

export function parseMentions(
  text: string,
  cast: readonly (CastEntry | Character | MentionSource)[] | null | undefined,
): MentionMatch[] {
  const source = String(text ?? '');
  const candidates = mentionCandidates(cast);
  const byHandle = new Map(candidates.map(candidate => [candidate.handle, candidate]));
  const matches: MentionMatch[] = [];
  MENTION_TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MENTION_TOKEN_RE.exec(source)) !== null) {
    const prefix = match[1] ?? '';
    const rawHandle = match[2] ?? '';
    const handle = rawHandle.toLowerCase();
    const start = match.index + prefix.length;
    const end = start + rawHandle.length + 1;
    const candidate = byHandle.get(handle) ?? null;
    matches.push({
      handle,
      token: source.slice(start, end),
      start,
      end,
      castId: candidate?.castId ?? null,
      characterId: candidate?.characterId ?? null,
      name: candidate?.name ?? null,
      role: candidate?.role ?? null,
      known: candidate !== null,
    });
  }
  return matches;
}

export function mention(
  text: string,
  cast: readonly (CastEntry | Character | MentionSource)[] | null | undefined,
  options: MentionOptions = {},
): MentionResult {
  const source = String(text ?? '');
  const mentions = parseMentions(source, cast);
  const castIds: string[] = [];
  const unknown: string[] = [];
  for (const item of mentions) {
    if (item.castId && !castIds.includes(item.castId)) castIds.push(item.castId);
    if (!item.known && !unknown.includes(item.handle)) unknown.push(item.handle);
  }
  const caret = options.caret ?? source.length;
  const active = options.suggest === false ? null : findActiveMention(source, caret);
  const suggestions = active
    ? autocompleteMentions(active.query, cast, {
        ...options,
        excludeHandles: [
          ...(options.excludeHandles ?? []),
          ...mentions.filter(item => item.known).map(item => item.handle),
        ],
      })
    : [];
  return {
    text: source,
    mentions,
    castIds,
    unknown,
    query: active?.query ?? '',
    start: active?.start ?? caret,
    end: active?.end ?? caret,
    suggestions,
  };
}

export const mentions = mention;
export const resolveMentions = parseMentions;
export const suggestMentions = autocompleteMentions;

export function completeMention(
  text: string,
  cast: readonly (CastEntry | Character | MentionSource)[] | null | undefined,
  options: MentionOptions = {},
): CompleteMentionResult {
  const source = String(text ?? '');
  const active = findActiveMention(source, options.caret ?? source.length);
  if (!active) {
    return {
      text: source,
      query: '',
      start: source.length,
      end: source.length,
      suggestions: [],
      castIds: [],
    };
  }
  const suggestions = autocompleteMentions(active.query, cast, options);
  return {
    text: source,
    query: active.query,
    start: active.start,
    end: active.end,
    suggestions,
    castIds: [...new Set(suggestions.map(suggestion => suggestion.castId))],
  };
}

export const mentionAutocomplete = completeMention;

export function applyMention(
  text: string,
  suggestion: MentionSuggestion | MentionCandidate | string,
  range?: { start: number; end: number },
): string {
  const source = String(text ?? '');
  const active = range ?? findActiveMention(source);
  if (!active) return source;
  const raw = typeof suggestion === 'string'
    ? suggestion
    : 'token' in suggestion
      ? suggestion.token
      : `@${suggestion.handle}`;
  const token = `@${raw.replace(/^@/, '').toLowerCase()}`;
  const start = Math.max(0, Math.min(active.start, source.length));
  const end = Math.max(start, Math.min(active.end, source.length));
  const before = source.slice(0, start);
  const after = source.slice(end);
  const spacer = after.startsWith(' ') || after === '' ? '' : ' ';
  return `${before}${token}${spacer}${after}`;
}

export const mentionText = applyMention;
