import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  datasetFromCsv,
  datasetHeadline,
  datasetValues,
  parseCsv,
  parseCsvNumber,
  validateDataset,
} from '../src/dataset.js';

test('D1: parseCsv handles quotes, escaped quotes, CRLF and a BOM', () => {
  const text = '\ufefflabel,value\r\n"North, sale","1,234"\r\n"He said ""hi""",7\r\n';
  const { rows, delimiter } = parseCsv(text);
  assert.equal(delimiter, ',');
  assert.deepEqual(rows, [
    ['label', 'value'],
    ['North, sale', '1,234'],
    ['He said "hi"', '7'],
  ]);
});

test('D1: parseCsv picks a semicolon delimiter and drops blank lines', () => {
  const { rows, delimiter } = parseCsv('label;value\n\nA;1\nB;2\n');
  assert.equal(delimiter, ';');
  assert.deepEqual(rows, [
    ['label', 'value'],
    ['A', '1'],
    ['B', '2'],
  ]);
});

test('D1: parseCsvNumber keeps the written value', () => {
  assert.equal(parseCsvNumber('1,234.5'), 1234.5);
  assert.equal(parseCsvNumber('$1,000'), 1000);
  assert.equal(parseCsvNumber('(42)'), -42);
  assert.equal(parseCsvNumber('12%'), 12);
  assert.equal(parseCsvNumber('  7 '), 7);
  assert.equal(parseCsvNumber('abc'), null);
  assert.equal(parseCsvNumber(''), null);
  assert.equal(parseCsvNumber('1,23'), null);
});

test('D1: datasetFromCsv turns a header CSV into a schema dataset', () => {
  const csv = 'label,value\nCPU slice,6\nRender queue,19\nReview edits,11\n';
  const { dataset, warnings } = datasetFromCsv(csv, { unit: 'minutes', note: 'from the planning log' });
  assert.equal(dataset.unit, 'minutes');
  assert.equal(dataset.source, 'user');
  assert.equal(dataset.label, 'Label');
  assert.equal(dataset.note, 'from the planning log');
  assert.deepEqual(datasetValues(dataset), [
    { label: 'CPU slice', value: 6 },
    { label: 'Render queue', value: 19 },
    { label: 'Review edits', value: 11 },
  ]);
  assert.deepEqual(warnings, []);
  assert.equal(validateDataset(dataset).valid, true);
});

test('D1: datasetFromCsv works without a header and with named columns', () => {
  const noHeader = datasetFromCsv('Alpha,4\nBeta,5\n', { unit: 'runs' }).dataset;
  assert.deepEqual(noHeader.values, [
    { label: 'Alpha', value: 4 },
    { label: 'Beta', value: 5 },
  ]);
  const named = datasetFromCsv('name,units sold,total\nA,3,"1,250"\nB,8,900\n', { unit: 'sales', labelColumn: 'name', valueColumn: 'total' }).dataset;
  assert.deepEqual(named.values, [
    { label: 'A', value: 1250 },
    { label: 'B', value: 900 },
  ]);
});

test('D1: datasetFromCsv warns on bad rows, duplicates and clamps to 64', () => {
  const rows = ['label,value', 'A,1', 'B,not-a-number', 'A,2', ...Array.from({ length: 70 }, (_, index) => `Row ${index},${index}`)].join('\n');
  const { dataset, warnings } = datasetFromCsv(rows, { unit: 'items' });
  assert.equal(dataset.values.length, 64);
  assert.equal(dataset.values[0].label, 'A');
  assert.equal(dataset.values[0].value, 1);
  assert.ok(warnings.some(line => line.includes('not a number')));
  assert.ok(warnings.some(line => line.includes('duplicate')));
  assert.ok(warnings.some(line => line.includes('first 64')));
});

test('D1: datasetFromCsv rejects empty and non-numeric input', () => {
  assert.throws(() => datasetFromCsv('', { unit: 'x' }), /empty/);
  assert.throws(() => datasetFromCsv('label,value\nA,hello\n', { unit: 'x' }), /no numeric value column/);
  assert.throws(() => datasetFromCsv('label,value\nA,1\n', { unit: '' }), /unit/);
});

test('D1: validateDataset reports schema problems without throwing', () => {
  assert.equal(validateDataset({ unit: 'seconds', values: [{ label: 'A', value: 1 }], source: 'user' }).valid, true);
  const bad = validateDataset({ unit: '', values: [{ label: '', value: 'x' }], source: 'nope' });
  assert.equal(bad.valid, false);
  assert.ok(bad.errors.length >= 3);
  assert.equal(validateDataset(null).valid, false);
});

test('D1: datasetHeadline is the first value for a big-number scene', () => {
  const { dataset } = datasetFromCsv('label,value\nA,9\nB,3\n', { unit: 'pts' });
  assert.deepEqual(datasetHeadline(dataset), { label: 'A', value: 9 });
});
