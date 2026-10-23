// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  renderBanner,
  renderEmptyState,
  renderErrorState,
  renderSkeleton,
  renderChoiceCards,
  renderSegmented,
  renderChip,
  renderProgressBar,
  renderButton,
} from '../src/easy/components.ts';

const css = readFileSync(new URL('../src/easy/components.css', import.meta.url), 'utf8');

function count(html, pattern) {
  return (html.match(pattern) || []).length;
}

test('banner is an alert for danger and a status otherwise', () => {
  assert.match(renderBanner({ tone: 'danger', text: 'Session stopped.' }), /role="alert"/);
  for (const tone of ['info', 'warn', 'success']) {
    const html = renderBanner({ tone, text: 'A message.' });
    assert.match(html, /role="status"/);
    assert.doesNotMatch(html, /role="alert"/);
  }
});

test('banner escapes its text and renders action objects', () => {
  const html = renderBanner({
    tone: 'info',
    text: '<script>alert(1)</script>',
    actions: [{ label: 'Try again', value: 'retry', kind: 'primary', data: { action: 'retry' } }],
  });
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(!html.includes('<script>'));
  assert.match(html, /class="btn btn-primary"/);
  assert.ok(html.includes('data-action="retry"'));
});

test('empty state escapes text and renders every action as a button', () => {
  const html = renderEmptyState({
    text: 'No characters yet. <script>bad</script>',
    actions: [
      { label: 'Add a character', kind: 'primary', data: { easyAction: 'add' } },
      { label: 'Browse', kind: 'secondary', data: { easyAction: 'browse' } },
    ],
  });
  assert.ok(html.includes('No characters yet.'));
  assert.ok(!html.includes('<script>'));
  assert.equal(count(html, /<button/g), 2);
  assert.ok(html.includes('data-easy-action="add"'));
  assert.ok(html.includes('data-easy-action="browse"'));
});

test('error state is an alert and puts why inside a Details disclosure', () => {
  const html = renderErrorState({
    what: 'We could not write your plan.',
    why: '<script>timeout</script>',
    action: { label: 'Try again', kind: 'secondary' },
  });
  assert.match(html, /role="alert"/);
  assert.match(html, /<details[^>]*><summary>Details<\/summary>/);
  assert.ok(html.includes('&lt;script&gt;timeout&lt;/script&gt;'));
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('Try again'));
});

test('error state omits the disclosure when there is no why', () => {
  const html = renderErrorState({ what: 'Something failed.', action: { label: 'Retry' } });
  assert.doesNotMatch(html, /<details/);
  assert.doesNotMatch(html, /<summary/);
});

test('skeleton has busy state, the loading label and exactly three rows', () => {
  const html = renderSkeleton(3, 'Loading plan');
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /aria-label="Loading plan"/);
  assert.equal(count(html, /class="easy-skeleton-row"/g), 3);
  assert.ok(!renderSkeleton(1, '<script>').includes('<script>'));
});

test('choice cards are a fieldset with native radios and one checked input', () => {
  const html = renderChoiceCards({
    name: 'look',
    legend: 'Look',
    value: 'clay',
    options: [
      { value: 'clay', title: 'Clay', body: 'Soft and warm', extra: 'Recommended' },
      { value: 'glass', title: 'Glass', body: '<script>bad</script>', disabled: true },
    ],
  });
  assert.match(html, /<fieldset/);
  assert.match(html, /<legend[^>]*>Look<\/legend>/);
  assert.equal(count(html, /type="radio"/g), 2);
  assert.equal(count(html, /\schecked(?=[\s>])/g), 1);
  assert.match(html, /name="look"/);
  assert.match(html, /value="clay" checked/);
  assert.match(html, /value="glass" disabled/);
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;bad&lt;/script&gt;'));
  assert.match(html, /<span class="easy-choice-extra">Recommended<\/span>/);
});

