import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.mjs';
import { LONG_MEDIA_BYTES, peaksFromRangedWav } from '../../web/src/editor/media/range-reader.ts';

const TOKEN = 'test-token-0123456789abcdef';

function wavPcm(bytesOfData) {
  const data = Buffer.alloc(bytesOfData);
  for (let index = 0; index < data.length; index += 2) data.writeInt16LE((index % 200) - 100, index);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(8000, 24);
  header.writeUInt32LE(16000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

test('byte-range media uses a ticket, not the API token, and does not load a long file at once', async () => {
  const runtime = mkdtempSync(join(tmpdir(), 'media-range-'));
  const mediaRoot = join(runtime, 'media');
  mkdirSync(join(mediaRoot, 'audio'), { recursive: true });
  const file = wavPcm(LONG_MEDIA_BYTES + 4096);
  writeFileSync(join(mediaRoot, 'audio', 'long.wav'), file);
  const app = createApp({
    token: TOKEN,
    runtimeDir: runtime,
    mediaRoot,
    render: async () => ({ output: 'x', bytes: 0, frames: 0, hash: 'x' }),
  });
  const server = createServer(app.handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  try {
    const denied = await fetch(`${origin}/api/media-ticket`, {
      method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ path: 'audio/long.wav' }),
    });
    assert.equal(denied.status, 401);
    const minted = await fetch(`${origin}/api/media-ticket`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json', 'x-comfyrizz-token': TOKEN },
      body: JSON.stringify({ path: 'audio/long.wav' }),
    });
    const body = await minted.json();
    assert.equal(minted.status, 200);
    assert.equal(JSON.stringify(body).includes(TOKEN), false);
    assert.equal(body.url.includes('token'), false);
    const escaped = await fetch(`${origin}/api/media-ticket`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json', 'x-comfyrizz-token': TOKEN },
      body: JSON.stringify({ path: '../secret.wav' }),
    });
    assert.equal(escaped.status, 400);
    const url = `${origin}${body.url}`;
    const result = await peaksFromRangedWav({
      size: file.length,
      sourceHash: 'server-long',
      buckets: 8,
      read: async (start, end) => {
        const response = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } });
        assert.equal(response.status, 206);
        const bytes = new Uint8Array(await response.arrayBuffer());
        assert.ok(bytes.byteLength < file.length);
        assert.equal(Buffer.from(bytes).includes(Buffer.from(TOKEN)), false);
        return bytes;
      },
    });
    assert.ok(result.ranges.length > 1);
    assert.equal(result.sampleRate, 8000);
  } finally {
    app.close();
    await new Promise(resolve => server.close(resolve));
    rmSync(runtime, { recursive: true, force: true });
  }
});
