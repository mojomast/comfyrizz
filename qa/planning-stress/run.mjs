// Planning-only stress runner. Isolated loopback workers, bounded retries, and
// sanitized reports. Never calls /api/run, production dispatch, or a GPU.
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIXTURES, PLANNING_MODEL, PLANNING_PROVIDER } from './fixtures.mjs';
import { evaluateFixture } from './oracles.mjs';
import { chooseUsage, resanitizeEvents, toAttemptRecord, varietyCoverage, writeReports } from './report.mjs';

export const SMOKE_IDS = ['S02', 'D13', 'H24', 'X33'];
export const PORTS = [4521, 4522, 4523, 4524, 4525, 4526];
export const LIMITS = {
  attemptTimeoutMs: 8 * 60 * 1000,
  // Must stay above attemptTimeoutMs: a live plan that is still burning tokens
  // when the harness gives up must not lose its socket first, or the run is
  // recorded as HTTP 0 / infrastructure. The worker receives this value as
  // COMFYRIZZ_REQUEST_TIMEOUT_MS (see workerEnv).
  serverRequestTimeoutMs: 30 * 60 * 1000,
  progressPollMs: 5000,
  suiteDeadlineMs: 60 * 60 * 1000,
  smokeConcurrency: 2,
  initialConcurrency: 4,
  maxConcurrency: 6,
  batchSize: 8,
  healthyBatchesToScale: 2,
  scaleP95Ms: 180_000,
  reduceP95Ms: 240_000,
  circuitFailures: 3,
  circuitWindowMs: 60_000,
  circuitOpenMs: 60_000,
  maxExternalReruns: 1,
  tokenRerunCeiling: 100_000,
};
export const STRESS_ROOT = '/tmp/opencode/comfyrizz-planning-stress';
const ALLOWED_PATHS = [
  { method: 'POST', test: path => path === '/api/agent' },
  { method: 'GET', test: path => path === '/api/agent/progress' || path.startsWith('/api/agent/progress?') },
  { method: 'GET', test: path => path === '/api/agent/settings' },
  { method: 'POST', test: path => path === '/api/agent/settings' },
  { method: 'PATCH', test: path => /^\/api\/package\/[^/]+$/.test(path) },
  { method: 'GET', test: path => path === '/api/health' },
];

const repoRoot = resolve(fileURLToPath(new URL('../../', import.meta.url)));

export function providerKeyPresent(env = process.env) {
  return Boolean(env.OPENCODE_GO_API_KEY || env.OPENCODE_API_KEY);
}

export function assertStressPath(path) {
  const resolved = resolve(path);
  const root = resolve(STRESS_ROOT);
  if (resolved !== root && !resolved.startsWith(`${root}/`)) throw new Error('refusing path outside the stress workspace');
  return resolved;
}

export function assertLoopback(base) {
  const url = new URL(base);
  if (url.hostname !== '127.0.0.1') throw new Error('refusing non-loopback host');
  if (!PORTS.includes(Number(url.port))) throw new Error('refusing unexpected port');
  return url;
}

export function assertAllowedRequest(method, path) {
  const allowed = ALLOWED_PATHS.some(entry => entry.method === method && entry.test(path.split('#')[0]));
  if (!allowed) throw new Error(`refusing ${method} ${path}`);
}

