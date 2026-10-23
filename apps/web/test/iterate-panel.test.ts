import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ITERATION_SCOPE_SCHEMA,
  validateIterationScope,
} from '../../server/src/productions/iteration-scope.mjs';
import { handleKey, openViewer } from '../src/viewer/model.ts';
import type { ViewerState } from '../src/viewer/model.ts';
import type {
  IterationScope,
  IteratePanelOptions,
} from '../src/viewer/iterate-panel.ts';

interface FakeEvent {
  type: string;
  target: FakeElement;
  currentTarget: FakeElement;
  defaultPrevented: boolean;
  propagationStopped: boolean;
  preventDefault(): void;
  stopPropagation(): void;
  [key: string]: unknown;
}

class FakeElement {
  readonly tagName: string;
  readonly ownerDocument: FakeDocument;
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, Set<(event: FakeEvent) => void>>();
  readonly children: FakeElement[] = [];
  parentNode: FakeElement | null = null;
  className = '';
  textContent = '';
  id = '';
  value = '';
  hidden = false;
  disabled = false;
  checked = false;
  focused = false;
  tabIndex = 0;
  type = '';
  name = '';
  required = false;
  maxLength = 0;
  rows = 0;

  constructor(tagName: string, ownerDocument: FakeDocument) {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
  }

  setAttribute(name: string, value: unknown): void {
    this.attributes.set(name.toLowerCase(), String(value));
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name.toLowerCase()) ?? null;
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name.toLowerCase());
  }

  appendChild(child: FakeElement): FakeElement {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  append(...children: FakeElement[]): void {
    for (const child of children) this.appendChild(child);
  }

  removeChild(child: FakeElement): FakeElement {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parentNode = null;
    return child;
  }

  addEventListener(type: string, listener: (event: FakeEvent) => void): void {
    const listeners = this.listeners.get(type) ?? new Set<(event: FakeEvent) => void>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: FakeEvent) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatchEvent(event: { type: string } & Record<string, unknown>): boolean {
    const payload = {
      ...event,
      target: this,
      currentTarget: this,
      defaultPrevented: false,
      propagationStopped: false,
      preventDefault() { payload.defaultPrevented = true; },
      stopPropagation() { payload.propagationStopped = true; },
    } as FakeEvent;
    let node: FakeElement | null = this;
    while (node) {
      payload.currentTarget = node;
      for (const listener of Array.from(node.listeners.get(payload.type) ?? [])) {
        listener.call(node, payload);
      }
      if (payload.propagationStopped) break;
      node = node.parentNode;
    }
    return !payload.defaultPrevented;
  }

  focus(): void {
    this.focused = true;
    this.ownerDocument.activeElement = this;
  }
}

class FakeDocument {
  activeElement: FakeElement | null = null;

  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName, this);
  }
}

function descendants(root: FakeElement): FakeElement[] {
  return root.children.flatMap(child => [child, ...descendants(child)]);
}

function findAllAttr(root: FakeElement, name: string): FakeElement[] {
  return [root, ...descendants(root)].filter(node => node.hasAttribute(name));
}

function findAttr(root: FakeElement, name: string): FakeElement {
  const element = findAllAttr(root, name)[0];
  assert.ok(element, `missing ${name}`);
  return element;
}

function click(element: FakeElement): void {
  element.dispatchEvent({ type: 'click' });
}

function change(element: FakeElement): void {
  element.dispatchEvent({ type: 'change' });
}

function keydown(element: FakeElement, key: string): void {
  element.dispatchEvent({ type: 'keydown', key });
}

