import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { licenceChips, renderLicenceChips } from '../src/demo/licence-chips.mjs';

const licensingDemo = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../examples/licensing-demo/package.json', import.meta.url)), 'utf8'),
);

const chipFor = (assets, assetId) => licenceChips({ assets }).find(chip => chip.assetId === assetId);

test('licensing demo has an approved CC BY receipt and a blocked NC receipt', () => {
  const chips = licenceChips(licensingDemo);
  assert.equal(chips.length, 2);

  const approved = chips.find(chip => chip.assetId === 'openverse-approved');
  assert.equal(approved.tone, 'ok');
  assert.match(approved.label, /CC BY 4\.0/);
  assert.match(approved.label, /Marta Rivera/);
  assert.match(approved.detail, /Marta Rivera/);
  assert.match(approved.detail, /CC BY 4\.0/);
  assert.equal(approved.sourceUrl, licensingDemo.assets['openverse-approved'].source.landing_url);

  const refused = chips.find(chip => chip.assetId === 'openverse-refused');
  assert.equal(refused.tone, 'blocked');
  assert.match(refused.label, /CC BY-NC 4\.0/);
  assert.match(refused.detail, /non-commercial/);
  assert.match(refused.detail, /v0\.1 policy/);
  assert.equal(refused.sourceUrl, licensingDemo.assets['openverse-refused'].source.landing_url);
});

test('generated output and CC0/PDM assets are ok without attribution obligations', () => {
  const generated = chipFor({
    gen: { kind: 'image', origin: 'generated', status: 'ready' },
    genCc0: { origin: 'generated', license: { id: 'CC0-1.0' } },
    cc0: { origin: 'stock', license: { id: 'cc0' }, source: { creator: 'Ada Lovelace' } },
    pdm: { origin: 'stock', license: { id: 'PDM-1.0' } },
  }, 'gen');

  assert.equal(generated.tone, 'ok');
  assert.equal(generated.label, 'generated (CC0)');
  assert.match(generated.detail, /CC0/);

  const genCc0 = chipFor({ a: { origin: 'generated', license: { id: 'CC0-1.0' } } }, 'a');
  assert.equal(genCc0.tone, 'ok');
  assert.equal(genCc0.label, 'generated (CC0)');

  const cc0 = chipFor({ a: { origin: 'stock', license: { id: 'cc0' }, source: { creator: 'Ada Lovelace' } } }, 'a');
  assert.equal(cc0.tone, 'ok');
  assert.match(cc0.label, /CC0 1\.0/);
  assert.match(cc0.label, /Ada Lovelace/);
  assert.match(cc0.detail, /CC0-1\.0 has no attribution obligation/);

  const pdm = chipFor({ a: { origin: 'stock', license: { id: 'pdm' } } }, 'a');
  assert.equal(pdm.tone, 'ok');
  assert.match(pdm.label, /Public Domain Mark/);
});

test('CC BY is ok only when approved with a stored attribution; otherwise it warns', () => {
  const unapproved = chipFor({
    a: {
      origin: 'stock',
      license: { id: 'CC-BY-4.0', attribution: '“X” by A, CC BY 4.0' },
      source: { creator: 'A' },
    },
  }, 'a');
  assert.equal(unapproved.tone, 'warn');
  assert.match(unapproved.detail, /needs approval/);
  assert.match(unapproved.label, /CC BY 4\.0/);
  assert.match(unapproved.label, /A/);

  const noAttribution = chipFor({
    a: { origin: 'stock', license: { id: 'CC-BY-4.0', approved_by_user: true } },
  }, 'a');
  assert.equal(noAttribution.tone, 'warn');
  assert.match(noAttribution.detail, /attribution/);

  const approved = chipFor({
    a: {
      origin: 'stock',
      license: {
        id: 'CC-BY-4.0',
        approved_by_user: true,
        attribution: '“X” by A, CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/)',
      },
      source: { creator: 'A' },
    },
  }, 'a');
  assert.equal(approved.tone, 'ok');
  assert.match(approved.detail, /approved|“X” by A/);
  assert.match(approved.detail, /A/);
});

