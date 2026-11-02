
## Chain progress and voiceover reuse (feat/vo-cache-chain-progress)

- **Chain progress.** Last-frame chaining keeps the previous clip's composition, so a shot that is a
  new beat never happened (Goat Getaway: the hay-bale jump and pond crash stayed in the sunflower
  field). The planner now compares each chained shot's still prompt with the previous one. A new beat
  (4+ new content words) re-anchors on the shot's own keyframe; identity is held by the character
  locks and the identity check. A continuation keeps the last-frame chain. Per shot:
  `gen.chainMode: auto | lastFrame | reanchor` (`chainFromPrevious` still overrides).
  The clip judge is told a chained clip must show its own action. A chained clip that fails the
  prompt check is re-rendered once from its own keyframe (`ref_clip_verdict.stalled`).
  First-plus-last-frame control (LTXVAddGuide with frame_idx -1) is the next step; it needs a
  workflow change and a live check.
- **Voiceover take cache.** `chatterbox_narrate.py --cache <previous out>` reuses every take that
  passed the speech check when the line text matches word for word, and only voices changed or
  failed lines. `voice.takes`: `cache`, `maxTakesPerLine`, `riskyMaxTakes`. Lines likely to loop
  (short lines, colon fragments, repeated words, odd names, alphanumerics) are pre-flagged
  (`take_report.risky`) and capped; the best take is kept.
