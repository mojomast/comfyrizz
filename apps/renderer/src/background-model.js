/**
 * Procedural background styles, split out of `components.tsx` so they can be
 * unit-tested on plain Node (20+). A6 fix: the `dots` and `grid` patterns used
 * the CSS `background` shorthand with the colour in the wrong position, so the
 * whole declaration was dropped and the scene rendered transparent. Each style
 * now keeps the base colour in `backgroundColor` and the pattern in
 * `backgroundImage`.
 *
 * @typedef {Object} BackgroundStyle
 * @property {string} [backgroundColor]
 * @property {string} [backgroundImage]
 * @property {string} [backgroundSize]
 * @property {string} [backgroundPosition]
 * @property {string} [background]
 */

import { color } from './theme-model.js';

/**
 * @param {string} pattern
 * @param {string[]} colors
 * @returns {BackgroundStyle}
 */
export function proceduralStyle(pattern, colors) {
  const base = color(colors, 0);
  const mid = color(colors, 1);
  const accent = color(colors, 2);
  const soft = color(colors, 3);

  if (pattern === 'grain' || pattern === 'mesh') return { backgroundColor: base };

  if (pattern === 'dots') {
    return {
      backgroundColor: base,
      backgroundImage: `radial-gradient(${accent} 2.5px, transparent 2.6px), radial-gradient(${soft} 1.5px, transparent 1.6px)`,
      backgroundSize: '46px 46px, 46px 46px',
      backgroundPosition: '0 0, 23px 23px',
    };
  }

  if (pattern === 'grid') {
    return {
      backgroundColor: base,
      backgroundImage: `linear-gradient(${mid} 1.5px, transparent 1.5px), linear-gradient(90deg, ${mid} 1.5px, transparent 1.5px)`,
      backgroundSize: '96px 96px, 96px 96px',
      backgroundPosition: '0 0, 0 0',
    };
  }

  return { background: `linear-gradient(140deg, ${base} 0%, ${mid} 58%, ${accent} 130%)` };
}
