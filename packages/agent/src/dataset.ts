/**
 * D1: turn a pasted/uploaded CSV into a validated `package-v1` dataset.
 *
 * Pure and offline: no model, no filesystem, no network. The value a row shows
 * is the exact value in the CSV after the documented normalisation (thousands
 * separators, currency symbols, a trailing `%`, and `(123)` negatives), so a
 * rendered label can be checked back against the source bytes.
 */

export interface DatasetValue {
  label: string;
  value: number;
}

export interface Dataset {
  unit: string;
  label?: string;
  values: DatasetValue[];
  source: 'user' | 'openverse' | 'example' | 'derived';
  approved?: boolean;
  source_url?: string;
  retrieved_at?: string;
  note?: string;
}

export interface CsvParseResult {
  rows: string[][];
  delimiter: string;
}

export interface DatasetParseOptions {
  unit: string;
  label?: string;
  source?: Dataset['source'];
  approved?: boolean;
  sourceUrl?: string;
  retrievedAt?: string;
  note?: string;
  labelColumn?: string;
  valueColumn?: string;
}

export interface DatasetParseResult {
  dataset: Dataset;
  warnings: string[];
  header: string[] | null;
}

export const DATASET_MAX_VALUES = 64;
export const DATASET_MAX_LABEL = 64;

const LABEL_HEADERS = /^(label|name|category|key|item|step|stage|phase)$/i;
const VALUE_HEADERS = /^(value|amount|count|total|number|score|minutes|seconds|hours|percent|percentage|units?)$/i;

/** RFC4180-ish CSV: quoted fields, `""` escapes, CRLF or LF, a trailing newline. */
export function parseCsv(text: string): CsvParseResult {
  if (typeof text !== 'string') throw new Error('parseCsv needs a string');
  const delimiter = pickDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    // Skip a single all-empty row (blank line), but keep an explicit empty cell.
    if (row.length > 1 || row[0] !== '') rows.push(row);
    row = [];
  };
  while (i < text.length) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      i += 1;
      continue;
    }
    if (ch === delimiter) {
      pushField();
      i += 1;
      continue;
    }
    if (ch === '\r' && text[i + 1] === '\n') {
      pushField();
      pushRow();
      i += 2;
      continue;
    }
    if (ch === '\n' || ch === '\r') {
      pushField();
      pushRow();
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  pushField();
  if (row.length > 1 || row[0] !== '') rows.push(row);
  // Drop a leading UTF-8 BOM.
  if (rows[0]?.[0]?.charCodeAt(0) === 0xfeff) rows[0][0] = rows[0][0].slice(1);
  return { rows, delimiter };
}

function pickDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const counts: Record<string, number> = { ',': 0, ';': 0, '\t': 0 };
  let quoted = false;
  for (const ch of firstLine) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch in counts) counts[ch] += 1;
  }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best[1] > 0 ? best[0] : ',';
}

/**
 * Parse one CSV number exactly as written. Accepts `1,234.5`, `$1 234`, `(42)`,
 * `12%`, `€9.99`; returns null when the cell is not a finite number.
 */
export function parseCsvNumber(raw: string): number | null {
  let text = String(raw ?? '').trim();
  if (text === '') return null;
  let negative = false;
  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1).trim();
  }
  text = text.replace(/^[-+]/, match => {
    if (match === '-') negative = !negative;
    return '';
  });
  if (text.endsWith('%')) text = text.slice(0, -1).trim();
  text = text.replace(/[$€£¥]/g, '').trim();
  // Thousands separators: `,` between digit groups, or a thin/regular space.
  text = text.replace(/(\d)[,\u00a0\u202f ](?=\d{3}\b)/g, '$1');
  if (!/^-?\d*\.?\d+(e[-+]?\d+)?$/i.test(text)) return null;
  const value = Number(text);
  if (!Number.isFinite(value)) return null;
  return negative ? -value : value;
}

function looksNumeric(cell: string): boolean {
  return parseCsvNumber(cell) !== null;
}

function titleCaseHeader(header: string | null): string | null {
  if (!header) return null;
  const clean = header.replace(/_/g, ' ').trim();
  return clean ? clean.charAt(0).toUpperCase() + clean.slice(1) : null;
}

/**
 * Build a schema-valid dataset from CSV text. Throws on empty input, no data
 * row, or no numeric value column; clamps to 64 rows and lists every drop in
 * `warnings` so the UI can show why a row was skipped.
 */
