// UX01: the production admission adapter.
//
// One place that turns the UX00 contract (`comfyrizz.admission/v1`) into
// decisions for every entry point that can allocate generation work. It owns no
// state: the production journal (`store`) is the only authority, and a caller
// boolean never is. `run.mjs` and `pipeline.mjs` call it at their start, and
// the coordinator can hand `guardRuns` to the take routes, the queue drain and
// chat so a bound package refuses there instead of falling back to the legacy
// path.
//
// Unbound packages keep today's behaviour exactly: every function returns
// `null` (no refusal) for them.
import {
  ADMISSION_ENTRY_POINTS,
  admissionRefusal,
  bindingRefusal,
  resolveProductionBinding,
  validateBoundAdmission,
} from './contract.mjs';

/** The entry points whose callers can present journal authority today. */
export const AUTHORITY_ENTRY_POINTS = Object.freeze(['run.start']);

const CALLER_KEYS = Object.freeze(['approved', 'actor', 'userEventId', 'reservationId', 'state']);

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function latestAction(events, actionId) {
  let action = null;
  for (const event of events) {
    if (event.type !== 'action.state_changed' || !isPlainObject(event.data)) continue;
    if (event.data.id !== actionId) continue;
    action = action ? { ...action, ...event.data } : { ...event.data };
  }
  return action;
}

/**
 * @param {{ store: { list: Function, read?: Function, readEvents?: Function } | null }} options
 */
