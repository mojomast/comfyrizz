// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import { CharacterApiError } from '../src/characters/api.ts';
import {
  CastStripController,
  renderCastStrip,
} from '../src/characters/cast-strip.ts';
import {
  charactersTabState,
  renderCharactersTab,
} from '../src/characters/mount.ts';

function fakeApi(error) {
  return {
    async listCast() {
      throw error;
    },
    async list() {
      return [];
    },
  };
}

test('cast strip render with a NOT_FOUND error shows the empty text', async () => {
  const controller = new CastStripController({
    api: fakeApi(new CharacterApiError('nope', 404, 'NOT_FOUND')),
    chatId: 'chat_abcdefgh',
  });
  const state = await controller.load();
  const html = renderCastStrip(state);
  assert.match(html, /No characters in this project yet/);
  assert.equal(state.cast.length, 0);
  assert.equal(state.message, '');
  assert.equal(state.messageError, false);
});

test('cast strip with a different error still shows Could not load the cast', async () => {
  const controller = new CastStripController({
    api: fakeApi(new CharacterApiError('boom', 500, 'SERVER')),
    chatId: 'chat_abcdefgh',
  });
  const state = await controller.load();
  const html = renderCastStrip(state);
  assert.match(html, /Could not load the cast/);
  assert.equal(state.messageError, true);
});

test('a message that merely contains not found is still shown', async () => {
  const controller = new CastStripController({
    api: fakeApi(new CharacterApiError('resource not found', 400, 'SERVER')),
    chatId: 'chat_abcdefgh',
  });
  const state = await controller.load();
  const html = renderCastStrip(state);
  assert.match(html, /not found/);
  assert.match(html, /Could not load the cast/);
});

test('overlay render with the editor open has no empty-state text', () => {
  const state = charactersTabState({
    library: {
      characters: [],
      loading: false,
      error: '',
      message: '',
      selectedId: '',
      project: {},
      thumbUrls: {},
    },
    editor: { mode: 'create' },
  });
  const html = renderCharactersTab(state, { includeEditor: true });
  assert.doesNotMatch(html, /No characters yet/);
  assert.doesNotMatch(html, /No characters in this project/);
});
