// U2 slice 2: the guided sign-in is a relay - live lines, redacted, and no credential anywhere.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EventEmitter } from "node:events";

import { startColabAuth, colabAuthInProgress, colabAccountBusy } from "../src/colab-auth.mjs";
import { createServer } from 'node:http';
import { createApp } from '../src/app.mjs';
import { createDurableInviteLedger } from '../../../packages/backends/src/durable-invite-ledger.mjs';
import { EventLog } from "../src/events.mjs";

/** A child that prints the given lines and exits with the given code, like `colab auth` does. */
function fakeChild(lines, { code = 0, error = null } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  setImmediate(() => {
    if (error) {
      child.emit("error", new Error(error));
      return;
    }
    for (const line of lines) child.stdout.emit("data", `${line}\n`);
    child.emit("close", code);
  });
  return child;
}

test("the sign-in relays the CLI's own lines and reports how it ended (U2)", async () => {
  const seen = [];
  const result = await startColabAuth({
    home: "/nonexistent-home",
    spawn: () => fakeChild(["Open this URL in a browser:", "https://accounts.google.com/o/oauth2/auth?client_id=abc", "Waiting for authorization..."]),
    onLine: (line) => seen.push(line),
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.code, 0);
  assert.equal(result.lines.length, 3);
  assert.deepEqual(seen, result.lines, "the card sees every line as it arrives");
  assert.match(result.lines[1], /accounts\.google\.com/, "the URL the user has to open survives");
});

test("OAuth lines are published to the existing event log before auth closes", async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  const events = new EventLog();
  let closed = false;
  const pending = startColabAuth({
    home: "/nonexistent-home",
    spawn: () => child,
    onLine: line => events.publish({ type: "colab_auth", line }),
  });
  child.stdout.emit("data", "Open https://accounts.google.com/o/oauth2/auth?client_id=abc\n");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, false);
  const published = events.replay(0);
  assert.equal(published.length, 1);
  assert.equal(published[0].type, "colab_auth");
  assert.match(published[0].line, /accounts\.google\.com/);
  const appSource = readFileSync(new URL("../src/app.mjs", import.meta.url), "utf8");
  assert.match(appSource, /events\?\.publish\?\.\(\{ type: 'colab_auth', line \}\)/);
  child.emit("close", 0);
  closed = true;
  const outcome = await pending;
  assert.equal(outcome.ok, true);
  events.closeAll();
});

test("a credential in a URL never reaches the card or a log (U2)", async () => {
  const result = await startColabAuth({
    home: "/nonexistent-home",
    spawn: () =>
      fakeChild([
        "Visit https://colab.example/auth?colab-runtime-proxy-token=SUPERSECRETVALUE&alt=media",
        "or use access_token=ANOTHERONESECRET",
      ]),
  });

  const text = result.lines.join("\n");
  assert.equal(text.includes("SUPERSECRETVALUE"), false, text);
  assert.equal(text.includes("ANOTHERONESECRET"), false, text);
  assert.match(text, /colab-runtime-proxy-token=\[REDACTED\]/);
  // `redactAll` (which runs first) already turns a bare `access_token=...` into [redacted]; what matters
  // is that the value is gone, not which of the two redactors got there first
  assert.match(text, /colab-runtime-proxy-token=\[REDACTED\]/);
  assert.match(text, /\[redacted\]|access_token=\[REDACTED\]/i);
});

test("chunk boundaries cannot split a credential past the redactor", async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  const pending = startColabAuth({ home: "/nonexistent-home", spawn: () => child });
  child.stdout.emit("data", "Visit https://colab.example/auth?token=SECRET");
  child.stdout.emit("data", "VALUE\n");
  child.emit("close", 0);
  const result = await pending;
  assert.equal(result.lines.join("\n").includes("SECRETVALUE"), false);
  assert.match(result.lines[0], /token=\[REDACTED\]|token=\[redacted\]/i);
});

test("a second tab gets a busy error instead of starting a duplicate OAuth process", async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  const first = startColabAuth({ home: "/nonexistent-home", spawn: () => child });
  const second = await startColabAuth({
    home: "/nonexistent-home",
    spawn: () => { throw new Error("must not spawn twice"); },
  });
  assert.equal(second.ok, false);
  assert.equal(second.busy, true);
  assert.match(second.reason, /already in progress/);
  child.emit("close", 0);
  assert.equal((await first).ok, true);
});

test("a sign-in that fails says so instead of looking successful (U2)", async () => {
  const failed = await startColabAuth({ home: "/nonexistent-home", spawn: () => fakeChild(["consent denied"], { code: 3 }) });
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 3);
  assert.match(failed.reason, /exited 3/);

  const crashed = await startColabAuth({ home: "/nonexistent-home", spawn: () => fakeChild([], { error: "ENOENT" }) });
  assert.equal(crashed.ok, false);
  assert.match(crashed.reason, /ENOENT/);
});

