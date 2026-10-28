// EX10: a failed approve/start is shown inline on the plan with a focused
// "Try again" button, not only through the shell's screen-reader alert.
// node:test imports are runtime-only; the fakes below never touch a browser,
// the network or Google Colab.
// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';

import { COPY } from '../copy.ts';
import { defaultEasyState } from '../store.ts';
import {
  approveAndGenerate,
  takeApprovalFailure,
} from '../approve-generate.ts';
import { renderPlan, setPlanSnapshot, step } from './plan.ts';

const PRODUCTION_ID = 'prod_0123456789abcdef01234567';
const PLAN_HASH = 'c'.repeat(64);

function snapshot() {
  return {
    productionId: PRODUCTION_ID,
    production: { id: PRODUCTION_ID, revision: 4 },
    revision: 4,
    gap: false,
    stale: false,
    events: [{
      id: 'evt_plan_1',
      sequence: 3,
      productionId: PRODUCTION_ID,
      type: 'plan.proposed',
      data: {
        id: 'plan_1',
        productionId: PRODUCTION_ID,
        revision: 0,
        planHash: PLAN_HASH,
        reservationCeiling: 9,
        collectAndStopReserve: 0,
        requiredDecisions: [],
        actions: [
          { id: 'act_shot_1', kind: 'shot.generate', targetId: 'shot_1', upperBound: 4, reuse: false },
        ],
      },
    }],
  };
}

function readyState() {
  const state = defaultEasyState();
  state.packageId = 'pkg_ex10';
  state.productionId = PRODUCTION_ID;
  state.compute = 'cpu';
  state.plan = { ...state.plan, status: 'ready' };
  return state;
}

function memoryStore(state) {
  return {
    get: () => state,
    patch(partial) {
      if (partial.plan) state.plan = { ...state.plan, ...partial.plan };
      if (partial.generate) state.generate = { ...state.generate, ...partial.generate };
      return state;
    },
  };
}

function failingApi() {
  return {
    async setSpendCap() {
      throw new Error('spend cap unavailable');
    },
    async sendCommand() {
      throw new Error('network down');
    },
    async dispatchAction() {
      throw new Error('dispatch down');
    },
    async startRun() {
      throw new Error('run down');
    },
    async colabStatus() {
      return {};
    },
    async getProduction() {
      return snapshot();
    },
    async proposeEasyPlan() {
      return snapshot();
    },
  };
}

class FakeButton {
  constructor(ownerDocument) {
    this.ownerDocument = ownerDocument;
    this.disabled = false;
  }

  focus() {
    this.ownerDocument.activeElement = this;
  }
}

class FakeElement {
  constructor(ownerDocument) {
    this.ownerDocument = ownerDocument;
    this.retry = new FakeButton(ownerDocument);
    this.listeners = new Map();
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(handler);
  }

  removeEventListener(type, handler) {
    this.listeners.get(type)?.delete(handler);
  }

  querySelector(selector) {
    return selector === '[data-easy-approve-retry]' ? this.retry : null;
  }
}

function fakeDocument() {
  return {
    activeElement: null,
    createElement(tagName) {
      return { tagName, textContent: '' };
    },
  };
}

function planContext(state, rerender) {
  return {
    state,
    store: memoryStore(state),
    api: failingApi(),
    host: {
      getPackage: () => null,
      playerElement: () => null,
      seekToScene() {},
      editorStore: { dispatch: () => ({ ok: true }) },
      openAgentSettings() {},
    },
    shell: {
      setPrimary() {},
      setStatus() {},
      alert() {},
      setBanner() {},
    },
    go() {},
    rerender,
    dialogs: {},
  };
}

test('a failed approve starts an inline error with a Try again button', () => {
  const state = readyState();
  const html = renderPlan(state, undefined, { approvalError: COPY.plan.approveFailed });

  assert.match(html, /data-easy-approve-error/u);
  assert.match(html, /role="alert"/u);
  assert.match(html, /data-easy-approve-retry/u);
  assert.match(html, /start making this video/u, 'the failure sentence is visible');
  assert.ok(html.includes(COPY.errors.tryAgain), 'the retry action is labelled');
});

test('a rejected approve records the actionable server error for the plan surface', async () => {
  const state = readyState();
  const deps = {
    api: failingApi(),
    store: memoryStore(state),
    snapshot: snapshot(),
  };

  await assert.rejects(approveAndGenerate(state, deps));
  assert.equal(takeApprovalFailure()?.message, 'network down');
});

test('the plan primary rerenders the failure and bind focuses Try again', async () => {
  const state = readyState();
  setPlanSnapshot(snapshot(), PRODUCTION_ID);
  let rerenders = 0;
  const deps = {
    api: failingApi(),
    store: memoryStore(state),
    snapshot: snapshot(),
  };
  const ctx = planContext(state, () => {
    rerenders += 1;
  });
  ctx.approveAndGenerate = () => approveAndGenerate(state, deps);

  await step.onPrimary(ctx);

  assert.equal(rerenders, 1);
  const rendered = step.render(state, {
    hasPackage: true,
    planApproved: false,
    actionsActive: false,
    allShotsKept: false,
    exportCurrent: false,
  });
  assert.match(rendered, /data-easy-approve-error/u);
  assert.match(rendered, /network down/u);

  const doc = fakeDocument();
  const el = new FakeElement(doc);
  step.bind(el, ctx);
  assert.equal(doc.activeElement, el.retry, 'the retry button receives focus');
});
