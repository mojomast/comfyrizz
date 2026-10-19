/**
 * Media URL adapter. Export and the bundled player use a static resolver.
 * A server preview passes mediaAuth; native elements cannot set API headers,
 * so the session token rides the query string. Callers must not put that URL
 * into an exported props file.
 */
export function authenticatedMediaUrl(file, { packageId, token, origin = '' }) {
  const params = new URLSearchParams({ path: file, token });
  return `${origin}/api/package/${encodeURIComponent(packageId)}/media?${params}`;
}

export function resolveMediaSrc(file, mediaAuth, staticSrc = (value) => value) {
  if (mediaAuth?.packageId && mediaAuth?.token) return authenticatedMediaUrl(file, mediaAuth);
  return staticSrc(file);
}
