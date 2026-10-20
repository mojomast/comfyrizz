/**
 * Media URL adapter. Export and the bundled player use a static resolver.
 * A server preview may pass already-resolved blob or short-lived ticket URLs.
 * Mint/fetch them using API headers outside the composition. Session credentials
 * are never accepted here and can never be embedded in a native media URL.
 */
export function resolveMediaSrc(file, sources, staticSrc = (value) => value) {
  const source = sources?.[file];
  if (typeof source === 'string' && (/^blob:[^?#]+$/.test(source) || /^\/api\/media\/[a-f0-9]{32}$/.test(source))) return source;
  return staticSrc(file);
}
