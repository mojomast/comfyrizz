/** Parse a bounded, server-owned CSV snapshot without guessing cell types. */
function parseCsv(text: string) {
  const rows: string[][] = [];
  let row: string[] = [], field = '', quoted = false, closed = false;
  // Comma is the CSV delimiter; quoted commas and embedded newlines are data.
  const push = () => { row.push(field); field = ''; closed = false; };
  const end = () => { push(); rows.push(row); row = []; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') { quoted = false; closed = true; }
      else field += c;
    } else if (c === '"') {
      if (field || closed) throw new Error('Malformed CSV: unexpected quote');
      quoted = true;
    } else if (c === ',') push();
    else if (c === '\n' || c === '\r') { end(); if (c === '\r' && text[i + 1] === '\n') i++; }
    else { if (closed) throw new Error('Malformed CSV: characters after closing quote'); field += c; }
  }
  if (quoted) throw new Error('Malformed CSV: unterminated quoted field');
  if (field || row.length || closed) end();
  if (rows[0]?.[0]?.startsWith('\ufeff')) rows[0][0] = rows[0][0].slice(1);
  const header = rows.shift() ?? [];
  return { header, rows };
}

export function readAttachmentCsv(text: string, offset: number, limit: number) {
  const { header, rows } = parseCsv(text);
  if (offset > rows.length) throw new Error('CSV offset exceeds the number of data rows');
  const page: string[][] = [];
  let size = JSON.stringify(header).length;
  if (size > 8000) throw new Error('CSV header exceeds the 8000-character page budget');
  for (const item of rows.slice(offset, offset + limit)) {
    const length = JSON.stringify(item).length + 1;
    if (size + length > 8000) break;
    page.push(item); size += length;
  }
  if (!page.length && offset < rows.length) throw new Error(`CSV row ${offset + 1} exceeds the 8000-character page budget`);
  const next = offset + page.length;
  return { header, rows: page, totalRows: rows.length, offset, nextOffset: next < rows.length ? next : null,
    warning: next < rows.length ? 'More rows omitted from this page; request nextOffset. Each chart supports at most 64 values.' : 'Each chart supports at most 64 values; select or derive values explicitly.' };
}

export type CsvFilter = { column: string; op: 'eq' | 'neq' | 'in' | 'not_in'; values: string[] };
export function selectAttachmentCsv(text: string, filters: CsvFilter[]) {
  if (!Array.isArray(filters) || filters.length > 10) throw new Error('Query allows at most 10 filters');
  for (const filter of filters) {
    if (!filter || typeof filter.column !== 'string' || !['eq', 'neq', 'in', 'not_in'].includes(filter.op) || !Array.isArray(filter.values) || !filter.values.length || filter.values.length > 50 || filter.values.some(value => typeof value !== 'string' || value.length > 500) || ((filter.op === 'eq' || filter.op === 'neq') && filter.values.length !== 1)) throw new Error('Invalid CSV filter');
  }
  const { header, rows } = parseCsv(text);
  if (!header.length || header.some(name => !name) || new Set(header).size !== header.length) throw new Error('CSV must have unique, nonempty column names');
  if (rows.length > 10000) throw new Error('CSV exceeds 10000 data rows');
  rows.forEach((row, index) => { if (row.length !== header.length) throw new Error(`CSV row ${index + 1} has ${row.length} cells; expected ${header.length}`); });
  const indexOf = (column: string) => {
    const index = header.indexOf(column);
    if (index < 0) throw new Error(`Unknown CSV column: ${column}`);
    return index;
  };
  const compiled = filters.map(filter => ({ ...filter, index: indexOf(filter.column) }));
  const selected = rows.filter(row => compiled.every(filter => {
    const match = filter.values.includes(row[filter.index]);
    return filter.op === 'eq' || filter.op === 'in' ? match : !match;
  }));
  return { header, rows, selected };
}

export function queryAttachmentCsv(text: string, filters: CsvFilter[], groupBy?: string, transform?: 'year') {
  const { header, rows, selected } = selectAttachmentCsv(text, filters);
  if (transform !== undefined && (transform !== 'year' || groupBy === undefined)) throw new Error('year transform requires a group_by column');
  const groupIndex = groupBy === undefined ? undefined : header.indexOf(groupBy);
  if (groupIndex === -1) throw new Error(`Unknown CSV column: ${groupBy}`);
  if (groupIndex === undefined) return { totalRows: rows.length, count: selected.length };
  const groups = new Map<string, number>();
  for (const row of selected) {
    let value = row[groupIndex];
    if (transform === 'year') {
      const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00.000Z`) : new Date(NaN);
      if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new Error(`Invalid ISO date in column ${groupBy}: ${JSON.stringify(value.slice(0, 100))}`);
      value = value.slice(0, 4);
    }
    groups.set(value, (groups.get(value) ?? 0) + 1);
  }
  if (groups.size > 200) throw new Error('Query exceeds 200 groups');
  if ([...groups.keys()].some(value => value.length > 500) || [...groups.keys()].reduce((sum, value) => sum + value.length, 0) > 8000) throw new Error('Query group values exceed the response budget');
  return { totalRows: rows.length, count: selected.length, distinct: groups.size, groups: [...groups].map(([value, count]) => ({ value, count })) };
}
