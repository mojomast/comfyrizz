// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { COPY, fill } from '../src/easy/copy.ts';

function flattenStrings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => flattenStrings(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => flattenStrings(v, out));
  return out;
}

const BANNED = [
  /\bpackage\b/i,
  /\btakes?\b/i,
  /\bclips?\b/i,
  /\brender\w*\b/i,
  /\bbackend\b/i,
  /\bLLM\b/i,
  /\bGPU units\b/i,
  /\bprocedural\b/i,
  /\bfallback\b/i,
  /\bKokoro\b/i,
  /\bQwen\b/i,
  /\bRemotion\b/i,
  /\bG4\b/i,
  /\bBYO\b/i,
  /\brevision\b/i,
];

test('copy has no banned words', () => {
  const strings = flattenStrings(COPY);
  for (const s of strings) {
    for (const re of BANNED) {
      assert.equal(re.test(s), false, `banned word in: ${s}`);
      re.lastIndex = 0;
    }
    const withoutGoogle = s.replace(/Google Colab/g, '');
    assert.equal(withoutGoogle.includes('Colab'), false, `Colab not preceded by Google in: ${s}`);
  }
});

test('scanner finds no banned words in easy sources', () => {
  const easyDir = existsSync('src/easy') ? 'src/easy' : 'apps/web/src/easy';
  const entries = readdirSync(easyDir, { recursive: true });
  const files = entries
    .map((e) => (typeof e === 'string' ? e : e.name))
    .filter((f) => f.endsWith('.ts'));
  for (const rel of files) {
    const full = join(easyDir, rel);
    const raw = readFileSync(full, 'utf8');
    const lines = raw.split(/\r?\n/);
    let code = '';
    for (const line of lines) {
      if (line.includes('banned-ok')) continue;
      code += line + '\n';
    }
    code = code.replace(/\/\*[\s\S]*?\*\//g, '');
    code = code.replace(/\/\/.*$/gm, '');
    const re = /(['"`])((?:\\.|(?!\1).)*)\1/g;
    let m;
    while ((m = re.exec(code)) !== null) {
      const lit = m[2];
      const check = lit.includes(' ') || /^[A-Z]/.test(lit);
      if (!check) continue;
      if (/^\/|^\.|^#|^data-|^aria-|^http/.test(lit)) continue;
      for (const bannedRe of BANNED) {
        assert.equal(bannedRe.test(lit), false, `${rel}: ${lit}`);
        bannedRe.lastIndex = 0;
      }
      const withoutGoogle = lit.replace(/Google Colab/g, '');
      assert.equal(withoutGoogle.includes('Colab'), false, `${rel}: ${lit}`);
    }
  }
});

test('fill works', () => {
  assert.equal(fill('Up to {n} units', { n: 6 }), 'Up to 6 units');
  assert.equal(fill('{a}', {}), '{a}');
});
