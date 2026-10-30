// The web package typecheck includes src/**/*.ts but does not depend on
// @types/node; these node:test-only imports are therefore not typechecked.
// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ACCEPT_ATTRIBUTE,
  LIMITS,
  ReferencePanelController,
  formatDuration,
  formatFileSize,
  precheckFile,
  renderPendingUploads,
  renderReferencePanel,
  type Reference,
  type ReferenceApi,
  type ReferenceAssignment,
  type ReferenceUploadFile,
  type UploadOptions,
} from './panel.ts';

const MB = 1024 * 1024;

function reference(id: string, overrides: Partial<Reference> = {}): Reference {
  return {
    id,
    kind: 'image',
    label: `File ${id}`,
    note: '',
    role: 'other',
    bytes: 1024,
    ...overrides,
  };
}

function file(name: string, type: string, size: number): ReferenceUploadFile {
  return { name, type, size };
}

type FakeOptions = {
  references?: Reference[];
  assignments?: ReferenceAssignment[];
  questions?: Record<string, string>;
  uploadFile?: (
    file: ReferenceUploadFile,
    options: UploadOptions | undefined,
    call: number,
  ) => Promise<Reference>;
};

function fakeApi(options: FakeOptions = {}) {
  const references = (options.references ?? []).map(item => ({ ...item }));
  const assignments = (options.assignments ?? []).map(item => ({ ...item }));
  const calls = {
    lists: 0,
    uploads: [] as string[],
    patches: [] as { id: string; patch: { role?: string; note?: string; label?: string } }[],
    deletes: [] as string[],
  };
  let uploads = 0;
  const api: ReferenceApi = {
    async list() {
      calls.lists += 1;
      return {
        references: references.map(item => ({ ...item })),
        assignments: assignments.map(item => ({ ...item })),
        questions: options.questions,
      };
    },
    async upload(item, uploadOptions) {
      calls.uploads.push(item.name);
      uploads += 1;
      if (options.uploadFile) return options.uploadFile(item, uploadOptions, uploads);
      const record = reference(`ref_${uploads}`, {
        kind: item.type?.startsWith('video/') ? 'video' : 'image',
        label: item.name,
        mime: item.type,
        bytes: item.size,
        note: '',
        role: 'other',
      });
      references.push(record);
      return { ...record };
    },
    async patch(id, patch) {
      calls.patches.push({ id, patch });
      const current = references.find(item => item.id === id);
      if (!current) throw new Error('reference not found');
      Object.assign(current, patch, { revision: (current.revision ?? 1) + 1 });
      return { ...current };
    },
    async delete(id) {
      calls.deletes.push(id);
      const index = references.findIndex(item => item.id === id);
      if (index >= 0) references.splice(index, 1);
    },
  };
  return { api, calls, references, assignments };
}

test('multiple files queue together and each rejected file reports its own error', async () => {
  const fake = fakeApi();
  const controller = new ReferencePanelController({ api: fake.api });

  const results = controller.queueFiles([
    file('texture.png', 'image/png', 4096),
    file('huge.png', 'image/png', 21 * MB),
    file('notes.txt', 'text/plain', 10),
    file('pour.mp4', 'video/mp4', 8192),
  ]);

  assert.deepEqual(results.map(result => result.ok), [true, false, false, true]);
  assert.equal(results[1]?.code, 'TOO_LARGE');
  assert.match(results[1]!.error!, /too large: 21 MB, images max 20 MB/);
  assert.equal(results[2]?.code, 'UNSUPPORTED_TYPE');
  assert.match(results[2]!.error!, /PNG, JPEG, WEBP, GIF, MP4, MOV or WEBM/);

  const errors = controller.getState().pending.filter(entry => entry.status === 'error');
  assert.deepEqual(errors.map(entry => entry.name), ['huge.png', 'notes.txt']);
  assert.equal(errors[0]?.error, results[1]?.error);

  await controller.settle();
  const state = controller.getState();
  assert.deepEqual(fake.calls.uploads, ['texture.png', 'pour.mp4']);
  assert.deepEqual(state.references.map(item => item.id).sort(), ['ref_1', 'ref_2']);
  assert.equal(state.pending.filter(entry => entry.status === 'error').length, 2, 'rejected files stay visible per file');
  assert.equal(state.pending.filter(entry => entry.status !== 'error').length, 0);

  const html = renderPendingUploads(state.pending);
  assert.match(html, /huge\.png/);
  assert.match(html, /notes\.txt/);
  assert.match(html, /role="alert"/);
});

