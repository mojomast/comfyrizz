// RW-W5B: FLUX 3 Image Klein is distilled (cfg 1) and has no negative lever, so the text guard
// has to name the positive end state instead of piling up negatives that tend to summon text.
import { test } from "node:test";
import assert from "node:assert/strict";

import { TEXT_GUARD, TEXT_GUARD_SATISFIED, applyPromptDefaults } from "../src/defaults.mjs";

const EXPECTED =
  "clean unmarked surfaces, plain untextured backgrounds, blank signage, imagery made only of shapes, colour and light";

const countOccurrences = (haystack, needle) => haystack.split(needle).length - 1;

test("TEXT_GUARD is positive end-state wording with no negative lever words", () => {
  assert.equal(TEXT_GUARD, EXPECTED);
  assert.doesNotMatch(TEXT_GUARD, /\b(no|not|without|avoid|never)\b/i);
});

test("applyPromptDefaults appends the positive guard exactly once and is idempotent", () => {
  const params = { prompt: "a small robot holding a film clapper, plain flat background" };
  const first = applyPromptDefaults(params, { kind: "still" });

  assert.equal(countOccurrences(params.prompt, TEXT_GUARD), 1);
  assert.equal(params.prompt, `a small robot holding a film clapper, plain flat background, ${TEXT_GUARD}`);
  assert.deepEqual(first.applied.map((entry) => entry.guard), ["text"]);
  assert.match(first.applied[0].because, /GPU test 2/);
  assert.match(first.applied[0].because, /Klein/);
  assert.match(first.applied[0].because, /positive/i);

  const afterFirst = params.prompt;
  const second = applyPromptDefaults(params, { kind: "still" });
  assert.equal(params.prompt, afterFirst);
  assert.equal(countOccurrences(params.prompt, TEXT_GUARD), 1);
  assert.equal(second.applied.length, 0);
});

test("a prompt already saying \"no text, no letters\" is left unchanged", () => {
  const params = { prompt: "a quiet nebula, no text, no letters" };
  const result = applyPromptDefaults(params, { kind: "still" });

  assert.equal(params.prompt, "a quiet nebula, no text, no letters");
  assert.equal(result.applied.length, 0);
});

test("a prompt that already carries the positive guard text is left unchanged", () => {
  const prompt = `a quiet nebula, ${TEXT_GUARD}`;
  assert.ok(TEXT_GUARD_SATISFIED.test(prompt));
  const params = { prompt };
  const result = applyPromptDefaults(params, { kind: "still" });

  assert.equal(params.prompt, prompt);
  assert.equal(countOccurrences(params.prompt, TEXT_GUARD), 1);
  assert.equal(result.applied.length, 0);
});
