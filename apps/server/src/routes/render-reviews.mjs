import { isDeepStrictEqual } from 'node:util';

const invalid = () => Object.assign(new Error('Supply only packageId, expectedRevision and renderId with valid identifiers and an integer revision.'), { status: 422, code: 'RENDER_REVIEW_INVALID' });

/** Owner authentication is enforced by the app before this route. Inspection
 * writes only an immutable report; it never dispatches chat, editing or rendering. */
export function createRenderReviewRoutes({ store, reviewer, readJson, sendJson }) {
  return {
    async handle(request, response, url) {
      if (url.pathname !== '/api/render-reviews') return false;
      if (request.method !== 'POST') {
        sendJson(response, 405, { error: 'method not allowed', code: 'METHOD_NOT_ALLOWED' });
        return true;
      }
      try {
        const input = await readJson(request);
        const keys = ['packageId', 'expectedRevision', 'renderId'];
        if (!input || typeof input !== 'object' || Array.isArray(input)
          || Object.keys(input).length !== keys.length || !keys.every(key => Object.hasOwn(input, key))
          || typeof input.packageId !== 'string' || !/^pkg_[A-Za-z0-9_-]+$/.test(input.packageId)
          || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0
          || typeof input.renderId !== 'string' || !/^(?:r|run)_[a-f0-9]{12}$/.test(input.renderId)) throw invalid();
        const pkg = store.read(input.packageId);
        if (!pkg) {
          sendJson(response, 404, { error: 'Saved project not found.', code: 'PACKAGE_NOT_FOUND' });
          return true;
        }
        const stale = () => Object.assign(new Error('The saved package changed. Inspect its current final render again.'), { status: 409, code: 'RENDER_REVIEW_STALE' });
        if (pkg.id !== input.packageId || pkg.revision !== input.expectedRevision) throw stale();
        const report = await reviewer.inspect(pkg, input);
        // CPU inspection can yield while an owner edits the saved project. A
        // historical report remains immutable but cannot be returned as current.
        if (!isDeepStrictEqual(store.read(input.packageId), pkg)) throw stale();
        sendJson(response, 200, report);
      } catch (error) {
        if (['ENOENT', 'ENOTDIR', 'ARTIFACT_MISSING'].includes(error.code)) {
          sendJson(response, 404, { error: 'The saved final render or its trusted evidence is missing or has changed.', code: 'ARTIFACT_MISSING' });
        } else if (['RENDER_REVIEW_INVALID', 'RENDER_REVIEW_STALE'].includes(error.code)) {
          sendJson(response, error.status, { error: error.message, code: error.code });
        } else if (error.status === 400 || error.status === 413) {
          sendJson(response, error.status, { error: error.message, code: error.status === 413 ? 'BODY_TOO_LARGE' : 'INVALID_JSON' });
        } else {
          sendJson(response, 500, { error: 'Render inspection could not be completed.', code: 'RENDER_REVIEW_FAILED' });
        }
      }
      return true;
    },
  };
}