export function workerEnv({ port, runtimeDir, token, baseEnv = {} }) {
  if (!PORTS.includes(port)) throw new Error('refusing unexpected port');
  assertStressPath(runtimeDir);
  if (LIMITS.serverRequestTimeoutMs < LIMITS.attemptTimeoutMs) {
    throw new Error('server request timeout must cover the full attempt timeout');
  }
  const env = {};
  for (const key of ['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'TMPDIR']) {
    if (typeof baseEnv[key] === 'string' && baseEnv[key]) env[key] = baseEnv[key];
  }
  env.COMFYRIZZ_PORT = String(port);
  env.COMFYRIZZ_HOST = '127.0.0.1';
  env.COMFYRIZZ_RUNTIME = runtimeDir;
  env.COMFYRIZZ_TOKEN = token;
  env.COMFYRIZZ_DEMO = 'launch';
  env.COMFYRIZZ_REQUEST_TIMEOUT_MS = String(LIMITS.serverRequestTimeoutMs);
  if (baseEnv.OPENCODE_GO_API_KEY) env.OPENCODE_GO_API_KEY = baseEnv.OPENCODE_GO_API_KEY;
  if (baseEnv.OPENCODE_API_KEY) env.OPENCODE_API_KEY = baseEnv.OPENCODE_API_KEY;
  return env;
}

export function publicWorkerConfig(env) {
  return {
    port: Number(env.COMFYRIZZ_PORT),
    host: env.COMFYRIZZ_HOST,
    runtimeDir: env.COMFYRIZZ_RUNTIME,
    providerKey: Boolean(env.OPENCODE_GO_API_KEY || env.OPENCODE_API_KEY),
  };
}

export function stopWorkers(pids, kill = (pid, signal) => process.kill(pid, signal)) {
  const stopped = [];
  for (const pid of pids) {
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('refusing to signal an unrecorded pid');
    try {
      kill(pid, 'SIGTERM');
      stopped.push(pid);
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error;
    }
  }
  return stopped;
}

export function complexity(fixture) {
  const scenes = fixture.oracle?.sceneCount ?? 1;
  const film = fixture.oracle?.kind === 'generated-film' ? 100 : 0;
  const narrated = fixture.oracle?.cuePhrases ? 20 : 0;
  return film + narrated + scenes;
}

export function orderSmoke(fixtures) {
  return SMOKE_IDS.map(id => fixtures.find(fixture => fixture.id === id)).filter(Boolean);
}

export function orderMain(fixtures) {
  return fixtures
    .filter(fixture => !SMOKE_IDS.includes(fixture.id))
    .slice()
    .sort((left, right) => {
      if ((left.expect === 'refusal') !== (right.expect === 'refusal')) return left.expect === 'refusal' ? 1 : -1;
      return complexity(right) - complexity(left) || left.id.localeCompare(right.id);
    });
}

export function decideRerun(attempt) {
  if ((attempt.reruns ?? 0) >= LIMITS.maxExternalReruns) return { rerun: false, reason: 'already_rerun' };
  if (attempt.expected === 'refusal') return { rerun: false, reason: 'expected_negative' };
  if (attempt.fallback) return { rerun: false, reason: 'fallback' };
  if ((attempt.usageTotal ?? attempt.usage?.total ?? 0) > LIMITS.tokenRerunCeiling) return { rerun: false, reason: 'token_ceiling' };
  if (attempt.semantic) return { rerun: false, reason: 'semantic' };
  if (attempt.transport || attempt.malformed || attempt.maxSteps || attempt.incomplete) return { rerun: true, reason: 'transient' };
  return { rerun: false, reason: 'terminal' };
}

export function batchHealth(records) {
  const elapsed = records.map(record => record.timings?.elapsedMs).filter(value => Number.isFinite(value));
  const p95 = elapsed.length ? elapsed.slice().sort((left, right) => left - right)[Math.min(elapsed.length - 1, Math.max(0, Math.ceil(0.95 * elapsed.length) - 1))] : 0;
  return {
    rateLimited: records.some(record => record.httpStatus === 429),
    networkErrors: records.some(record => record.transport || record.actual === 'infrastructure'),
    p95Ms: p95,
  };
}

export function updateConcurrency(state, batch) {
  let { concurrency, healthyBatches } = state;
  if (batch.rateLimited || batch.p95Ms > LIMITS.reduceP95Ms) {
    return { concurrency: Math.max(1, concurrency - 1), healthyBatches: 0 };
  }
  if (!batch.networkErrors && batch.p95Ms < LIMITS.scaleP95Ms) {
    healthyBatches += 1;
    if (healthyBatches >= LIMITS.healthyBatchesToScale) {
      return { concurrency: Math.min(LIMITS.maxConcurrency, concurrency + 1), healthyBatches: 0 };
    }
    return { concurrency, healthyBatches };
  }
  return { concurrency, healthyBatches: 0 };
}

export function createBreaker() {
  return { failures: [], openUntil: 0, canary: false };
}

export function noteTransport(breaker, now) {
  breaker.failures = breaker.failures.filter(at => now - at <= LIMITS.circuitWindowMs);
  breaker.failures.push(now);
  if (breaker.failures.length >= LIMITS.circuitFailures) {
    breaker.openUntil = now + LIMITS.circuitOpenMs;
    breaker.canary = true;
    breaker.failures = [];
  }
  return breaker;
}

export function admission(breaker, now, concurrency) {
  if (now < breaker.openUntil) return { allow: false, concurrency, waiting: true, canary: false };
  if (breaker.canary) return { allow: true, concurrency: 1, waiting: false, canary: true };
  return { allow: true, concurrency, waiting: false, canary: false };
}

export function noteCanaryFinished(breaker) {
  breaker.canary = false;
}

export function fixtureHash(fixtures) {
  const canonical = fixtures.map(fixture => ({
    id: fixture.id,
    brief: fixture.brief,
    motionModel: fixture.motionModel,
    expect: fixture.expect,
    oracle: fixture.oracle,
  }));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export function repoMetadata(root = repoRoot) {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const diff = execFileSync('git', ['diff', 'HEAD'], { cwd: root, encoding: 'utf8' });
  return { commit, diffHash: createHash('sha256').update(diff).digest('hex') };
}

function sleep(ms) {
  return new Promise(resolveSleep => setTimeout(resolveSleep, ms));
}

/**
 * Plain node:http keeps the client budget on AbortSignal.timeout alone. The
 * global fetch implementation adds its own 300 s headers/body timeout, which
 * silently aborts a live plan below LIMITS.attemptTimeoutMs even when the
 * worker is configured with a longer requestTimeout.
 */
async function planningFetch(base, method, path, { token, body, timeoutMs }) {
  assertLoopback(base);
  assertAllowedRequest(method, path);
  const url = new URL(`${base}${path}`);
  const payload = body === undefined ? null : JSON.stringify(body);
  const response = await new Promise((resolveRequest, rejectRequest) => {
    const request = httpRequest({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method,
      headers: {
        'content-type': 'application/json',
        'x-comfyrizz-token': token,
        origin: base,
        ...(payload === null ? {} : { 'content-length': Buffer.byteLength(payload) }),
      },
      signal: AbortSignal.timeout(timeoutMs),
    }, incoming => {
      const chunks = [];
      incoming.on('data', chunk => chunks.push(chunk));
      incoming.on('error', rejectRequest);
      incoming.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try {
          json = text ? JSON.parse(text) : {};
        } catch {
          resolveRequest({ status: incoming.statusCode ?? 0, malformed: true, body: {} });
          return;
        }
        resolveRequest({ status: incoming.statusCode ?? 0, malformed: false, body: json });
      });
    });
    request.on('error', rejectRequest);
    if (payload === null) request.end();
    else request.end(payload);
  });
  return response;
}

