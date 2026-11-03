// Chain progress (Goat Getaway, 2026-11-02): a last-frame-chained shot starts from the previous
// clip's final frame, so LTX keeps that composition and the new beat never happens (the hay-bale
// jump and the pond crash both stayed in the sunflower field). Best practice for first-frame /
// first-plus-last-frame video control: chain only a continuation of the same moment; when the
// shot's action or place is a new beat, re-anchor on the shot's own keyframe (identity is held by
// the character locks and the judge's identity check), or split the shot.
// Pure module: compares the two shots' still prompts.

const STOP = new Set(("a an the and or of with in on at to from into onto over under above below by for as " +
  "is are was were be been his her their its it this that these those while then than very " +
  "shot wide close medium camera framed full body head toe space feet ground moderate distance " +
  "no not text signs logos sign logo").split(/\s+/));

export const CHAIN_NOVELTY_THRESHOLD = 4;

function contentWords(text) {
  return new Set(String(text ?? "").toLowerCase().match(/[a-z][a-z'-]+/g)?.filter((w) => w.length > 2 && !STOP.has(w)) ?? []);
}

/** Content words in `prompt` that the previous shot's prompt never mentions. */
export function novelContent(previousPrompt, prompt) {
  const before = contentWords(previousPrompt);
  return [...contentWords(prompt)].filter((w) => !before.has(w));
}

/**
 * Decide whether a chained shot keeps the previous clip's last frame or re-anchors on its own still.
 * mode: "auto" (default) | "lastFrame" (always chain) | "reanchor" (never chain from the clip).
 */
export function chainProgress({ previousPrompt, prompt, mode = "auto", threshold = CHAIN_NOVELTY_THRESHOLD } = {}) {
  if (mode === "lastFrame") return { reanchor: false, reason: "chain mode lastFrame" };
  if (mode === "reanchor") return { reanchor: true, reason: "chain mode reanchor" };
  if (typeof previousPrompt !== "string" || typeof prompt !== "string") return { reanchor: false, reason: "no prompts to compare" };
  const novel = novelContent(previousPrompt, prompt);
  return novel.length >= threshold
    ? { reanchor: true, reason: `new beat: ${novel.slice(0, 6).join(", ")}`, novel }
    : { reanchor: false, reason: "continuation of the previous shot", novel };
}
