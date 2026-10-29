import assert from 'node:assert/strict';
import test from 'node:test';
import { proposalForPackage, renderSuperEasyProposal } from './proposal.ts';

test('revised data and tile categories are visible for fresh review and approval', () => {
  const drawing = (color: string) => ({ source: { description: JSON.stringify({ colors: [{ value: '1', color }], rules: [], require_categories: ['1'] }) }, elements: [{ type: 'rect', color }] });
  const before = { id: 'pkg_data', revision: 3, scenes: [{ id: 's1', drawing: drawing('#777777') }], datasets: { d_years: { values: [{ label: '2011', value: 999 }] } } };
  const after = { ...before, revision: 4, scenes: [{ id: 's1', drawing: drawing('#ff00aa') }], datasets: { d_years: { values: [{ label: '2011', value: 17 }] } } };
  const proposal = proposalForPackage(after, 'Data story', ['Fix the yearly counts and winning tile'], false, before);
  assert.equal(proposal.reviewedPackageRevision, 4);
  const html = renderSuperEasyProposal(proposal);
  assert.match(html, /d_years: Dataset values/);
  assert.match(html, /999/);
  assert.match(html, /17/);
  assert.match(html, /s1: Tile wall categories/);
  assert.match(html, /#ff00aa/);
  assert.match(html, /data-super-easy-approve-proposal/);
  assert.match(html, /original upload/);
  assert.match(html, /Visual: Source-bound drawing/);
  assert.match(html, /no per-tile labels/);
  assert.match(html, /Name the scene ID or scene number/);
});

test('dataset display name and category label changes are shown with unchanged counts', () => {
  const before = { id: 'pkg_data', revision: 3, scenes: [{ id: 's1' }], datasets: { d_results: { label: 'Results', values: [{ label: 'Retirements', value: 18 }] } } };
  const after = { ...before, revision: 4, datasets: { d_results: { label: 'Classifications', values: [{ label: 'DNF classifications', value: 18 }] } } };
  const proposal = proposalForPackage(after, 'Data story', ['Rename the category'], false, before);
  const html = renderSuperEasyProposal(proposal);
  assert.equal(proposal.reviewedPackageRevision, 4);
  assert.match(html, /d_results: Dataset display name/);
  assert.match(html, /Classifications/);
  assert.match(html, /Retirements/);
  assert.match(html, /DNF classifications/);
  assert.match(html, /18/);
  assert.match(html, /data-super-easy-approve-proposal/);
});
