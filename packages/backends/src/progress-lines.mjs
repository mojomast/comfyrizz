// A transport chunk is not a JSON line. Preserve split records and UTF-8 text.
export function progressLines(onEvent, onText = () => {}) {
  let pending = '';
  const line = text => {
    const clean = text.trim();
    if (!clean) return;
    try {
      const event = JSON.parse(clean);
      if (event && typeof event === 'object' && !Array.isArray(event)) return onEvent(event);
    } catch { /* ordinary diagnostic output */ }
    onText(clean.slice(-2000));
  };
  return {
    write(text) {
      pending += text;
      let end;
      while ((end = pending.indexOf('\n')) >= 0) {
        line(pending.slice(0, end));
        pending = pending.slice(end + 1);
      }
      // A malformed producer must not grow the buffer without bound.
      if (pending.length > 65536) { onText(pending.slice(-2000)); pending = ''; }
    },
    end() { line(pending); pending = ''; },
  };
}
