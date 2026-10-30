const LIST_PATTERN = /^\/api\/productions\/([^/]+)\/ref-review(?:\/(events|override))?\/?$/;
const EVIDENCE_PATTERN = /^\/api\/productions\/([^/]+)\/ref-review\/([^/]+)\/evidence\/?$/;
const OVERRIDE_FIELDS = ['keyframeId', 'stillSha', 'receiptId', 'reason'];

function segment(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function methodNotAllowed(sendJson, response) {
  sendJson(response, 405, { error: 'method not allowed', code: 'METHOD_NOT_ALLOWED' });
  return true;
}

function overrideInvalid(sendJson, response) {
  sendJson(response, 400, {
    error: 'override needs keyframeId, stillSha, receiptId and reason',
    code: 'REF_REVIEW_OVERRIDE_INVALID',
  });
  return true;
}

function stillShaFor(evidence) {
  return evidence.stillSha ?? evidence.keyframeSha256 ?? evidence.imageSha256 ?? null;
}

function normalizeEvidence(raw, productionId, keyframeId) {
  const verdict = raw.verdict
    ?? (Array.isArray(raw.verdicts) && raw.verdicts.length > 0 ? raw.verdicts[raw.verdicts.length - 1] : null);
  const decision = raw.decision ?? null;
  const receipt = raw.receipt;
  return {
    productionId: raw.productionId ?? productionId,
    keyframeId: raw.keyframeId ?? raw.jobId ?? keyframeId,
    stillSha: stillShaFor(raw),
    verdict: verdict ?? null,
    decision,
    receiptId: raw.receiptId ?? (isObject(receipt) ? receipt.id : null) ?? decision?.receiptId ?? null,
    receiptPath: raw.receiptPath ?? (typeof receipt === 'string' ? receipt : receipt?.path) ?? null,
  };
}

function keyframeStates(bus, productionId) {
  const states = new Map();
  for (const event of bus.recent(productionId)) {
    const keyframeId = event.jobId ?? event.keyframeId;
    if (typeof keyframeId !== 'string' || keyframeId === '') continue;
    if (!states.has(keyframeId)) {
      states.set(keyframeId, { keyframeId, productionId: event.productionId ?? productionId });
    }
    const state = states.get(keyframeId);
    if (event.state !== undefined) state.state = event.state;
    if (event.keyframeSha256 !== undefined) state.stillSha = event.keyframeSha256;
    if (event.verdict !== undefined) state.verdict = event.verdict;
    if (event.decision !== undefined) state.decision = event.decision;
    if (event.estimate !== undefined) state.estimate = event.estimate;
    if (event.at !== undefined) state.at = event.at;
    state.lastEvent = event.type;
  }
  return [...states.values()];
}

function openStream(request, response, bus, productionId) {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  let closed = false;
  const write = (event) => {
    if (closed) return;
    try {
      response.write(bus.formatSse(event));
    } catch {
      closed = true;
    }
  };
  for (const event of bus.recent(productionId)) write(event);
  const unsubscribe = bus.subscribe((event) => {
    if (event.productionId === productionId) write(event);
  });
  const close = () => {
    closed = true;
    unsubscribe();
  };
  if (typeof request.on === 'function') request.on('close', close);
  if (typeof response.on === 'function') response.on('close', close);
  return true;
}

export function createRefReviewRoutes({ bus, readEvidence, applyOverride, readJson, sendJson }) {
  async function handleOverride(request, response, productionId) {
    if (request.method !== 'POST') return methodNotAllowed(sendJson, response);
    let body;
    try {
      body = await readJson(request);
    } catch {
      sendJson(response, 400, { error: 'invalid JSON body', code: 'INVALID_JSON' });
      return true;
    }
    if (!isObject(body) || !OVERRIDE_FIELDS.every((field) => (
      typeof body[field] === 'string' && body[field].trim() !== ''
    ))) return overrideInvalid(sendJson, response);

    let raw;
    try {
      raw = await readEvidence({ productionId, keyframeId: body.keyframeId });
    } catch {
      sendJson(response, 500, { error: 'reference review evidence could not be read', code: 'REF_REVIEW_FAILED' });
      return true;
    }
    if (raw === null || raw === undefined) {
      sendJson(response, 409, {
        error: 'the keyframe has no review receipt to override',
        code: 'REF_REVIEW_RECEIPT_MISSING',
      });
      return true;
    }

    const evidence = normalizeEvidence(raw, productionId, body.keyframeId);
    if (!evidence.stillSha || evidence.stillSha !== body.stillSha) {
      sendJson(response, 409, {
        error: 'the keyframe changed since it was reviewed',
        code: 'REF_REVIEW_STALE',
      });
      return true;
    }
    if (!evidence.receiptId) {
      sendJson(response, 409, {
        error: 'the keyframe has no review receipt to override',
        code: 'REF_REVIEW_RECEIPT_MISSING',
      });
      return true;
    }
    if (evidence.receiptId !== body.receiptId) {
      sendJson(response, 409, {
        error: 'the override does not match the current review receipt',
        code: 'REF_REVIEW_RECEIPT_MISMATCH',
      });
      return true;
    }

    try {
      const result = await applyOverride({
        productionId,
        keyframeId: body.keyframeId,
        stillSha: body.stillSha,
        receiptId: body.receiptId,
        reason: body.reason,
        evidence,
      });
      sendJson(response, 200, { ok: true, ...(isObject(result) ? result : {}) });
    } catch {
      sendJson(response, 500, { error: 'the override could not be applied', code: 'REF_REVIEW_FAILED' });
    }
    return true;
  }

  async function handleEvidence(response, productionId, keyframeId) {
    let raw;
    try {
      raw = await readEvidence({ productionId, keyframeId });
    } catch {
      sendJson(response, 500, { error: 'reference review evidence could not be read', code: 'REF_REVIEW_FAILED' });
      return true;
    }
    if (raw === null || raw === undefined) {
      sendJson(response, 404, { error: 'reference review evidence not found', code: 'REF_REVIEW_NOT_FOUND' });
      return true;
    }
    sendJson(response, 200, normalizeEvidence(raw, productionId, keyframeId));
    return true;
  }

  return {
    async handle(request, response, url) {
      const pathname = typeof url === 'string' ? url : url.pathname;
      const evidenceMatch = EVIDENCE_PATTERN.exec(pathname);
      if (evidenceMatch) {
        if (request.method !== 'GET') return methodNotAllowed(sendJson, response);
        return handleEvidence(response, segment(evidenceMatch[1]), segment(evidenceMatch[2]));
      }

      const listMatch = LIST_PATTERN.exec(pathname);
      if (!listMatch) return false;
      const productionId = segment(listMatch[1]);
      const action = listMatch[2];

      if (action === 'events') {
        if (request.method !== 'GET') return methodNotAllowed(sendJson, response);
        return openStream(request, response, bus, productionId);
      }
      if (action === 'override') return handleOverride(request, response, productionId);
      if (request.method !== 'GET') return methodNotAllowed(sendJson, response);
      sendJson(response, 200, { productionId, keyframes: keyframeStates(bus, productionId) });
      return true;
    },
  };
}