function submit(form: FakeElement): void {
  assert.equal(form.dispatchEvent({ type: 'submit' }), false, 'submit must prevent native navigation');
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function policy(level = 'balanced') {
  const videoTakes = level === 'director' ? 3 : level === 'balanced' ? 2 : 1;
  const videoRounds = level === 'director' ? 2 : 1;
  return {
    level,
    stages: {
      script: { takes: 1, rounds: 1, auditions: 0, pick: 'auto' },
      voice: { takes: 1, rounds: 1, auditions: 0, pick: 'auto', linesPerVoice: 1 },
      keyframe: { takes: 1, rounds: 1, auditions: 0, pick: 'auto' },
      video: { takes: videoTakes, rounds: videoRounds, auditions: 0, pick: 'auto' },
    },
    reviewDepth: 'standard',
    shotOverrides: {},
  };
}

function iterationRead(level = 'balanced') {
  const currentPolicy = policy(level);
  const range = { low: 1, expected: 2, high: 3 };
  const estimate = {
    gpuMinutes: range,
    units: range,
    wallMinutes: range,
    voiceSamples: 0,
    vsCap: { ceiling: null, fraction: null, status: 'no_cap' },
    labels: [],
  };
  return {
    policy: currentPolicy,
    level,
    estimates: { draft: estimate, balanced: estimate, director: estimate },
    recommendation: { level: 'balanced', policy: policy(), reasons: [] },
    prefill: null,
    lockedShotIds: [],
    revision: 4,
  };
}

function viewerState(): ViewerState {
  return openViewer([{ id: 'a_vid', kind: 'video', duration: 8 }], 0);
}

function annotatedViewerState(): ViewerState {
  let state = handleKey(viewerState(), 'r').state;
  state = handleKey({ ...state, time: 1.25 }, 'i').state;
  return handleKey({ ...state, time: 2.5 }, 'o').state;
}

function defaultAsset(): IteratePanelOptions['asset'] {
  return {
    characters: [
      { characterId: 'chr_pip', name: 'Pip' },
      { characterId: 'chr_basil', name: 'Basil' },
    ],
    voiceLines: [
      { lineId: 's1:l1', text: 'Hello.' },
      { lineId: 's1:l2', text: 'Again.' },
    ],
  };
}

function defaultTarget(): IteratePanelOptions['target'] {
  return {
    packageId: 'pkg_1',
    clipId: 's1:a_vid',
    takeId: 'take_1',
    assetId: 'a_vid',
    shotId: 's1',
  };
}

type MountOverrides = Partial<Omit<IteratePanelOptions, 'document' | 'host'>>;

async function mount(overrides: MountOverrides = {}) {
  const { mountIteratePanel } = await import('../src/viewer/iterate-panel.ts');
  const document = new FakeDocument();
  const host = document.createElement('div');
  const handle = mountIteratePanel({
    document: document as unknown as Document,
    host: host as unknown as HTMLElement,
    asset: defaultAsset(),
    target: defaultTarget(),
    viewer: viewerState(),
    productionId: 'prod_1',
    apiFetch: async () => json(iterationRead()),
    onSubmit: () => {},
    ...overrides,
  });
  await handle.ready;
  return {
    document,
    host,
    handle,
    form: handle.element as unknown as FakeElement,
  };
}

function radios(form: FakeElement): FakeElement[] {
  return descendants(form).filter(node => node.getAttribute('role') === 'radio');
}

function selectedRadio(form: FakeElement): FakeElement {
  const selected = radios(form).find(node => node.getAttribute('aria-checked') === 'true');
  assert.ok(selected, 'one radio must be checked');
  return selected;
}

function choiceLabel(choice: FakeElement): string | null {
  return choice.getAttribute('aria-label');
}

test('the asset radiogroup lists concrete characters and voice lines with roving keyboard selection', async () => {
  const { document, form } = await mount();
  const group = findAttr(form, 'data-iterate-elements');
  const choices = radios(form);

  assert.equal(group.getAttribute('role'), 'radiogroup');
  assert.equal(group.getAttribute('aria-label'), 'Element to iterate');
  assert.deepEqual(choices.map(choiceLabel), [
    'Character: Pip',
    'Character: Basil',
    'Voice line: Hello.',
    'Voice line: Again.',
    'Background',
    'Motion',
    'Framing',
    'Lighting',
    'Audio',
    'Other',
  ]);
  assert.equal(choiceLabel(selectedRadio(form)), 'Character: Pip');
  assert.equal(choices.filter(choice => choice.tabIndex === 0).length, 1);

  keydown(selectedRadio(form), 'ArrowRight');
  assert.equal(choiceLabel(selectedRadio(form)), 'Character: Basil');
  assert.equal(document.activeElement, selectedRadio(form));
  keydown(selectedRadio(form), 'ArrowLeft');
  assert.equal(choiceLabel(selectedRadio(form)), 'Character: Pip');
  keydown(selectedRadio(form), 'ArrowLeft');
  assert.equal(choiceLabel(selectedRadio(form)), 'Other');
  keydown(selectedRadio(form), 'Home');
  assert.equal(choiceLabel(selectedRadio(form)), 'Character: Pip');
  keydown(selectedRadio(form), 'End');
  assert.equal(choiceLabel(selectedRadio(form)), 'Other');
  keydown(selectedRadio(form), 'ArrowDown');
  assert.equal(choiceLabel(selectedRadio(form)), 'Character: Pip');
  assert.equal(choices.filter(choice => choice.getAttribute('aria-checked') === 'true').length, 1);
  assert.equal(choices.filter(choice => choice.tabIndex === 0).length, 1);

  click(choices[4]!);
  assert.equal(choiceLabel(selectedRadio(form)), 'Background');
});

test('the panel reads the IL14 level and shows the exact approval copy and note limit', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const { form } = await mount({
    apiFetch: async (url, init) => {
      calls.push({ url, init });
      return json(iterationRead('balanced'));
    },
  });

  assert.equal(findAttr(form, 'data-iterate-level').textContent, 'Level: Balanced, up to 2 takes per shot');
  assert.equal(
    findAttr(form, 'data-iterate-approval').textContent,
    'This asks the agent to propose a plan. You approve any Google Colab spend.',
  );
  const note = findAttr(form, 'data-iterate-note');
  assert.equal(note.tagName, 'TEXTAREA');
  assert.equal(note.maxLength, 500);
  assert.equal(note.getAttribute('maxlength'), '500');
  assert.equal(note.required, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, '/api/productions/prod_1/iteration');
  assert.equal(calls[0]?.init?.method, 'GET');
});

