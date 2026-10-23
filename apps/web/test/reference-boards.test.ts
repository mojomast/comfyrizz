// IP57: role-labelled reference boards attachable per shot.
//
// The board surface is pure TypeScript, like the rest of the references panel:
// a controller owns durable attachment state and emits one production
// `artifact.attach` command per attach or replace, and the render helpers
// produce the board cards. No DOM, network or Google Colab call is involved.
// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REFERENCE_BOARD_LIMITS,
  ReferenceBoardController,
  buildReferenceBoardCommand,
  normalizeReferenceBoard,
  normalizeReferenceBoards,
  renderReferenceBoard,
  renderReferenceBoards,
} from '../src/references/panel.ts';

const PRODUCTION_ID = 'prod_0123456789abcdef01234567';

function entry(refId, role = 'style', overrides = {}) {
  return { refId, role, label: `Reference ${refId}`, ...overrides };
}

function board(id, overrides = {}) {
  return {
    id,
    name: `Board ${id}`,
    role: 'style',
    entries: [entry(`${id}_ref_1`, 'style'), entry(`${id}_ref_2`, 'subject')],
    ...overrides,
  };
}

function stateFixture(overrides = {}) {
  return {
    productionId: PRODUCTION_ID,
    revision: 4,
    boards: [board('board_style'), board('board_character', {
      name: 'Characters',
      role: 'character',
      entries: [entry('ref_actor', 'character')],
    })],
    attachments: [],
    shots: ['shot_1', 'shot_2'],
    loading: false,
    stale: false,
    message: '',
    messageError: false,
    pending: [],
    ...overrides,
  };
}

function idSequence(...values) {
  let index = 0;
  return () => {
    const value = values[index % values.length];
    index += 1;
    return value;
  };
}

function fakeSender(handler) {
  const calls = [];
  return {
    calls,
    async send(command) {
      calls.push(command);
      if (handler) return handler(command, calls.length);
      return { revision: command.expected.productionRevision + 1 };
    },
  };
}

test('normalizeReferenceBoard canonicalises roles, entries and names', () => {
  const normalized = normalizeReferenceBoard({
    id: 'board_1',
    name: '  Look and feel  ',
    role: 'style',
    entries: [
      { refId: 'ref_a', role: 'style', label: 'Grain' },
      { refId: 'ref_b' },
      'ref_c',
      { refId: 'ref_a', role: 'composition', note: 'Last one wins' },
      { refId: '', role: 'style' },
      { refId: 'ref_d', role: 'not-a-role' },
    ],
  });

  assert.equal(normalized.id, 'board_1');
  assert.equal(normalized.name, 'Look and feel');
  assert.equal(normalized.role, 'style');
  assert.deepEqual(
    normalized.entries.map(item => [item.refId, item.role]),
    [['ref_a', 'composition'], ['ref_b', 'style'], ['ref_c', 'style'], ['ref_d', 'other']],
  );
  assert.equal(normalized.entries[0].note, 'Last one wins');
  assert.equal(normalized.entries[2].label, undefined);
});

test('normalizeReferenceBoard defaults a missing role and clamps long names', () => {
  const normalized = normalizeReferenceBoard({
    id: 'board_2',
    name: 'x'.repeat(200),
    role: 'unknown',
    entries: ['ref_1'],
  });
  assert.equal(normalized.role, 'other');
  assert.equal(normalized.entries[0].role, 'other');
  assert.equal(normalized.name.length, REFERENCE_BOARD_LIMITS.nameMaxChars);
});

test('normalizeReferenceBoard rejects a board without a stable id or name', () => {
  assert.throws(() => normalizeReferenceBoard({ id: '', name: 'No id' }), /board id/);
  assert.throws(() => normalizeReferenceBoard({ id: 'board_3', name: '   ' }), /board name/);
  assert.throws(() => normalizeReferenceBoard(null), /board/i);
});

test('normalizeReferenceBoards drops invalid boards and duplicate ids', () => {
  const boards = normalizeReferenceBoards([
    board('board_1'),
    null,
    { id: '', name: 'broken' },
    board('board_1', { name: 'Newer name' }),
    board('board_2'),
  ]);
  assert.deepEqual(boards.map(item => item.id), ['board_1', 'board_2']);
  assert.equal(boards[0].name, 'Newer name');
});

