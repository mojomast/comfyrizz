/**
 * Offline syntax highlighting for the code scene.
 *
 * Shiki (MIT) with the pure-JavaScript regex engine: grammars and the theme
 * are imported from the installed package, so a render does not fetch WASM,
 * grammars or themes. The same source always tokenises to the same spans.
 */
import { createHighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import githubDark from '@shikijs/themes/github-dark';
import typescript from '@shikijs/langs/typescript';
import tsx from '@shikijs/langs/tsx';
import javascript from '@shikijs/langs/javascript';
import jsx from '@shikijs/langs/jsx';
import python from '@shikijs/langs/python';
import bash from '@shikijs/langs/bash';
import json from '@shikijs/langs/json';
import css from '@shikijs/langs/css';
import html from '@shikijs/langs/html';
import markdown from '@shikijs/langs/markdown';
import diff from '@shikijs/langs/diff';

const LANGS = {
  typescript,
  tsx,
  javascript,
  jsx,
  python,
  bash,
  json,
  css,
  html,
  markdown,
  diff,
};

const ALIAS = {
  ts: 'typescript',
  js: 'javascript',
  py: 'python',
  sh: 'bash',
  shell: 'bash',
  shellscript: 'bash',
  zsh: 'bash',
  md: 'markdown',
  txt: 'text',
  text: 'text',
  plaintext: 'text',
};

const PLAIN = '#e6e8ee';

/** @param {string} code */
export function plainTokens(code) {
  return String(code).split('\n').map(line => [{ content: line, color: PLAIN }]);
}

let highlighterPromise = null;

function highlighter() {
  if (!highlighterPromise) {
    highlighterPromise = Promise.resolve(createJavaScriptRegexEngine()).then(engine => createHighlighterCore({
      themes: [githubDark],
      langs: Object.values(LANGS),
      engine,
    }));
  }
  return highlighterPromise;
}

/**
 * @param {string} code
 * @param {string} language
 * @returns {Promise<{content:string, color:string}[][]>}
 */
export async function highlightTokens(code, language) {
  const requested = String(language || 'text').toLowerCase();
  const lang = ALIAS[requested] ?? requested;
  if (lang === 'text' || !LANGS[lang]) return plainTokens(code);
  try {
    const hl = await highlighter();
    const result = hl.codeToTokens(String(code), { lang, theme: 'github-dark' });
    return result.tokens.map(line => line.map(token => ({
      content: token.content,
      color: token.color || PLAIN,
    })));
  } catch {
    return plainTokens(code);
  }
}
