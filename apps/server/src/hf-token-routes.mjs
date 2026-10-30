/** Authenticated/same-origin enforcement is shared with every other API in app.mjs. */
export async function handleHfTokenRoutes({ request, response, url, settings, readJson, sendJson }) {
  const statusPath = url.pathname === '/api/hf/settings';
  const probePath = url.pathname === '/api/hf/settings/probe';
  if (!statusPath && !probePath) return false;

  try {
    if (statusPath && request.method === 'GET') {
      sendJson(response, 200, settings.status());
      return true;
    }
    if (statusPath && request.method === 'PUT') {
      sendJson(response, 200, settings.save(await readJson(request)));
      return true;
    }
    if (statusPath && request.method === 'DELETE') {
      sendJson(response, 200, settings.remove());
      return true;
    }
    if (probePath && request.method === 'POST') {
      sendJson(response, 200, await settings.probe());
      return true;
    }
    sendJson(response, 405, { error: 'method not allowed' });
  } catch (error) {
    // Validation and filesystem messages are fixed by hf-token-settings.mjs;
    // upstream response bodies and token values are never included here.
    sendJson(response, error?.status ?? 500, { error: error?.message ?? 'Hugging Face settings failed' });
  }
  return true;
}