test('buildReferenceBoardCommand emits one closed-vocabulary artifact.attach command', () => {
  const command = buildReferenceBoardCommand({
    productionId: PRODUCTION_ID,
    productionRevision: 7,
    shotId: 'shot_2',
    board: board('board_style'),
    mode: 'attach',
    commandId: 'cmd_1',
    idempotencyKey: 'idem_1',
    replaces: [],
  });

  assert.equal(command.kind, 'artifact.attach');
  assert.equal(command.productionId, PRODUCTION_ID);
  assert.equal(command.commandId, 'cmd_1');
  assert.equal(command.idempotencyKey, 'idem_1');
  assert.deepEqual(command.expected, { productionRevision: 7 });
  assert.equal(command.payload.artifactKind, 'conditioning');
  assert.equal(command.payload.mode, 'attach');
  assert.equal(command.payload.shotId, 'shot_2');
  assert.equal(command.payload.boardId, 'board_style');
  assert.equal(command.payload.role, 'style');
  assert.deepEqual(command.payload.references, [
    { refId: 'board_style_ref_1', role: 'style' },
    { refId: 'board_style_ref_2', role: 'subject' },
  ]);
  assert.deepEqual(command.payload.replaces, []);
  // Attribution is server-owned, so a client envelope must never assert it.
  assert.equal(Object.hasOwn(command, 'actor'), false);
  assert.equal(Object.hasOwn(command, 'userEventId'), false);
});

test('attach emits the command once with a stable base revision and records the attachment', async () => {
  const sender = fakeSender(() => ({ revision: 5 }));
  const controller = new ReferenceBoardController({
    productionId: PRODUCTION_ID,
    revision: 4,
    boards: [board('board_style')],
    shots: ['shot_1'],
    sendCommand: command => sender.send(command),
    randomId: idSequence('attach1'),
  });

  const result = await controller.attachBoard('shot_1', 'board_style');

  assert.equal(result.ok, true);
  assert.equal(result.code, undefined);
  assert.equal(sender.calls.length, 1);
  const command = sender.calls[0];
  assert.equal(command.kind, 'artifact.attach');
  assert.equal(command.commandId, 'cmd_attach1');
  assert.equal(command.idempotencyKey, 'idem_attach1');
  assert.equal(command.expected.productionRevision, 4);
  assert.equal(command.payload.mode, 'attach');
  assert.equal(command.payload.shotId, 'shot_1');
  assert.equal(command.payload.boardId, 'board_style');

  const state = controller.getState();
  assert.equal(state.revision, 5, 'the command result advances the base revision');
  assert.deepEqual(state.attachments, [{
    shotId: 'shot_1',
    boardId: 'board_style',
    role: 'style',
    revision: 5,
    commandId: 'cmd_attach1',
  }]);
  assert.deepEqual(state.pending, []);
  assert.match(state.message, /Attached Board board_style to shot_1/);
});

test('attach is idempotent while the board is already on that shot', async () => {
  const sender = fakeSender();
  const controller = new ReferenceBoardController({
    productionId: PRODUCTION_ID,
    revision: 1,
    boards: [board('board_style')],
    attachments: [{ shotId: 'shot_1', boardId: 'board_style', role: 'style' }],
    sendCommand: command => sender.send(command),
    randomId: idSequence('dup'),
  });

  const result = await controller.attach('shot_1', 'board_style');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'ALREADY_ATTACHED');
  assert.equal(sender.calls.length, 0);
  assert.equal(controller.getState().attachments.length, 1);
});

test('replace emits mode replace and swaps only the same role on that shot', async () => {
  const sender = fakeSender(() => ({ revision: 8 }));
  const controller = new ReferenceBoardController({
    productionId: PRODUCTION_ID,
    revision: 7,
    boards: [
      board('board_style'),
      board('board_style_v2', { name: 'New look', role: 'style' }),
      board('board_character', { name: 'Characters', role: 'character' }),
    ],
    attachments: [
      { shotId: 'shot_1', boardId: 'board_style', role: 'style', revision: 7 },
      { shotId: 'shot_1', boardId: 'board_character', role: 'character', revision: 7 },
      { shotId: 'shot_2', boardId: 'board_style', role: 'style', revision: 7 },
    ],
    shots: ['shot_1', 'shot_2'],
    sendCommand: command => sender.send(command),
    randomId: idSequence('replace1'),
  });

  const result = await controller.replaceBoard('shot_1', 'board_style_v2');

  assert.equal(result.ok, true);
  assert.equal(sender.calls.length, 1);
  const command = sender.calls[0];
  assert.equal(command.payload.mode, 'replace');
  assert.deepEqual(command.payload.replaces, ['board_style']);
  assert.equal(command.payload.role, 'style');

  const state = controller.getState();
  assert.deepEqual(
    state.attachments.map(item => [item.shotId, item.boardId, item.role]),
    [
      ['shot_1', 'board_character', 'character'],
      ['shot_2', 'board_style', 'style'],
      ['shot_1', 'board_style_v2', 'style'],
    ],
  );
  assert.match(state.message, /Replaced the style board on shot_1 with New look/);
});