test('each upload reports its own progress and only succeeds on its own record', async () => {
  let release: (value: Reference) => void = () => {};
  let report: ((progress: number | { loaded: number; total: number }) => void) | undefined;
  const fake = fakeApi();
  fake.api.upload = (item, options) => {
    report = options?.onProgress;
    return new Promise<Reference>(resolve => {
      release = value => resolve({ ...value, label: item.name });
    });
  };
  const controller = new ReferencePanelController({ api: fake.api });

  controller.queueFiles([file('clip.mp4', 'video/mp4', 2048)]);
  const uploading = controller.getState().pending[0];
  assert.equal(uploading?.status, 'uploading');

  report?.(0.5);
  assert.equal(controller.getState().pending[0]?.progress, 0.5);
  report?.({ loaded: 9, total: 10 });
  assert.equal(controller.getState().pending[0]?.progress, 0.9);

  release(reference('ref_progress', { kind: 'video', label: 'clip.mp4', durationSec: 8 }));
  await controller.settle();
  const state = controller.getState();
  assert.equal(state.pending.length, 0);
  assert.equal(state.references[0]?.id, 'ref_progress');
  assert.equal(state.references[0]?.durationSec, 8);
});

test('a note edit patches exactly once on blur and leaves other references alone', async () => {
  const fake = fakeApi({
    references: [
      reference('ref_a', { note: 'old note', role: 'style' }),
      reference('ref_b', { note: 'keep me', role: 'product' }),
    ],
  });
  const controller = new ReferencePanelController({ api: fake.api });
  await controller.load();

  const changed = await controller.saveNote('ref_a', 'new note');
  assert.equal(changed, true);
  assert.deepEqual(fake.calls.patches, [{ id: 'ref_a', patch: { note: 'new note' } }]);

  await controller.saveNote('ref_a', 'new note');
  assert.equal(fake.calls.patches.length, 1, 'an unchanged note is not patched again');

  const state = controller.getState();
  assert.equal(state.references.find(item => item.id === 'ref_a')?.note, 'new note');
  assert.equal(state.references.find(item => item.id === 'ref_b')?.note, 'keep me');
  assert.equal(state.references.find(item => item.id === 'ref_b')?.role, 'product');
});

test('notes are capped at 1000 characters before they reach the API', async () => {
  const fake = fakeApi({ references: [reference('ref_cap', { note: '' })] });
  const controller = new ReferencePanelController({ api: fake.api });
  await controller.load();
  await controller.saveNote('ref_cap', 'x'.repeat(1200));
  assert.equal(fake.calls.patches[0]?.patch.note?.length, 1000);
  assert.equal(controller.getState().references[0]?.note.length, 1000);
});

