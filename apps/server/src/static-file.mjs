import { createReadStream, statSync } from 'node:fs';

/** Single byte ranges let browsers seek in longer local video previews. */
export function serveStaticFile(request, response, file, headers = {}) {
  const size = statSync(file).size;
  const base = { ...headers, 'accept-ranges': 'bytes' };
  const range = request.method === 'GET' ? request.headers.range : null;
  if (!range) {
    response.writeHead(200, { ...base, 'content-length': size });
    if (request.method === 'HEAD') return response.end();
    return createReadStream(file).pipe(response);
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  let start = 0, end = size - 1;
  let valid = Boolean(match && (match[1] || match[2]) && size > 0);
  if (valid) {
    if (!match[1]) {
      const suffix = Number(match[2]);
      valid = Number.isSafeInteger(suffix) && suffix > 0;
      start = Math.max(0, size - suffix);
    } else {
      start = Number(match[1]);
      end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
      valid = Number.isSafeInteger(start) && Number.isSafeInteger(end) && start < size && start <= end;
    }
  }
  if (!valid) {
    response.writeHead(416, { ...base, 'content-range': `bytes */${size}`, 'content-length': 0 });
    return response.end();
  }
  response.writeHead(206, { ...base, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 });
  return createReadStream(file, { start, end }).pipe(response);
}
