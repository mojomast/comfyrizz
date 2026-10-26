# Casting voice continuity

This document describes the approved-recording and native-transfer path added by
UX14. It is deliberately narrow: it records what the code can prove. A fixture
that plans a test, or a technical transcript that happens to match, is not a
listening review and does not establish voice quality.

## What is approved

A voice reference is one recording that the user has explicitly approved for one
character. The canonical shape is `comfyrizz.voice-reference/v1` in
`apps/server/src/characters/voice-projection.mjs`.

| Field | Meaning |
| --- | --- |
| `referenceId` | Stable id for this reference record. |
| `characterId` | The one character that owns the reference. |
| `kind` | `recording`. |
| `audio.sha256` | 64-character checksum of the exact approved bytes. |
| `audio.bytes` | Exact byte count of the approved recording. |
| `audio.mimeType` | Declared audio type; the default is `audio/wav`. |
| `language` | Language tag such as `en-us` or `fr-fr`. |
| `delivery` | The user's delivery direction, for example `low and measured`. |
| `provenance` | `source`, optional origin project, optional capture time and note. |
| `status` | `approved` or `rejected`. |
| `decidedBy` | Always `user`; an agent or a pipeline result cannot decide. |
| `availability` | `available` or `missing`, with a reason when missing. |

Paths, local file names, expiring URLs and media tickets are not reference
identity. A record that carries one of those fields is refused instead of being
silently persisted. The portable projection keeps the checksum and byte count
unchanged, so moving the same reference into another project does not rewrite
the approved bytes.

## Explicit selection, rejection and missing bytes

Selection is explicit. The browser and server do not auto-select one of several
approved references, and they never fall back to another character's recording.

- **Approved and available:** the reference may be selected for its own
  character.
- **Rejected:** the record remains visible as a rejection, but it cannot be
  selected and cannot produce a transfer test.
- **Missing bytes:** the approved record still names its checksum, but selection
  is refused with `VOICE_REFERENCE_MISSING`. The character is not recast and no
  other reference is substituted.
- **Foreign reference:** selecting another character's reference is refused with
  `VOICE_REFERENCE_FOREIGN_CHARACTER`.

The browser module `apps/web/src/characters/voice-reference.ts` mirrors this as a
read-only state. Its statuses are `approved`, `rejected`, `missing`,
`unavailable`, `selection_required`, `foreign` and `invalid`. It displays the
short checksum, language, delivery and provenance, but it does not create an
approval, a selection or an audio URL.

## Actual backend capability

`inspectVoiceTransferCapability` reads only explicit declarations:

- `model.capabilities.voiceTransfer === true`;
- a workflow conditioning entry of `voice_reference_audio`.

The model name or workflow label is shown for context and never treated as
evidence. A model called “Google Colab native voice” with no declared capability
is unsupported. If the model or workflow is missing or does not declare the
required capability, the capability report is unsupported and the plan is
refused with `NATIVE_TRANSFER_UNSUPPORTED`. No modality is promised because a
label exists.

## Native transfer test

`buildNativeTransferTest` in `apps/server/src/productions/native-test.mjs` plans
one test, not a render. It never starts a backend, reserves budget or dispatches
work. The planned record is frozen and carries:

- the exact character and approved reference;
- the reference checksum and byte count;
- the model id and its declared transfer/native flags;
- the workflow id and revision;
- the conditioning list, including `voice_reference_audio`;
- the exact line and language.

The dependency set is the invalidation key. A transfer test is accepted only
while the same reference bytes, model and workflow revision still apply. A
changed recording, model or workflow invalidates the test and any prior human
verdict.

## Technical evidence and the human verdict

The test record is technical evidence. `nativeTransferStatus` reports
`unreviewed` until a separate human verdict exists. A clean transcript, a
matching ASR result or another technical success flag does not approve acting
and does not change the status to accepted.

`recordNativeTransferVerdict` records a verdict only when `reviewedBy` is
`user`. The verdict is a separate record bound to the test id; it is either
`accepted` or `rejected`. A rejected verdict is terminal for that exact test. An
accepted verdict is invalidated by any dependency change. Agents, fixture
results and the technical review cannot create or borrow a verdict.

Real dry audition and native-speaking validation remain a separately authorized
human acceptance step. Fixture success establishes the contract and the
invalidation rules, not voice quality.

## Returning characters and appearance-only edits

Returning characters reuse their own approved reference in a new project. The
projection is per character; it never copies another character's bytes or turns
a global preference into voice identity.

An appearance-only edit, such as a wardrobe or identity-image change that leaves
the `voice` record unchanged, keeps the same voice and reference. A real voice
change is reported as `voice_changed` and does not silently reuse the old
approval. This keeps a returning Basil, Molty or Don Piedro separate: each keeps
their own reference and their own transfer tests. Basil, Molty and Don Piedro
are never treated as interchangeable voices.

## Fixture decisions

The UX14 fixtures keep the named characters separate:

- Basil, Molty and Don Piedro each have their own approved reference checksum.
- Selecting Molty's reference for Basil is refused.
- QC1 and QC2 are explicitly rejected references and cannot be selected or used
  to build a transfer test.
- A missing-byte reference refuses selection rather than recasting the
  character.

## Checks

Local checks use fixtures only. They make no network request, start no GPU and
do not call Google Colab:

```bash
node --experimental-strip-types --test apps/web/src/characters/voice-reference.test.ts
node --test apps/server/test/characters/native-transfer.test.mjs
```

The test files use labelled fixture hashes rather than media files. The release
scan does not treat a hash or a language tag as a secret.