function attemptFacts(fixture, http, events) {
  const text = `${http.body?.error ?? ''}\n${(http.body?.details ?? []).join?.('\n') ?? ''}`;
  const transport = http.transport === true || http.status === 429 || http.status === 502 || http.status === 503 || http.status === 504;
  const maxSteps = /max_steps|repair_limit|step limit|repair limit/i.test(text);
  const incomplete = http.status === 422 && fixture.expect === 'plan';
  const semantic = http.status === 200 && fixture.expect === 'plan';
  return { transport, malformed: http.malformed === true, maxSteps, incomplete, semantic, events };
}

function countInvalidTools(events) {
  return resanitizeEvents(events).filter(event => event.type === 'repair' || (event.type === 'tool_result' && event.ok === false)).length;
}

async function enableVoice(base, token, pkg, revision) {
  const patched = {
    ...pkg,
    voice: {
      ...(pkg.voice ?? {}),
      enabled: true,
      engine: 'kokoro',
      voice: pkg.voice?.voice || 'af_heart',
      language: pkg.voice?.language || 'en-us',
    },
  };
  const response = await planningFetch(base, 'PATCH', `/api/package/${encodeURIComponent(pkg.id)}`, {
    token,
    timeoutMs: 30_000,
    body: { package: patched, baseRevision: revision },
  });
  return response.status === 200 && response.body?.package?.voice?.enabled === true;
}