test('choice cards escape the legend and every option title', () => {
  const html = renderChoiceCards({
    name: '<script>n</script>',
    legend: '<script>legend</script>',
    value: 'a',
    options: [{ value: 'a', title: '<script>title</script>', body: 'b' }],
  });
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;legend&lt;/script&gt;'));
  assert.ok(html.includes('&lt;script&gt;title&lt;/script&gt;'));
});

test('segmented control is the same fieldset and radios in a pill row', () => {
  const html = renderSegmented({
    name: 'length',
    legend: 'Length',
    value: '30',
    options: [
      { value: '15', title: '15 s' },
      { value: '30', title: '30 s' },
      { value: '60', title: '60 s' },
    ],
  });
  assert.match(html, /class="easy-segmented"/);
  assert.match(html, /<legend[^>]*>Length<\/legend>/);
  assert.equal(count(html, /type="radio"/g), 3);
  assert.equal(count(html, /\schecked(?=[\s>])/g), 1);
  assert.match(html, /value="30" checked/);
});

test('chip only has aria-pressed when pressed is a boolean', () => {
  const quiet = renderChip({ label: 'Product launch', data: { template: 'launch' } });
  assert.match(quiet, /<button[^>]*type="button"/);
  assert.doesNotMatch(quiet, /aria-pressed/);
  assert.ok(quiet.includes('data-template="launch"'));

  assert.match(renderChip({ label: 'On', pressed: true, data: {} }), /aria-pressed="true"/);
  assert.match(renderChip({ label: 'Off', pressed: false, data: {} }), /aria-pressed="false"/);
});

test('chip escapes its label', () => {
  const html = renderChip({ label: '<script>chip</script>', data: {} });
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;chip&lt;/script&gt;'));
});

test('progress bar exposes role and value attributes', () => {
  const html = renderProgressBar({ label: 'Export <script>', value: 42 });
  assert.match(html, /role="progressbar"/);
  assert.match(html, /aria-valuemin="0"/);
  assert.match(html, /aria-valuemax="100"/);
  assert.match(html, /aria-valuenow="42"/);
  assert.ok(html.includes('aria-label="Export &lt;script&gt;"'));
  assert.ok(!html.includes('<script>'));
});

test('button uses the shared classes, escapes labels and links a disabled reason', () => {
  const html = renderButton({
    label: '<script>remove</script>',
    kind: 'danger',
    data: { action: 'remove' },
    disabled: true,
    reasonId: 'why-id',
  });
  assert.match(html, /class="btn btn-danger"/);
  assert.match(html, /disabled/);
  assert.match(html, /aria-describedby="why-id"/);
  assert.ok(html.includes('data-action="remove"'));
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;remove&lt;/script&gt;'));

  const primary = renderButton({ label: 'Continue', kind: 'primary', data: {} });
  assert.match(primary, /class="btn btn-primary"/);
  assert.doesNotMatch(primary, /aria-describedby/);
  assert.doesNotMatch(primary, /disabled/);

  const link = renderButton({ label: 'Details', kind: 'link', data: {} });
  assert.match(link, /class="btn btn-ghost easy-button-link"/);
});

test('renderers are pure', () => {
  const model = {
    name: 'shape',
    legend: 'Shape',
    value: '16:9',
    options: [
      { value: '16:9', title: 'Landscape', body: 'Wide' },
      { value: '9:16', title: 'Vertical', body: 'Tall' },
    ],
  };
  const before = JSON.stringify(model);
  assert.equal(renderChoiceCards(model), renderChoiceCards(model));
  assert.equal(JSON.stringify(model), before);
});

test('components.css only defines easy classes from tokens', () => {
  assert.equal(css.includes('.btn'), false);
  assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(css), false);
  assert.equal(/rgba?\(|hsla?\(/i.test(css), false);
  assert.equal(/\brem\b/.test(css), false);
  const pixels = [...css.matchAll(/\b(\d+(?:\.\d+)?)px\b/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(pixels)], ['1']);
  assert.ok(css.includes('var(--'));

  const classes = [...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((match) => match[1]);
  assert.ok(classes.length > 0);
  for (const className of classes) {
    assert.ok(className.startsWith('easy-'), `${className} is not an easy-* class`);
  }
});