test('delete asks for confirmation first and removes only that reference and its assignments', async () => {
  const fake = fakeApi({
    references: [
      reference('ref_a', { label: 'Brand texture' }),
      reference('ref_b', { label: 'Grinder' }),
    ],
    assignments: [
      { refId: 'ref_a', sceneId: 's1', sceneNumber: 1, slot: 'style_reference', status: 'confirmed' },
      { refId: 'ref_b', sceneId: 's2', sceneNumber: 2, slot: 'subject_reference', status: 'confirmed' },
    ],
  });
  const messages: string[] = [];
  let answer = false;
  const controller = new ReferencePanelController({
    api: fake.api,
    confirm: message => {
      messages.push(message);
      return answer;
    },
  });
  await controller.load();

  assert.equal(await controller.deleteReference('ref_a'), false);
  assert.equal(fake.calls.deletes.length, 0, 'nothing is deleted without confirmation');
  assert.match(messages[0] ?? '', /Brand texture/);

  answer = true;
  assert.equal(await controller.deleteReference('ref_a'), true);
  assert.deepEqual(fake.calls.deletes, ['ref_a']);
  const state = controller.getState();
  assert.deepEqual(state.references.map(item => item.id), ['ref_b']);
  assert.deepEqual(state.assignments.map(item => item.refId), ['ref_b']);
  assert.deepEqual(controller.assignmentsFor('ref_a'), []);
  assert.equal(controller.assignmentsFor('ref_b').length, 1);
});

test('a video card shows its duration badge and uses the label as alt text', () => {
  const video = reference('ref_video', {
    kind: 'video',
    label: 'Push-in.mp4',
    durationSec: 8,
    role: 'motion',
    thumbUrl: '/api/chat/chat_abc/references/ref_video/thumb',
  });
  const image = reference('ref_image', {
    id: 'ref_image',
    label: 'Brand texture',
    role: 'style',
    note: 'Warm grain',
    thumbUrl: '/api/chat/chat_abc/references/ref_image/thumb',
  });
  const html = renderReferencePanel({
    references: [video, image],
    assignments: [
      { refId: 'ref_image', sceneId: 's2', sceneNumber: 2, slot: 'style_reference', status: 'confirmed' },
    ],
    pending: [],
    questions: {},
    message: '',
    messageError: false,
    loading: false,
  });

  assert.match(html, /class="ref-duration"[^>]*>0:08</);
  assert.match(html, /data-duration="0:08"/);
  assert.ok(!/<img[^>]+src="\/api\//.test(html), 'authed thumbs never render as a bare img src');
  assert.match(html, /data-ref-thumb="\/api\/chat\/chat_abc\/references\/ref_video\/thumb"[^>]*data-ref-id="ref_video"/);
  assert.match(html, /data-ref-thumb="\/api\/chat\/chat_abc\/references\/ref_image\/thumb"[^>]*aria-label="Brand texture"/);
  assert.match(html, /Scene 2 \/ style reference/);
  assert.match(html, /Warm grain/);
  assert.match(html, /data-note-ref="ref_image"[^>]*maxlength="1000"/);
  assert.match(html, /10 \/ 1000/);
  assert.equal(html.match(/<option /g)?.length, 20, 'both cards offer the full role list');

  assert.equal(formatDuration(8), '0:08');
  assert.equal(formatDuration(65), '1:05');
  assert.equal(formatDuration(3661), '1:01:01');
});

test('an audio card shows song role and duration without a fake image', () => {
  const song = reference('ref_song', {
    kind: 'audio', label: 'Master.mp3', role: 'song', durationSec: 212.5,
    thumbUrl: '/api/chat/chat_abc/references/ref_song/thumb',
  });
  const html = renderReferencePanel({
    references: [song], assignments: [], pending: [], questions: {}, message: '', messageError: false, loading: false,
  });
  assert.match(html, /ref-thumb-audio[^>]*>Audio</u);
  assert.match(html, /data-duration="3:33"/u);
  assert.match(html, /Audio · 3:33/u);
  assert.match(html, /<option value="song" selected>Song<\/option>/u);
  assert.doesNotMatch(html, /<img/iu);
  assert.doesNotMatch(html, /data-ref-thumb=/u);
});

test('the agent question badge and upload errors render with escaped user text', () => {
  const dirty = reference('ref_x', {
    label: '<img src=x onerror="alert(1)">',
    note: '<script>alert(1)</script>',
    needsAnswer: true,
  });
  const html = renderReferencePanel({
    references: [dirty],
    assignments: [],
    pending: [{
      key: 'upload_1',
      name: '<b>bad.png</b>',
      file: file('<b>bad.png</b>', 'image/png', 1),
      status: 'error',
      progress: 0,
      error: '<svg onload=alert(1)>',
    }],
    questions: {},
    message: '',
    messageError: false,
    loading: false,
  });

  assert.match(html, /agent has a question/);
  assert.match(html, /data-question-ref="ref_x"/);
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(!html.includes('<img src=x'));
  assert.ok(!html.includes('<b>bad.png</b>'));
  assert.ok(!html.includes('<svg onload'));
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&lt;b&gt;bad\.png&lt;\/b&gt;/);
  assert.match(html, /role="alert"/);
});