async function runFixture(fixture, worker, { attempt = 1, rerun = false, concurrency }) {
  const sessionId = `stress_${fixture.id}_${attempt}_${randomUUID()}`;
  const started = Date.now();
  const events = [];
  let progressUsage = null;
  let firstChunkMs = null;
  let lastProgressAt = null;
  let progressTicks = 0;
  const base = `http://127.0.0.1:${worker.port}`;
  const poll = setInterval(async () => {
    try {
      const progress = await planningFetch(base, 'GET', `/api/agent/progress?sessionId=${encodeURIComponent(sessionId)}`, {
        token: worker.token,
        timeoutMs: 10_000,
      });
      if (progress.status === 200) {
        progressTicks += 1;
        lastProgressAt = Date.now();
        progressUsage = progress.body?.usage ?? progressUsage;
        const safe = resanitizeEvents(progress.body?.recentEvents ?? []);
        events.push(...safe);
        const chunk = safe.find(event => Number.isFinite(event.firstChunkMs));
        if (chunk && firstChunkMs === null) firstChunkMs = chunk.firstChunkMs;
      }
    } catch {
      // Progress is telemetry. A missed poll does not fail the attempt.
    }
  }, LIMITS.progressPollMs);
  let http;
  try {
    http = await planningFetch(base, 'POST', '/api/agent', {
      token: worker.token,
      timeoutMs: LIMITS.attemptTimeoutMs,
      body: {
        brief: fixture.brief,
        provider: PLANNING_PROVIDER,
        model: PLANNING_MODEL,
        motionModel: fixture.motionModel,
        sessionId,
      },
    });
  } catch (error) {
    http = { status: 0, transport: true, malformed: error?.name === 'SyntaxError', body: {} };
  } finally {
    clearInterval(poll);
  }
  let voiceEnabled = false;
  if (fixture.oracle?.voice && http.status === 200 && http.body?.package?.id) {
    try {
      voiceEnabled = await enableVoice(base, worker.token, http.body.package, http.body.revision);
    } catch {
      voiceEnabled = false;
    }
  }
  const usage = chooseUsage(http.body?.usage, progressUsage);
  const restart = http.transport === true || http.status === 0;
  const judged = evaluateFixture(fixture, {
    status: http.status,
    body: http.body,
    transport: http.transport === true,
    live: http.body?.live,
    fallback: http.body?.fallback,
    provider: http.body?.provider,
    model: http.body?.model,
    voiceEnabled,
    usage,
    repaired: events.some(event => event.phase === 'repair'),
  });
  const facts = attemptFacts(fixture, http, events);
  const semanticFailure = judged.outcome === 'fail' || judged.outcome === 'missing_actionable_refusal';
  return {
    record: toAttemptRecord({
      fixture: fixture.id,
      category: fixture.category,
      attempt,
      expected: fixture.expect,
      actual: judged.outcome,
      httpStatus: Number.isInteger(http.status) ? http.status : null,
      live: judged.live,
      fallback: judged.fallback,
      provider: PLANNING_PROVIDER,
      model: PLANNING_MODEL,
      motionModel: fixture.motionModel,
      routes: judged.routes,
      durationSeconds: judged.durationSeconds,
      durationAcceptance: judged.durationAcceptance,
      elapsedMs: Date.now() - started,
      firstChunkMs,
      usage,
      validation: judged.validation,
      failures: judged.failures,
      repaired: judged.repaired,
      rerun,
      concurrency,
      workerPort: worker.port,
      reason: judged.failures[0] ?? null,
    }),
    events,
    invalidTools: countInvalidTools(events),
    restart,
    heartbeat: { ticks: progressTicks, lastProgressMs: lastProgressAt === null ? null : lastProgressAt - started },
    rerunDecision: decideRerun({
      expected: fixture.expect,
      fallback: judged.fallback,
      usageTotal: usage.total,
      semantic: semanticFailure && http.status === 200 && !facts.transport && !facts.malformed && !facts.maxSteps,
      transport: facts.transport || http.status === 0,
      malformed: facts.malformed,
      maxSteps: facts.maxSteps,
      incomplete: http.status === 422 && fixture.expect === 'plan',
      reruns: rerun ? 1 : 0,
    }),
  };
}

