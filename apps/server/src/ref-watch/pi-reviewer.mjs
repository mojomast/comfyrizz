import { REF_VERDICT_SCHEMA } from '../../../../packages/schema/src/ref-review.mjs';

function errorVerdict(request) {
  return {
    schema: REF_VERDICT_SCHEMA,
    jobId: request?.jobId,
    keyframeSha256: request?.keyframeSha256,
    reviewer: 'pi',
    overall: 'error',
    checks: [],
    fixHints: [],
  };
}

export function createPiRefReviewer({ reviewStill, model, loadImage } = {}) {
  if (typeof reviewStill !== 'function') throw new TypeError('createPiRefReviewer requires reviewStill');
  if (typeof loadImage !== 'function') throw new TypeError('createPiRefReviewer requires loadImage');

  return async function piRefReviewer(input, options = {}) {
    const envelope = input && typeof input === 'object' && input.request && typeof input.request === 'object'
      ? input
      : null;
    const request = envelope ? envelope.request : input;
    const signal = options?.signal ?? envelope?.signal;
    try {
      const image = await loadImage(request?.imagePath);
      return await reviewStill({ request, image, model, signal });
    } catch {
      return errorVerdict(request);
    }
  };
}