test('the drop zone is a keyboard-operable button and the picker accepts multiple files', () => {
  const html = renderReferencePanel({
    references: [],
    assignments: [],
    pending: [],
    questions: {},
    message: '',
    messageError: false,
    loading: false,
  });
  assert.match(html, /<button type="button" class="ref-dropzone" data-ref-pick/);
  assert.match(html, /<input class="ref-file-input" data-ref-file type="file" multiple hidden accept="/);
  assert.ok(ACCEPT_ATTRIBUTE.includes('image/png'));
  assert.ok(ACCEPT_ATTRIBUTE.includes('video/mp4'));
  assert.ok(ACCEPT_ATTRIBUTE.includes('audio/wav'));
  assert.ok(ACCEPT_ATTRIBUTE.includes('audio/mpeg'));
});

test('client pre-check mirrors the server limits and rejects unsafe types', () => {
  assert.equal(LIMITS.imageMaxBytes, 20 * MB);
  assert.equal(LIMITS.videoMaxBytes, 200 * MB);
  assert.equal(LIMITS.audioMaxBytes, 100 * MB);
  assert.equal(LIMITS.audioMaxSeconds, 300);
  assert.equal(LIMITS.maxReferences, 24);
  assert.equal(LIMITS.noteMaxChars, 1000);

  assert.equal(precheckFile(file('ok.png', 'image/png', 20 * MB)).ok, true);
  const tooBig = precheckFile(file('big.png', 'image/png', 20 * MB + 1));
  assert.equal(tooBig.ok, false);
  assert.equal(!tooBig.ok && tooBig.code, 'TOO_LARGE');
  assert.match(!tooBig.ok ? tooBig.message : '', /images max 20 MB/);

  assert.equal(precheckFile(file('ok.mp4', 'video/mp4', 200 * MB)).ok, true);
  assert.equal(precheckFile(file('big.mp4', 'video/mp4', 200 * MB + 1)).ok, false);
  const wav = precheckFile(file('ok.wav', '', 100 * MB));
  assert.equal(wav.ok, true);
  assert.equal(wav.ok && wav.kind, 'audio');
  assert.equal(wav.ok && wav.mime, 'audio/wav');
  assert.equal(precheckFile(file('big.mp3', 'audio/mpeg', 100 * MB + 1)).ok, false);
  assert.equal(precheckFile({ ...file('long.mp3', 'audio/mpeg', 10), durationSec: 301 }).ok, false);
  assert.equal(precheckFile({ ...file('trimmed.mp3', 'audio/mpeg', 10), durationSec: 300 }).ok, true);
  assert.equal(precheckFile(file('empty.png', 'image/png', 0)).ok, false);
  assert.equal(!precheckFile(file('logo.svg', 'image/svg+xml', 10)).ok, true);
  assert.equal(!precheckFile(file('page.html', 'text/html', 10)).ok, true);
  assert.equal(!precheckFile(file('clip.bin', '', 10)).ok, true);

  const mismatch = precheckFile(file('odd.png', 'video/mp4', 10));
  assert.equal(mismatch.ok, true);
  assert.equal(mismatch.ok && mismatch.kind, 'video');
  assert.match(mismatch.ok ? mismatch.warning ?? '' : '', /disagree/);

  assert.equal(formatFileSize(32 * MB), '32 MB');
  assert.equal(formatFileSize(1536), '1.5 KB');
});

test('the controller refuses more than 24 references per conversation', async () => {
  const existing = Array.from({ length: LIMITS.maxReferences }, (_, index) =>
    reference(`ref_${index}`, { bytes: 10 }));
  const fake = fakeApi({ references: existing });
  const controller = new ReferencePanelController({ api: fake.api });
  await controller.load();

  const results = controller.queueFiles([file('last.png', 'image/png', 10)]);
  assert.equal(results[0]?.ok, false);
  assert.equal(results[0]?.code, 'TOO_MANY');
  assert.equal(controller.getState().pending[0]?.status, 'error');
  assert.deepEqual(fake.calls.uploads, []);
});

test('each reference has one role select and no role chip buttons', () => {
  const html = renderReferencePanel({
    references: [
      reference('ref_a', { role: 'style' }),
      reference('ref_b', { role: 'product' }),
    ],
    assignments: [],
    pending: [],
    questions: {},
    message: '',
    messageError: false,
    loading: false,
  });

  assert.equal(html.match(/data-role-chip/g)?.length ?? 0, 0, 'no role chip buttons render');
  assert.equal(html.match(/data-role-ref=/g)?.length, 2, 'one role select per reference');
  assert.equal(html.match(/<select /g)?.length, 2, 'the role select is kept');
});

test('panel.ts has no native confirm call', () => {
  const source = readFileSync(new URL('./panel.ts', import.meta.url), 'utf8');
  assert.ok(!/\bglobalThis\.confirm\b/.test(source), 'no globalThis.confirm');
  assert.ok(!/\bview\??\.confirm\b/.test(source), 'no view.confirm');
  assert.ok(!/\bscope\??\.confirm\b/.test(source), 'no scope.confirm');

  const withoutControllerCall = source.replace(/\bthis\.confirm\s*\(/g, '');
  assert.ok(!/\bconfirm\s*\(/.test(withoutControllerCall), 'no bare confirm() outside this.confirm()');
});

test('role changes patch only the reference that changed', async () => {
  const fake = fakeApi({
    references: [
      reference('ref_a', { role: 'style' }),
      reference('ref_b', { role: 'product' }),
    ],
  });
  const controller = new ReferencePanelController({ api: fake.api });
  await controller.load();

  assert.equal(await controller.setRole('ref_b', 'motion'), true);
  assert.deepEqual(fake.calls.patches, [{ id: 'ref_b', patch: { role: 'motion' } }]);
  assert.equal(controller.getState().references.find(item => item.id === 'ref_a')?.role, 'style');
  assert.equal(controller.getState().references.find(item => item.id === 'ref_b')?.role, 'motion');
  assert.equal(await controller.setRole('ref_b', 'not-a-role'), false);
});

test('a failed upload reports only its own file and leaves the successful one in place', async () => {
  const fake = fakeApi({
    uploadFile: async (item, _options, call) => {
      if (item.name === 'broken.mp4') throw new Error('server rejected the video');
      return reference(`ref_${call}`, { kind: item.type?.startsWith('video/') ? 'video' : 'image', label: item.name });
    },
  });
  const controller = new ReferencePanelController({ api: fake.api });

  const results = controller.queueFiles([
    file('good.png', 'image/png', 100),
    file('broken.mp4', 'video/mp4', 200),
  ]);
  assert.deepEqual(results.map(result => result.ok), [true, true]);

  await controller.settle();
  const state = controller.getState();
  assert.deepEqual(state.references.map(item => item.label), ['good.png']);
  const failed = state.pending.find(entry => entry.name === 'broken.mp4');
  assert.equal(failed?.status, 'error');
  assert.match(failed?.error ?? '', /server rejected the video/);
  assert.equal(state.pending.some(entry => entry.name === 'good.png'), false);
  assert.equal(state.messageError, true);
});
