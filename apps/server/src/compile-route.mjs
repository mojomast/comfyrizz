import { dirname } from 'node:path';
import { compileInputHash, compileTimeline } from '../../../packages/planner/dist/src/browser.js';
import { measuredOptionsFromDir } from './compile-package.mjs';

/**
 * Authenticated compile. Debounce and stale-drop live in the browser client:
 * each response carries revision, editSequence and inputHash so an older one
 * can be discarded. The route itself recomputes the hash and the timeline.
 */
export async function handleCompile({ request, response, url, readJson, sendJson, store }) {
  if (url.pathname !== '/api/compile') return false;
  if (request.method !== 'POST') {
    sendJson(response, 405, { error: 'method not allowed' });
    return true;
  }
  const body = await readJson(request);
  const doc = body.doc ?? (body.package ? { package: body.package, editor: body.editor, editSequence: body.editSequence } : null);
  if (!doc || (typeof doc !== 'object')) {
    sendJson(response, 400, { error: 'doc or package required' });
    return true;
  }
  let measured = body.measured;
  if (measured == null && doc.package?.id) {
    try {
      measured = measuredOptionsFromDir(dirname(store.path(doc.package.id)), doc.package);
    } catch {
      measured = {};
    }
  }
  const revision = body.revision ?? doc.package?.revision ?? null;
  const editSequence = body.editSequence ?? doc.editSequence ?? null;
  try {
    const input = editSequence == null ? doc : { ...doc, editSequence };
    const timeline = compileTimeline(input, measured ?? {});
    const inputHash = compileInputHash(input, measured ?? {});
    sendJson(response, 200, { revision, editSequence, inputHash, timeline });
  } catch (error) {
    sendJson(response, 400, { error: error.message, ...(error.code ? { code: error.code } : {}) });
  }
  return true;
}
