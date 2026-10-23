// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import { COPY, fill } from '../src/easy/copy.ts';
import { renderShell, renderPrimary, stepAnnouncement } from '../src/easy/shell.ts';

function count(html, pattern) {
  return (html.match(pattern) || []).length;
}

test('the shell has one main, header, footer and stepper host', () => {
  const html = renderShell({ videoName: 'Crumb & Co', saveStatus: COPY.shell.saved });

  assert.equal(count(html, /<header\b/g), 1);
  assert.equal(count(html, /<main\b/g), 1);
  assert.equal(count(html, /<footer\b/g), 1);
  assert.equal(count(html, /data-easy-stepper\b/g), 1);

  assert.match(html, /<main id="easy-main"[^>]*tabindex="-1"/);
  assert.match(html, /<a[^>]*href="\/"/);
  assert.match(html, /data-easy-name[^>]*>Crumb &amp; Co</);
  assert.match(html, /data-easy-save[^>]*aria-live="polite"/);
  assert.match(html, /data-easy-banner/);
  assert.match(html, /data-easy-step/);
  assert.match(html, /data-easy-actions/);
  assert.match(html, /data-easy-back/);
  assert.match(html, /data-easy-status[^>]*aria-live="polite"/);
  assert.match(html, /data-easy-reason/);
  assert.match(html, /data-easy-primary/);
  assert.match(html, /data-easy-alert[^>]*aria-live="assertive"/);

  assert.ok(html.includes(`>${COPY.shell.help}</button>`));
  assert.ok(html.includes(`>${COPY.shell.settings}</button>`));
  assert.ok(html.includes(`>${COPY.shell.openEditor}</button>`));
});

test('the primary gets aria-describedby when it is given a reason', () => {
  const reason = 'Connect Google Colab or choose This computer.';
  const html = renderPrimary({ label: COPY.idea.continue, disabled: true, reason });

  assert.match(html, /aria-describedby="easy-primary-reason"/);
  assert.match(html, /\bdisabled\b/);
  assert.match(html, />Continue<\/button>/);
});

test('the step announcement text uses fill', () => {
  const expected = fill(COPY.shell.stepAnnounce, { n: 3, total: 7, name: COPY.steps.level });

  assert.equal(stepAnnouncement('level'), expected);
  assert.equal(stepAnnouncement('level'), 'Step 3 of 7, Iteration level');
});