test('a failed command reports an error, keeps prior attachments and retries with a new key', async () => {
  let attempt = 0;
  const sender = fakeSender(() => {
    attempt += 1;
    if (attempt === 1) throw new Error('the server rejected the command');
    return { revision: 3 };
  });
  const controller = new ReferenceBoardController({
    productionId: PRODUCTION_ID,
    revision: 2,
    boards: [board('board_style')],
    attachments: [{ shotId: 'shot_1', boardId: 'board_style', role: 'style', revision: 2 }],
    sendCommand: command => sender.send(command),
    randomId: idSequence('fail1', 'fail2'),
  });

  const failed = await controller.replaceBoard('shot_1', 'board_style');
  assert.equal(failed.ok, false);
  assert.match(failed.error, /server rejected/);
  let state = controller.getState();
  assert.equal(state.messageError, true);
  assert.deepEqual(state.attachments.map(item => item.boardId), ['board_style']);
  assert.deepEqual(state.pending, []);

  const retried = await controller.replaceBoard('shot_1', 'board_style');
  assert.equal(retried.ok, true);
  assert.equal(sender.calls.length, 2);
  assert.notEqual(sender.calls[0].idempotencyKey, sender.calls[1].idempotencyKey);
  state = controller.getState();
  assert.equal(state.revision, 3);
  assert.equal(state.messageError, false);
});

test('a revision conflict adopts the server revision and marks the boards stale', async () => {
  const sender = fakeSender(() => {
    const error = new Error('baseRevision does not match the committed revision');
    error.status = 409;
    error.code = 'REVISION_CONFLICT';
    error.currentRevision = 12;
    throw error;
  });
  const controller = new ReferenceBoardController({
    productionId: PRODUCTION_ID,
    revision: 4,
    boards: [board('board_style')],
    shots: ['shot_1'],
    sendCommand: command => sender.send(command),
    randomId: idSequence('stale1'),
  });

  const result = await controller.attachBoard('shot_1', 'board_style');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'REVISION_CONFLICT');
  const state = controller.getState();
  assert.equal(state.revision, 12);
  assert.equal(state.stale, true);
  assert.equal(state.messageError, true);
});

test('concurrent attach for the same shot and board sends one command', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const sender = fakeSender(async command => {
    await gate;
    return { revision: command.expected.productionRevision + 1 };
  });
  const controller = new ReferenceBoardController({
    productionId: PRODUCTION_ID,
    revision: 1,
    boards: [board('board_style')],
    sendCommand: command => sender.send(command),
    randomId: idSequence('race1'),
  });

  const first = controller.attachBoard('shot_1', 'board_style');
  const second = await controller.attachBoard('shot_1', 'board_style');
  assert.equal(second.ok, false);
  assert.equal(second.code, 'IN_PROGRESS');
  assert.equal(sender.calls.length, 1);
  release();
  assert.equal((await first).ok, true);
  assert.equal(controller.getState().attachments.length, 1);
});

test('unknown boards and blank shots are refused before a command is sent', async () => {
  const sender = fakeSender();
  const controller = new ReferenceBoardController({
    productionId: PRODUCTION_ID,
    boards: [board('board_style')],
    sendCommand: command => sender.send(command),
    randomId: idSequence('refuse'),
  });

  const missing = await controller.attachBoard('shot_1', 'board_missing');
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'UNKNOWN_BOARD');
  const blank = await controller.attachBoard('   ', 'board_style');
  assert.equal(blank.ok, false);
  assert.equal(blank.code, 'INVALID_SHOT');
  assert.equal(sender.calls.length, 0);
});