export function datasetFromCsv(text: string, options: DatasetParseOptions): DatasetParseResult {
  if (!options?.unit || typeof options.unit !== 'string') throw new Error('datasetFromCsv needs a unit');
  const unit = options.unit.trim();
  if (unit.length === 0 || unit.length > 32) throw new Error('unit must be 1-32 characters');
  const { rows } = parseCsv(text);
  if (rows.length === 0) throw new Error('CSV is empty');
  const warnings: string[] = [];

  const first = rows[0] ?? [];
  const bodyRows = rows.slice(1);
  // A header row has a non-numeric cell whose body cells are numeric (e.g.
  // `label,value` / `CPU slice,6`); a data row like `Alpha,4` does not.
  const header =
    rows.length > 1 &&
    first.length >= 2 &&
    first.some((cell, index) => !looksNumeric(cell) && bodyRows.some(row => looksNumeric(row[index] ?? '')))
      ? first
      : null;
  const body = header ? bodyRows : rows;

  let labelIndex = 0;
  let valueIndex = 1;
  if (header) {
    const find = (pattern: RegExp) => header.findIndex(cell => pattern.test(cell.trim()));
    const namedLabel = options.labelColumn ? header.findIndex(cell => cell.trim().toLowerCase() === options.labelColumn!.trim().toLowerCase()) : -1;
    const namedValue = options.valueColumn ? header.findIndex(cell => cell.trim().toLowerCase() === options.valueColumn!.trim().toLowerCase()) : -1;
    const guessedLabel = find(LABEL_HEADERS);
    const guessedValue = find(VALUE_HEADERS);
    labelIndex = namedLabel >= 0 ? namedLabel : guessedLabel >= 0 ? guessedLabel : 0;
    valueIndex = namedValue >= 0 ? namedValue : guessedValue >= 0 ? guessedValue : labelIndex === 0 ? 1 : 0;
    if (valueIndex === labelIndex) {
      const numericColumn = header.findIndex((_, index) => index !== labelIndex && body.some(row => looksNumeric(row[index] ?? '')));
      if (numericColumn >= 0) valueIndex = numericColumn;
    }
  }
  if (labelIndex === valueIndex) throw new Error('label and value columns are the same');

  const values: DatasetValue[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < body.length; index += 1) {
    const row = body[index];
    const rawLabel = (row[labelIndex] ?? '').trim();
    const rawValue = row[valueIndex] ?? '';
    const value = parseCsvNumber(rawValue);
    if (value === null) {
      const detail = rawLabel || `row ${index + 1}`;
      warnings.push(`skipped ${detail}: "${rawValue.trim()}" is not a number`);
      continue;
    }
    const label = rawLabel.slice(0, DATASET_MAX_LABEL);
    if (rawLabel.length > DATASET_MAX_LABEL) warnings.push(`truncated label "${rawLabel.slice(0, 24)}…" to ${DATASET_MAX_LABEL} characters`);
    const key = label.toLowerCase();
    if (seen.has(key)) {
      warnings.push(`skipped duplicate label "${label}"`);
      continue;
    }
    seen.add(key);
    values.push({ label, value });
    if (values.length >= DATASET_MAX_VALUES) {
      if (index < body.length - 1) warnings.push(`kept the first ${DATASET_MAX_VALUES} values; ignored the rest`);
      break;
    }
  }
  if (values.length === 0) throw new Error('CSV has no numeric value column');

  const dataset: Dataset = {
    unit,
    values,
    source: options.source ?? 'user',
    ...(titleCaseHeader(options.label ?? header?.[labelIndex] ?? null) ? { label: titleCaseHeader(options.label ?? header?.[labelIndex] ?? null)! } : {}),
    ...(options.approved !== undefined ? { approved: options.approved } : {}),
    ...(options.sourceUrl ? { source_url: options.sourceUrl } : {}),
    ...(options.retrievedAt ? { retrieved_at: options.retrievedAt } : {}),
    ...(options.note ? { note: options.note } : {}),
  };
  return { dataset, warnings, header };
}

/** Validate a dataset against the package-v1 dataset shape; never throws. */
export function validateDataset(dataset: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const value = dataset as Partial<Dataset> | null;
  if (!value || typeof value !== 'object') return { valid: false, errors: ['dataset is not an object'] };
  if (typeof value.unit !== 'string' || value.unit.length === 0 || value.unit.length > 32) errors.push('unit must be 1-32 characters');
  if (!Array.isArray(value.values) || value.values.length < 1 || value.values.length > DATASET_MAX_VALUES) {
    errors.push(`values must be an array of 1-${DATASET_MAX_VALUES}`);
    return { valid: false, errors };
  }
  value.values.forEach((item, index) => {
    if (!item || typeof item !== 'object') {
      errors.push(`values[${index}] is not an object`);
      return;
    }
    if (typeof item.label !== 'string' || item.label.length < 1 || item.label.length > DATASET_MAX_LABEL) errors.push(`values[${index}].label must be 1-${DATASET_MAX_LABEL} characters`);
    if (typeof item.value !== 'number' || !Number.isFinite(item.value) || Math.abs(item.value) > 1e12) errors.push(`values[${index}].value must be a finite number within ±1e12`);
  });
  if (!['user', 'openverse', 'example', 'derived'].includes(value.source as string)) errors.push('source must be user, openverse, example or derived');
  return { valid: errors.length === 0, errors };
}

/** Measurable numbers in declaration order, for animated chart labels. */
export function datasetValues(dataset: Dataset): DatasetValue[] {
  return dataset.values.map(item => ({ label: item.label, value: item.value }));
}

/** A single headline number (first value) and its label, for a big-number scene. */
export function datasetHeadline(dataset: Dataset): { label: string; value: number } | null {
  const [first] = dataset.values;
  return first ? { label: first.label, value: first.value } : null;
}
