import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as mediaRange from '../src/media-range.mjs';

const { createMediaTickets, mediaIdFor } = mediaRange;

function workspace() {
  return mkdtempSync(join(tmpdir(), 'media-ticket-'));
}

function audioFile(dir, name = 'take.wav') {
  mkdirSync(join(dir, 'audio'), { recursive: true });
  const file = join(dir, 'audio', name);
  writeFileSync(file, 'not-a-real-wav');
  return file;
}

test('mediaIdFor is stable, opaque, and derived from the identity string', () => {
  assert.equal(mediaIdFor('art_123'), mediaIdFor('art_123'));
  assert.notEqual(mediaIdFor('art_123'), mediaIdFor('art_124'));
  assert.match(mediaIdFor('art_123'), /^med_[a-f0-9]{32}$/);
  assert.match(mediaIdFor('/tmp/example.wav'), /^med_[a-f0-9]{32}$/);
  assert.throws(() => mediaIdFor(''), TypeError);
});

test('mint is keyed by artifact id and resolve only accepts a live ticket', () => {
  const dir = workspace();
  try {
    const file = audioFile(dir);
    let clock = 1_000_000;
    const tickets = createMediaTickets({ ttlMs: 5_000, now: () => clock });
    const minted = tickets.mint(file, { artifactId: 'art_live' });

    assert.equal(minted.artifactId, 'art_live');
    assert.equal(minted.mediaId, mediaIdFor('art_live'));
    assert.equal(minted.expiresAt, new Date(clock + 5_000).toISOString());
    assert.match(minted.ticket, /^[a-f0-9]{32}$/);
    assert.equal(minted.url, `/api/media/${minted.ticket}`);
    assert.equal(tickets.resolve(minted.ticket), file);

    const active = tickets.inspect(minted.ticket);
    assert.equal(active.status, 'active');
    assert.equal(active.mediaId, minted.mediaId);
    assert.equal(active.artifactId, 'art_live');
    assert.equal(active.expiresAt, minted.expiresAt);
    assert.equal(active.file, file);

    assert.equal(tickets.resolve('0'.repeat(32)), null);
    assert.deepEqual(tickets.inspect('0'.repeat(32)), { status: 'unknown' });

    clock += 5_000;
    assert.equal(tickets.resolve(minted.ticket), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an expired ticket is refused, inspected as expired metadata, and cannot mint another', () => {
  const dir = workspace();
  try {
    const file = audioFile(dir);
    let clock = 2_000_000;
    const tickets = createMediaTickets({ ttlMs: 1_000, now: () => clock });
    const minted = tickets.mint(file, { artifactId: 'art_expired' });

    clock += 1_001;
    assert.equal(tickets.resolve(minted.ticket), null);

    const second = tickets.mint(file, { artifactId: 'art_expired' });
    clock += 1_001;
    const expired = tickets.inspect(second.ticket);
    assert.deepEqual(expired, {
      status: 'expired',
      mediaId: second.mediaId,
      artifactId: 'art_expired',
      expiresAt: second.expiresAt,
    });
    assert.equal('file' in expired, false);
    assert.equal(tickets.resolve(second.ticket), null);

    assert.equal(tickets.remintForArtifact(second.ticket), null);
    assert.equal(tickets.remintForArtifact(minted.ticket), null);

    for (const removed of ['resolveTicket', 'refresh', 'remint', 'remintTicket', 'remintByArtifact']) {
      assert.equal(typeof tickets[removed], 'undefined', `${removed} must not be part of the API`);
    }
    assert.equal(typeof mediaRange.stableMediaId, 'undefined');
    assert.equal(typeof mediaRange.resolveOrRemint, 'undefined');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('remintForArtifact works after restart and never persists bearer tokens', () => {
  const dir = workspace();
  try {
    const file = audioFile(dir);
    const stateFile = join(dir, 'runtime', 'media-index.json');
    let clock = 3_000_000;

    const first = createMediaTickets({ stateFile, ttlMs: 60_000, now: () => clock });
    const minted = first.mint(file, { artifactId: 'art_restart' });
    first.close();

    const persisted = readFileSync(stateFile, 'utf8');
    assert.equal(persisted.includes(minted.ticket), false);
    assert.equal(persisted.includes('"ticket"'), false);
    const rows = JSON.parse(persisted);
    assert.equal(rows.media.length, 1);
    assert.equal(rows.media[0].mediaId, minted.mediaId);
    assert.equal(rows.media[0].artifactId, 'art_restart');
    assert.equal(rows.media[0].file, file);
    assert.equal(statSync(stateFile).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(join(dir, 'runtime')), ['media-index.json']);

    clock += 10;
    const second = createMediaTickets({ stateFile, ttlMs: 60_000, now: () => clock });
    const again = second.remintForArtifact('art_restart');
    assert.ok(again);
    assert.equal(again.artifactId, 'art_restart');
    assert.equal(again.mediaId, minted.mediaId);
    assert.notEqual(again.ticket, minted.ticket);
    assert.equal(second.resolve(again.ticket), file);

    const byMediaId = second.remintForArtifact(minted.mediaId);
    assert.equal(byMediaId.mediaId, minted.mediaId);
    assert.equal(second.resolve(byMediaId.ticket), file);

    assert.equal(second.remintForArtifact('art_missing'), null);

    const persistedAgain = readFileSync(stateFile, 'utf8');
    assert.equal(persistedAgain.includes(minted.ticket), false);
    assert.equal(persistedAgain.includes(again.ticket), false);
    assert.equal(JSON.parse(persistedAgain).media.length, 1);
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the persisted identity index stays bounded to one row per mediaId', () => {
  const dir = workspace();
  try {
    const file = audioFile(dir);
    const stateFile = join(dir, 'media-index.json');
    const tickets = createMediaTickets({ stateFile });
    for (let index = 0; index < 5; index += 1) {
      const minted = tickets.mint(file, { artifactId: 'art_same' });
      assert.equal(minted.mediaId, mediaIdFor('art_same'));
    }
    tickets.mint(file);
    tickets.close();

    const rows = JSON.parse(readFileSync(stateFile, 'utf8')).media;
    assert.equal(rows.length, 2);
    const ids = rows.map(row => row.mediaId);
    assert.equal(new Set(ids).size, ids.length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('no stateFile keeps tickets in memory and writes nothing to tmpdir', () => {
  const sandbox = workspace();
  const previousTmpdir = process.env.TMPDIR;
  try {
    const file = audioFile(sandbox);
    process.env.TMPDIR = sandbox;
    const tickets = createMediaTickets();
    const minted = tickets.mint(file, { artifactId: 'art_memory' });
    assert.equal(tickets.resolve(minted.ticket), file);
    assert.equal(minted.mediaId, mediaIdFor('art_memory'));
    tickets.close();
    assert.deepEqual(readdirSync(sandbox), ['audio']);
  } finally {
    if (previousTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmpdir;
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('the in-memory form still mints by file alone for existing callers', () => {
  const dir = workspace();
  try {
    const file = audioFile(dir);
    const tickets = createMediaTickets();
    const minted = tickets.mint(file);
    assert.equal(minted.artifactId, null);
    assert.equal(minted.mediaId, mediaIdFor(file));
    assert.equal(tickets.resolve(minted.ticket), file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
