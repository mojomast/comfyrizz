// @ts-nocheck
// UR14: the Characters step and its library picker.

import test from 'node:test';
import assert from 'node:assert/strict';

import { COPY } from '../src/easy/copy.ts';
import { renderCharacters } from '../src/easy/steps/characters.ts';
import { filterCharacters } from '../src/easy/dialogs/library-picker.ts';

function castMember(overrides = {}) {
  return {
    castId: 'cast_1',
    characterId: 'chr_1',
    name: 'Juno',
    role: 'protagonist',
    voiceId: 'bella',
    voiceLabel: 'Bella',
    imageUrl: null,
    ...overrides,
  };
}

function stateWith(cast) {
  return {
    cast,
    narration: { on: true, voiceId: null },
  };
}

function count(html, pattern) {
  return (html.match(pattern) || []).length;
}

test('an empty cast renders the empty-state text and two actions', () => {
  const html = renderCharacters(stateWith([]));
  assert.equal(html.includes(COPY.characters.empty), true);
  assert.equal(count(html, /<button\b/g), 2);
  assert.equal(html.includes(COPY.characters.emptyAddLibrary), true);
  assert.equal(html.includes(COPY.characters.emptyCreate), true);
});

test('two cast members render two cards with named Remove buttons', () => {
  const html = renderCharacters(stateWith([
    castMember(),
    castMember({
      castId: 'cast_2',
      characterId: 'chr_2',
      name: 'Pip',
      role: 'mascot',
      voiceId: null,
      voiceLabel: null,
    }),
  ]));
  assert.equal(count(html, /data-easy-cast-card=/g), 2);
  assert.equal(count(html, /data-easy-cast-remove=/g), 2);
  assert.match(html, /aria-label="Remove Juno from this video"/);
  assert.match(html, /aria-label="Remove Pip from this video"/);
  assert.equal(html.includes(COPY.characters.roles.protagonist), true);
  assert.equal(html.includes(COPY.characters.roles.mascot), true);
  assert.match(html, /Voice: Bella/);
  assert.equal(html.includes(COPY.characters.noVoice), true);
});

test('a 404 or NOT_FOUND cast error renders the empty state', () => {
  const notFound = renderCharacters(stateWith([castMember()]), { status: 404, code: 'HTTP_404' });
  assert.equal(notFound.includes(COPY.characters.empty), true);
  assert.equal(count(notFound, /<button\b/g), 2);
  assert.equal(notFound.includes('Juno'), false);

  const named = renderCharacters(stateWith([castMember()]), { status: 500, code: 'NOT_FOUND' });
  assert.equal(named.includes(COPY.characters.empty), true);
});

test('filterCharacters matches names case-insensitively', () => {
  const characters = [{ name: 'Juno' }, { name: 'Pip' }, { name: 'junebug' }];
  assert.deepEqual(filterCharacters(characters, 'JU').map((item) => item.name), ['Juno', 'junebug']);
  assert.deepEqual(filterCharacters(characters, 'pIp').map((item) => item.name), ['Pip']);
  assert.deepEqual(filterCharacters(characters, 'zzz'), []);
  assert.equal(filterCharacters(characters, '  ').length, 3);
});
