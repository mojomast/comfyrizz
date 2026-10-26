// UX20: pre-fix failure harness for node:test.
//
// A packet's acceptance assertion is written once, against the behavior the
// plan requires. Until that packet lands the assertion fails for the audited
// reason, and `knownDefect` turns that failure into a passing, labelled
// "reproduced" result. When the defect is fixed the same assertion passes, the
// wrapper fails loudly, and the fixing packet removes the wrapper (or sets
// QA_EXPECT_FIXED) so the test becomes an ordinary regression.
//
//   QA_EXPECT_FIXED=UX01,UX09   run those packets' assertions unwrapped (they must pass)
//   QA_EXPECT_FIXED=all         every packet
//
// Only assertion failures count as a reproduction. A TypeError, a timeout or a
// harness bug rethrows, so a broken fixture cannot masquerade as the defect.
import assert from 'node:assert/strict';

export function expectedFixed(packet, env = process.env) {
  const raw = String(env.QA_EXPECT_FIXED ?? '').split(',').map(part => part.trim().toUpperCase()).filter(Boolean);
  return raw.includes('ALL') || raw.includes(String(packet).toUpperCase());
}

/**
 * @param {import('node:test').TestContext} t
 * @param {{ packet: string, finding: string }} meta  packet id and the audit finding it reproduces
 * @param {() => Promise<void> | void} assertion  states the REQUIRED behavior
 */
export async function knownDefect(t, { packet, finding }, assertion) {
  if (expectedFixed(packet)) {
    await assertion();
    return { status: 'fixed' };
  }
  try {
    await assertion();
  } catch (error) {
    if (error instanceof assert.AssertionError) {
      t.diagnostic(`${packet} pre-fix failure reproduced (${finding}): ${String(error.message).split('\n')[0]}`);
      return { status: 'reproduced', error };
    }
    throw error;
  }
  throw new Error(`${packet} baseline no longer fails (${finding}). The defect looks fixed: remove knownDefect() and keep this as a regression, or run with QA_EXPECT_FIXED=${packet}.`);
}
