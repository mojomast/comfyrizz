// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import { COPY } from '../src/easy/copy.ts';

const loadDrawer = () => import('../src/easy/ask-drawer.ts');

test('without an AI provider the drawer shows the no-provider text and no textarea', async () => {
  const { renderAskDrawer } = await loadDrawer();
  const html = renderAskDrawer({ hasProvider: false });

  assert.ok(html.includes(COPY.ask.noProvider));
  assert.match(html, /<button[^>]*data-easy-ask-connect[^>]*>Connect<\/button>/);
  assert.doesNotMatch(html, /<textarea\b/);
  assert.doesNotMatch(html, /data-easy-ask-chat\b/);
});

test('with an AI provider the drawer contains the project chat labelled composer', async () => {
  const { renderAskDrawer } = await loadDrawer();
  const projectChatHtml = '<form><label for="project-chat-1-prompt">Message</label><textarea id="project-chat-1-prompt"></textarea><button type="submit">Send</button></form>';
  const html = renderAskDrawer({ hasProvider: true, projectChatHtml });

  assert.match(html, /<label[^>]*for="project-chat-1-prompt"[^>]*>Message<\/label>/);
  assert.match(html, /<textarea[^>]*id="project-chat-1-prompt"/);
  assert.match(html, /data-easy-ask-chat\b/);
});

test('the drawer is a labelled non-modal aside with a close button', async () => {
  const { renderAskDrawer } = await loadDrawer();
  const html = renderAskDrawer({ hasProvider: false });

  assert.match(html, /<aside[^>]*aria-labelledby="easy-ask-title"/);
  assert.match(html, /<h2[^>]*id="easy-ask-title"[^>]*>Ask for changes<\/h2>/);
  assert.match(html, /<button[^>]*data-easy-ask-close[^>]*>Close<\/button>/);
  assert.doesNotMatch(html, /aria-modal\b/);
  assert.doesNotMatch(html, /<dialog\b/);
});
