export const WEB_SAFE_H264 = Object.freeze([
  '-pix_fmt', 'yuv420p',
  '-profile:v', 'high',
  '-movflags', '+faststart',
]);

const WEB_SAFE_OPTIONS = new Set(['-pix_fmt', '-profile:v', '-movflags']);

export function withWebSafe(args) {
  if (!Array.isArray(args) || args.length === 0) {
    throw new TypeError('withWebSafe expects a non-empty argument list');
  }
  const output = args[args.length - 1];
  const body = [];
  for (let index = 0; index < args.length - 1; index += 1) {
    if (WEB_SAFE_OPTIONS.has(args[index])) {
      index += 1;
      continue;
    }
    body.push(args[index]);
  }
  return [...body, ...WEB_SAFE_H264, output];
}
