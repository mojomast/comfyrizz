/**
 * The copy pieces the `stat` layout draws (N12).
 *
 * A stat scene can carry a kicker, a headline, a sub line and a footnote; the
 * dataset it cites can be user/openverse/derived/example. Only an `example`
 * dataset is an invented placeholder, so only it gets the "example data" tag —
 * a real dataset keeps its own label, and the scene's footnote (its source
 * line) is rendered instead of being dropped.
 */
export function statLines(copy = {}, dataset) {
  const label = dataset?.label;
  return {
    kicker: copy.kicker ?? copy.headline,
    sourceLine: label ? (dataset.source === 'example' ? `${label} · example data` : label) : undefined,
    footnote: copy.footnote,
  };
}
