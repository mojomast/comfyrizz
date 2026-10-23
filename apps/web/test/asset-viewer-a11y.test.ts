import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mountAssetViewer } from '../src/viewer/asset-viewer.ts';
import { renderThumb } from '../src/thumbs/thumb.ts';
import { hydrateAssetThumbs } from '../src/assets/asset-row.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tokensCss = readFileSync(join(root, 'src/ui/tokens.css'), 'utf8');
const thumbsCss = readFileSync(join(root, 'src/thumbs/thumbs.css'), 'utf8');
const viewerCss = readFileSync(join(root, 'src/viewer/viewer.css'), 'utf8');
const mainSource = readFileSync(join(root, 'src/main.ts'), 'utf8');

function cssRules(css) {
  const source = css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/@import\s+[^;]+;/g, '');
  return Array.from(source.matchAll(/([^{}]+)\{([^{}]+)\}/g), match => {
    const declarations = new Map();
    for (const declaration of match[2].matchAll(/(--[\w-]+|[a-zA-Z-]+)\s*:\s*([^;]+)/g)) {
      declarations.set(declaration[1], declaration[2].trim());
    }
    return {
      selector: match[1].trim().replace(/\s+/g, ' '),
      declarations,
    };
  });
}

const thumbRules = cssRules(thumbsCss);
const viewerRules = cssRules(viewerCss);

function findRule(rules, selector) {
  return rules.find(rule => rule.selector.split(',').some(part => part.trim() === selector));
}

function declaration(rules, selector, property) {
  const rule = rules.find(candidate => (
    candidate.selector.split(',').some(part => part.trim() === selector)
    && candidate.declarations.has(property)
  ));
  assert.ok(rule, `${selector} must declare ${property}`);
  return rule.declarations.get(property);
}

function tokenValues(css) {
  const values = new Map();
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const match of source.matchAll(/--([\w-]+)\s*:\s*([^;}\n]+)/g)) {
    values.set(match[1], match[2].trim());
  }
  return values;
}

const tokens = tokenValues(tokensCss);

function resolveValue(value) {
  let resolved = value;
  for (let pass = 0; pass < 12; pass += 1) {
    const next = resolved.replace(
      /var\(\s*--([\w-]+)\s*(?:,\s*([^()]*))?\)/g,
      (whole, name, fallback) => tokens.get(name) ?? fallback?.trim() ?? whole,
    );
    if (next === resolved) break;
    resolved = next;
  }
  return resolved;
}

function parseColor(value) {
  const resolved = resolveValue(value);
  const hex = /#([\da-f]{3,8})\b/i.exec(resolved);
  if (hex) {
    let digits = hex[1];
    if (digits.length === 3 || digits.length === 4) {
      digits = Array.from(digits, channel => channel + channel).join('');
    }
    assert.ok(digits.length === 6 || digits.length === 8, `unsupported colour ${value}`);
    return {
      r: Number.parseInt(digits.slice(0, 2), 16),
      g: Number.parseInt(digits.slice(2, 4), 16),
      b: Number.parseInt(digits.slice(4, 6), 16),
      a: digits.length === 8 ? Number.parseInt(digits.slice(6, 8), 16) / 255 : 1,
    };
  }
  const rgb = /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)/i.exec(resolved);
  assert.ok(rgb, `expected a colour in ${value}; resolved as ${resolved}`);
  const alpha = rgb[4] === undefined
    ? 1
    : rgb[4].endsWith('%')
      ? Number.parseFloat(rgb[4]) / 100
      : Number.parseFloat(rgb[4]);
  return {
    r: Number.parseFloat(rgb[1]),
    g: Number.parseFloat(rgb[2]),
    b: Number.parseFloat(rgb[3]),
    a: alpha,
  };
}

