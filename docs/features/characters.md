# Character creator

Characters live in a library outside any one project, so the same person or mascot can be reused
across projects. Code: `apps/server/src/characters/`, `apps/web/src/characters/`. Detailed guide:
[CHARACTER_CREATOR.md](../CHARACTER_CREATOR.md).

- **Define once.** Name, `@handle`, role, look, voice and bible, plus PNG, JPEG or WEBP references.
- **Pinned snapshots.** Adding a character to a project pins a revision. Library edits never change
  an existing project; the cast chip offers **Update to vN**. Edits honour `If-Match`, so a stale
  revision is a `409`.
- **Cast and mentions.** The cast strip above the chat composer lists members; `@handle`
  autocompletes and an unknown handle is reported, not invented.
- **Identity.** Klein multi-reference editing by default; PuLID or a trained LoRA for fictional
  characters when available, with a visible fallback. **Generate sheet** makes a turnaround sheet
  behind its own spend approval.
- **Speakers.** Each scene can name a cast speaker; see [voice](voice.md).
- **Real people** need a consent record (who, when, scope) before saving.
