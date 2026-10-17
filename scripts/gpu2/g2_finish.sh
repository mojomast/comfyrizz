#!/usr/bin/env bash
# Run g2_finish.py with a path that cannot be wrong (H-fix5).
#
# GPU test 2's collection step never ran: it was invoked with a wrong `-f` path, so the CLI never
# loaded the file. This wrapper resolves the script's own directory and passes absolute paths, so it
# works from any cwd on the VM (or from the box's copy of the script):
#
#   scripts/gpu2/g2_finish.sh                      # collect /content/out into /content/out.tgz
#   scripts/gpu2/g2_finish.sh --dry-run
#   scripts/gpu2/g2_finish.sh --content /content --out /content/out --tarball /content/out.tgz
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON="${PYTHON:-python3}"
exec "$PYTHON" "$HERE/g2_finish.py" "$@"
