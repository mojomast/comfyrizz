// @ts-nocheck
// The Easy player is borrowed from the editor. Replacing a step's body can
// detach it, so the module keeps the element and its original home.
import test from 'node:test';
import assert from 'node:assert/strict';

import { adoptPlayer, currentPlayer, holdPlayer, releasePlayer } from '../src/easy/preview-slot.ts';

class FakeNode {
  constructor(name) {
    this.name = name;
    this.parentNode = null;
    this.parentElement = null;
    this.nextSibling = null;
    this.children = [];
  }

  remove(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    if (child.parentNode === this) {
      child.parentNode = null;
      child.parentElement = null;
    }
  }

  append(child) {
    if (child.parentNode) child.parentNode.remove(child);
    this.children.push(child);
    child.parentNode = this;
    child.parentElement = this;
    child.nextSibling = null;
  }

  appendChild(child) {
    this.append(child);
  }

  insertBefore(child, next) {
    const index = this.children.indexOf(next);
    if (index < 0) {
      this.append(child);
      return;
    }
    if (child.parentNode) child.parentNode.remove(child);
    this.children.splice(index, 0, child);
    child.parentNode = this;
    child.parentElement = this;
    child.nextSibling = next;
  }
}

test('the borrowed player survives a detached step slot and returns home', () => {
  const root = new FakeNode('root');
  const player = new FakeNode('player');
  const slot = new FakeNode('slot');
  root.append(player);
  root.append(slot);

  holdPlayer(player);
  assert.equal(currentPlayer(), player);

  adoptPlayer(slot, player);
  assert.equal(player.parentNode, slot);
  assert.equal(currentPlayer(), player);

  // Repainting a step replaces its body, which detaches the adopted player.
  slot.remove(player);
  assert.equal(player.parentNode, null);
  assert.equal(currentPlayer(), player, 'the detached player is still addressable');

  releasePlayer();
  assert.equal(player.parentNode, root);
  assert.equal(currentPlayer(), null);
});
