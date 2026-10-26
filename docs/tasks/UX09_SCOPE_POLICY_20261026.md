# UX09 — Authoritative scope across agent tools

Packet UX09 of `docs/tasks/UX_RESULTS_REMEDIATION_20261026.md`. Status:
**component verified and mounted at the chat route** (`/api/agent/chat` over
HTTP with a scripted model). No change to `app.mjs` or `main.ts` is needed for
the fix itself; the optional host wiring is listed at the end.

## Contract

One mutation policy decides every tool that can change a production-bound
project: the production tools (`production_propose_plan`, `production_command`)
and the ordinary project tools (`project_update_plan`, `project_patch_plan`,
`project_build`). An unbound project is not restricted.

### Where the rules live

| Piece | Location |
| --- | --- |
| UX00 mirror: id patterns, `MUTATION_REFUSAL_CODES`, `normalizeTargetSet`, `targetSetAllows` | `packages/agent/src/mutation-policy.ts` |
| Policy: intent, target set, locks, draft diff, remaining capacity | `packages/agent/src/mutation-policy.ts` |
| Production tools use it | `packages/agent/src/production-tools.ts` |
| Ordinary tools use it (`guardOrdinaryMutation`) | `packages/agent/src/conversation.ts` calls `production-tools.ts` |
| Planner shares the capacity logic | `packages/agent/src/production-planner.ts` |
| Chat route builds the context | `apps/server/src/agent-chat.mjs` |

The agent mirror passes `apps/server/test/fixtures/ux00/scope.json` and is
compared with the server module's exports in
`packages/agent/test/ux09-mutation-policy.test.ts`.

### Requested targets

| Input | Meaning |
| --- | --- |
| no `targets`, no chips, no `iterationScope` | `unscoped`: every shot, still subject to read, intent, lock and preserve rules |
| `targets: { shotIds: [], lineIds: [] }` | `empty`: nothing may change. Reads and the pause safety stop remain |
| `targets: { shotIds: [...], lineIds: [...] }` | `scoped`: a shot id permits the whole shot, a line id only that line |
| malformed `targets` | HTTP 400, `code: "INVALID_TARGETS"`, before any model call |
| turnContext chips | canonical ids (`s_intro`, `s_intro:l2`, a clip means its shot) or real shot/line ids of the production, or numeric prose such as "shot 2 line 1". A chip that names nothing is ignored. No named target leaves the turn unscoped, never empty |
| viewer `iterationScope` | line scope when it has `elementRef.lineId` (voice line), else its shot, else the shot of its clip. A target with no resolvable shot authorizes nothing (`SCOPE_UNRESOLVED`) |
| `iterationScope` and chips together | the intersection. If they share nothing: `SCOPE_EXPANSION` |
| `iterationScope.sourceRevision.packageRevision` != current package revision | `SCOPE_STALE` |

The effective set is computed once per turn in `effectiveTargets` and used by
both tool families.

### Refusal vocabulary

Every refusal is `{ ok: false, error, code }`, and the chat trace carries
`code` on the failed tool entry. A policy refusal does not spend the repair
budget; the model is told not to retry or work around it.

| Code | When |
| --- | --- |
| `READ_REQUIRED` | production mutation or `project_build` without `production_read` this turn |
| `REVISION_CONFLICT` | stale `expected_revision`, or the production moved between the read and the build |
| `PRODUCTION_NOT_ACTIVE` | intent is paused, cancel_requested or archived, for any mutation |
| `SCOPE_EMPTY` | the requested target list is empty |
| `SCOPE_EXPANSION` | an id, shot, project-wide field or structural change outside the target set; a different `plan.scope`; a slot for another shot or line |
| `SCOPE_UNRESOLVED` | a target or named id is not a shot or line of this production, or an unusable scope or target list |
| `SCOPE_STALE` | the viewer scope was authored against another package revision |
| `PRESERVE_VIOLATION` | an element scope's slot would change an element it says to preserve (an audition under a voice-preserving scope; a visual slot under a voice-line scope) |
| `ITERATION_SHOT_LOCKED` | text edit, draft edit or paid slot on a locked shot |
| `ITERATION_EXCEEDED` | a slot beyond the stage's takes x rounds minus what is used |

`ITERATION_EXCEEDED` is an existing server code (`productions/contract.mjs`),
not in `MUTATION_REFUSAL_CODES`. It is the one code outside the UX00 list.
**Amendment request to UX00:** add it to `MUTATION_REFUSAL_CODES` and to
`scope.json`, with the agent mirror, in the same change.

### Ordinary tools

- `project_update_plan` and `project_patch_plan` compute the draft they would
  leave and diff it against the current draft by scene id. Changed, added,
  removed and reordered scenes, and project-wide fields, are the change set.
- `project_build` diffs the draft against the plan the package was last built
  from (`builtPlan`; the draft at the turn's start when the host gives none).
- Draft edits and builds are whole-shot changes. A line-only scope therefore
  cannot authorize them. The refusal says to use `production_propose_plan`, the
  approval path for a single line.
- A first draft has no baseline: it is project-wide (refused under a scope) and
  names no existing shot (no lock applies).
- Draft edits need no `production_read`. A build needs one in the same turn and
  re-reads the production to confirm it has not moved.
- The explicit UI `action: "build"` applies a reviewed draft and does not run
  through the tool loop. It is unchanged.

### Planner

`remainingStageCapacity` (takes x rounds minus used) is shared by the planner
and the tool guard, so a take the planner proposes is never one the guard
refuses. A scoped turn on a locked shot gets a refusal reply with no proposal. A
scoped turn on an exhausted stage asks whether to change the level and proposes
nothing. Named ids in prose are recognised when they are real ids of the
production.

## Compatibility

- `productionState.requestedShotIds` / `requestedLineIds` still work. Absent
  means unscoped. Both present and empty means nothing may change (this
  changes: the route used to send `[]` for no chips). Requested lines narrow to
  those lines; requested shots alone permit those shots.
- `<production_context>` gains `targetMode`.
- `ConversationTrace.tools[]` gains optional `code`.
- No persisted field, no route, no schema change.

## Handoff

- **UX17, then UX18** (`chat-project.mjs`, agent files): keep `guardOrdinaryMutation`
  in front of every tool that changes the draft or package. A new mutating tool
  adds a name to `OrdinaryMutationTool` and a call in `conversation.ts`. Do not
  add a private copy of the target-set rules.
- **Coordinator, `main.ts`:** send `targets` only when chips exist, and map the
  legacy scene-valued viewer `lineId` into `shotIds`. Never send `[]` for no
  selection.
- **Coordinator, `app.mjs`:** the production adapter's `read` does not return
  `lockedShotIds`, so locks are enforced only when the adapter supplies them.
  Return `lockedShotIds` (see `lockedShotIdsFor` in
  `productions/iteration-routes.mjs`) from the `production.read` adapter given
  to `createProjectChat`. No other wiring is needed.

## Limitations

- Ordinary tools cannot be narrowed to one line, only to shots (above).
- `sourceRevision.productionRevision` is accepted but not enforced: the
  production revision moves on unrelated events, so pinning to it would refuse
  valid turns. Only `packageRevision` makes a scope stale.
- A build when no `builtPlan` exists and no draft existed at the start of the
  turn treats the whole project as changed.
- Preserve checks cover slots (audition versus visual). A text edit under a
  background scope that preserves the voice is allowed, as before (AV15).