function colorsIn(value) {
  const resolved = resolveValue(value);
  return Array.from(resolved.matchAll(/#[\da-f]{3,8}\b|rgba?\([^)]*\)/gi), match => parseColor(match[0]));
}

function composite(foreground, background) {
  const alpha = foreground.a + background.a * (1 - foreground.a);
  assert.ok(alpha > 0, 'a transparent pair has no measurable contrast');
  return {
    r: (foreground.r * foreground.a + background.r * background.a * (1 - foreground.a)) / alpha,
    g: (foreground.g * foreground.a + background.g * background.a * (1 - foreground.a)) / alpha,
    b: (foreground.b * foreground.a + background.b * background.a * (1 - foreground.a)) / alpha,
    a: 1,
  };
}

function luminance(color) {
  const channel = value => {
    const scaled = value / 255;
    return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

function contrast(foreground, background) {
  const first = luminance(foreground);
  const second = luminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

function assertContrast(label, foregroundValue, backgroundValue, minimum) {
  const background = parseColor(backgroundValue);
  assert.equal(background.a, 1, `${label} needs an opaque background for measurement`);
  const foreground = composite(parseColor(foregroundValue), background);
  const ratio = contrast(foreground, background);
  assert.ok(
    ratio >= minimum,
    `${label}: ${resolveValue(foregroundValue)} on ${resolveValue(backgroundValue)} is ${ratio.toFixed(2)}:1; expected ${minimum}:1`,
  );
}

function functionBody(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `main.ts must define ${name}`);
  const candidates = [
    source.indexOf('\nfunction ', start + 1),
    source.indexOf('\nasync function ', start + 1),
  ].filter(index => index >= 0);
  const end = candidates.length > 0 ? Math.min(...candidates) : source.length;
  return source.slice(start, end);
}

class FakeElement {
  constructor(tagName, ownerDocument, namespaceURI = null) {
    this.tagName = String(tagName).toUpperCase();
    this.ownerDocument = ownerDocument;
    this.namespaceURI = namespaceURI;
    this.parentNode = null;
    this.children = [];
    this.attributes = new Map();
    this.listeners = new Map();
    this.dataset = {};
    this.style = {};
    this.className = '';
    this.textContent = '';
    this.id = '';
    this.value = '';
    this.hidden = false;
    this.disabled = false;
    this.open = false;
    this.modal = false;
    this.focused = false;
  }

  setAttribute(name, value) {
    const key = String(name).toLowerCase();
    this.attributes.set(key, String(value));
    if (key === 'class') this.className = String(value);
  }

  getAttribute(name) {
    const key = String(name).toLowerCase();
    return this.attributes.has(key) ? this.attributes.get(key) : null;
  }

  hasAttribute(name) {
    return this.attributes.has(String(name).toLowerCase());
  }

  removeAttribute(name) {
    this.attributes.delete(String(name).toLowerCase());
  }

  appendChild(child) {
    child.parentNode = this;
    child.ownerDocument = this.ownerDocument;
    this.children.push(child);
    return child;
  }

  append(...nodes) {
    for (const node of nodes) this.appendChild(node);
  }

  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }

  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parentNode = null;
    return child;
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatchEvent(event) {
    const payload = {
      ...event,
      target: this,
      currentTarget: this,
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.propagationStopped = true; },
    };
    let node = this;
    while (node) {
      for (const listener of Array.from(node.listeners.get(payload.type) ?? [])) {
        listener.call(node, payload);
      }
      if (payload.propagationStopped) break;
      node = node.parentNode;
    }
    return !payload.defaultPrevented;
  }

  matches(selector) {
    if (selector.startsWith('[') && selector.endsWith(']')) {
      return this.hasAttribute(selector.slice(1, -1));
    }
    if (selector.startsWith('.')) {
      return this.className.split(/\s+/).includes(selector.slice(1));
    }
    const tagAndClass = /^([a-z]+)\.(.+)$/.exec(selector);
    if (tagAndClass) {
      return this.tagName === tagAndClass[1].toUpperCase()
        && this.className.split(/\s+/).includes(tagAndClass[2]);
    }
    return this.tagName === selector.toUpperCase();
  }

  querySelectorAll(selector) {
    const found = [];
    const visit = node => {
      for (const child of node.children) {
        if (child.matches(selector)) found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  focus() {
    this.focused = true;
    this.ownerDocument.activeElement = this;
  }

  showModal() {
    this.open = true;
    this.modal = true;
  }

  close() {
    this.open = false;
    this.modal = false;
    this.dispatchEvent({ type: 'close' });
  }

  play() {
    return Promise.resolve();
  }

  pause() {}
}

class FakeDocument {
  constructor() {
    this.activeElement = null;
    this.defaultView = {
      matchMedia: query => ({ matches: false, media: query }),
    };
  }

  createElement(tagName) {
    return new FakeElement(tagName, this);
  }

  createElementNS(namespaceURI, tagName) {
    return new FakeElement(tagName, this, namespaceURI);
  }
}

function descendants(root) {
  const found = [];
  const visit = node => {
    for (const child of node.children ?? []) {
      found.push(child);
      visit(child);
    }
  };
  visit(root);
  return found;
}

function findAttr(root, name) {
  return [root, ...descendants(root)].find(node => node.hasAttribute(name));
}

function mountViewer(item) {
  const document = new FakeDocument();
  const host = document.createElement('div');
  const opener = document.createElement('button');
  const handle = mountAssetViewer({ document, host, items: [item], index: 0, opener });
  return { document, host, opener, handle };
}

function imageItem(overrides = {}) {
  return {
    id: 'a_image',
    kind: 'image',
    title: 'Still',
    src: '/api/media/image-ticket',
    ...overrides,
  };
}

test('every thumbnail text colour pair meets WCAG AA at 4.5:1', () => {
  const pairs = [
    ['default thumbnail text', declaration(thumbRules, '[data-thumb-state]', 'color'), declaration(thumbRules, '[data-thumb-state]', 'background')],
    ['retry text', declaration(thumbRules, '.thumb-retry', 'color'), declaration(thumbRules, '.thumb-retry', 'background')],
    ['disabled retry text', declaration(thumbRules, '.thumb-retry:disabled', 'color'), declaration(thumbRules, '.thumb-retry', 'background')],
  ];
  for (const state of ['ready', 'pending', 'failed', 'none']) {
    const selector = `[data-thumb-state='${state}']`;
    const background = declaration(thumbRules, selector, 'background');
    pairs.push([`${state} text`, declaration(thumbRules, selector, 'color'), background]);
    const labelSelector = state === 'failed' ? "[data-thumb-state='failed'] .thumb-label" : '.thumb-label';
    const reasonSelector = state === 'failed' ? "[data-thumb-state='failed'] .thumb-reason" : '.thumb-reason';
    pairs.push([`${state} label`, declaration(thumbRules, labelSelector, 'color'), background]);
    pairs.push([`${state} reason`, declaration(thumbRules, reasonSelector, 'color'), background]);
  }
  for (const [label, foreground, background] of pairs) {
    assertContrast(label, foreground, background, 4.5);
  }
});

test('pending thumbnail state border is at least 3:1 against its own background', () => {
  const selector = "[data-thumb-state='pending']";
  assertContrast(
    'pending thumbnail border',
    declaration(thumbRules, selector, 'border-color'),
    declaration(thumbRules, selector, 'background'),
    3,
  );
});

test('failed thumbnail state border is at least 3:1 against its own background', () => {
  const selector = "[data-thumb-state='failed']";
  assertContrast(
    'failed thumbnail border',
    declaration(thumbRules, selector, 'border-color'),
    declaration(thumbRules, selector, 'background'),
    3,
  );
});

test('thumbnail waveform colour is at least 3:1 against its background', () => {
  assertContrast(
    'thumbnail waveform',
    declaration(thumbRules, '.thumb-waveform', 'color'),
    declaration(thumbRules, '.thumb-waveform', 'background'),
    3,
  );
});

test('every viewer text colour pair meets WCAG AA at 4.5:1', () => {
  const dialogBackground = declaration(viewerRules, '.asset-viewer', 'background');
  const dialogText = declaration(viewerRules, '.asset-viewer', 'color');
  const mediaBackground = declaration(viewerRules, '.viewer-media', 'background');
  const pairs = [
    ['viewer text', dialogText, dialogBackground],
    ['viewer live region', declaration(viewerRules, '.viewer-live', 'color'), dialogBackground],
    ['viewer zoom label', declaration(viewerRules, '.viewer-zoom-label', 'color'), dialogBackground],
    ['viewer region description', declaration(viewerRules, '.viewer-region-desc', 'color'), dialogBackground],
    ['viewer compare error', declaration(viewerRules, '.viewer-compare-error', 'color'), dialogBackground],
    ['viewer media error', declaration(viewerRules, '.viewer-error', 'color'), dialogBackground],
    ['viewer text asset', dialogText, mediaBackground],
  ];
  for (const [label, foreground, background] of pairs) {
    assertContrast(label, foreground, background, 4.5);
  }
});

test('viewer focus, selection, scrub and waveform colours are at least 3:1', () => {
  const mediaBackground = parseColor(declaration(viewerRules, '.viewer-media', 'background'));
  assert.equal(mediaBackground.a, 1);
  assertContrast(
    'viewer media focus outline',
    declaration(viewerRules, '.viewer-media:focus-visible', 'outline'),
    declaration(viewerRules, '.viewer-media', 'background'),
    3,
  );
  const regionBackground = composite(
    parseColor(declaration(viewerRules, '.viewer-region-box', 'background')),
    mediaBackground,
  );
  const regionBorder = composite(
    parseColor(declaration(viewerRules, '.viewer-region-box', 'border')),
    regionBackground,
  );
  assert.ok(contrast(regionBorder, regionBackground) >= 3, 'viewer region border must be at least 3:1');

  const waveformBackground = composite(
    parseColor(declaration(viewerRules, '.viewer-waveform', 'background')),
    mediaBackground,
  );
  const waveColors = colorsIn(declaration(viewerRules, '.viewer-wave-bar', 'background'));
  assert.ok(waveColors.length >= 2, 'the waveform gradient colours must be measured');
  for (const color of waveColors) {
    assert.ok(contrast(composite(color, waveformBackground), waveformBackground) >= 3, 'waveform bars must be at least 3:1');
  }

  const controlsBackground = composite(
    parseColor(declaration(viewerRules, '.viewer-controls', 'background')),
    mediaBackground,
  );
  const scrubColor = composite(
    parseColor(declaration(viewerRules, '.viewer-scrub', 'accent-color')),
    controlsBackground,
  );
  assert.ok(contrast(scrubColor, controlsBackground) >= 3, 'the media scrubber must be at least 3:1');
});

test('viewer hover outline is at least 3:1 against its own background', () => {
  assertContrast(
    'viewer hover outline',
    declaration(viewerRules, '.viewer-hover', 'border'),
    declaration(viewerRules, '.viewer-hover', 'background-color'),
    3,
  );
});

test('thumbnail and viewer keyboard surfaces have visible focus indicators', () => {
  const thumbFocus = findRule(thumbRules, '.thumb-retry:focus-visible');
  const viewerFocus = findRule(viewerRules, '.viewer-media:focus-visible');
  assert.ok(thumbFocus?.declarations.get('outline'));
  assert.ok(thumbFocus.declarations.get('outline') !== 'none');
  assert.ok(thumbFocus.declarations.has('outline-offset'));
  assert.ok(viewerFocus?.declarations.get('outline'));
  assert.ok(viewerFocus.declarations.get('outline') !== 'none');
  assert.ok(viewerFocus.declarations.has('outline-offset'));
});

test('the viewer has native modal dialog semantics, a labelled title and managed focus', () => {
  const { document, host, opener, handle } = mountViewer(imageItem({ width: 1920, height: 1080 }));
  const dialog = handle.element;
  const title = findAttr(host, 'data-viewer-title');
  const live = findAttr(host, 'data-viewer-live');
  const media = findAttr(host, 'data-viewer-media');
  assert.equal(dialog.tagName, 'DIALOG');
  assert.equal(dialog.open, true);
  assert.equal(dialog.modal, true);
  assert.equal(dialog.getAttribute('aria-modal'), 'true');
  assert.ok(title);
  assert.ok(title.id.length > 0);
  assert.equal(dialog.getAttribute('aria-labelledby'), title.id);
  assert.equal(title.textContent, 'Still');
  assert.equal(live.getAttribute('role'), 'status');
  assert.equal(live.getAttribute('aria-live'), 'polite');
  assert.equal(document.activeElement, media);
  dialog.dispatchEvent({ type: 'cancel' });
  assert.equal(dialog.open, false);
  assert.equal(document.activeElement, opener);
  handle.destroy();
});

test('a 48-asset package renders no more than ASSET_PAGE_SIZE thumbnail requests', async () => {
  const pageSize = Number(/const ASSET_PAGE_SIZE = (\d+);/.exec(mainSource)?.[1]);
  assert.ok(Number.isInteger(pageSize) && pageSize > 0 && pageSize < 48);
  const renderAssets = functionBody(mainSource, 'renderAssets');
  assert.match(renderAssets, /const start = railState\.assetPage \* ASSET_PAGE_SIZE/);
  assert.match(renderAssets, /const windowEntries = filtered\.slice\(start, start \+ ASSET_PAGE_SIZE\)/);
  assert.match(renderAssets, /host\.innerHTML = windowEntries/);
  assert.match(renderAssets, /hydrateAssetThumbs\(host, assetThumbsClient/);

  const assets = Array.from({ length: 48 }, (_, index) => `a_${String(index).padStart(2, '0')}`);
  const start = 0;
  const windowEntries = assets.slice(start, start + pageSize);
  const document = new FakeDocument();
  const host = document.createElement('div');
  for (const ref of windowEntries) {
    const row = document.createElement('div');
    row.dataset.assetId = ref;
    row.setAttribute('data-asset-id', ref);
    const thumb = document.createElement('button');
    thumb.className = 'thumb';
    row.appendChild(thumb);
    host.appendChild(row);
  }

  let observerCallback;
  const observed = [];
  const loads = [];
  const handle = hydrateAssetThumbs(host, {
    async load(request) {
      loads.push(request);
      return {
        status: 'ready',
        key: 'a'.repeat(64),
        ticketUrl: '/api/media/poster-ticket',
        width: 160,
        height: 90,
      };
    },
    retry() {},
  }, {
    packageId: 'pkg_1',
    observerFactory(callback) {
      observerCallback = callback;
      return {
        observe(element) { observed.push(element); },
        unobserve() {},
        disconnect() {},
      };
    },
  });
  assert.equal(observed.length, pageSize);
  observerCallback(observed.map(target => ({ target, isIntersecting: true })));
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(loads.length <= pageSize, `${loads.length} requests exceeded ASSET_PAGE_SIZE ${pageSize}`);
  assert.equal(loads.length, pageSize);
  assert.equal(new Set(loads.map(load => load.ref)).size, pageSize);
  assert.ok(loads.every(load => load.packageId === 'pkg_1' && load.kind === 'poster'));
  assert.ok(loads.every(load => assets.indexOf(load.ref) < pageSize));
  handle.disconnect();
});

test('ready thumbnails render img elements with explicit width and height', () => {
  const document = new FakeDocument();
  const host = document.createElement('div');
  renderThumb(host, {
    status: 'ready',
    key: 'b'.repeat(64),
    ticketUrl: '/api/media/poster-ticket',
    width: 320,
    height: 180,
  }, { alt: 'Poster', width: 160, height: 90, kind: 'poster' });
  const images = descendants(host).filter(node => node.tagName === 'IMG');
  assert.equal(images.length, 1);
  assert.equal(images[0].getAttribute('width'), '160');
  assert.equal(images[0].getAttribute('height'), '90');
});

test('viewer images use explicit width and height when both dimensions are known', () => {
  const { host, handle } = mountViewer(imageItem({ width: 1920, height: 1080 }));
  const image = descendants(host).find(node => node.tagName === 'IMG');
  assert.ok(image);
  assert.equal(image.getAttribute('width'), '1920');
  assert.equal(image.getAttribute('height'), '1080');
  handle.destroy();
});

test('viewer images without known dimensions reserve a CSS box without invented attributes', () => {
  for (const dimensions of [{}, { width: 1920 }, { height: 1080 }, { width: 0, height: 1080 }]) {
    const { host, handle } = mountViewer(imageItem(dimensions));
    const image = descendants(host).find(node => node.tagName === 'IMG');
    assert.ok(image);
    assert.equal(image.getAttribute('width'), null);
    assert.equal(image.getAttribute('height'), null);
    handle.destroy();
  }
  const fallback = findRule(viewerRules, '.viewer-image:not([width]):not([height])');
  assert.ok(fallback, 'unknown-sized viewer images need a CSS reserved-box rule');
  assert.match(fallback.declarations.get('aspect-ratio') ?? '', /^\d+(?:\.\d+)?\s*\/\s*\d+(?:\.\d+)?$/);
  const width = fallback.declarations.get('width');
  const height = fallback.declarations.get('height');
  assert.ok(
    (width !== undefined && width !== 'auto') || (height !== undefined && height !== 'auto'),
    'the unknown-sized image rule must reserve a width or height',
  );
});
