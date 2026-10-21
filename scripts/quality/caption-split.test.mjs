import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { captionMetrics } from './caption-metrics.mjs';
import { presentCaptions } from './caption-split.mjs';

// Synthetic fixture from the review's measured caption examples (section 4):
// a 148-character displayed cue, a 28.70 cps cue, and ordinary cues.
const fix = JSON.parse(
  readFileSync(new URL('./fixtures/captions.json', import.meta.url), 'utf8')
);

const opts = { maxCps: 20, maxLine: 42, maxLines: 2 };

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function passes(cue, options = opts) {
  const metrics = captionMetrics([cue], options);
  return (
    metrics.overCps.length === 0 &&
    metrics.overLength.length === 0 &&
    cue.lines.length <= options.maxLines &&
    cue.lines.every((line) => line.length <= options.maxLine) &&
    cue.displayLines.length <= options.maxLines &&
    cue.displayLines.every((line) => line.length <= options.maxLine)
  );
}

describe('Q14 caption presentation', () => {
  test('every output cue passes captionMetrics or is listed in needsEdit', () => {
    const result = presentCaptions(fix.cues, opts);
    const editIndexes = new Set(result.needsEdit.map((entry) => entry.index));

    assert.ok(result.cues.length > 0);
    result.cues.forEach((cue, index) => {
      assert.ok(
        passes(cue) || editIndexes.has(index),
        `cue ${index} (${cue.speaker}: "${cue.text}") must pass or be in needsEdit`
      );
    });
  });

  test('concatenated text equals the input text', () => {
    const result = presentCaptions(fix.cues, opts);
    assert.equal(
      result.cues.map((cue) => cue.text).join(' '),
      fix.cues.map((cue) => cue.text).join(' ')
    );

    fix.cues.forEach((source, sourceIndex) => {
      const parts = result.cues.filter((cue) => cue.sourceIndex === sourceIndex);
      assert.ok(parts.length >= 1, `source ${sourceIndex} has output`);
      assert.equal(
        parts.map((cue) => cue.text).join(' '),
        source.text,
        `source ${sourceIndex} text is preserved verbatim`
      );
    });
  });

  test('sub-cue spans stay inside the original cue', () => {
    const result = presentCaptions(fix.cues, opts);
    for (const cue of result.cues) {
      const source = fix.cues[cue.sourceIndex];
      assert.ok(
        Number(cue.start) >= Number(source.start) - 1e-9,
        `cue "${cue.text}" starts inside its source`
      );
      assert.ok(
        Number(cue.end) <= Number(source.end) + 1e-9,
        `cue "${cue.text}" ends inside its source`
      );
      const duration = Number(cue.end) - Number(cue.start);
      const editIndexes = new Set(result.needsEdit.map((entry) => entry.index));
      assert.ok(
        duration > 0 || editIndexes.has(result.cues.indexOf(cue)),
        `cue "${cue.text}" has a positive span or is in needsEdit`
      );
    }
  });

  test("split sub-cues are provenance 'estimated' and invent no word timings", () => {
    const result = presentCaptions(fix.cues, opts);
    const splitCues = result.cues.filter((cue) => cue.parts > 1);
    assert.ok(splitCues.length >= 1, 'fixture produces split cues');

    for (const cue of splitCues) {
      assert.equal(cue.provenance, 'estimated');
      assert.equal(cue.timing, 'estimated');
      assert.equal(cue.split, true);
      assert.ok(!Object.prototype.hasOwnProperty.call(cue, 'words'));
      assert.ok(!Object.prototype.hasOwnProperty.call(cue, 'wordTimings'));
    }
  });

  test('the 148-character cue is split and passes at 20 cps / 2 x 42', () => {
    const result = presentCaptions(fix.cues, opts);
    const parts = result.cues.filter((cue) => cue.sourceIndex === 0);
    assert.ok(parts.length >= 2, 'long cue is split at phrase boundaries');
    for (const part of parts) {
      assert.ok(passes(part), `"${part.text}" is readable in 2 x 42`);
    }
  });

  test('splits prefer punctuation and conjunction phrase boundaries', () => {
    const result = presentCaptions(fix.cues, opts);
    const parts = result.cues.filter((cue) => cue.sourceIndex === 0);
    const startsAtConjunction = parts
      .slice(1)
      .some((part) => /^(and|but|while|so|or|because|when|then)\b/i.test(part.text));
    const endsAtPunctuation = parts
      .slice(0, -1)
      .some((part) => /[.!?,;:\u2014\u2013]$/.test(part.text));
    assert.ok(
      startsAtConjunction || endsAtPunctuation,
      'a split lands on a phrase boundary rather than mid-phrase'
    );
  });

  test('over-20 cps cues are returned in needsEdit with their text intact', () => {
    const result = presentCaptions(fix.cues, opts);
    assert.ok(result.needsEdit.length >= 1);
    assert.ok(result.needsEdit.every((entry) => entry.cps > opts.maxCps));
    assert.ok(result.needsEdit.every((entry) => entry.reasons.includes('CPS')));

    const nell = fix.cues[1];
    const nellEdits = result.needsEdit.filter((entry) => entry.speaker === 'Nell');
    assert.ok(nellEdits.length >= 1, 'the 28.70 cps Nell cue is listed');
    assert.ok(nellEdits.every((entry) => entry.cps > 20));
    assert.ok(nellEdits.some((entry) => entry.sourceText === nell.text));

    for (const entry of result.needsEdit) {
      const cue = result.cues[entry.index];
      assert.ok(cue, `needsEdit index ${entry.index} maps to an output cue`);
      assert.equal(cue.text, entry.text);
      assert.ok(entry.text.length > 0);
      assert.ok(entry.reasons.length > 0);
      assert.equal(entry.action, 'caption-edit-required');
    }
  });

  test('cue text is never shortened', () => {
    const result = presentCaptions(fix.cues, opts);
    const inputWords = fix.cues.flatMap((cue) => String(cue.text).split(/\s+/));
    const outputWords = result.cues.flatMap((cue) => String(cue.text).split(/\s+/));
    assert.deepEqual(outputWords, inputWords);

    for (const entry of result.needsEdit) {
      assert.equal(entry.sourceText, fix.cues[entry.sourceIndex].text);
    }
  });

  test('input cues and their timings are not mutated', () => {
    const before = deepClone(fix.cues);
    presentCaptions(fix.cues, opts);
    assert.deepEqual(fix.cues, before);

    const single = [{ speaker: 'Ada', text: 'A short line.', start: 1, end: 3 }];
    const singleBefore = deepClone(single);
    presentCaptions(single, opts);
    assert.deepEqual(single, singleBefore);
  });

  test('output is deterministic', () => {
    assert.deepEqual(
      presentCaptions(fix.cues, opts),
      presentCaptions(fix.cues, opts)
    );
  });

  test('defaults match the documented 20 cps / 42 chars / 2 lines', () => {
    const withDefaults = presentCaptions(fix.cues);
    assert.deepEqual(withDefaults.options, opts);
    assert.deepEqual(withDefaults, presentCaptions(fix.cues, opts));
    assert.equal(withDefaults.schema, 'comfyrizz.caption-presentation/v1');
  });

  test('empty input yields empty output', () => {
    const result = presentCaptions([]);
    assert.deepEqual(result.cues, []);
    assert.deepEqual(result.needsEdit, []);
    assert.equal(result.stats.outputCues, 0);
  });

  test('a tighter maxLine forces more wrapping without losing text', () => {
    const cues = [
      {
        speaker: 'Ada',
        text: 'One two three four five six seven.',
        start: 0,
        end: 10,
      },
    ];
    const result = presentCaptions(cues, { maxCps: 20, maxLine: 10, maxLines: 1 });
    assert.ok(result.cues.length >= 2);
    assert.equal(result.cues.map((cue) => cue.text).join(' '), cues[0].text);
    for (const cue of result.cues) {
      assert.ok(cue.lines.length <= 1);
      assert.ok(cue.lines.every((line) => line.length <= 10));
    }
  });

  test('a cue under the rate limit can still need an explicit edit for layout', () => {
    const cues = [
      {
        speaker: 'Ada',
        text: 'Pneumonoultramicroscopicsilicovolcanoconiosis.',
        start: 0,
        end: 10,
      },
    ];
    const result = presentCaptions(cues, opts);
    assert.equal(result.cues.length, 1);
    assert.equal(result.cues[0].text, cues[0].text);
    assert.equal(result.needsEdit.length, 1);
    assert.ok(result.needsEdit[0].reasons.includes('LINE_LENGTH'));
  });

  test('a non-positive span is reported for an explicit edit', () => {
    const cues = [{ speaker: 'Ada', text: 'One line.', start: 5, end: 5 }];
    const result = presentCaptions(cues, opts);
    assert.equal(result.cues.length, 1);
    assert.equal(result.needsEdit.length, 1);
    assert.ok(result.needsEdit[0].reasons.includes('DURATION'));
    assert.equal(result.needsEdit[0].cps, 0);
  });

  test('a low custom maxCps routes readable text to needsEdit', () => {
    const cues = [{ speaker: 'Ada', text: 'Short line.', start: 0, end: 2 }];
    const result = presentCaptions(cues, { maxCps: 3, maxLine: 42, maxLines: 2 });
    assert.equal(result.cues.length, 1);
    assert.equal(result.cues[0].text, cues[0].text);
    assert.equal(result.needsEdit.length, 1);
    assert.ok(result.needsEdit[0].reasons.includes('CPS'));
  });
});