function linkBuild(sourceRoot, worktree) {
  const links = [
    'node_modules',
    'packages/agent/dist',
    'packages/llm/dist',
    'packages/planner/dist',
    'packages/vector/dist',
    'packages/sources/dist',
    'packages/tts/dist',
  ];
  for (const workspace of ['packages', 'apps']) {
    const root = join(sourceRoot, workspace);
    if (!existsSync(root)) continue;
    for (const name of readdirSync(root)) {
      links.push(join(workspace, name, 'node_modules'));
    }
  }
  for (const relative of links) {
    const from = join(sourceRoot, relative);
    const to = join(worktree, relative);
    if (!existsSync(from) || existsSync(to)) continue;
    mkdirSync(dirname(to), { recursive: true });
    symlinkSync(from, to);
  }
}

function ensureWorktree(sourceRoot) {
  const dest = assertStressPath(join(STRESS_ROOT, 'src'));
  if (!existsSync(join(dest, 'apps', 'server', 'src', 'index.mjs'))) {
    mkdirSync(dirname(dest), { recursive: true });
    execFileSync('git', ['worktree', 'add', '--detach', dest, 'HEAD'], { cwd: sourceRoot, stdio: 'ignore' });
  }
  linkBuild(sourceRoot, dest);
  return dest;
}

async function waitForHealth(port, pid) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await planningFetch(`http://127.0.0.1:${port}`, 'GET', '/api/health', { token: 'health', timeoutMs: 2000 });
      if (response.status === 200 && response.body?.ok === true) return;
    } catch {
      // The worker is still booting.
    }
    if (pid) {
      try { process.kill(pid, 0); } catch { throw new Error(`worker on ${port} exited before health`); }
    }
    await sleep(250);
  }
  throw new Error(`worker on ${port} did not become healthy`);
}

function startWorker(worktree, { port, runtimeDir, token, baseEnv }) {
  assertStressPath(runtimeDir);
  mkdirSync(runtimeDir, { recursive: true });
  const child = spawn(process.execPath, ['apps/server/src/index.mjs'], {
    cwd: worktree,
    env: workerEnv({ port, runtimeDir, token, baseEnv }),
    stdio: ['ignore', 'ignore', 'ignore'],
    detached: true,
  });
  child.unref();
  return { port, pid: child.pid, token, runtimeDir };
}

async function bootWorkers(worktree, runId, baseEnv) {
  const workers = [];
  try {
    for (const port of PORTS) {
      const runtimeDir = assertStressPath(join(STRESS_ROOT, 'runtimes', runId, String(port)));
      const token = randomBytes(32).toString('hex');
      const worker = startWorker(worktree, { port, runtimeDir, token, baseEnv });
      workers.push(worker);
      await waitForHealth(port, worker.pid);
    }
    const pidPath = assertStressPath(join(STRESS_ROOT, 'results', runId, 'workers.json'));
    mkdirSync(dirname(pidPath), { recursive: true });
    writeFileSync(pidPath, `${JSON.stringify(workers.map(worker => ({ port: worker.port, pid: worker.pid })), null, 2)}\n`);
    return workers;
  } catch (error) {
    stopWorkers(workers.map(worker => worker.pid));
    throw error;
  }
}

async function restartWorker(worktree, worker, runId, baseEnv) {
  stopWorkers([worker.pid]);
  await sleep(500);
  const token = randomBytes(32).toString('hex');
  const runtimeDir = assertStressPath(join(STRESS_ROOT, 'runtimes', runId, `${worker.port}-r${randomUUID()}`));
  const next = startWorker(worktree, { port: worker.port, runtimeDir, token, baseEnv });
  await waitForHealth(worker.port, next.pid);
  return next;
}

