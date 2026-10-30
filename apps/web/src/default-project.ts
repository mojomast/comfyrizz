/**
 * PN07: choose the project the editor opens on first paint.
 *
 * The bundled package (Pip's Night Shift) is always the fallback. When the
 * page has a session token, a `?package=<id>` query still wins; otherwise the
 * editor asks the local server for the seeded demo so the takes, references,
 * cast and render bar come from the API instead of staying empty.
 *
 * The decision and the fetch are kept here, away from the DOM, so tests can
 * inject a request function and a package adopter and exercise every branch
 * without a server, network, GPU or browser.
 */
import type { PackageV1 } from '../../../packages/schema/types';

export const DEFAULT_PACKAGE_ID = 'pkg_pipnightshift01';
export const DEFAULT_PROJECT_TITLE = "Pip's Night Shift";
export const DEFAULT_EXAMPLE_DIR = 'examples/pip-night-shift';
/** The conversation the seeder attaches the demo references and cast to. */
export const SEEDED_CHAT_ID = 'chat_pipnightshift01';

export const BUNDLED_ACTIVITY = `Loaded ${DEFAULT_EXAMPLE_DIR} package + compiled timeline`;

export type InitialProjectSource = 'bundled' | 'seeded' | 'requested';

export interface InitialProjectTarget {
  source: InitialProjectSource;
  packageId: string | null;
}

export interface OpenedProject {
  source: InitialProjectSource;
  packageId: string | null;
  activity: string;
  /** Present only for the seeded default, so sidecars resolve to its chat. */
  chatId?: string;
  editor?: unknown;
  budgetUnits?: number;
}

export type PackageRequest = (input: string, init?: RequestInit) => Promise<Response>;

export interface OpenInitialProjectOptions {
  search: string;
  hasToken: boolean;
  /** Usually the authenticated `apiFetch`; injected so tests need no server. */
  request: PackageRequest;
  /** Adopt a successfully fetched package (and its editor sidecar). */
  onPackage: (pkg: PackageV1, editor?: unknown) => void;
  onError?: (error: unknown) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requestedId(search: string): string | null {
  try {
    const value = new URLSearchParams(search).get('package');
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * `?package=` always wins. With a token and no query, open the seeded demo;
 * without a token the statically bundled package stays in place.
 */
export function initialProjectTarget(search: string, hasToken: boolean): InitialProjectTarget {
  if (!hasToken) return { source: 'bundled', packageId: null };
  const requested = requestedId(search);
  if (requested) return { source: 'requested', packageId: requested };
  if (new URLSearchParams(search).get('demo') === '1') return { source: 'bundled', packageId: null };
  return { source: 'seeded', packageId: DEFAULT_PACKAGE_ID };
}

/** The Activity line for whichever project actually opened. */
export function initialProjectActivity(source: InitialProjectSource, packageId: string | null): string {
  if (source === 'seeded') {
    return `Opened ${DEFAULT_PROJECT_TITLE} from the local server (${DEFAULT_EXAMPLE_DIR}) + compiled timeline`;
  }
  if (source === 'requested') {
    return `Opened requested package ${packageId ?? ''} from the local server + compiled timeline`.replace(/\s+/g, ' ').trim();
  }
  return BUNDLED_ACTIVITY;
}

/**
 * Open the initial project and report what happened. A failed or malformed
 * response leaves the bundled package untouched, matching the old
 * `?package=` behaviour; the caller only sees the failure through `onError`.
 */
export async function openInitialProject(options: OpenInitialProjectOptions): Promise<OpenedProject> {
  const target = initialProjectTarget(options.search, options.hasToken);
  const bundled: OpenedProject = {
    source: 'bundled',
    packageId: null,
    activity: initialProjectActivity('bundled', null),
  };
  if (target.source === 'bundled' || !target.packageId) return bundled;

  const url = `/api/package/${encodeURIComponent(target.packageId)}`;
  try {
    const response = await options.request(url);
    if (!response.ok) {
      options.onError?.(new Error(`package ${target.packageId} returned HTTP ${response.status}`));
      return bundled;
    }
    const body = await response.json() as { package?: unknown; editor?: unknown; runDefaults?: { budgetUnits?: unknown } };
    if (!isRecord(body.package)) {
      options.onError?.(new Error(`package ${target.packageId} response has no package`));
      return bundled;
    }
    const editor = isRecord(body.editor) ? body.editor : undefined;
    options.onPackage(body.package as unknown as PackageV1, editor);
    return {
      source: target.source,
      packageId: target.packageId,
      activity: initialProjectActivity(target.source, target.packageId),
      ...(target.source === 'seeded' ? { chatId: SEEDED_CHAT_ID } : {}),
      ...(target.source === 'requested' && /^chat_[A-Za-z0-9_-]{8,80}$/.test(new URLSearchParams(options.search).get('chat') ?? '')
        ? { chatId: new URLSearchParams(options.search).get('chat')! } : {}),
      ...(editor ? { editor } : {}),
      ...(typeof body.runDefaults?.budgetUnits === 'number' && Number.isFinite(body.runDefaults.budgetUnits) && body.runDefaults.budgetUnits >= 0
        ? { budgetUnits: body.runDefaults.budgetUnits } : {}),
    };
  } catch (error) {
    options.onError?.(error);
    return bundled;
  }
}
