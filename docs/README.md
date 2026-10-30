# Comfyrizz documentation

Start with the [project README](../README.md).

**No local GPU?** The default managed path deploys the ComfyUI inference stack
on Google Colab for you, from allocation and pinned model setup through generation,
collection and confirmed shutdown. Start with [One prompt setup](ONE_PROMPT.md)
and [Colab automation and compute allowances](features/google-colab.md).

## Recent production changes

- [Pi production runtime and ComfyUI contribution gate](PI_PIPELINE_MIGRATION.md):
  Pi 1.4 orchestration, trusted generation/render receipts and final-export checks.
- [Agent providers](AGENT_PROVIDERS.md): Node 22.19.0+ and the 65,536-token output
  allowance for the configured DeepSeek Flash routes.
- [Super Easy](ui/SUPER_EASY.md): exact custom durations from 1–120 seconds,
  proposal review and scoped same-project chat edits.
- [Deadline handoff](submission/DEADLINE_HANDOFF.md): dated verification,
  remaining end-to-end blockers and final artifact status.

## Features

- [Iterative production agent](features/production-agent.md): coordinator, plan cards and approvals, agent tools, guardrails, budget ledger and spend cap, evals
- [Iteration levels](ITERATION_LEVELS.md): Draft, Balanced, Director or Custom, chosen before any paid generation; never spend approval
- [Asset viewer](ASSET_VIEWER.md): thumbnails, filmstrips, region and time-range iteration
- [Character creator](features/characters.md)
- [Voice](features/voice.md): native model voice or Kokoro, no cloning
- [Research sources](features/research.md): use my URLs or search for me
- [Google Colab inference automation](features/google-colab.md)
- [Model-agnostic chat agent](features/chat-agent.md)
- [Timeline review and export](features/timeline-review-and-export.md)
- [Interface: Easy home and steps, Easy and Advanced, density, Kinetic ZZ brand](features/interface.md)
- [Testing](features/testing.md)

## Guides

Start with [One prompt setup](ONE_PROMPT.md), [Super Easy](ui/SUPER_EASY.md) and
[Managed hackathon demo](DEPLOYED_DEMO.md). For recording, see
[Procedure capture](ui/PROCEDURE_CAPTURE.md).

[SPEC](SPEC.md) · [Agent providers](AGENT_PROVIDERS.md) · [Conversation agent](CONVERSATION_AGENT.md) ·
[Agent cassette](AGENT_CASSETTE.md) · [Character creator](CHARACTER_CREATOR.md) ·
[Timeline review](TIMELINE_REVIEW.md) · [Reference assets](REFERENCE_ASSETS.md) ·
[Voice generation](VOICE_GENERATION.md) · [Motion styles](MOTION_STYLES.md) ·
[Compositions](COMPOSITIONS.md) · [Quality pipeline](QUALITY_PIPELINE.md) ·
[Pipeline observability](PIPELINE_OBSERVABILITY.md) · [Doctor](DOCTOR.md) ·
[Release check](RELEASE_CHECK.md) · [Default project](DEFAULT_PROJECT.md)

Specifications are in [specs/](specs/); hackathon material in [submission/](submission/). Other
files in this folder are dated test logs and research notes kept for the record.
