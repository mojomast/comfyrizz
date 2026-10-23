// @ts-nocheck
// UR15: the Easy quick character dialog and its pure helpers.

import test from 'node:test';
import assert from 'node:assert/strict';

import { COPY } from '../src/easy/copy.ts';
import {
  quickCharacterDisabledReason,
  quickCharacterPayload,
  renderQuickCharacterForm,
} from '../src/easy/dialogs/quick-character.ts';

const VOICE = {
  id: 'af_bella',
  voice: 'af_bella',
  name: 'Bella',
  character: 'warm',
  label: 'Bella, warm',
  engine: 'kokoro',
  language: 'en-us',
  previewUrl: null,
};

test('quickCharacterPayload builds the create payload', () => {
  const payload = quickCharacterPayload({
    name: '  Juno  ',
    role: 'protagonist',
    look: '  Curly red hair, green apron, round glasses  ',
    fictional: true,
    voice: VOICE,
  });

  assert.deepEqual(payload, {
    name: 'Juno',
    role: 'protagonist',
    kind: 'fictional',
    visual: { identityPrompt: 'Curly red hair, green apron, round glasses' },
    voice: { engine: 'kokoro', voice: 'af_bella', sampleLines: [] },
  });
});

test('quickCharacterPayload keeps the fictional kind even without a look or voice', () => {
  const payload = quickCharacterPayload({
    name: 'Pip',
    role: 'mascot',
    look: '',
    fictional: true,
  });

  assert.equal(payload.name, 'Pip');
  assert.equal(payload.role, 'mascot');
  assert.equal(payload.kind, 'fictional');
  assert.deepEqual(payload.visual, { identityPrompt: '' });
  assert.equal('voice' in payload, false);
});

test('a disabled reason is produced for a missing name or unticked fictional box', () => {
  assert.equal(
    quickCharacterDisabledReason({ name: '   ', fictional: true }),
    COPY.quickCharacter.needName,
  );
  assert.equal(
    quickCharacterDisabledReason({ name: 'Juno', fictional: false }),
    COPY.quickCharacter.needFictional,
  );
  assert.equal(
    quickCharacterDisabledReason({ name: '', fictional: false }),
    COPY.quickCharacter.needName,
  );
  assert.equal(
    quickCharacterDisabledReason({ name: 'Juno', fictional: true }),
    null,
  );
});

test('the rendered form has a label for every field', () => {
  const html = renderQuickCharacterForm({ idPrefix: 'quick', voices: [VOICE] });

  const fieldIds = Array.from(html.matchAll(/<(?:input|select|textarea)\b[^>]*\bid="([^"]+)"/g))
    .map((match) => match[1]);
  const labelled = new Set(
    Array.from(html.matchAll(/<label[^>]*\bfor="([^"]+)"/g)).map((match) => match[1]),
  );

  assert.deepEqual(fieldIds, [
    'quick-name',
    'quick-role',
    'quick-look',
    'quick-picture',
    'quick-voice',
    'quick-fictional',
  ]);
  for (const id of fieldIds) {
    assert.equal(labelled.has(id), true, `missing label for ${id}`);
  }

  assert.equal(html.includes(COPY.quickCharacter.name), true);
  assert.equal(html.includes(COPY.quickCharacter.role), true);
  assert.equal(html.includes(COPY.quickCharacter.look), true);
  assert.equal(html.includes(COPY.quickCharacter.picture), true);
  assert.equal(html.includes(COPY.quickCharacter.voice), true);
  assert.equal(html.includes(COPY.quickCharacter.fictional), true);
  assert.equal(html.includes(COPY.quickCharacter.more), true);
  assert.equal(html.includes(COPY.quickCharacter.create), true);
  assert.match(html, /data-easy-quick-create[^>]*disabled/);
  assert.match(html, /aria-describedby="quick-reason"/);
});

test('the role select uses every CharacterRole value with the copy label', () => {
  const html = renderQuickCharacterForm({ idPrefix: 'quick' });

  for (const [role, label] of Object.entries(COPY.characters.roles)) {
    assert.match(html, new RegExp(`<option value="${role}"`));
    assert.equal(html.includes(label), true);
  }
});
