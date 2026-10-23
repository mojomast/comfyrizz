# Timeline review and export

**Timeline review** (`apps/server/src/takes/`, `apps/web/src/takes/`): every generated clip has
takes. Preview and A/B them, write a correction for one clip and regenerate only that clip. Clip
chips show states such as `planned`, `generating`, `review`, `approved` and `stale`. The final
render is gated by `n/m clips approved`; a `stale` clip blocks it, and **Render anyway** needs a
4–500 character reason. Full guide: [TIMELINE_REVIEW.md](../TIMELINE_REVIEW.md).

**Export** (`apps/server/src/export.mjs`): **Export MP4** or **Export bundle** (MP4, SRT/VTT
captions, `CREDITS.md` and a rights-filtered `package.zip` that ships only redistributable assets).
In a production, deliveries are versioned manifests with captions and a source/stem archive; see
[production agent](production-agent.md).