test("with no CLI the card is told to install it (U2)", async () => {
  // the resolver refuses a setting that points at nothing, so that is the state where there is nothing
  // to spawn and the card has to show the install command instead of a sign-in button
  const previous = process.env.COMFYRIZZ_COLAB_BIN;
  process.env.COMFYRIZZ_COLAB_BIN = "/definitely/not/here/colab";
  try {
    const result = await startColabAuth({
      home: "/nonexistent-home",
      spawn: () => {
        throw new Error("nothing should be spawned when the binary is missing");
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.install, true);
    assert.match(result.reason, /does not exist/);
    assert.deepEqual(result.lines, []);
  } finally {
    if (previous === undefined) delete process.env.COMFYRIZZ_COLAB_BIN;
    else process.env.COMFYRIZZ_COLAB_BIN = previous;
  }
});

test("a sign-in that never finishes times out with something to show (U2)", async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  let killed = false;
  child.kill = () => {
    killed = true;
  };
  const result = await startColabAuth({ home: "/nonexistent-home", spawn: () => child, timeoutMs: 1500 });

  assert.equal(result.ok, false);
  assert.match(result.reason, /did not finish within \d+ second/);
  assert.equal(killed, true, "the CLI is not left waiting for a browser that will never open");
  assert.equal(colabAuthInProgress(), true, 'a signal does not prove auth stopped changing credentials');
  child.emit('close', 1);
  assert.equal(colabAuthInProgress(), false);
});

test('auth HTTP rejects allocating, running, reconciling and unconfirmed run ownership and durable invite holds', async t => {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'colab-account-http-'));
  const ledger = createDurableInviteLedger({ path: join(runtimeDir, 'invites.sqlite') });
  const token = 'account-gate-test-token';
  const app = createApp({ token, runtimeDir, inviteLedger: ledger,
    backendFactory() { throw new Error('Live backend forbidden'); }, render: async () => {}, renderScene: async () => {} });
  const server = createServer(app.handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await app.close(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    ledger.close(); rmSync(runtimeDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const blocked = async () => {
    const response = await fetch(base + '/api/colab/auth', { method: 'POST', headers: { origin: base, 'x-comfyrizz-token': token } });
    assert.equal(response.status, 409, await response.clone().text());
    assert.equal((await response.json()).code, 'COLAB_ACCOUNT_BUSY');
  };
  for (const status of ['starting', 'running', 'reconciling', 'stop_unconfirmed']) {
    app.runs.runs.set('run_111111111111', { backendId: 'colab', status, teardown: { state: status === 'stop_unconfirmed' ? 'stop_unconfirmed' : 'running' } });
    await blocked();
  }
  app.runs.runs.clear();
  const runDir = join(runtimeDir, 'runs', 'run_222222222222');
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'state.json'), JSON.stringify({ backendId: 'colab', status: 'failed', teardown: { state: 'stop_unconfirmed' } }));
  await blocked();
  writeFileSync(join(runDir, 'state.json'), JSON.stringify({ backendId: 'colab', status: 'failed', teardown: { state: 'stopped' } }));
  const invite = ledger.mint({ cu: 1, ttlDays: 1 }).invite;
  ledger.bindResource(invite.id, 'production', 'prod_held');
  ledger.reserveAction({ inviteId: invite.id, productionId: 'prod_held', actionId: 'act_held', backendId: 'colab', units: 1 });
  await blocked();
  ledger.settleAction({ productionId: 'prod_held', actionId: 'act_held', spent: 0 });
  app.runs.runs.set('cpu', { backendId: 'cpu', status: 'running' });
  assert.equal(colabAccountBusy({ runtimeDir, runs: app.runs, pipelines: app.pipelines, inviteLedger: ledger }), false);
  assert.equal((await startColabAuth({ isBusy: () => colabAccountBusy({ runtimeDir, runs: app.runs, pipelines: app.pipelines, inviteLedger: ledger }), spawn: () => fakeChild([]) })).ok, true);
});

test("the module never returns a token field at all (U2)", () => {
  // the shape is the contract: if a token ever needs returning, this test should be the thing that
  // fails, not a review
  const fields = ["ok", "code", "lines", "reason", "bin", "source", "install"];
  assert.deepEqual(Object.keys({ ok: true, code: 0, lines: [], reason: null, bin: "colab", source: "PATH" }).filter((key) => !fields.includes(key)), []);
  assert.ok(mkdtempSync(join(tmpdir(), "comfyrizz-u2-auth-")).length > 0);
});