export function createProductionAdmission({ store } = {}) {
  /** A journal that cannot be read refuses bound-looking work; it never admits it. */
  function binding(pkg) {
    const productions = store && typeof store.list === 'function' ? store.list() : [];
    return resolveProductionBinding(pkg, productions);
  }

  function unavailable(entryPoint, error) {
    return admissionRefusal('BOUND_AUTHORITY_UNAVAILABLE', 'the production journal is not available', {
      entryPoint,
      errors: [String(error?.code ?? 'READ_FAILED')],
    });
  }

  /**
   * The binding checks that come before any authority is looked at: ownership
   * conflict, then a production that is not active. A missing production is
   * reported by the caller after it has checked the authority shape, so the
   * existing "authority required" answer for a bare request does not change.
   *
   * @returns {{ bound: false } | { bound: true, binding: object, refusal?: object }}
   */
  function preflight(pkg, entryPoint = 'run.start') {
    if (!ADMISSION_ENTRY_POINTS.includes(entryPoint)) {
      throw new TypeError(`unknown admission entry point: ${entryPoint}`);
    }
    let resolved;
    try {
      resolved = binding(pkg);
    } catch (error) {
      return { bound: true, binding: null, refusal: unavailable(entryPoint, error) };
    }
    if (resolved.state === 'unbound') return { bound: false };
    const refusal = bindingRefusal(resolved, entryPoint);
    if (refusal && refusal.code !== 'PRODUCTION_NOT_FOUND') return { bound: true, binding: resolved, refusal };
    if (!AUTHORITY_ENTRY_POINTS.includes(entryPoint)) {
      return {
        bound: true,
        binding: resolved,
        refusal: admissionRefusal('BOUND_ENTRY_UNSUPPORTED', 'this entry point cannot verify production authority; use the production plan card', {
          entryPoint,
          productionId: resolved.productionId,
        }),
      };
    }
    return { bound: true, binding: resolved, ...(refusal ? { notFound: refusal } : {}) };
  }

  /**
   * Caller-supplied authority is refused outright. The key list and the codes
   * come from the UX00 `validateBoundAdmission`, so the rule is not copied here.
   *
   * @param {{ authority?: unknown, expected?: unknown, caller?: Record<string, unknown> }} request
   */
  function callerAuthorityRefusal({ authority, expected, caller = {} }, entryPoint) {
    const doc = {};
    if (authority !== undefined && authority !== null) doc.authority = authority;
    if (expected !== undefined && expected !== null) doc.expected = expected;
    for (const key of CALLER_KEYS) {
      const value = caller[key];
      if (value === undefined || value === null || value === false) continue;
      doc[key] = value;
    }
    const result = validateBoundAdmission(doc);
    const forbidden = result.errors.filter((error) => error.code === 'CALLER_AUTHORITY_FORBIDDEN');
    if (forbidden.length === 0) return null;
    return admissionRefusal('CALLER_AUTHORITY_FORBIDDEN', 'approval and attribution come from the production journal, not from the request', {
      entryPoint,
      errors: forbidden.map((error) => String(error.path ?? error.code).replace(/^\/+/, '')),
    });
  }

  /**
   * Refusal for an entry point that can never carry journal authority (take
   * regeneration, the queued drain, chat corrections, the pipeline route), or
   * null for an unbound package.
   */
  function entryRefusal(pkg, entryPoint) {
    const gate = preflight(pkg, entryPoint);
    if (!gate.bound) return null;
    if (gate.refusal) return gate.refusal;
    return admissionRefusal('BOUND_ENTRY_UNSUPPORTED', 'this entry point cannot verify production authority; use the production plan card', {
      entryPoint,
      productionId: gate.binding.productionId,
    });
  }

  /**
   * Admission for `pipeline.start`.
   *
   * The server-owned dispatch path (the pipeline adapter) passes `origin`: the
   * production and action it journaled as `dispatching`. Nothing a caller can
   * put in the HTTP body reaches `origin`. A bound package without it is
   * refused, because the route cannot consume an action slot and so could not
   * stop a repeated command from allocating twice.
   *
   * @param {object} pkg
   * @param {object} input the request body; read only for authority diagnostics
   * @param {{ origin?: { productionId: string, actionId: string } | null }} [options]
   * @returns {object|null} a typed refusal, or null to admit
   */
  function pipelineRefusal(pkg, input, { origin = null } = {}) {
    const entryPoint = 'pipeline.start';
    let resolved;
    try {
      resolved = binding(pkg);
    } catch (error) {
      return unavailable(entryPoint, error);
    }
    if (resolved.state === 'unbound' && !origin) return null;
    if (resolved.state !== 'unbound') {
      const refusal = bindingRefusal(resolved, entryPoint);
      if (refusal) return refusal;
    }
    if (!origin) {
      const hasAuthority = isPlainObject(input) && isPlainObject(input.authority);
      if (!hasAuthority) {
        return admissionRefusal('BOUND_AUTHORITY_REQUIRED', 'a production-bound pipeline run requires its dispatched action', {
          entryPoint,
          productionId: resolved.productionId,
        });
      }
      return admissionRefusal('BOUND_ENTRY_UNSUPPORTED', 'the pipeline route cannot verify production authority; dispatch the action instead', {
        entryPoint,
        productionId: resolved.productionId,
      });
    }
    if (resolved.state !== 'unbound' && origin.productionId !== resolved.productionId) {
      return admissionRefusal('PRODUCTION_MISMATCH', 'the dispatching production does not own this package', {
        entryPoint,
        productionId: resolved.productionId,
      });
    }
    // The dispatching production may not have been linked to a package yet; it
    // is still the authority for this run, so its own intent decides.
    if (resolved.state === 'unbound') {
      let production;
      try {
        production = store.read(origin.productionId);
      } catch (error) {
        return unavailable(entryPoint, error);
      }
      const refusal = bindingRefusal({
        state: 'bound',
        productionId: origin.productionId,
        source: 'store',
        intent: typeof production?.intent === 'string' ? production.intent : null,
        revision: Number.isSafeInteger(production?.revision) ? production.revision : null,
      }, entryPoint);
      if (refusal) return refusal;
    }
    let action;
    try {
      action = latestAction(store.readEvents(origin.productionId), origin.actionId);
    } catch (error) {
      return unavailable(entryPoint, error);
    }
    if (!action) {
      return admissionRefusal('UNKNOWN_ACTION', 'the action was never dispatched', {
        entryPoint,
        productionId: origin.productionId,
        actionId: origin.actionId,
      });
    }
    if (action.state !== 'dispatching' || typeof action.reservationId !== 'string' || action.reservationId === '') {
      return admissionRefusal('ACTION_NOT_ADMITTED', 'the action is not dispatching with a slot reservation', {
        entryPoint,
        productionId: origin.productionId,
        actionId: origin.actionId,
      });
    }
    return null;
  }

  /**
   * Wrap a run controller so every start through it names its entry point.
   * `run.mjs` then refuses a bound package with BOUND_ENTRY_UNSUPPORTED instead
   * of reaching a backend. Everything else is delegated unchanged.
   */
  function guardRuns(runs, entryPoint) {
    if (!ADMISSION_ENTRY_POINTS.includes(entryPoint)) throw new TypeError(`unknown admission entry point: ${entryPoint}`);
    if (AUTHORITY_ENTRY_POINTS.includes(entryPoint)) throw new TypeError(`${entryPoint} carries its own authority; do not guard it`);
    return new Proxy(runs, {
      get(target, property, receiver) {
        if (property === 'start') return (options = {}) => target.start({ ...options, entryPoint });
        return Reflect.get(target, property, receiver);
      },
    });
  }

  return { binding, preflight, callerAuthorityRefusal, entryRefusal, pipelineRefusal, guardRuns };
}
