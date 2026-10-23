import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chipThumbRequest,
  filmstripLayout,
  createLazyThumbs,
} from '../src/editor/timeline/clip-state.ts';
import type { ThumbResult } from '../src/thumbs/client.ts';

function result(tiles: number): ThumbResult {
  const list = Array.from({ length: tiles }, (_, i) => ({ t: i, x: i * 160, y: 0, w: 160, h: 90 }));
  return {
    status: 'ready',
    key: 'a'.repeat(64),
    ticketUrl: '/api/media/0123456789abcdef0123456789abcdef',
    width: tiles * 160,
    height: 90,
    tiles: list,
  } as ThumbResult;
}

test('chipThumbRequest: off -> null', () => {
  assert.equal(chipThumbRequest({ kind: 'plate' }, { mode: 'off', chipPixelWidth: 100 }), null);
  assert.equal(chipThumbRequest({ kind: 'still' }, { mode: 'off', chipPixelWidth: 100 }), null);
});

test('chipThumbRequest: still -> poster', () => {
  assert.deepEqual(chipThumbRequest({ kind: 'still' }, { mode: 'auto', chipPixelWidth: 100 }), { kind: 'poster' });
  assert.deepEqual(chipThumbRequest({ kind: 'still' }, { mode: 'filmstrip', chipPixelWidth: 100 }), { kind: 'poster' });
  assert.deepEqual(chipThumbRequest({ kind: 'still' }, { mode: 'head', chipPixelWidth: 100 }), { kind: 'poster' });
  assert.deepEqual(chipThumbRequest({ kind: 'still' }, { mode: undefined, chipPixelWidth: 100 }), { kind: 'poster' });
});

test('chipThumbRequest: plate/presenter -> filmstrip in auto or filmstrip mode', () => {
  assert.deepEqual(chipThumbRequest({ kind: 'plate' }, { mode: 'auto', chipPixelWidth: 100 }), { kind: 'filmstrip' });
  assert.deepEqual(chipThumbRequest({ kind: 'plate' }, { mode: 'filmstrip', chipPixelWidth: 100 }), { kind: 'filmstrip' });
  assert.deepEqual(chipThumbRequest({ kind: 'presenter' }, { mode: undefined, chipPixelWidth: 100 }), { kind: 'filmstrip' });
});

test('chipThumbRequest: plate/presenter -> poster in head mode', () => {
  assert.deepEqual(chipThumbRequest({ kind: 'plate' }, { mode: 'head', chipPixelWidth: 100 }), { kind: 'poster' });
  assert.deepEqual(chipThumbRequest({ kind: 'presenter' }, { mode: 'head', chipPixelWidth: 100 }), { kind: 'poster' });
});

test('filmstripLayout: non-ready -> []', () => {
  assert.deepEqual(filmstripLayout({ status: 'pending' } as ThumbResult, { chipPixelWidth: 200, chipPixelHeight: 24 }), []);
  assert.deepEqual(filmstripLayout({ status: 'none', reason: 'x' } as ThumbResult, { chipPixelWidth: 200, chipPixelHeight: 24 }), []);
});

test('filmstripLayout: tile width from server map, counts 0/2/3/8', () => {
  const r = result(12);
  // displayed tile width = 160*24/90 = 42.666...
  assert.equal(filmstripLayout(r, { chipPixelWidth: 30, chipPixelHeight: 24 }).length, 0);
  assert.equal(filmstripLayout(r, { chipPixelWidth: 100, chipPixelHeight: 24 }).length, 2);
  assert.equal(filmstripLayout(r, { chipPixelWidth: 140, chipPixelHeight: 24 }).length, 3);
  assert.equal(filmstripLayout(r, { chipPixelWidth: 360, chipPixelHeight: 24 }).length, 8);
});

test('filmstripLayout: chip height 36', () => {
  const r = result(12);
  // displayed tile width = 160*36/90 = 64
  assert.equal(filmstripLayout(r, { chipPixelWidth: 63, chipPixelHeight: 36 }).length, 0);
  assert.equal(filmstripLayout(r, { chipPixelWidth: 128, chipPixelHeight: 36 }).length, 2);
  assert.equal(filmstripLayout(r, { chipPixelWidth: 192, chipPixelHeight: 36 }).length, 3);
  assert.equal(filmstripLayout(r, { chipPixelWidth: 512, chipPixelHeight: 36 }).length, 8);
});

test('filmstripLayout: even sampling picks first and last tile', () => {
  const r = result(12);
  const cells = filmstripLayout(r, { chipPixelWidth: 360, chipPixelHeight: 24 });
  assert.equal(cells.length, 8);
  assert.equal(cells[0].tile.x, 0);
  assert.equal(cells[cells.length - 1].tile.x, 11 * 160);
});

test('filmstripLayout: backgroundPosition and backgroundSize', () => {
  const r = result(12);
  const cells = filmstripLayout(r, { chipPixelWidth: 360, chipPixelHeight: 24 });
  const scale = 24 / 90;
  assert.equal(cells[0].backgroundPosition, `-0px -0px`);
  assert.equal(cells[0].backgroundSize, `${r.width * scale}px ${r.height * scale}px`);
});

test('createLazyThumbs: no load before intersect', () => {
  const loads: unknown[] = [];
  let cb: ((entries: unknown[]) => void) | null = null;
  const factory = (callback: (entries: unknown[]) => void) => {
    cb = callback;
    return { observe() {}, unobserve() {}, disconnect() {} };
  };
  const lazy = createLazyThumbs({ observerFactory: factory, load: (el, req) => { loads.push({ el, req }); } });
  const el = { id: 1 };
  lazy.observe(el, { kind: 'poster' });
  assert.equal(loads.length, 0);
  assert.ok(cb);
  cb!([{ isIntersecting: false, target: el }]);
  assert.equal(loads.length, 0);
  cb!([{ isIntersecting: true, target: el }]);
  assert.equal(loads.length, 1);
  // second intersect does not load again
  cb!([{ isIntersecting: true, target: el }]);
  assert.equal(loads.length, 1);
});

test('createLazyThumbs: nothing after disconnect', () => {
  const loads: unknown[] = [];
  let cb: ((entries: unknown[]) => void) | null = null;
  const factory = (callback: (entries: unknown[]) => void) => {
    cb = callback;
    return { observe() {}, unobserve() {}, disconnect() {} };
  };
  const lazy = createLazyThumbs({ observerFactory: factory, load: (el, req) => { loads.push(1); } });
  const el = { id: 2 };
  lazy.observe(el, { kind: 'poster' });
  lazy.disconnect();
  cb!([{ isIntersecting: true, target: el }]);
  assert.equal(loads.length, 0);
});
