// UX20: preload for spawned Node processes (the acceptance server).
//   NODE_OPTIONS="--import /abs/path/qa/lib/egress-preload.mjs" QA_EGRESS_LOG=/tmp/x.jsonl node ...
// Every blocked attempt is appended to QA_EGRESS_LOG so the harness can fail the
// run, in addition to the error the blocked code path sees.
import { installEgressGuard } from './egress-guard.mjs';

installEgressGuard({
  logFile: process.env.QA_EGRESS_LOG || null,
  label: process.env.QA_EGRESS_LABEL || `pid:${process.pid}`,
  allow: (process.env.QA_EGRESS_ALLOW || '').split(',').filter(Boolean),
});