async function executeGroup(fixtures, workers, options) {
  const results = [];
  let cursor = 0;
  let concurrency = options.concurrency;
  let healthyBatches = 0;
  const history = [{ concurrency, at: new Date().toISOString(), phase: options.phase }];
  const breaker = createBreaker();
  const batch = [];
  const free = workers.slice();
  const waiters = [];
  const running = new Set();

  function acquireWorker() {
    const worker = free.pop();
    if (worker) return Promise.resolve(worker);
    return new Promise(resolveWorker => waiters.push(resolveWorker));
  }

  function releaseWorker(worker) {
    const waiter = waiters.shift();
    if (waiter) waiter(worker);
    else free.push(worker);
  }

  async function one(fixture, attempt, rerun) {
    let worker = await acquireWorker();
    const gate = admission(breaker, Date.now(), concurrency);
    if (!gate.allow) {
      releaseWorker(worker);
      await sleep(Math.max(0, breaker.openUntil - Date.now()));
      return one(fixture, attempt, rerun);
    }
    try {
      const outcome = await runFixture(fixture, worker, { attempt, rerun, concurrency: gate.concurrency });
      if (outcome.restart) {
        console.warn(`worker ${worker.port} restart after transport (progress ticks=${outcome.heartbeat.ticks}, attempt=${LIMITS.attemptTimeoutMs}ms, server socket=${LIMITS.serverRequestTimeoutMs}ms)`);
        worker = await restartWorker(options.worktree, worker, options.runId, options.baseEnv);
      }
      results.push(outcome);
      if (outcome.record.transport || outcome.record.actual === 'infrastructure') noteTransport(breaker, Date.now());
      if (gate.canary) noteCanaryFinished(breaker);
      batch.push(outcome.record);
      if (batch.length >= LIMITS.batchSize && options.scale) {
        const next = updateConcurrency({ concurrency, healthyBatches }, batchHealth(batch.splice(0, LIMITS.batchSize)));
        concurrency = Math.min(workers.length, next.concurrency);
        healthyBatches = next.healthyBatches;
        history.push({ concurrency, at: new Date().toISOString(), phase: options.phase });
      }
      if (!rerun && outcome.rerunDecision.rerun && Date.now() < options.deadlineAt) {
        releaseWorker(worker);
        worker = null;
        await one(fixture, attempt + 1, true);
      }
      return outcome;
    } finally {
      if (worker) releaseWorker(worker);
    }
  }

  while (cursor < fixtures.length || running.size > 0) {
    if (Date.now() >= options.deadlineAt) break;
    while (running.size < concurrency && cursor < fixtures.length && Date.now() < options.deadlineAt) {
      const fixture = fixtures[cursor];
      cursor += 1;
      const promise = one(fixture, 1, false).finally(() => running.delete(promise));
      running.add(promise);
    }
    if (running.size === 0) break;
    await Promise.race(running);
  }
  await Promise.all([...running]);
  return { results, history, completed: cursor };
}

function blockedRecords(reason) {
  return FIXTURES.map(fixture => toAttemptRecord({
    fixture: fixture.id,
    category: fixture.category,
    expected: fixture.expect,
    actual: 'not_run',
    provider: PLANNING_PROVIDER,
    model: PLANNING_MODEL,
    motionModel: fixture.motionModel,
    reason,
    failures: [],
  }));
}

function configFor(runId, metadata, extra = {}) {
  return {
    runId,
    commit: metadata.commit,
    diffHash: metadata.diffHash,
    fixtureHash: fixtureHash(FIXTURES),
    provider: PLANNING_PROVIDER,
    model: PLANNING_MODEL,
    ports: PORTS,
    limits: LIMITS,
    keyPresent: providerKeyPresent(),
    ...extra,
  };
}

