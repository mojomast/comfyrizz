// G6-6: `colab new` is silent while POST /tun/m/assign provisions the VM (~55-60 s on a cold G4 pool,
// measured 2026-10-19 10:00 EDT). The runner's default 60 s silence watchdog used to SIGTERM it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createColabBackend, NEW_WALL_MS } from "../src/colab-backend.mjs";

test("G6-6: colab new is not killed by the 60 s silence watchdog", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "g6-6-"));
  const calls = [];
  const cli = {
    bin: "colab",
    environment: () => ({}),
    async run(args, opts = {}) {
      calls.push({ args, opts });
      if (args[0] === "sessions") return { code: 0, output: "[colab] No active sessions found on server.\n" };
      return { code: 0, output: "[colab] Session READY.\n" };
    },
  };
  try {
    const backend = createColabBackend({ cli, packageId: "g66test", scratchDir: scratch, watchdogMinutes: 0 });
    const up = await backend.ensureUp({ approved: true });
    assert.equal(up.state, "created");
    const made = calls.find((c) => c.args[0] === "new");
    assert.ok(made, "colab new was called");
    assert.ok(made.opts.silenceMs >= 180000, `silenceMs ${made.opts.silenceMs} must outlast a slow assign`);
    assert.ok(made.opts.wallMs >= made.opts.silenceMs);
    assert.equal(made.opts.silenceMs, NEW_WALL_MS);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("G6-6: a 503 from the assign POST is retried, then reported as capacity", async () => {
  const { isAssignUnavailable } = await import("../src/colab-backend.mjs");
  const real503 = "ColabRequestError: Failed to issue request POST \nhttps://colab.research.google.com/tun/m/assign?nbh=x........&variant=GPU&accelerat\nor=G4: Service Unavailable\n";
  assert.ok(isAssignUnavailable(real503));
  assert.ok(!isAssignUnavailable("[colab] Backend rejected accelerator 'G4'."));
  for (const finalCode of [0, 1]) {
    const scratch = mkdtempSync(join(tmpdir(), "g6-6r-"));
    let news = 0;
    const events = [];
    const cli = {
      bin: "colab",
      environment: () => ({}),
      async run(args) {
        if (args[0] === "sessions") return { code: 0, output: "[colab] No active sessions found on server.\n" };
        news += 1;
        if (news < 3 || finalCode === 1) return { code: 1, output: real503 };
        return { code: 0, output: "[colab] Session READY.\n" };
      },
    };
    try {
      const backend = createColabBackend({ cli, packageId: "g66retry", scratchDir: scratch, watchdogMinutes: 0, newRetryMs: 1 });
      if (finalCode === 0) {
        const up = await backend.ensureUp({ approved: true, onEvent: (e) => events.push(e) });
        assert.equal(up.state, "created");
        assert.equal(news, 3);
        assert.equal(events.filter((e) => e.type === "assign_retry").length, 2);
      } else {
        await assert.rejects(backend.ensureUp({ approved: true }), /503 Service Unavailable.*no capacity/);
        assert.equal(news, 3);
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
});
