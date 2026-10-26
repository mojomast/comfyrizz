// UX07: one project identity owner for New video, Make another, Idea replans
// and plan approval. These tests use in-memory stores and fake APIs only; no
// browser, network, paid call or Google Colab access is involved.
// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';

import { defaultEasyState, createEasyStore, newProjectState, preserveUnsentPrompt } from './store.ts';
import { NEW_PROJECT_CARRY, NEW_PROJECT_RESET } from './session-contract.ts';
import { writePlan } from './plan-writer.ts';
import { readPlanCard } from '../productions/cards/plan-card.ts';
import { ideaChangePatch } from './steps/idea.ts';
import {
  approveAndGenerate,
  bindPlanDecision,
  planDecisionAnswers,
  resetPlanDecisionAnswers,
} from './approve-generate.ts';

const PACKAGE_A = 'pkg_identity_a';
const PRODUCTION_A = 'prod_0123456789abcdef01234567';
const PRODUCTION_B = 'prod_89abcdef0123456789abcdef';
const PLAN_ID = 'plan_identity_1';
const PLAN_HASH = 'd'.repeat(64);

function memoryStorage() {
  const map = new Map();
  return {
    map,
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      map.set(key, String(value));
    },
    removeItem(key) {
      map.delete(key);
    },
  };
}

function projectAState() {
  const state = defaultEasyState();
  state.packageId = PACKAGE_A;
  state.chatId = 'chat_a';
  state.productionId = PRODUCTION_A;
  state.idea = { ...state.idea, text: 'Project A: a bakery sourdough launch.', lengthS: 60 };
  state.questions = [{ id: 'q_a', field: 'tone', prompt: 'Tone?', options: ['warm', 'bold'], decide: 'warm' }];
  state.questionsAsked = true;
  state.answers = { q_a: 'bold' };
  state.cast = [{
    castId: 'cast_a',
    characterId: 'char_a',
    name: 'Ada',
    role: 'baker',
    voiceId: null,
    voiceLabel: null,
    imageUrl: null,
  }];
  state.narration = { on: true, voiceId: 'voice_a' };
  state.level = 'director';
  state.levelTouched = true;
  state.compute = 'colab';
  state.spendCap = 22;
  state.offline = true;
  state.planHash = 'a'.repeat(64);
  state.plan = { ...state.plan, status: 'ready' };
  state.generate = { status: 'done' };
  state.review = { shotId: 'shot_a' };
  state.exported = { revision: 7, at: '2026-10-26T15:00:00.000Z' };
  return state;
}

function readyCard(overrides = {}) {
  return {
    productionId: PRODUCTION_A,
    production: { id: PRODUCTION_A, revision: 4 },
    revision: 4,
    gap: false,
    stale: false,
    events: [{
      id: 'evt_plan_identity',
      sequence: 3,
      productionId: PRODUCTION_A,
      type: 'plan.proposed',
      data: {
        id: PLAN_ID,
        productionId: PRODUCTION_A,
        revision: 0,
        planHash: PLAN_HASH,
        reservationCeiling: 9,
        collectAndStopReserve: 0,
        requiredDecisions: [{
          id: 'd_tone',
          prompt: 'Tone?',
          options: [
            { value: 'warm', label: 'Warm' },
            { value: 'bold', label: 'Bold' },
          ],
          default: 'warm',
        }],
        actions: [
          { id: 'act_shot_1', kind: 'shot.generate', targetId: 'shot_1', upperBound: 4, reuse: false },
        ],
      },
    }],
    ...overrides,
  };
}

function planCard(snapshot = readyCard()) {
  return readPlanCard(snapshot);
}

function approvedState() {
  const state = defaultEasyState();
  state.packageId = 'pkg_identity_approved';
  state.productionId = PRODUCTION_A;
  state.compute = 'colab';
  state.spendCap = 15;
  state.level = 'director';
  state.levelTouched = true;
  state.plan = { ...state.plan, status: 'ready' };
  return state;
}

function memoryStore(initial) {
  let state = structuredClone(initial);
  return {
    get: () => structuredClone(state),
    patch(partial) {
      state = { ...state, ...partial };
      for (const key of ['idea', 'narration', 'plan', 'generate', 'review', 'exported']) {
        if (partial[key] && typeof partial[key] === 'object' && !Array.isArray(partial[key])) {
          state[key] = { ...initial[key], ...state[key], ...partial[key] };
        }
      }
      return structuredClone(state);
    },
  };
}

