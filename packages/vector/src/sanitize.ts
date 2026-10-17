/**
 * SVG sanitizer for generated (`llm-svg`) assets. Spec A5 / PLAN "Generated-first assets".
 *
 * Allow-list, not block-list: only known SVG elements and attributes survive.
 * `<script>`, `<foreignObject>`, event handlers, external `href`s, `@import`,
 * external fonts/images and `data:` images (except none) are removed. The output
 * is deterministic — the renderer, not a SMIL wall clock, drives animation.
 */

export const SANITIZER_VERSION = '1.0.0';

export interface SanitizeError {
  code: string;
  message: string;
  detail?: string;
}

export interface SanitizeResult {
  ok: boolean;
  svg: string;
  removed: string[];
  warnings: string[];
  errors: SanitizeError[];
}

interface SanitizeLimits {
  maxBytes: number;
  maxNodes: number;
  maxPathData: number;
  maxDimension: number;
}

export const DEFAULT_LIMITS: SanitizeLimits = {
  maxBytes: 512 * 1024,
  maxNodes: 2000,
  maxPathData: 100_000,
  maxDimension: 8192,
};

const ALLOWED_ELEMENTS = new Set([
  'svg', 'g', 'defs', 'symbol', 'use', 'path', 'rect', 'circle', 'ellipse', 'line',
  'polyline', 'polygon', 'text', 'tspan', 'textPath', 'title', 'desc',
  'linearGradient', 'radialGradient', 'stop', 'pattern', 'clipPath', 'mask',
  'marker', 'filter', 'feGaussianBlur', 'feOffset', 'feBlend', 'feColorMatrix',
  'feComponentTransfer', 'feFuncR', 'feFuncG', 'feFuncB', 'feFuncA', 'feMerge',
  'feMergeNode', 'feFlood', 'feComposite', 'feTurbulence', 'feDisplacementMap',
  'animate', 'animateTransform', 'animateMotion', 'mpath', 'set',
]);

/** Elements whose entire content (including children) is dropped. */
const DROP_CONTENT = new Set([
  'script', 'foreignObject', 'style', 'iframe', 'object', 'embed', 'audio', 'video',
  'image', 'a', 'switch', 'metadata', 'cursor', 'handler', 'listener',
]);

const VOID_ELEMENTS = new Set([
  'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'stop', 'use',
  'animate', 'animateTransform', 'animateMotion', 'set', 'mpath', 'feGaussianBlur',
  'feOffset', 'feFlood', 'feMergeNode', 'feColorMatrix', 'feTurbulence',
  'feDisplacementMap', 'feComposite', 'feBlend',
]);

const ALLOWED_ATTRS = new Set([
  'id', 'class', 'viewBox', 'width', 'height', 'x', 'y', 'x1', 'y1', 'x2', 'y2',
  'cx', 'cy', 'r', 'rx', 'ry', 'd', 'points', 'fill', 'fill-opacity', 'fill-rule',
  'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray',
  'stroke-dashoffset', 'stroke-opacity', 'stroke-miterlimit', 'opacity', 'transform',
  'transform-origin', 'gradientUnits', 'gradientTransform', 'spreadMethod', 'offset',
  'stop-color', 'stop-opacity', 'patternUnits', 'patternContentUnits',
  'patternTransform', 'clipPathUnits', 'maskUnits', 'maskContentUnits', 'markerWidth',
  'markerHeight', 'refX', 'refY', 'orient', 'markerUnits', 'preserveAspectRatio',
  'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant',
  'text-anchor', 'dominant-baseline', 'letter-spacing', 'word-spacing', 'paint-order',
  'vector-effect', 'shape-rendering', 'text-rendering', 'image-rendering',
  'clip-path', 'clip-rule', 'mask', 'filter', 'mix-blend-mode', 'isolation',
  'color-interpolation-filters', 'flood-color', 'flood-opacity', 'result', 'in',
  'in2', 'stdDeviation', 'dx', 'dy', 'mode', 'values', 'operator', 'k1', 'k2', 'k3',
  'k4', 'scale', 'baseFrequency', 'numOctaves', 'seed', 'stitchTiles', 'type',
  'tableValues', 'slope', 'intercept', 'amplitude', 'exponent', 'dur', 'begin', 'end',
  'repeatCount', 'repeatDur', 'fill', 'restart', 'calcMode', 'keyTimes', 'keySplines',
  'attributeName', 'attributeType', 'from', 'to', 'by', 'additive', 'accumulate',
  'path', 'rotate', 'keyPoints', 'href', 'xlink:href', 'xmlns', 'xmlns:xlink',
]);

