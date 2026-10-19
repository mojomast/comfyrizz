/**
 * TEMPORARY STAND-IN until CA-1 removes `node:crypto` from the planner bundle.
 *
 * The browser cannot import Node's crypto. This shim lets Vite evaluate
 * `compileTimeline` for the timeline preview. It is not a cryptographic hash
 * and must not be used for save, export, or parity checks. Node tests import
 * the planner directly and keep the real SHA-256.
 */
export function createHash(_algorithm: string) {
  let data = '';
  return {
    update(chunk: string) {
      data += String(chunk);
      return this;
    },
    digest(encoding?: string) {
      let hash = 0x811c9dc5;
      for (let i = 0; i < data.length; i += 1) {
        hash ^= data.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
      }
      const hex = (hash >>> 0).toString(16).padStart(8, '0');
      return encoding === 'hex' || encoding == null ? hex : hex;
    },
  };
}
