import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serveStaticFile } from '../src/static-file.mjs';

test('video previews support byte, suffix and open ranges with honest HTTP lengths', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'static-range-'));
  const file = join(dir, 'video.mp4');
  writeFileSync(file, '0123456789');
  const server = createServer((req, res) => serveStaticFile(req, res, file, { 'content-type': 'video/mp4' }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); rmSync(dir, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${server.address().port}/video.mp4`;
  for (const [range, body, contentRange] of [['bytes=2-5','2345','bytes 2-5/10'],['bytes=-3','789','bytes 7-9/10'],['bytes=8-','89','bytes 8-9/10']]) {
    const r = await fetch(url, { headers: { range } });
    assert.equal(r.status, 206);
    assert.equal(r.headers.get('content-range'), contentRange);
    assert.equal(r.headers.get('content-length'), String(body.length));
    assert.equal(await r.text(), body);
  }
  for (const range of ['bytes=10-', 'bytes=5-2', 'bytes=-0', 'bytes=a-b']) {
    const r = await fetch(url, { headers: { range } });
    assert.equal(r.status, 416);
    assert.equal(r.headers.get('content-range'), 'bytes */10');
    assert.equal(await r.text(), '');
  }
  const head = await fetch(url, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), '10');
  assert.equal(await head.text(), '');
});
