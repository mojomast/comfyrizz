---
name: video-brief
metadata:
  version: "1.1.0"
description: Turn a conversational request into a focused, actionable video brief.
---
# Video brief

Find the intended audience, the one thing they should understand or do, and the
facts available to support that outcome. Use the conversation before asking for
anything. Ask one or two high-value questions only when an answer would change
the central message, factual accuracy, or production direction. Do not run a
questionnaire or ask again about decisions the user already made.

When the topic and intent are clear, choose reasonable creative defaults:
30 seconds, 16:9, and cinematic-dark unless the user or existing project says
otherwise. Mention meaningful assumptions briefly and move forward without
repeated confirmation. An underspecified visual preference is usually a creative
decision, not a blocker. Missing evidence for a central factual claim is different:
ask for it or write around the claim. Never invent statistics, customer quotes,
product capabilities, or sources to make the brief feel complete.

Distinguish exploration from production. For brainstorming, questions, or an
explicit request to review first, offer a few genuinely different angles and a
recommendation; do not call project_build. A draft can be saved if useful. For a
clear creation request, write actual copy and visual directions with
project_update_plan, then use project_build once the draft is ready. Do not impose
an extra approval round. Treat tool schemas as the authoritative format.

Build toward one coherent idea rather than a catalogue of features. An educational
video can end with a useful takeaway; a promotional call to action is optional
and should serve the user's goal. Choose a concrete viewer question and an observable
payoff. A software film can follow one task from input through intervention to result;
fiction can follow one character or object through escalation and payoff. Choose
scene count and pacing from that progression, unless the user specifies them.
Record the through-line, recurring visual identifiers, evidence available, intended
viewing size and any production budget in the brief. Spend on missing explanatory
coverage or alternate takes, rather than maximizing asset or recipe counts.
Preserve explicitly requested story premises and recurring props: a teal form is
not interchangeable with a teal character. Creative additions must support them.

Building applies a project draft. It does not
mean narration audio, GPU-generated imagery, or a video export has completed.
Report only results confirmed by successful tools.

## Sources

Original guidance informed by audience-first communication and focused messages:
- [CDC Clear Communication Index](https://www.cdc.gov/ccindex/)
- [Plain language guidelines](https://www.plainlanguage.gov/guidelines/)
