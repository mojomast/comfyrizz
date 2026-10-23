// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC_ROOT = join(WEB_ROOT, 'src');
const INDEX_HTML = join(WEB_ROOT, 'index.html');
const BARE_COLAB = /(?<!Google )Colab/g;
const IDENTIFIER_CHAR = /[A-Za-z0-9_$]/;

function toPosix(path) {
  return path.split(sep).join('/');
}

function sourceFiles(root = SRC_ROOT) {
  return readdirSync(root, { recursive: true })
    .map((entry) => (typeof entry === 'string' ? entry : entry.name))
    .filter((file) => /\.(ts|mjs)$/.test(file))
    .map((file) => join(root, file))
    .sort();
}

function lineNumberAt(source, index) {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i += 1) {
    if (source[i] === '\n') line += 1;
  }
  return line;
}

function lineAt(source, index) {
  const start = source.lastIndexOf('\n', index - 1) + 1;
  let end = source.indexOf('\n', index);
  if (end === -1) end = source.length;
  return source.slice(start, end);
}

function isIdentifierOccurrence(text, index) {
  const before = text[index - 1];
  const after = text[index + 'Colab'.length];
  return Boolean(
    (before && IDENTIFIER_CHAR.test(before)) || (after && IDENTIFIER_CHAR.test(after)),
  );
}

/**
 * Collect the text chunks of every single-quoted, double-quoted and template
 * string literal. Comments, regex literals and the expressions inside
 * `${...}` are code, not display text, so they are skipped.
 */
function stringLiterals(source) {
  const literals = [];
  let i = 0;
  let regexAllowed = true;

  function readString(quote) {
    const start = i + 1;
    i += 1;
    while (i < source.length && source[i] !== quote) {
      if (source[i] === '\\') i += 1;
      i += 1;
    }
    literals.push({ text: source.slice(start, i), index: start });
    i += 1;
    regexAllowed = false;
  }

  function readTemplate() {
    let start = i + 1;
    i += 1;
    while (i < source.length) {
      const char = source[i];
      if (char === '\\') {
        i += 2;
        continue;
      }
      if (char === '`') {
        literals.push({ text: source.slice(start, i), index: start });
        i += 1;
        regexAllowed = false;
        return;
      }
      if (char === '$' && source[i + 1] === '{') {
        literals.push({ text: source.slice(start, i), index: start });
        i += 2;
        readCode(true);
        start = i;
        continue;
      }
      i += 1;
    }
  }

  function readRegex() {
    i += 1;
    let inClass = false;
    while (i < source.length) {
      const char = source[i];
      if (char === '\\') {
        i += 2;
        continue;
      }
      if (char === '[') inClass = true;
      else if (char === ']') inClass = false;
      else if (char === '/' && !inClass) {
        i += 1;
        break;
      } else if (char === '\n') {
        break;
      }
      i += 1;
    }
    while (i < source.length && /[a-z]/i.test(source[i])) i += 1;
    regexAllowed = false;
  }

  function readWord() {
    const start = i;
    while (i < source.length && IDENTIFIER_CHAR.test(source[i])) i += 1;
    const word = source.slice(start, i);
    regexAllowed = /^(?:return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/.test(word);
  }

  function readCode(untilBrace) {
    let depth = untilBrace ? 1 : 0;
    while (i < source.length) {
      const char = source[i];
      const next = source[i + 1];

      if (char === '/' && next === '/') {
        i += 2;
        while (i < source.length && source[i] !== '\n') i += 1;
        continue;
      }
      if (char === '/' && next === '*') {
        i += 2;
        while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
        i += 2;
        continue;
      }
      if (char === "'" || char === '"') {
        readString(char);
        continue;
      }
      if (char === '`') {
        readTemplate();
        continue;
      }
      if (char === '/') {
        if (regexAllowed) readRegex();
        else {
          i += 1;
          regexAllowed = true;
        }
        continue;
      }
      if (char === '{') {
        depth += 1;
        regexAllowed = true;
        i += 1;
        continue;
      }
      if (char === '}') {
        i += 1;
        if (untilBrace && depth === 1) return;
        depth -= 1;
        regexAllowed = false;
        continue;
      }
      if (IDENTIFIER_CHAR.test(char)) {
        readWord();
        continue;
      }
      if (/\s/.test(char)) {
        i += 1;
        continue;
      }
      regexAllowed = !(char === ')' || char === ']' || char === '.');
      i += 1;
    }
  }

  readCode(false);
  return literals;
}

function scanSource(source, file) {
  const offenders = [];
  for (const literal of stringLiterals(source)) {
    for (const match of literal.text.matchAll(BARE_COLAB)) {
      if (isIdentifierOccurrence(literal.text, match.index)) continue;
      const index = literal.index + match.index;
      const line = lineNumberAt(source, index);
      // `banned-ok` is the repository's marker for a line that intentionally
      // spells a banned word for a scanner. Only copy.ts's own
      // BANNED_EASY_WORDS list uses it.
      if (lineAt(source, index).includes('banned-ok')) continue;
      offenders.push({
        file,
        line,
        text: literal.text.trim(),
      });
    }
  }
  return offenders;
}

function formatOffender(offender) {
  return `${offender.file}:${offender.line}: ${JSON.stringify(offender.text)}`;
}

test('the scanner checks display literals but not identifiers, comments or regexes', () => {
  const sample = [
    "const ok = 'Google Colab';",
    "const bad = 'Colab session';",
    "const id = 'colabStatus';",
    "const type = 'ColabStatus';",
    "const camel = 'mountColabHistory';",
    'const regex = /\\\\bColab\\\\b/g;',
    "// 'Colab' in a comment",
    'const nested = `${on ? `Bare Colab` : \'Google Colab\'}`;',
  ].join('\n');

  assert.deepEqual(
    scanSource(sample, 'sample.ts').map((offender) => offender.text),
    ['Colab session', 'Bare Colab'],
  );
});

test('every web string literal names Google Colab in full', () => {
  const offenders = [];
  for (const file of sourceFiles()) {
    offenders.push(...scanSource(readFileSync(file, 'utf8'), toPosix(relative(WEB_ROOT, file))));
  }

  const html = readFileSync(INDEX_HTML, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  for (const match of html.matchAll(BARE_COLAB)) {
    if (isIdentifierOccurrence(html, match.index)) continue;
    offenders.push({
      file: 'index.html',
      line: lineNumberAt(html, match.index),
      text: lineAt(html, match.index).trim(),
    });
  }

  assert.deepEqual(
    offenders.map(formatOffender),
    [],
    ['Bare "Colab" must be written as "Google Colab":', ...offenders.map(formatOffender)].join('\n'),
  );
});
