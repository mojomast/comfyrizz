# Agent cassettes: record, replay, diff

A **cassette** is a JSON file (`comfyrizz.cassette/v1`) that records one chat
agent session's OpenAI-compatible LLM traffic. It exists so that:

- the demo runs **with no network and no provider**, deterministically;
- the same session can be **replayed under a different model** (the request
  key ignores the model), which is the model-agnostic proof;
- two runs — same session, two models — can be **diffed** into a table a judge
  can read.

The chat agent talks to any OpenAI-compatible provider. Cassettes record that
traffic with credential-shaped values redacted (see
[Redaction](#redaction-guarantees-and-limits)).

Everything below is run from the repository root with Node 22+.

## Files

| Path | What it is |
| --- | --- |
| `scripts/cassette/format.mjs` | schema, validation, request key |
| `scripts/cassette/redact.mjs` | redaction rules |
| `scripts/cassette/recorder.mjs` | fetch wrapper that records |
| `scripts/cassette/player.mjs` | fetch wrapper that replays |
| `scripts/cassette/diff.mjs` | cassette diff and markdown table |
| `scripts/cassette/cli.mjs` | the command line tool |
| `scripts/cassette/replay-smoke.mjs` | replay smoke loop (module API) |
| `scripts/cassette/fixtures/launch-brief.cassette.json` | synthetic sample cassette |
| `apps/server/src/cassette-hook.mjs` | opt-in server hook (env var) |

## Command line tool

```bash
node scripts/cassette/cli.mjs validate <file>
node scripts/cassette/cli.mjs stats <file>
node scripts/cassette/cli.mjs diff <a> <b> [--md]
node scripts/cassette/cli.mjs redact <in> <out>
node scripts/cassette/cli.mjs help
```

- `validate` prints one line for a valid cassette and exits `1` with a
  path-specific error list for an invalid one.
- `stats` prints counts only: entries, unique/duplicate keys, messages, tool
  calls per tool, responses by status.
- `diff` compares two cassettes; `--md` renders the judge-readable table.
- `redact` rewrites a cassette with the redaction rules applied and writes the
  result to `<out>`; it reports how many entries it wrote, never their content.

Request bodies are never printed in full — only counts, key prefixes, tool
names and previews of at most 80 characters.

Try them on the committed sample:

```bash
node scripts/cassette/cli.mjs validate scripts/cassette/fixtures/launch-brief.cassette.json
node scripts/cassette/cli.mjs stats scripts/cassette/fixtures/launch-brief.cassette.json
```

## Recording a session with a free provider

The recording is done by the **server hook**, driven by one environment
variable. It is off by default; with the variable unset the server behaves
exactly as before.

1. Configure a provider in **Agent settings** in the app's top bar. The
   built-in **OpenCode Go** preset is the free pool and ships with
   `deepseek-v4.1-flash` as its default model; press **Fetch models** to pick
   another Chat Completions model with tool calling, then **Test connection &
   tools** and **Save & use**. The provider key comes from the environment
   (`OPENCODE_API_KEY` or `OPENCODE_GO_API_KEY`) or from the settings dialog.
   A key value is never printed or returned by the API — only whether a key is
   set and where it came from; a key saved in the dialog lives in the
   git-ignored runtime file with owner-only permissions.

2. Start the server in record mode. The value is `record:<file>`:

   ```bash
   COMFYRIZZ_LLM_CASSETTE=record:apps/server/.runtime/session.cassette.json npm --prefix apps/server run start
   ```

   (`pnpm --filter @comfyrizz/server start` runs the same script.) The server
   prints its URL and the token file when it is ready.

   The file must live **inside the server runtime directory
   (`apps/server/.runtime/`) or inside the working directory**; any other path
   is refused with `Cassette record path must be inside the server runtime
   directory or the working directory`.

3. Drive the session in the app (open the URL the server prints, paste the
   token from `apps/server/.runtime/server-token`).

4. Stop the server. The cassette is written **after every recorded entry and
   again when the process exits**, so an interrupted run still leaves a usable
   file.

5. Check what was captured, then review it (see
   [Review before committing](#review-before-committing)):

   ```bash
   node scripts/cassette/cli.mjs stats apps/server/.runtime/session.cassette.json
   node scripts/cassette/cli.mjs validate apps/server/.runtime/session.cassette.json
   ```

`apps/server/.runtime/` is git-ignored, so a raw recording never lands in a
commit by accident. Copy the reviewed file somewhere deliberate (for example
`scripts/cassette/fixtures/`) if you want it committed.

### What is recorded

- Only `POST` requests whose path ends in `/chat/completions` and whose JSON
  body has a `messages` array. Every other request (model listing, media
  download, …) is passed through untouched and is not recorded.
- The recorded request keeps `model`, `messages`, `tools`, `tool_choice` and
  `temperature`. Request headers are never recorded.
- The recorded response keeps the HTTP status and the body. A streaming
  response is stored as the assembled final completion body and the entry is
  marked `stream: true`.
- An upstream error is stored as the status plus the error message and is
  re-thrown to the caller unchanged.

### Scripted capture

The recorder is a plain fetch wrapper, so any client can be captured without
the server. This example records one exchange against a stub upstream and
saves a valid cassette:

```bash
node --input-type=module -e "
import { createRecorder } from './scripts/cassette/recorder.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
mkdirSync('apps/server/.runtime', { recursive: true });
const upstream = async () => new Response(JSON.stringify({
  id: 'chatcmpl-example', object: 'chat.completion', created: 0, model: 'demo-model',
  choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
}), { status: 200, headers: { 'content-type': 'application/json' } });
const recorder = createRecorder({ fetch: upstream, meta: { model: 'demo-model', provider: 'example' } });
await recorder.fetch('https://provider.example.test/v1/chat/completions', {
  method: 'POST',
  body: JSON.stringify({ model: 'demo-model', messages: [{ role: 'user', content: 'hello cassette' }] }),
});
await recorder.save('apps/server/.runtime/demo.cassette.json', { writeFileSync });
"
```

Point `upstream` at your provider's `fetch` (and let the recorder wrap it) to
capture a real free-provider session.

## Replaying for a no-network demo

Replay is the same hook in `play` mode: `play:<file>`. The player answers
every matching request from the file and never touches the network.

```bash
COMFYRIZZ_LLM_CASSETTE=play:scripts/cassette/fixtures/launch-brief.cassette.json npm --prefix apps/server run start
```

- Matching is **strict by request key**: the sha256 of the canonical request
  (sorted keys, trimmed message content, tools sorted, `model` and the
  transport flags `stream`/`stream_options` excluded). Because the model is
  excluded from the key, a recorded session replays unchanged under a
  different model — that is the model-agnostic behaviour, demonstrated rather
  than claimed.
- A request that is not in the file raises `Cassette miss`. The error lists
  the three closest recorded keys with a short preview of their first user
  message, so you can see how far off the request was. Nothing else is
  printed.
- A recorded non-streaming completion is replayed as a streaming SSE response
  when the request asked for `stream: true`.
- `play:` needs no key and no network: the demo can run on a machine with no
  provider account and no internet access.

Replay a cassette without a server (smoke loop over a file):

```bash
node --input-type=module -e "
import { readFileSync } from 'node:fs';
import { runReplay } from './scripts/cassette/replay-smoke.mjs';
const cassette = JSON.parse(readFileSync('scripts/cassette/fixtures/launch-brief.cassette.json', 'utf8'));
const result = await runReplay(cassette);
console.log('turns', result.turns.length, 'toolCalls', result.toolCalls.length);
"
```

It prints `turns 5 toolCalls 4` for the sample cassette, and throws a clear
error for a corrupted one (invalid JSON body, missing `finish_reason`,
unparseable tool arguments).

## Diffing two models' runs (the model-agnostic story)

Because the request key excludes the model, the *same* conversation recorded
with two different models produces two cassettes with the *same* keys — one
row per turn. The diff lines the turns up and shows what each model did.

1. Record the session with model A:

   ```bash
   COMFYRIZZ_LLM_CASSETTE=record:apps/server/.runtime/model-a.cassette.json npm --prefix apps/server run start
   ```

   Repeat with model B selected in **Agent settings** and a second file
   (`model-b.cassette.json`). Keep the brief and the conversation identical.

2. Compare:

   ```bash
   node scripts/cassette/cli.mjs diff apps/server/.runtime/model-a.cassette.json apps/server/.runtime/model-b.cassette.json
   node scripts/cassette/cli.mjs diff apps/server/.runtime/model-a.cassette.json apps/server/.runtime/model-b.cassette.json --md
   ```

The plain form prints the counts (identical / only in A / only in B /
changed) and one line per changed turn:

```
- 39f159c9d34c "Brief a 30-second launch video…" textChanged=yes a assets.route(kind, need, scene_id, source) | b assets.route(kind, need, scene_id, source)
```

The `--md` form is the judge-facing table:

```markdown
# Cassette diff: model-a vs model-b

- 3 identical turn(s)
- 0 turn(s) only in model-a
- 0 turn(s) only in model-b
- 2 changed turn(s)

| turn | text changed | tool calls |
| --- | --- | --- |
| Brief a 30-second launch video… | yes | model-a: assets.route(kind, need, scene_id, source) — model-b: assets.route(kind, need, scene_id, source) |
```

What the table proves: the same brief went through two different models, the
agent's own tools were offered and used on both sides, and the difference is
confined to the model's wording and choices — the pipeline around the model
is provider-agnostic. Tool names and argument **keys** are compared; argument
values are not shown.

## Redaction: guarantees and limits

Redaction runs when the recorder saves a file and whenever `cli.mjs redact`
is used. It never mutates the input in place.

**Guarantees**

- Request headers are dropped entirely.
- Message text and response bodies are scanned for secrets and the match is
  replaced with `[REDACTED]`. Covered shapes:
  - `Bearer <token>` headers;
  - `sk-…`, `hf_…`, `ghp_…` and `github_pat_…` key formats;
  - assignments such as `api_key = …`, `apikey: "…"`, `access_key=…`,
    `secret=…`, `client_secret=…`, `auth_token=…`, `access_token=…`,
    `refresh_token=…`, `password=…`, `passwd=…`, `authorization=…`;
  - the value of **every environment variable whose name contains** `KEY`,
    `TOKEN`, `SECRET`, `PASSWORD`, `PASSWD`, `CREDENTIAL` or `AUTH` (at least
    8 characters long) — so a provider key that leaked into a prompt is
    removed even if it does not look like a known key format.
- Absolute filesystem paths (POSIX, `/…`, Windows `C:\…` and `~/…`) are
  replaced with `<path>`.
- Only the **names** of environment variables and their set/unset state are
  ever reported. No secret value is printed, logged, stored or returned by
  any cassette command.

**Limits — read before you record**

- Redaction is pattern-based. A secret that is not in one of the shapes
  above and is not the value of a matching environment variable (for example
  a key embedded in a base64 blob, split across two strings, or named
  `LLM_CRED` with fewer than 8 characters) can survive in the file.
- Absolute-path replacement is a heuristic. Relative paths, bare host names
  and `http(s)://` URLs are not treated as paths and are kept.
- Redaction covers text and body content. It does not restructure the
  cassette: the model name, provider name, tool names and tool argument keys
  stay visible, which is what makes the diff table useful.
- `cli.mjs redact` reads the environment of the process that runs it. A
  secret that only exists in the recording process's environment but not in
  yours is only caught by the pattern rules.
- Redaction is a safety net, not a guarantee. Review the file before it
  leaves your machine (see below).

## The environment variable

| Name | Values | Effect |
| --- | --- | --- |
| `COMFYRIZZ_LLM_CASSETTE` | unset / empty / anything unrecognised | The server's fetch is untouched — identical to no variable at all. |
| | `record:<file>` | Every OpenAI-compatible chat completion sent through the hooked fetch is recorded into `<file>`; the file is written after each entry and at process exit. The path must be inside `apps/server/.runtime/` or the working directory. |
| | `play:<file>` | The hooked fetch answers from `<file>` and never reaches the network. Unknown requests raise `Cassette miss`. |

Examples:

```bash
COMFYRIZZ_LLM_CASSETTE=record:apps/server/.runtime/session.cassette.json npm --prefix apps/server run start
COMFYRIZZ_LLM_CASSETTE=play:scripts/cassette/fixtures/launch-brief.cassette.json npm --prefix apps/server run start
```

## Review before committing

**Recordings must be reviewed before they are committed.** A cassette is a
transcript of a real session: it can contain a brief, project names, prompts,
tool arguments, and — if redaction missed a shape — a credential. Before
`git add`ing a cassette:

1. `node scripts/cassette/cli.mjs validate <file>` — it must be valid.
2. `node scripts/cassette/cli.mjs stats <file>` — the entry, message and tool
   counts must be the ones you expect; an empty or one-entry cassette is
   usually a mis-wired capture.
3. `node scripts/cassette/cli.mjs redact <file> <file>.clean.json` and read
   the redacted file yourself. If it contains anything you would not publish,
   the recording does not go in the repository.
4. Never commit a raw recording from `apps/server/.runtime/`; that directory is
   git-ignored on purpose.

## Coverage and limitations

- The hook is a **fetch wrapper**. The server installs it on the provider
  fetch it owns (the provider connection's model listing and the tool-use
  probe). Traffic that reaches the provider through a different fetch is not
  captured or replayed. After a record run, always confirm with `stats` that
  the expected turns are present before trusting the cassette; if they are
  missing, that traffic did not pass through the hooked fetch.
- Only `/chat/completions` POSTs with a `messages` array are recorded.
- A cassette replays exactly the recorded turns. Asking the agent something
  new during a `play:` run is a miss by design — cassettes are replay, not a
  cache.
- The request key ignores the model, so the same conversation replays under
  any model, but the *content* of a replayed answer is always the recorded
  one.

## Tests

The cassette code is offline-only: no network, no GPU, no server, no built
packages.

```bash
node --test scripts/cassette/format.test.mjs
node --test scripts/cassette/redact.test.mjs
node --test scripts/cassette/recorder.test.mjs
node --test scripts/cassette/player.test.mjs
node --test scripts/cassette/diff.test.mjs
node --test scripts/cassette/cli.test.mjs
node --test scripts/cassette/replay-smoke.test.mjs
node --test scripts/cassette/fixtures/fixture.test.mjs
node --test apps/server/test/cassette-hook.test.mjs
```