async function main() {
  const runId = `${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-${randomBytes(3).toString('hex')}`;
  const outDir = assertStressPath(join(STRESS_ROOT, 'results', runId));
  const metadata = repoMetadata();
  const variety = varietyCoverage(FIXTURES);
  if (!providerKeyPresent()) {
    const records = blockedRecords('OPENCODE_GO_API_KEY and OPENCODE_API_KEY are unset; live planning was not started');
    const written = writeReports(outDir, records, {
      runId,
      status: 'blocked',
      provider: PLANNING_PROVIDER,
      model: PLANNING_MODEL,
      blocked: 'OPENCODE_GO_API_KEY and OPENCODE_API_KEY are unset',
      variety,
      concurrency: [],
      invalidTools: 0,
      config: configFor(runId, metadata, { live: false }),
    });
    console.log(`planning stress blocked: provider key missing`);
    console.log(`provider=${PLANNING_PROVIDER} model=${PLANNING_MODEL}`);
    console.log(`fixtures=${FIXTURES.length} smoke=${SMOKE_IDS.join(',')}`);
    console.log(`results=${outDir}`);
    console.log(`summary status=${written.summary.status} not_run=${records.length}`);
    process.exitCode = 2;
    return;
  }

  const baseEnv = process.env;
  const worktree = ensureWorktree(repoRoot);
  let workers = [];
  try {
    workers = await bootWorkers(worktree, runId, baseEnv);
    const deadlineAt = Date.now() + LIMITS.suiteDeadlineMs;
    const smoke = await executeGroup(orderSmoke(FIXTURES), workers.slice(0, LIMITS.smokeConcurrency), {
      concurrency: LIMITS.smokeConcurrency,
      phase: 'smoke',
      scale: false,
      deadlineAt,
      worktree,
      runId,
      baseEnv,
    });
    const smokeHealthy = smoke.results.every(result => result.record.actual !== 'infrastructure');
    const mainGroup = smokeHealthy
      ? await executeGroup(orderMain(FIXTURES), workers, {
        concurrency: LIMITS.initialConcurrency,
        phase: 'main',
        scale: true,
        deadlineAt,
        worktree,
        runId,
        baseEnv,
      })
      : { results: [], history: [], completed: 0 };
    const finishedIds = new Set([...smoke.results, ...mainGroup.results].map(result => result.record.fixture));
    const skipped = FIXTURES.filter(fixture => !finishedIds.has(fixture.id)).map(fixture => toAttemptRecord({
      fixture: fixture.id,
      category: fixture.category,
      expected: fixture.expect,
      actual: 'not_run',
      provider: PLANNING_PROVIDER,
      model: PLANNING_MODEL,
      motionModel: fixture.motionModel,
      reason: smokeHealthy ? 'suite deadline reached before this fixture' : 'smoke was not healthy',
    }));
    const records = [...smoke.results, ...mainGroup.results].map(result => result.record).concat(skipped);
    const events = {};
    let invalidTools = 0;
    for (const result of [...smoke.results, ...mainGroup.results]) {
      invalidTools += result.invalidTools;
      events[`${result.record.fixture}-a${result.record.attempt}.json`] = result.events;
    }
    const unexpected = records.some(record => record.actual === 'fail' || record.actual === 'missing_actionable_refusal');
    const infrastructure = records.some(record => record.actual === 'infrastructure') || !smokeHealthy;
    writeReports(outDir, records, {
      runId,
      status: infrastructure ? 'infrastructure' : unexpected ? 'oracle_failures' : 'complete',
      provider: PLANNING_PROVIDER,
      model: PLANNING_MODEL,
      variety,
      concurrency: [...smoke.history, ...mainGroup.history],
      invalidTools,
      events,
      config: configFor(runId, metadata, { live: true, smokeHealthy }),
    });
    console.log(`planning stress ${infrastructure ? 'infrastructure failure' : unexpected ? 'oracle failures' : 'complete'}`);
    console.log(`provider=${PLANNING_PROVIDER} model=${PLANNING_MODEL}`);
    console.log(`results=${outDir}`);
    process.exitCode = infrastructure ? 2 : unexpected ? 1 : 0;
  } finally {
    stopWorkers(workers.map(worker => worker.pid));
  }
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  main().catch(error => {
    console.error(`planning stress failed: ${error?.message ?? 'unknown error'}`);
    process.exitCode = 2;
  });
}