test('submit emits the viewer region and time in a scope accepted by the AV11 validator', async () => {
  const submissions: IterationScope[] = [];
  const { form } = await mount({
    viewer: annotatedViewerState(),
    onSubmit: scope => { submissions.push(scope); },
  });
  const characterPreserve = findAllAttr(form, 'data-iterate-preserve')
    .find(input => input.getAttribute('data-iterate-preserve') === 'character');
  assert.ok(characterPreserve);
  assert.equal(characterPreserve.disabled, true);
  assert.equal(characterPreserve.checked, false);

  findAttr(form, 'data-iterate-note').value = '  Make Pip grin.  ';
  const timing = findAllAttr(form, 'data-iterate-preserve')
    .find(input => input.getAttribute('data-iterate-preserve') === 'timing');
  assert.ok(timing);
  timing.checked = false;
  change(timing);
  submit(form);

  assert.equal(submissions.length, 1);
  const expected = {
    target: defaultTarget(),
    element: 'character',
    elementRef: { characterId: 'chr_pip' },
    region: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 },
    time: { in: 1.25, out: 2.5 },
    note: 'Make Pip grin.',
    preserve: ['voice', 'background', 'motion', 'framing', 'lighting', 'audio'],
  };
  assert.deepEqual(submissions[0], expected);
  assert.deepEqual(validateIterationScope(submissions[0]), expected);
  assert.equal(ITERATION_SCOPE_SCHEMA, 'comfyrizz.iteration-scope/v1');
  assert.equal(Object.hasOwn(submissions[0]!, 'schema'), false);
});

test('a voice-line choice emits its exact line id and does not preserve the changed voice', async () => {
  const submissions: IterationScope[] = [];
  const { form } = await mount({ onSubmit: scope => { submissions.push(scope); } });
  const voiceLine = radios(form).find(choice => choiceLabel(choice) === 'Voice line: Hello.');
  assert.ok(voiceLine);
  click(voiceLine);
  findAttr(form, 'data-iterate-note').value = 'A little more breath.';
  submit(form);

  assert.equal(submissions.length, 1);
  assert.equal(submissions[0]?.element, 'voice_line');
  assert.deepEqual(submissions[0]?.elementRef, { lineId: 's1:l1' });
  assert.equal(submissions[0]?.preserve.includes('voice'), false);
  assert.equal(submissions[0]?.preserve.includes('character'), true);
  assert.equal(Object.hasOwn(submissions[0]!, 'region'), false);
  assert.equal(Object.hasOwn(submissions[0]!, 'time'), false);
  assert.doesNotThrow(() => validateIterationScope(submissions[0]));
});

test('blank and overlong notes show a validation error without emitting', async () => {
  const submissions: IterationScope[] = [];
  const { form } = await mount({ onSubmit: scope => { submissions.push(scope); } });
  const note = findAttr(form, 'data-iterate-note');
  const error = findAttr(form, 'data-iterate-error');

  note.value = '   ';
  submit(form);
  assert.equal(submissions.length, 0);
  assert.equal(error.hidden, false);
  assert.equal(error.getAttribute('role'), 'alert');

  note.value = 'x'.repeat(501);
  submit(form);
  assert.equal(submissions.length, 0);
  assert.match(error.textContent, /500/);
});

test('element selection and submit never call takes, production commands, approvals, or reservations', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const submissions: IterationScope[] = [];
  const { form } = await mount({
    apiFetch: async (url, init) => {
      calls.push({ url, init });
      return json(iterationRead());
    },
    onSubmit: scope => { submissions.push(scope); },
  });

  const background = radios(form).find(choice => choiceLabel(choice) === 'Background');
  assert.ok(background);
  click(background);
  findAttr(form, 'data-iterate-note').value = 'Use a warmer sunset.';
  submit(form);

  assert.equal(submissions.length, 1, 'the host callback is the only submission side effect');
  assert.equal(calls.length, 1, 'only the initial IL14 read occurred');
  assert.equal(calls[0]?.url, '/api/productions/prod_1/iteration');
  assert.equal(calls[0]?.init?.method, 'GET');
  assert.equal(calls.some(call => /regenerate|select|approve|reserve|commands|takes/u.test(call.url)), false);
});
