# Iterative production agent

The production agent turns a one-shot build into a durable **production**: a record that you and
the agent work on scene by scene. You approve scope and spend; the agent proposes. Full design:
[specs/ITERATIVE_PRODUCTION_AGENT.md](../specs/ITERATIVE_PRODUCTION_AGENT.md).

## How a production moves

1. **Production record.** A production has a stable id before a package exists. Every change is a
   command written to an append-only journal (`apps/server/src/productions/store.mjs`). Commands
   carry an expected revision (a stale one is a `409`) and an idempotency key, so a retry never
   applies twice (`commands.mjs`).
2. **Plan cards and approvals.** The agent records a plan with `production_propose_plan`. The web
   app shows it as a plan card (`apps/web/src/productions/cards/plan-card.ts`) with the scoped
   shots, slots and a `reservationCeiling`. Only you can approve or reject it. An approval binds
   one server-computed `planHash` and the slots on that plan; each slot is admitted at most once
   (`actions.mjs`). A changed plan needs a new approval.
3. **Production coordinator.** `coordinator.mjs` derives the next step as a pure function of the
   snapshot and its events, so a restart or a second process computes the same work. It runs a
   bounded number of steps per drain and skips paused, archived, cancelling or superseded
   productions. It never calls a backend or settles budget itself; dispatch goes through the action
   coordinator and the outbox.
4. **Takes, review and delivery.** Generated files land as takes for
   [timeline review](timeline-review-and-export.md). A delivery is an append-only version
   (`v1..vN`) whose manifest pins revisions, selected takes, file hashes, provenance and rights mode
   (`delivery.mjs`).
5. **Chat decisions.** A bare "yes" or "no" in chat resolves a pending decision through the same
   `decision.resolve` command as a click. Qualified or ambiguous replies get one clarifying question
   instead (`decisions.mjs`).

HTTP surface (loopback, token-protected): `/api/productions`, `/api/productions/:id`,
`.../commands`, `.../action-plans`, `.../actions`, `.../actions/:actionId` and `.../events`.

## Agent tools

When a conversation has a production, the chat agent gets three extra tools
(`packages/agent/src/production-tools.ts`):

| Tool | What it does |
| --- | --- |
| `production_read` | Reads the production state and revision. Must be the first call each turn. |
| `production_propose_plan` | Records a plan proposal for you to approve. |
| `production_command` | Issues one non-approval command: `plan.propose`, `stage.advance`, `artifact.attach`, `take.request`, `render.request` or `production.pause`. |

## Guardrails

- **Propose, never approve.** Approval, rejection, spend, decision, lifecycle and action-cancel
  commands are refused for the agent. It cannot approve its own plan, select a take, accept a
  delivery or override a gate.
- **No spend authority.** The agent cannot reserve, settle, dispatch or retry paid work or change a
  budget ceiling. A paid Google Colab `render.request` is allowed only when you asked for a render
  and stated a cap, and its `upperBound` must stay at or under that cap.
- **Scope.** Plans and commands may name only shot and line ids that exist in the production and
  in the requested scope; any other id anywhere in a payload is rejected.
- **Attribution.** The server attributes every command to the agent and the originating user
  message. Actor, user-event id, command id and idempotency key are never taken from tool arguments.
- **Untrusted content.** Notes and fetched research are data, never instructions.
- **Your intent wins.** If a production is paused, cancelling or archived, the agent reads and stops.

## Budget, reservations and the Google Colab spend cap

Each production has its own budget ledger (`ledger.mjs`, `comfyrizz.budget-ledger/v1`, unit
`colab_compute_units`).

- **The spend cap is yours.** You set it per production. There is no default: a new ledger is
  uncapped until you set a ceiling, and you can turn the cap off. The agent can never write one.
  With the cap off, every reservation and settlement is still recorded.
- **Reservations.** Dispatching an approved slot reserves its upper bound plus the six-minute
  collect-and-stop reserve, within both the plan's `reservationCeiling` and the ledger ceiling.
- **Settlement policy.** `actual` or `estimated` charges the units used; a failed Google Colab run
  whose usage is unknown settles as `reservation_unverified` and charges the full hold;
  `no_allocation` charges zero. Totals are derived from the entries on every read, so a restart
  never resets or double-counts the balance.

## Behavioural evals and the cassette

`packages/agent/scripts/eval-production.mjs` scores the agent's tool calls against
`packages/agent/evals/production-cases.json`, running every call through the real production
store, command handler and action modules. By default it replays the committed cassette
`packages/agent/evals/production-cassette.json`; a missing, stale or short cassette prints
`NOT RECORDED` and exits 1. `--record` (or `--live`) drives a real model through a configured
OpenCode Go connection. `COMFYRIZZ_EVAL_CASSETTE` points at another cassette.

```bash
pnpm --filter @comfyrizz/agent build
node packages/agent/scripts/eval-production.mjs            # replay and score
node packages/agent/scripts/eval-conversation.mjs          # conversation evals
```