test('share-alike, non-commercial, no-derivatives and unknown licences are blocked for a reason', () => {
  const bySa = chipFor({ a: { origin: 'stock', license: { id: 'CC-BY-SA-4.0' } } }, 'a');
  assert.equal(bySa.tone, 'blocked');
  assert.match(bySa.detail, /share-alike/);

  const byNc = chipFor({ a: { origin: 'stock', license: { id: 'by-nc' } } }, 'a');
  assert.equal(byNc.tone, 'blocked');
  assert.match(byNc.detail, /non-commercial/);

  const byNd = chipFor({ a: { origin: 'stock', license: { id: 'CC-BY-ND-4.0' } } }, 'a');
  assert.equal(byNd.tone, 'blocked');
  assert.match(byNd.detail, /no-derivatives/);

  const unknown = chipFor({ a: { origin: 'stock', license: { id: 'all-rights-reserved' } } }, 'a');
  assert.equal(unknown.tone, 'blocked');
  assert.match(unknown.detail, /unrecognised licence/);

  const missing = chipFor({ a: { origin: 'stock' } }, 'a');
  assert.equal(missing.tone, 'blocked');
  assert.match(missing.detail, /unrecognised licence UNKNOWN/);
});

test('uploads follow the shareable flag', () => {
  const shareable = chipFor({ a: { origin: 'upload', redistributable: true } }, 'a');
  assert.equal(shareable.tone, 'ok');
  assert.equal(shareable.label, 'upload (shareable)');
  assert.match(shareable.detail, /shareability/);

  const privateUpload = chipFor({ a: { origin: 'upload', redistributable: false } }, 'a');
  assert.equal(privateUpload.tone, 'blocked');
  assert.equal(privateUpload.label, 'upload (not shareable)');
  assert.match(privateUpload.detail, /not marked shareable/);
});

test('an explicit licence block wins over the licence family', () => {
  const chip = chipFor({
    a: {
      origin: 'stock',
      license: { id: 'CC0-1.0', blocked: true, blocked_reason: 'held for review' },
    },
  }, 'a');

  assert.equal(chip.tone, 'blocked');
  assert.equal(chip.detail, 'held for review');
});

test('rendered labels, titles and URLs are escaped', () => {
  const html = renderLicenceChips([{
    assetId: 'a<&">',
    label: '<img src=x onerror="alert(1)">',
    tone: 'ok',
    detail: '"><script>alert(1)</script>',
    sourceUrl: 'https://example.test/image?a=1&b="two"',
  }]);

  assert.match(html, /^<ul class="licence-chips"/);
  assert.match(html, /data-asset-id="a&lt;&amp;&quot;&gt;"/);
  assert.match(html, /title="&quot;&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;"/);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img'));
  assert.match(html, /href="https:\/\/example\.test\/image\?a=1&amp;b=%22two%22"/);
  assert.match(html, /rel="noopener"/);
});

test('javascript and other unsafe source URLs are dropped', () => {
  const chips = licenceChips({
    assets: {
      bad: {
        origin: 'stock',
        license: { id: 'CC0-1.0' },
        source: { landing_url: 'javascript:alert(1)' },
      },
    },
  });
  assert.equal(chips[0].sourceUrl, undefined);

  const html = renderLicenceChips([{
    assetId: 'bad',
    label: 'CC0 1.0',
    tone: 'ok',
    detail: 'fine',
    sourceUrl: 'javascript:alert(1)',
  }]);
  assert.equal((html.match(/href=/g) ?? []).length, 0);
  assert.ok(!html.includes('javascript:'));

  const dataUrl = renderLicenceChips([{
    assetId: 'bad', label: 'x', tone: 'blocked', detail: 'x', sourceUrl: 'data:text/html,<script>alert(1)</script>',
  }]);
  assert.ok(!dataUrl.includes('data:'));
});

test('empty and malformed packages render an empty escaped list', () => {
  assert.deepEqual(licenceChips(null), []);
  assert.deepEqual(licenceChips(undefined), []);
  assert.deepEqual(licenceChips('nope'), []);
  assert.deepEqual(licenceChips({}), []);
  assert.deepEqual(licenceChips({ assets: null }), []);
  assert.equal(renderLicenceChips([]), '<ul class="licence-chips" aria-label="Asset licences"></ul>');
  assert.equal(renderLicenceChips(null), '<ul class="licence-chips" aria-label="Asset licences"></ul>');
});

test('the demo module is pure and does not import the Node-only sources package', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/demo/licence-chips.mjs', import.meta.url)), 'utf8');
  assert.ok(!/^\s*import\s/m.test(source));
  assert.ok(!/from\s+['"][^'"]*packages\/sources/.test(source));
  assert.ok(!/document|window|globalThis/.test(source));
});
