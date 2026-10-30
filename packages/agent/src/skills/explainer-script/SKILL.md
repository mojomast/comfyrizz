---
name: explainer-script
metadata:
  version: "1.2.0"
description: Write concise, factual on-screen copy and speakable narration.
---
# Explainer script

Choose one governing idea and give each scene a distinct job in explaining it.
Start with a relevant question, concrete situation, or useful promise; show how
the idea works; then land the takeaway. This is a flexible progression, not a
mandatory template. Avoid generic openings and empty closing slogans. Educational
content does not need a sales pitch or a call to action unless requested.

Write the actual words the audience will see and hear. Replace directions such as
“explain the benefits here” with finished copy. Make headlines meaningful at a
glance, supporting text selective, and narration conversational. Let narration
explain relationships while the screen supplies labels, examples, or a memorable
summary. Do not make every surface repeat the same paragraph. Read the narration
mentally aloud and simplify awkward phrasing, jargon, and stacked clauses.
For each beat ask what the picture adds beyond the spoken words. Prefer an example
with a visible cause and result over a capability list. For comedy, separate setup,
reveal and reaction; keep surprise-causing information out of setup copy and narration.

For planning, budget roughly 1.8 spoken words per second of usable scene time,
after allowing about half a second of synthesis padding per narrated scene and
accounting for transition overlaps. Leave room for pauses, visual inspection and
emphasis. This is a heuristic, not a measured duration: language, voice, delivery
and subject complexity change the pace. Check both each scene and the entire film.
If the draft overruns, remove secondary
ideas or split a dense beat within the tool's constraints; do not simply demand
faster speech or silently extend a requested duration.
Vary beat lengths by purpose; leave deliberate inspection or reaction time, not
uniform padding. When measured narration is available, use it to revise shot
coverage and cue timing before final production. Script estimates are provisional.

Reduce redundant supporting copy, not access to speech. Preserve accurate captions
and meaningful sound information. Write short clauses that can form natural caption
groups; never remove qualifications to fit. Review caption width, reading time and
diagram labels together at the intended playback size. Aim for two lines in landscape;
portrait may need three. These are review targets, not guarantees from script text:
the chat schema does not expose caption segmentation or soundtrack cues.
Sidecar captions may still overlay the picture; they do not automatically free
layout space. Use actual player/platform geometry, not universal safe-zone or
character-count claims. Caption grouping need not split the scene.

Separate established facts from illustrations. Preserve supplied qualifications,
units, names, and causal limits. Never invent evidence, quotations, testimonials,
or metrics. Use clearly hypothetical examples when helpful and omit unsupported
claims; ask only when missing facts are essential to the explanation.

Follow the active tool schema for text limits and scene structure rather than
adding fields. Save a new complete draft with project_update_plan; use
project_patch_plan for focused changes to an existing draft. Narration remains
script text until audio is actually synthesized. Describe draft and build results
accurately, without claiming a finished soundtrack or export.

For native generated dialogue, use a shot-specific conditioning sample containing
only the intended line. Preserve character voice, language, accent, intentional
grammar and delivery; measure the sample with padding at natural speed against
the editorial slot, not the longer generated source. Revise an overfull line or
explicitly rebalance timing. Voice references can leak their words even when the
prompt asks for timbre only. Exact-line conditioning is a mitigation to test, not
a guarantee. Keep finished native audio, and disable duplicate narrator tracks.

For fictional shorts/miniseries, write the complete dramatic scene before splitting
it into generation jobs. Give each character a want, an opposing tactic and an
unspoken concern; make the exchange change a decision, relationship or available
option. Replies should respond to the previous thought: challenge, evade, bargain,
concede or reveal. More complex dialogue means connected subtext and consequences,
not longer exposition or a punchline after every sentence. Preserve distinct
vocabulary, intentional grammar and recurring emotional concerns. Pay off earlier
choices and end with a changed situation that motivates the next episode.

One model shot is coverage, not an entire dramatic scene. Vary turn length and
leave measured time for listening, hesitation and reaction. Preserve geography and
eyelines across coverage. Let important lines land on a listener or a meaningful
insert where editing supports it. J/L cuts require independently placed native
audio and picture; they are editorial instructions, not a fade transition or
invented chat field. Table-read the whole exchange at natural speed before
generating a representative sample; then review it as a scene, not isolated clips.

## Sources

Original wording informed by clear writing and multimedia explanation principles:
- [Plain language guidelines](https://www.plainlanguage.gov/guidelines/)
- [Richard Mayer: multimedia learning research](https://psych.ucsb.edu/people/faculty/richard-mayer)
- [BBC Subtitle Guidelines, March 2026](https://www.bbc.co.uk/accessibility/forproducts/guides/subtitles/)
- [W3C captions guidance](https://www.w3.org/WAI/media/av/captions/)
- [BBC Writers: scenes and subtext](https://www.bbc.co.uk/writers/resources/scriptwriting-essentials/6-scenes)
- [Scriptnotes: conflict and stakes](https://johnaugust.com/2024/scriptnotes-episode-655-conflict-and-stakes-compendium-transcript)
- [Editing dialogue scenes and reactions](https://www.studiobinder.com/blog/how-to-edit-a-dialogue-scene/)
