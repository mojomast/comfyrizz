# Model-agnostic chat agent

The chat agent (`packages/agent`, `packages/llm`, `apps/server/src/agent-chat.mjs`) runs a bounded,
schema-validated tool loop against any OpenAI-compatible endpoint: OpenRouter, OpenCode Go or a
custom server. Configure profiles in **Agent settings**; details in
[AGENT_PROVIDERS.md](../AGENT_PROVIDERS.md) and [CONVERSATION_AGENT.md](../CONVERSATION_AGENT.md).

- A built-in **local · scripted model** runs the whole CPU path offline with no key.
- **Plan mode** asks up to three questions and builds nothing until you confirm.
- Cassettes (`COMFYRIZZ_LLM_CASSETTE=record:<file>|play:<file>`) record and replay sessions under
  any model; see [AGENT_CASSETTE.md](../AGENT_CASSETTE.md).
- With a production attached, the agent also gets the [production tools](production-agent.md).
- The agent never chooses where the MP4 renders and never starts a Google Colab session itself.
