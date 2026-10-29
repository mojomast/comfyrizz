# Model-agnostic chat agent

The chat agent (`packages/agent`, `packages/llm`, `apps/server/src/agent-chat.mjs`) uses
**Pi 1.4** for its bounded, schema-validated production tool loop against an
OpenAI-compatible endpoint: OpenRouter, OpenCode Go or a
custom server. Configure profiles in **Agent settings**; details in
[AGENT_PROVIDERS.md](../AGENT_PROVIDERS.md) and [CONVERSATION_AGENT.md](../CONVERSATION_AGENT.md).

- A built-in **local · scripted model** supports offline planning/editing diagnostics with no key.
- **Plan mode** asks up to three questions and builds nothing until you confirm.
- Cassettes (`COMFYRIZZ_LLM_CASSETTE=record:<file>|play:<file>`) record and replay sessions under
  any model; see [AGENT_CASSETTE.md](../AGENT_CASSETTE.md).
- With a production attached, the agent also gets the [production tools](production-agent.md).
- The agent never chooses where the MP4 renders and never starts a Google Colab session itself.

Pi also coordinates initial planning, proposal/narration revisions, repairs and
continuation. Deterministic services retain approval, spending, media execution
and export authority. See [Pi production migration](../PI_PIPELINE_MIGRATION.md).
The default managed media backend deploys the inference stack on Google Colab,
so users need no local GPU ([Colab guide](google-colab.md)). Final delivery still
requires visibly used, verified ComfyUI media and trusted receipts.

Use **Open in editor → project chat** for scoped edits to the current package.
Scene IDs, package binding and revision checks preserve project identity and
reject stale edits. Arbitrary asset/conditioning/source-timing changes are not
all supported; review the proposed change and resulting export.