test('setBoards and setShots refresh the view without losing attachments', () => {
  const controller = new ReferenceBoardController({
    productionId: PRODUCTION_ID,
    boards: [board('board_style')],
    attachments: [{ shotId: 'shot_1', boardId: 'board_style', role: 'style' }],
    sendCommand: async () => ({}),
  });
  controller.setBoards([board('board_style', { name: 'Renamed' }), board('board_2')]);
  controller.setShots(['shot_1', 'shot_2']);
  const state = controller.getState();
  assert.deepEqual(state.boards.map(item => item.name), ['Renamed', 'Board board_2']);
  assert.deepEqual(state.shots, ['shot_1', 'shot_2']);
  assert.equal(state.attachments.length, 1);
});

test('renderReferenceBoard shows the role label and escapes board content', () => {
  const html = renderReferenceBoard({
    id: 'board_1',
    name: '<Look>',
    role: 'style',
    entries: [
      { refId: 'ref_1', role: 'style', label: 'Grain & light' },
      { refId: 'ref_2', role: 'character', label: 'Hero' },
    ],
  });

  assert.match(html, /data-reference-board="board_1"/);
  assert.match(html, /data-board-role="style"/);
  assert.match(html, /data-board-role-label[^>]*>Style</);
  assert.match(html, /&lt;Look&gt;/);
  assert.doesNotMatch(html, /<Look>/);
  assert.match(html, /data-board-ref="ref_1"/);
  assert.match(html, /data-board-ref-role="style"/);
  assert.match(html, /data-board-ref-role="character"/);
  assert.match(html, /Grain &amp; light/);
});

test('renderReferenceBoards renders per-shot attach and replace controls', () => {
  const html = renderReferenceBoards(stateFixture({
    attachments: [{ shotId: 'shot_1', boardId: 'board_style', role: 'style' }],
  }), { shots: ['shot_1', 'shot_2'] });

  assert.match(html, /data-reference-boards/);
  assert.match(html, /data-board-shot="shot_1"/);
  assert.match(html, /data-board-shot="shot_2"/);
  assert.match(html, /data-board-attach[^>]*data-shot-id="shot_1"[^>]*data-board-id="board_character"/);
  assert.match(html, /data-board-replace[^>]*data-shot-id="shot_1"[^>]*data-board-id="board_character"/);
  assert.match(html, /aria-label="Attach Characters to shot_2"/);
  assert.match(html, /aria-label="Replace the character board on shot_1 with Characters"/);
  assert.match(html, /data-board-attached="board_style"/);
  assert.match(html, /data-board-attachment-role="style"/);
});

test('renderReferenceBoards has loading, error, stale and empty states', () => {
  const loading = renderReferenceBoards({ ...stateFixture(), loading: true });
  assert.match(loading, /data-board-state="loading"/);
  assert.match(loading, /role="status"/);

  const error = renderReferenceBoards({
    ...stateFixture(),
    message: 'Could not load boards',
    messageError: true,
  });
  assert.match(error, /data-board-state="error"/);
  assert.match(error, /role="alert"/);
  assert.match(error, /Could not load boards/);

  const stale = renderReferenceBoards(stateFixture({ stale: true }), { shots: ['shot_1'] });
  assert.match(stale, /data-board-stale="true"/);
  assert.match(stale, /Boards are stale/);

  const empty = renderReferenceBoards({ ...stateFixture(), boards: [] });
  assert.match(empty, /data-board-state="empty"/);
  assert.match(empty, /No reference boards yet/);
});

test('the controller subscribes, notifies and stops after destroy', async () => {
  const changes = [];
  const controller = new ReferenceBoardController({
    productionId: PRODUCTION_ID,
    boards: [board('board_style')],
    sendCommand: async command => ({ revision: command.expected.productionRevision + 1 }),
    randomId: idSequence('sub1'),
    onChange: (state, change) => changes.push([change, state.attachments.length]),
  });
  const seen = [];
  const unsubscribe = controller.subscribe((state, change) => seen.push([change, state.revision]));

  await controller.attachBoard('shot_1', 'board_style');
  assert.ok(changes.some(([kind]) => kind === 'attachments'));
  assert.ok(seen.some(([kind]) => kind === 'attachments'));

  unsubscribe();
  controller.destroy();
  const before = seen.length;
  await controller.attachBoard('shot_1', 'board_style');
  assert.equal(seen.length, before);
});
