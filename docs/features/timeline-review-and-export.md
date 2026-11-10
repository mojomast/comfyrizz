# Timeline review and export

**Timeline review** (`apps/server/src/takes/`, `apps/web/src/takes/`): every generated clip has
takes. Preview and A/B them, write a correction for one clip and regenerate only that clip. Clip
chips show states such as `planned`, `generating`, `review`, `approved` and `stale`. The final
render is gated by `n/m clips approved`; a `stale` clip blocks it, and **Render anyway** needs a
4–500 character reason. Full guide: [TIMELINE_REVIEW.md](../TIMELINE_REVIEW.md).

**Money shot.** Every default MP4 opens on a finished hero. Frame 0 is the
scene with `scene.hero: true` when one is set (the optional package flag, also
used for Balanced iteration picks, and separate from layout `"hero"`).
Otherwise the renderer scores the film: layout `hero`, then title, stat,
chart, split, list, and code, with extra weight for a headline, picture,
background plate, or drawing. Outros and textless media-only plates rank
lower. That scene is drawn at the local frame where its entrance has settled
and held until the timeline reaches it. If that shot is later in the film, it
is a short picture-only cold open; the opening scene is already revealed when
the cold open ends. Narration, music and captions stay on the compiled frames,
and the export is the same length. The compiler does not insert frames. Set
`COMFYRIZZ_MONEY_SHOT=0` (`false`, `off`, and `no` also work), or pass
`moneyShot: false` to `renderPackage`, to keep the fade-in.

**Export** (`apps/server/src/export.mjs`): **Export MP4** or **Export bundle** (MP4, SRT/VTT
captions, `CREDITS.md` and a rights-filtered `package.zip` that ships only redistributable assets).
In a production, deliveries are versioned manifests with captions and a source/stem archive; see
[production agent](production-agent.md).