class FakeError extends Error {
  constructor(code, status = 409) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

function approvalApi() {
  let revision = 4;
  const dispatched = new Set();
  const runs = new Set();
  const dispatchCommands = [];
  const sentCommands = [];
  const calls = { spend: 0, dispatch: 0, run: 0 };
  const successfulRuns = [];
  const commits = new Map();
  return {
    calls,
    successfulRuns,
    dispatchCommands,
    sentCommands,
    async setSpendCap(_id, body) {
      calls.spend += 1;
      const prior = commits.get(body.commandId);
      if (prior) return { revision: prior };
      revision += 1;
      commits.set(body.commandId, revision);
      return { revision };
    },
    async sendCommand(_id, command) {
      sentCommands.push(command);
      const prior = commits.get(command.commandId);
      if (prior) return { revision: prior };
      revision += 1;
      commits.set(command.commandId, revision);
      return { revision };
    },
    async colabStatus() {
      return { backendId: 'colab' };
    },
    async getProduction() {
      return readyCard();
    },
    async proposeEasyPlan() {
      return readyCard();
    },
    async dispatchAction(_id, body) {
      calls.dispatch += 1;
      dispatchCommands.push(body.commandId);
      const prior = commits.get(body.commandId);
      if (prior) return { revision: prior };
      const actionId = body.payload.actionId;
      if (dispatched.has(actionId)) throw new FakeError('SLOT_CONSUMED');
      dispatched.add(actionId);
      revision += 1;
      commits.set(body.commandId, revision);
      return { revision };
    },
    async startRun(body) {
      calls.run += 1;
      const actionId = body.authority.actionId;
      if (runs.has(actionId)) throw new FakeError('ACTION_CONSUMED');
      runs.add(actionId);
      successfulRuns.push(actionId);
      return { runId: 'run_identity_1' };
    },
  };
}

function dependencies(store, api, snapshot = readyCard()) {
  return {
    api,
    store,
    snapshot,
    context: {},
  };
}

test('one clean start keeps project A stored while creating a decision-free B', () => {
  resetPlanDecisionAnswers();
  const storage = memoryStorage();
  const store = createEasyStore({ storage, key: 'comfyrizz.easy.' + PACKAGE_A });
  store.replace(projectAState());
  store.flush();
  const generation = store.generation();

  const next = store.startNew();

  assert.deepEqual(next.packageId, null);
  assert.deepEqual(next.chatId, null);
  assert.deepEqual(next.productionId, null);
  assert.deepEqual(next.cast, []);
  assert.deepEqual(next.answers, {});
  assert.deepEqual(next.questions, []);
  assert.equal(next.questionsAsked, false);
  assert.equal(next.planHash, null);
  assert.equal(next.plan.status, 'none');
  assert.equal(next.generate.status, 'idle');
  assert.deepEqual(next.exported, { revision: null, at: null });
  assert.deepEqual(next.review, { shotId: null });
  assert.equal(next.idea.text, '');
  assert.ok(store.generation() > generation, 'the new project has a new session generation');
  assert.deepEqual(store.sessionRef(), {
    generation: store.generation(),
    packageId: null,
    chatId: null,
    productionId: null,
  });

  const kept = JSON.parse(storage.getItem('comfyrizz.easy.' + PACKAGE_A));
  assert.equal(kept.packageId, PACKAGE_A);
  assert.equal(kept.productionId, PRODUCTION_A);
  assert.equal(kept.cast[0].castId, 'cast_a');
  assert.equal(kept.exported.revision, 7);

  const fresh = JSON.parse(storage.getItem('comfyrizz.easy.new'));
  assert.equal(fresh.packageId, null);
  assert.deepEqual(fresh.cast, []);
  assert.deepEqual(fresh.exported, { revision: null, at: null });
});

test('the clean-start state carries only the frozen workflow preferences', () => {
  const previous = projectAState();
  const next = newProjectState(previous);
  assert.deepEqual(next, {
    ...defaultEasyState(),
    offline: previous.offline,
    level: previous.level,
    levelTouched: previous.levelTouched,
    compute: previous.compute,
  });
  for (const key of NEW_PROJECT_RESET) {
    if (key === 'offline' || key === 'level' || key === 'levelTouched' || key === 'compute') continue;
    assert.equal(NEW_PROJECT_CARRY.includes(key), false, key + ' is not carried');
  }
  assert.equal(NEW_PROJECT_RESET.includes('packageId'), true);
  assert.equal(NEW_PROJECT_RESET.includes('cast'), true);
  assert.equal(NEW_PROJECT_RESET.includes('exported'), true);
  assert.equal(NEW_PROJECT_RESET.includes('answers'), true);
  assert.equal(previous.packageId, PACKAGE_A, 'the previous state is not mutated');
});

test('an unsent Super Easy prompt survives the mode handoff', () => {
  const state = defaultEasyState();
  const next = preserveUnsentPrompt(state, '  A robot bakery in Lisbon  ');
  assert.equal(next.idea.text, 'A robot bakery in Lisbon');
  assert.equal(state.idea.text, '', 'the input state is not mutated');
  assert.equal(preserveUnsentPrompt(next, '   ').idea.text, 'A robot bakery in Lisbon');
});

test('late results from project A cannot update a clean-started project B', async () => {
  const storage = memoryStorage();
  const store = createEasyStore({ storage, key: 'comfyrizz.easy.' + PACKAGE_A });
  const state = projectAState();
  state.plan = { ...state.plan, status: 'stale', wordsChanged: false };
  store.replace(state);
  store.flush();

  let resolveBuild;
  const built = new Promise((resolve) => {
    resolveBuild = resolve;
  });
  const calls = { build: 0, create: 0, propose: 0 };
  const api = {
    buildVideo() {
      calls.build += 1;
      return built;
    },
    async createProduction() {
      calls.create += 1;
      return { productionId: PRODUCTION_B };
    },
    async proposeEasyPlan() {
      calls.propose += 1;
      return {};
    },
  };
  const host = {
    adoptBuiltPackage() {},
    async aiSelection() {
      return { provider: 'none' };
    },
  };

  const pending = writePlan(store.get(), { api, host, store });
  await new Promise((resolve) => setImmediate(resolve));
  store.startNew();
  resolveBuild({ package: { id: 'pkg_late_a' }, live: true });
  await pending;

  assert.deepEqual({
    packageId: store.get().packageId,
    chatId: store.get().chatId,
    productionId: store.get().productionId,
    planStatus: store.get().plan.status,
  }, { packageId: null, chatId: null, productionId: null, planStatus: 'none' });
  assert.equal(calls.create, 0, 'the stale build never creates production B');
  assert.equal(calls.propose, 0, 'the stale build never proposes on B');
});

test('Idea text changes rebuild the brief and drop the old questionnaire', () => {
  const state = projectAState();
  state.plan = { ...state.plan, status: 'ready', wordsChanged: false };
  const patch = ideaChangePatch(state, { text: 'Project B: a completely different film about glassblowing.' });

  assert.equal(patch.idea.text, 'Project B: a completely different film about glassblowing.');
  assert.equal(patch.plan.status, 'stale');
  assert.equal(patch.plan.wordsChanged, false, 'a brief change is not scene text');
  assert.deepEqual(patch.questions, []);
  assert.equal(patch.questionsAsked, false);
  assert.deepEqual(patch.answers, {});
  assert.equal(patch.productionId, null);
  assert.equal(patch.planHash, null);
  assert.equal(state.packageId, PACKAGE_A, 'the caller state is not mutated');
});

test('non-text brief options mark a full rebuild without clearing questions', () => {
  const state = projectAState();
  state.plan = { ...state.plan, status: 'ready' };
  const patch = ideaChangePatch(state, { lengthS: 15 });

  assert.equal(patch.idea.lengthS, 15);
  assert.equal(patch.plan.status, 'stale');
  assert.equal(patch.plan.wordsChanged, false);
  assert.equal('questions' in patch, false);
  assert.equal('answers' in patch, false);
});

test('a scene-text edit re-proposes without rebuilding the brief', async () => {
  const state = projectAState();
  state.plan = { ...state.plan, status: 'stale', wordsChanged: true };
  const calls = { build: 0, create: 0, propose: 0 };
  const store = memoryStore(state);
  const api = {
    async buildVideo() {
      calls.build += 1;
      return { package: { id: 'pkg_scene_only' } };
    },
    async createProduction() {
      calls.create += 1;
      return { productionId: PRODUCTION_B };
    },
    async proposeEasyPlan() {
      calls.propose += 1;
      return {};
    },
  };
  const host = {
    adoptBuiltPackage() {},
    async aiSelection() {
      return { provider: 'none' };
    },
  };

  await writePlan(state, { api, host, store });

  assert.equal(calls.build, 0, 'editing a headline must not rebuild the brief');
  assert.equal(calls.create, 0);
  assert.equal(calls.propose, 1);
});

test('Idea B reaches the builder and binds a new production to the new package', async () => {
  const state = projectAState();
  state.plan = { ...state.plan, status: 'stale', wordsChanged: false };
  const calls = { build: 0, create: 0, propose: 0 };
  const adopted = [];
  const store = memoryStore({ ...state, productionId: PRODUCTION_A });
  const api = {
    async buildVideo() {
      calls.build += 1;
      return { package: { id: 'pkg_identity_b' }, live: true };
    },
    async createProduction() {
      calls.create += 1;
      return { productionId: PRODUCTION_B };
    },
    async proposeEasyPlan() {
      calls.propose += 1;
      return {};
    },
  };
  const host = {
    adoptBuiltPackage(body) {
      adopted.push(body);
    },
    async aiSelection() {
      return { provider: 'none' };
    },
  };

  await writePlan(state, { api, host, store });

  assert.equal(calls.build, 1, 'Idea B must reach the builder');
  assert.equal(calls.create, 1);
  assert.equal(calls.propose, 1);
  assert.equal(adopted.length, 1);
  assert.equal(store.get().packageId, 'pkg_identity_b');
  assert.equal(store.get().productionId, PRODUCTION_B);
  assert.equal(store.get().plan.status, 'ready');
});

test('decision answers follow the proposal identity and drop when it changes', () => {
  resetPlanDecisionAnswers();
  const first = planCard();
  bindPlanDecision(first, 'd_tone', 'bold');
  assert.deepEqual(planDecisionAnswers(first), { d_tone: 'bold' });

  const changedPlan = planCard(readyCard({
    events: [{
      ...readyCard().events[0],
      data: { ...readyCard().events[0].data, revision: 2, planHash: 'e'.repeat(64) },
    }],
  }));
  assert.deepEqual(planDecisionAnswers(changedPlan), {}, 'a changed proposal drops old answers');

  bindPlanDecision(changedPlan, 'd_tone', 'warm');
  assert.deepEqual(planDecisionAnswers(changedPlan), { d_tone: 'warm' });
  assert.deepEqual(planDecisionAnswers(first), {}, 'the old identity no longer owns an answer');
  resetPlanDecisionAnswers();
});

test('a nondefault plan decision is submitted with approval', async () => {
  resetPlanDecisionAnswers();
  const store = memoryStore(approvedState());
  const api = approvalApi();
  bindPlanDecision(planCard(), 'd_tone', 'bold');

  const message = await approveAndGenerate(store.get(), dependencies(store, api));

  assert.equal(message, undefined);
  const approval = api.sentCommands.find((command) => command.kind === 'plan.approve');
  assert.ok(approval, 'the plan approval was sent');
  assert.deepEqual(approval.payload.decisions, { d_tone: 'bold' });
  resetPlanDecisionAnswers();
});

test('a duplicate approval retries the same identities and starts no second run', async () => {
  resetPlanDecisionAnswers();
  const store = memoryStore(approvedState());
  const api = approvalApi();
  bindPlanDecision(planCard(), 'd_tone', 'bold');

  await approveAndGenerate(store.get(), dependencies(store, api));
  await approveAndGenerate(store.get(), dependencies(store, api));

  assert.equal(api.dispatchCommands.length, 2);
  assert.equal(api.dispatchCommands[0], api.dispatchCommands[1], 'the dispatch retry is the same command');
  assert.equal(new Set(api.dispatchCommands).size, 1);
  assert.deepEqual(api.successfulRuns, ['act_shot_1'], 'a duplicate approval starts no second run');
  resetPlanDecisionAnswers();
});
test('a reloaded plan that is already approved starts no second run', async () => {
  resetPlanDecisionAnswers();
  const store = memoryStore(approvedState());
  const api = approvalApi();
  bindPlanDecision(planCard(), 'd_tone', 'bold');

  await approveAndGenerate(store.get(), dependencies(store, api));

  const first = readyCard();
  const reloaded = {
    ...first,
    revision: 7,
    production: { id: PRODUCTION_A, revision: 7 },
    events: [
      ...first.events,
      {
        id: 'evt_plan_identity_approved',
        sequence: 4,
        productionId: PRODUCTION_A,
        type: 'plan.approved',
        data: { planId: PLAN_ID, planHash: PLAN_HASH, proposalRevision: 0 },
      },
    ],
  };
  const message = await approveAndGenerate(store.get(), dependencies(store, api, reloaded));

  assert.equal(message, undefined);
  assert.deepEqual(api.successfulRuns, ['act_shot_1'], 'the reloaded approval starts no second run');
  resetPlanDecisionAnswers();
});