const DANGEROUS_VALUE = /(?:javascript:|vbscript:|expression\s*\(|@import|behavior\s*:)/i;
const EXTERNAL_URL = /url\s*\(\s*['"]?\s*(?!['"]?\s*#)/i;
const DISALLOWED_STYLE_PROPS = /^(?:animation|transition|behavior|zoom|position|content)(?:-|$)/i;

const TAG_RE = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<!DOCTYPE[^>]*>|<\?[\s\S]*?\?>|<\/\s*([A-Za-z][\w:.-]*)\s*>|<\s*([A-Za-z][\w:.-]*)((?:"[^"]*"|'[^']*'|[^"'<>])*)\/?>/g;
const ATTR_RE = /([^\s=\/<>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function escapeText(text: string): string {
  return text.replace(/&(?!(?:[a-zA-Z]+|#\d+|#x[0-9a-fA-F]+);)/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function sanitizeStyle(value: string): string {
  return value
    .split(';')
    .map(part => part.trim())
    .filter(Boolean)
    .filter(part => {
      const [prop, ...rest] = part.split(':');
      if (!prop || rest.length === 0) return false;
      if (DISALLOWED_STYLE_PROPS.test(prop.trim())) return false;
      const val = rest.join(':').trim();
      return !DANGEROUS_VALUE.test(val) && !EXTERNAL_URL.test(val);
    })
    .join('; ');
}

function sanitizePaint(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (DANGEROUS_VALUE.test(trimmed)) return null;
  if (/url\s*\(/i.test(trimmed)) {
    // Only same-document references (gradients, patterns, clip paths, markers) survive.
    if (!/^url\(\s*['"]?#[A-Za-z_][\w:.-]*['"]?\s*\)/.test(trimmed)) return null;
  }
  return trimmed;
}

function sanitizeAttributes(raw: string, element: string, removed: string[], warnings: string[]): string {
  const out: string[] = [];
  ATTR_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ATTR_RE.exec(raw)) !== null) {
    let name = match[1];
    if (!name || name === '/') continue;
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    const lower = name.toLowerCase();
    if (lower.startsWith('on')) {
      removed.push(`${element}[${name}] event handler`);
      continue;
    }
    if (lower === 'src') {
      removed.push(`${element}[${name}] external reference`);
      continue;
    }
    if (lower === 'xmlns') {
      if (value.trim() !== 'http://www.w3.org/2000/svg') removed.push(`${element}[xmlns] unexpected namespace`);
      else out.push('xmlns="http://www.w3.org/2000/svg"');
      continue;
    }
    if (lower === 'xmlns:xlink') {
      if (value.trim() !== 'http://www.w3.org/1999/xlink') removed.push(`${element}[xmlns:xlink] unexpected namespace`);
      else out.push('xmlns:xlink="http://www.w3.org/1999/xlink"');
      continue;
    }
    if (lower === 'href' || lower === 'xlink:href') {
      if (!value.trim().startsWith('#')) {
        removed.push(`${element}[${name}] external reference`);
        continue;
      }
      name = 'href';
    }
    if (!ALLOWED_ATTRS.has(name)) {
      removed.push(`${element}[${name}] attribute`);
      continue;
    }
    if (name === 'style') {
      const style = sanitizeStyle(value);
      if (style) out.push(`style="${style.replace(/"/g, '&quot;')}"`);
      continue;
    }
    if (name === 'fill' || name === 'stroke' || name === 'filter' || name === 'clip-path' || name === 'mask' || name === 'marker-start' || name === 'marker-mid' || name === 'marker-end') {
      const paint = sanitizePaint(value);
      if (paint === null) {
        removed.push(`${element}[${name}] unsafe paint`);
        continue;
      }
      out.push(`${name}="${paint.replace(/"/g, '&quot;')}"`);
      continue;
    }
    if (name === 'd' && value.length > DEFAULT_LIMITS.maxPathData) {
      warnings.push(`${element} path data truncated to the path limit.`);
      out.push(`d="${value.slice(0, DEFAULT_LIMITS.maxPathData)}"`);
      continue;
    }
    if ((name === 'width' || name === 'height') && Number.isFinite(Number.parseFloat(value)) && Number.parseFloat(value) > DEFAULT_LIMITS.maxDimension) {
      removed.push(`${element}[${name}] over ${DEFAULT_LIMITS.maxDimension}`);
      continue;
    }
    if (DANGEROUS_VALUE.test(value) || EXTERNAL_URL.test(value)) {
      removed.push(`${element}[${name}] unsafe value`);
      continue;
    }
    out.push(`${name}="${value.replace(/"/g, '&quot;')}"`);
  }
  return out.length ? ` ${out.join(' ')}` : '';
}

function hasViewBox(svg: string): boolean {
  return /<svg\b[^>]*\bviewBox\s*=\s*(?:"|')[\s\d.,eE+-]+(?:"|')/i.test(svg);
}

export function sanitizeSvg(src: unknown, limits: SanitizeLimits = DEFAULT_LIMITS): SanitizeResult {
  const removed: string[] = [];
  const warnings: string[] = [];
  const errors: SanitizeError[] = [];
  if (typeof src !== 'string') {
    return { ok: false, svg: '', removed, warnings, errors: [{ code: 'not-a-string', message: 'SVG source must be a string.' }] };
  }
  if (Buffer.byteLength(src, 'utf8') > limits.maxBytes) {
    return { ok: false, svg: '', removed, warnings, errors: [{ code: 'too-large', message: `SVG source exceeds ${limits.maxBytes} bytes.` }] };
  }
  if (!/<svg[\s>]/i.test(src)) {
    return { ok: false, svg: '', removed, warnings, errors: [{ code: 'missing-svg-root', message: 'SVG source has no <svg> root element.' }] };
  }
  if (!hasViewBox(src)) {
    errors.push({ code: 'missing-viewBox', message: 'SVG root needs a viewBox so it scales deterministically.' });
  }

  const output: string[] = [];
  const stack: Array<{ name: string; allowed: boolean; emitted: boolean; dropped: boolean }> = [];
  let nodeCount = 0;
  let cursor = 0;
  let match: RegExpExecArray | null;
  TAG_RE.lastIndex = 0;

  const isDropping = () => stack.some(entry => entry.dropped);

  while ((match = TAG_RE.exec(src)) !== null) {
    const [full, closeName, openName, attrs] = match;
    const text = src.slice(cursor, match.index);
    cursor = TAG_RE.lastIndex;
    if (text && !isDropping()) output.push(escapeText(text));
    if (full.startsWith('<!--') || full.startsWith('<!DOCTYPE') || full.startsWith('<?') || full.startsWith('<![CDATA[')) continue;
    if (closeName) {
      const top = stack.at(-1);
      if (top && top.name === closeName) {
        stack.pop();
        if (top.allowed && top.emitted && !top.dropped) output.push(`</${top.name}>`);
      }
      continue;
    }
    if (!openName) continue;
    const name = openName;
    if (isDropping()) {
      // Track nesting only so the matching close tag does not leak. Void and
      // self-closing tags have no close tag and must never stay on the stack.
      const selfClosing = /\/\s*>$/.test(full) || VOID_ELEMENTS.has(name);
      if (!selfClosing) stack.push({ name, allowed: false, emitted: false, dropped: true });
      continue;
    }
    if (DROP_CONTENT.has(name)) {
      removed.push(`${name} element (with contents)`);
      const selfClosing = /\/\s*>$/.test(full) || VOID_ELEMENTS.has(name);
      if (!selfClosing) stack.push({ name, allowed: false, emitted: false, dropped: true });
      continue;
    }
    if (!ALLOWED_ELEMENTS.has(name)) {
      removed.push(`${name} element (unwrapped)`);
      stack.push({ name, allowed: false, emitted: false, dropped: false });
      continue;
    }
    nodeCount += 1;
    if (nodeCount > limits.maxNodes) {
      errors.push({ code: 'too-many-nodes', message: `SVG has more than ${limits.maxNodes} elements.` });
      break;
    }
    const cleanAttrs = sanitizeAttributes(attrs ?? '', name, removed, warnings);
    const selfClosing = /\/\s*>$/.test(full) || VOID_ELEMENTS.has(name);
    output.push(`<${name}${cleanAttrs}${selfClosing ? '/>' : '>'}`);
    if (!selfClosing) stack.push({ name, allowed: true, emitted: true, dropped: false });
  }

  // Trailing text after the last tag.
  const tail = src.slice(cursor);
  if (tail && !isDropping()) output.push(escapeText(tail));

  // Unclosed allowed elements: close them in order.
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    const entry = stack[index];
    if (entry.allowed && entry.emitted && !entry.dropped && !VOID_ELEMENTS.has(entry.name)) output.push(`</${entry.name}>`);
  }

  let svg = output.join('');
  // Resvg/usvg needs the SVG namespace even for inline markup.
  if (/^<svg\b/.test(svg) && !/\sxmlns=/.test(svg.slice(0, svg.indexOf('>') + 1))) {
    svg = svg.replace(/^<svg\b/, '<svg xmlns="http://www.w3.org/2000/svg"');
  }
  if (!svg.startsWith('<svg')) {
    const root = svg.indexOf('<svg');
    svg = root >= 0 ? svg.slice(root) : '';
  }
  if (!svg) {
    errors.push({ code: 'empty-output', message: 'Sanitizing removed every element; nothing to render.' });
  }
  return { ok: errors.length === 0, svg, removed, warnings, errors };
}
