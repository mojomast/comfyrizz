import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeSvg } from '../src/index.js';

test('malicious fixtures are stripped: script, foreignObject, handlers, external refs, @import', () => {
  const hostile = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" onload="steal()">
  <script>alert(document.cookie)</script>
  <foreignObject width="10" height="10"><body xmlns="http://www.w3.org/1999/xhtml">hi</body></foreignObject>
  <style>@import url("https://evil.example/x.css"); .a { animation: spin 1s linear infinite; }</style>
  <image href="https://evil.example/pixel.png" width="10" height="10"/>
  <a href="https://evil.example"><rect width="10" height="10" fill="#6d8cff"/></a>
  <rect x="0" y="0" width="50" height="50" fill="url(https://evil.example/p.svg#x)" onclick="x()"/>
  <rect x="0" y="0" width="20" height="20" fill="#6d8cff"/>
</svg>`;
  const result = sanitizeSvg(hostile);
  assert.equal(result.ok, true);
  assert.doesNotMatch(result.svg, /script|foreignObject|onload|onclick|@import|evil\.example|https?:\/\/(?!www\.w3\.org)/i);
  assert.match(result.svg, /<rect[^>]*fill="#6d8cff"/);
  assert.match(result.svg, /viewBox="0 0 100 100"/);
  const removed = result.removed.join(' | ');
  assert.match(removed, /script/);
  assert.match(removed, /foreignObject/);
  assert.match(removed, /event handler/);
  assert.match(removed, /image element|a element|external reference/);
});

test('missing viewBox and no svg root fail with structured errors', () => {
  assert.equal(sanitizeSvg('<div>not svg</div>').errors[0].code, 'missing-svg-root');
  const noViewBox = sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg"><rect width="4" height="4"/></svg>');
  assert.equal(noViewBox.ok, false);
  assert.equal(noViewBox.errors[0].code, 'missing-viewBox');
});

test('text content survives and external paint servers do not', () => {
  const result = sanitizeSvg('<svg viewBox="0 0 100 40"><text x="4" y="20" fill="url(#grad)" style="animation: spin 2s">Hello &amp; hi</text></svg>');
  assert.equal(result.ok, true);
  assert.match(result.svg, /Hello &amp; hi/);
  assert.match(result.svg, /fill="url\(#grad\)"/);
  assert.doesNotMatch(result.svg, /animation/);
});
