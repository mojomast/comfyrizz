/**
 * D1: the exact series a chart/stat scene draws, so a label on screen can be
 * compared with the dataset (and the CSV it came from) in a plain Node test.
 * Nothing here invents a number: it is the dataset's own values in order.
 */

/**
 * @param {{ values?: Array<{ label: string, value: number }> } | null | undefined} dataset
 * @returns {Array<{ label: string, value: number, ratio: number }>}
 */
export function chartSeries(dataset) {
  const values = Array.isArray(dataset?.values) ? dataset.values : [];
  const max = Math.max(1, ...values.map(item => item.value));
  return values.map(item => ({
    label: item.label,
    value: item.value,
    ratio: item.value / max,
  }));
}

/** The single headline number a `stat` scene draws (the dataset's first value). */
/**
 * @param {{ values?: Array<{ label: string, value: number }> } | null | undefined} dataset
 * @returns {{ label: string, value: number } | null}
 */
export function headlineValue(dataset) {
  const [first] = Array.isArray(dataset?.values) ? dataset.values : [];
  if (!first) return null;
  return { label: first.label, value: first.value };
}
