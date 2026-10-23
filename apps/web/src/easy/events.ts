import {
  ProductionClientError,
  createProductionClient,
} from '../productions/client.ts';
import type {
  ProductionApiFetch,
  ProductionState,
} from '../productions/client.ts';

const DEFAULT_INTERVAL_MS = 2000;
const HIDDEN_INTERVAL_MS = 10000;
const RETRY_DELAYS_MS = [2000, 4000, 8000, 16000] as const;
const MAX_RETRY_DELAY_MS = 30000;

export interface ProductionWatchState extends ProductionState {
  error: ProductionClientError | null;
}

export interface ProductionWatchHandle {
  (): void;
  stop: () => void;
}

export interface WatchProductionOptions {
  productionId: string;
  fetchImpl?: ProductionApiFetch;
  onState: (state: ProductionWatchState) => void;
  intervalMs?: number;
  setTimeout?: (callback: () => void, delayMs: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  isHidden?: () => boolean;
}

function normalizeInterval(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_INTERVAL_MS;
}

function readRetryDelay(failures: number): number {
  if (failures < RETRY_DELAYS_MS.length) return RETRY_DELAYS_MS[failures];
  return MAX_RETRY_DELAY_MS;
}

function asClientError(error: unknown): ProductionClientError {
  if (error instanceof ProductionClientError) return error;
  const message = error instanceof Error && error.message !== ''
    ? error.message
    : 'the production watch failed';
  return new ProductionClientError(message, { code: 'WATCH_ERROR', cause: error });
}

function documentHidden(): boolean {
  const scope = globalThis as typeof globalThis & { document?: { hidden?: boolean } };
  return Boolean(scope.document?.hidden);
}

export function watchProduction(options: WatchProductionOptions): ProductionWatchHandle {
  const client = createProductionClient({
    productionId: options.productionId,
    ...(options.fetchImpl === undefined ? {} : { apiFetch: options.fetchImpl }),
  });

  const intervalMs = normalizeInterval(options.intervalMs);
  const schedule = typeof options.setTimeout === 'function'
    ? options.setTimeout
    : (callback: () => void, delayMs: number) => globalThis.setTimeout(callback, delayMs);
  const cancel = typeof options.clearTimeout === 'function'
    ? options.clearTimeout
    : (handle: unknown) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>);
  const hidden = typeof options.isHidden === 'function' ? options.isHidden : documentHidden;

  let timer: unknown = null;
  let active: AbortController | null = null;
  let stopped = false;
  let loaded = false;
  let failures = 0;

  function emit(state: ProductionState, error: ProductionClientError | null): void {
    if (stopped) return;
    options.onState({ ...state, error });
  }

  function scheduleNext(delayMs: number): void {
    if (stopped) return;
    if (timer !== null) {
      cancel(timer);
      timer = null;
    }
    timer = schedule(() => {
      timer = null;
      void attempt();
    }, delayMs);
  }

  function pollDelay(): number {
    return hidden() ? HIDDEN_INTERVAL_MS : intervalMs;
  }

  async function attempt(): Promise<void> {
    if (stopped) return;

    const previous = client.getState();
    const controller = new AbortController();
    active = controller;

    try {
      let next: ProductionState;
      if (!loaded) {
        next = await client.loadSnapshot({ signal: controller.signal });
        loaded = true;
      } else {
        next = await client.pullEvents({ signal: controller.signal });
        if (!stopped && next.lastSequence > previous.lastSequence
          && next.revision === previous.revision) {
          next = await client.refresh({ signal: controller.signal });
        }
      }

      if (stopped) return;
      if (active === controller) active = null;
      failures = 0;
      emit(next, null);
      scheduleNext(pollDelay());
    } catch (error) {
      if (active === controller) active = null;
      if (stopped) return;
      const clientError = asClientError(error);
      const delayMs = readRetryDelay(failures);
      failures += 1;
      emit(client.getState(), clientError);
      scheduleNext(delayMs);
    }
  }

  void attempt();

  function stop(): void {
    if (stopped) return;
    stopped = true;
    if (timer !== null) {
      cancel(timer);
      timer = null;
    }
    if (active !== null) {
      active.abort();
      active = null;
    }
  }

  const handle = stop as ProductionWatchHandle;
  handle.stop = stop;
  return handle;
}