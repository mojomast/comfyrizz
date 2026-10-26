// EX07: the Review step's empty player is a labelled placeholder, never a
// silent dark box. node:test imports are runtime-only; no DOM, no network.
// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';

import { renderReview } from './review.ts';
import { adoptPlayer, releasePlayer } from '../preview-slot.ts';

const NO_GATE = { ok: false, approved: 0, total: 0, blocking: [] };

test('an empty player slot shows a labelled placeholder instead of a blank box', () => {
  const html = renderReview({ shots: [], gate: NO_GATE });

  assert.match(html, /data-easy-player/u);
  assert.match(html, /data-easy-player-placeholder/u);
  assert.match(html, /aria-label="Video preview"/u);
  assert.match(html, />Video preview</u);
  assert.match(html, />Your video will play here\.</u);
});

test('the placeholder lives inside the player slot that the borrowed player fills', () => {
  const html = renderReview({ shots: [], gate: NO_GATE });
  const player = html.match(/<section[^>]*data-easy-player[^>]*>([\s\S]*?)<\/section>/u);

  assert.ok(player, 'player slot is missing');
  assert.match(player[1], /data-easy-player-placeholder/u);
});

test('adopting the borrowed player clears the placeholder', () => {
  const root = {
    children: [],
    append(child) {
      this.children.push(child);
      child.parentNode = this;
    },
    appendChild(child) {
      this.append(child);
    },
  };
  const placeholder = {
    removed: false,
    remove() {
      this.removed = true;
    },
  };
  const slot = {
    children: [],
    append(child) {
      this.children.push(child);
      child.parentNode = this;
      child.parentElement = this;
    },
    querySelector(selector) {
      return selector === '[data-easy-player-placeholder]' ? placeholder : null;
    },
  };
  const player = {
    parentNode: root,
    parentElement: null,
    nextSibling: null,
  };
  root.append(player);

  adoptPlayer(slot, player);
  assert.equal(slot.children[0], player);
  assert.equal(placeholder.removed, true);

  releasePlayer();
  assert.equal(player.parentNode, root);
});
