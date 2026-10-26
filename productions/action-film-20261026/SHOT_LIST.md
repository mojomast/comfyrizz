# Shot list skeleton

Generated from `shots.skeleton.json` by `node tools/validate-package.mjs --markdown`.
Edit the JSON, then regenerate; `node --test tools/package.test.mjs` fails when this file is stale.

Edited length is 2880 frames at 24fps (120s). `Gen fr` is the generated length on the H3 17n+5 grid (22, 39, 56, 73, 90, 107, 124, 141, 158, ...); for example 124 frames is 5.1667s, not 5s. `-` means a still animated deterministically in Remotion/FFmpeg. The `Measured fr` column is filled from decoded takes; edit from measured frames.

| ID | Beat | Edit fr | Gen fr | Measured fr | Dominant action | Contact / result | Risk tier | Model path | Fallback | Flags |
|---|---|---:|---:|---:|---|---|---|---|---|---|
| S01 | hook | 96 (4.00s) | - |  | Locked-off wide: rockfall seals the canyon gate | Boulder lands at the gate base; dust plume; gate visibly closed | batch | flux3-still | remotion-deterministic |  |
| S02 | hook | 84 (3.50s) | 90 |  | char_c_small drops from a cliff ledge, lands on all fours and skids | Feet/palms meet ground; body compresses then settles; dust at the skid | pilot P1 | fasth3-omni | ltx25-fallback | landing |
| S03 | hook | 96 (4.00s) | 107 |  | char_a_heavy lumbers in and shoulder-bumps the gate | Shoulder meets gate; gate does not move; dust sifts down | batch | fasth3-omni | ltx25-fallback | heavy-contact |
| S04 | hook | 84 (3.50s) | 90 |  | Close on char_a_heavy: realization and sag | Eyes narrow then widen; shoulders drop; settle into a held beat | pilot P3 | fasth3-omni | ltx25-fallback | face-stability |
| S05 | team | 120 (5.00s) | 124 |  | char_b_spindly unfolds from a perch and points to a crank wheel high on the cliff | char_b_spindly pincer points; char_c_small turns head to the wheel | batch | fasth3-omni | ltx25-fallback | two-character-framing |
| S06 | team | 120 (5.00s) | 124 |  | char_a_heavy cups hands and launches char_c_small upward | char_c_small steps into char_a_heavy's hands; launch; char_c_small leaves frame top | batch | fasth3-omni | ltx25-fallback | multi-character-handoff |
| S07 | team | 120 (5.00s) | 124 |  | char_b_spindly strides across stepping stones in a staccato rhythm | Each foot plant visible on a stone; stone wobbles on the last step | batch | fasth3-omni | ltx25-fallback | locomotion |
| S08 | team | 120 (5.00s) | 124 |  | char_c_small grips the crank wheel and pushes: first attempt | Wheel rotates a quarter turn then jams; jam pin pops out; wheel state changes from rest to jammed | pilot P2 | fasth3-omni | ltx25-fallback | hand-prop-state-change |
| S09 | escalate | 144 (6.00s) | 158 |  | char_b_spindly pole-vaults a collapsing gap | Pole plants and bends; body clears gap; pole lands on far side | batch | fasth3-omni | ltx25-fallback | prop-in-hand, locomotion |
| S10 | escalate | 120 (5.00s) | 124 |  | char_c_small scrambles up a crumbling wall | Foot on stone, stone breaks away and falls; second foothold holds | batch | fasth3-omni | ltx25-fallback | hand-prop-state-change |
| S11 | escalate | 132 (5.50s) | 141 |  | char_a_heavy swings a mallet at the jam pin | Mallet strikes pin; pin shears and drops; sparks | batch | fasth3-omni | ltx25-fallback | hand-prop-state-change, heavy-contact |
| S12 | escalate | 144 (6.00s) | 158 |  | Crank wheel spins free; gate chains rattle taut | Wheel rotation drives chains; gate rises one hand-width | batch | fasth3-omni | remotion-deterministic | mechanism |
| S13 | escalate | 132 (5.50s) | 141 |  | char_b_spindly and char_c_small tumble as the ledge collapses | Ledge breaks under both; both fall toward camera-left | batch | fasth3-omni | ltx25-fallback | multi-character-handoff, falling |
| S14 | escalate | 120 (5.00s) | 124 |  | char_a_heavy catches char_b_spindly and char_c_small mid-fall | char_a_heavy's arms close around both; char_a_heavy skids to a stop | batch | fasth3-omni | ltx25-fallback | multi-character-handoff |
| S15 | escalate | 144 (6.00s) | - |  | Wide: storm front rolls toward the canyon | Storm edge reaches the near ridge; light drains from the ground | batch | flux3-still | remotion-deterministic |  |
| S16 | escalate | 144 (6.00s) | 158 |  | char_a_heavy braces under the slipping gate | Gate bottom lands on char_a_heavy's shoulders; legs bend; gate holds | batch | fasth3-omni | ltx25-fallback | heavy-contact, body-reaction |
| S17 | solution | 120 (5.00s) | 124 |  | char_b_spindly and char_c_small slip under the lifted gate past char_a_heavy | Bodies pass under gate edge without touching it | batch | fasth3-omni | ltx25-fallback | locomotion |
| S18 | solution | 120 (5.00s) | 124 |  | char_c_small lifts the lantern off its pedestal | Hands lift lantern; pedestal clicks; lantern state changes from dark to lit | batch | fasth3-omni | ltx25-fallback | hand-prop-state-change |
| S19 | solution | 120 (5.00s) | - |  | Floor glyphs light in a ripple from the pedestal | Glyph rows light in sequence toward the gate | batch | flux3-still | remotion-deterministic |  |
| S20 | solution | 120 (5.00s) | 124 |  | char_a_heavy rolls out as the gate drops behind | Gate lands where char_a_heavy was; dust blast; char_a_heavy comes up on one knee | batch | fasth3-omni | ltx25-fallback | locomotion, heavy-contact |
| S21 | solution | 120 (5.00s) | 124 |  | All three regroup; char_c_small raises the lantern into the storm | Storm edge parts around the lantern light; characters look up | batch | fasth3-omni | ltx25-fallback | multi-character-framing |
| S22 | payoff | 72 (3.00s) | - |  | Lantern light spreads across the canyon wall | Light front reveals a painted mural; wall visibly changes from dark to lit | batch | flux3-still | remotion-deterministic |  |
| S23 | payoff | 60 (2.50s) | 73 |  | char_a_heavy breaks into a simple smile | Mouth and cheeks move; eyes soften; settle | batch | fasth3-omni | ltx25-fallback | face-stability |
| S24 | payoff | 72 (3.00s) | 73 |  | char_b_spindly and char_c_small bump fists/pincers | Contact point visible; both recoil slightly | batch | fasth3-omni | ltx25-fallback | multi-character-contact |
| S25 | payoff | 60 (2.50s) | 73 |  | Wide: the three walk away along the ridge at dusk, screen-left to screen-right | Silhouettes cross the ridge; lantern glow recedes | batch | fasth3-omni | ltx25-fallback | locomotion |
| S26 | close | 36 (1.50s) | - |  | Close: lantern flame flickers | Flame sways then steadies | batch | flux3-still | remotion-deterministic |  |
| S27 | close | 36 (1.50s) | - |  | Title card over a stylized still | Title text resolves over the still | batch | flux3-still | remotion-deterministic |  |
| S28 | close | 24 (1.00s) | - |  | Fade to end card | Image and audio fall to black/silence on the final frame | batch | flux3-still | remotion-deterministic |  |
