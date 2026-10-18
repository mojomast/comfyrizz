// GPU test 4: the one package both g4 scripts plan, so the estimate and the dry run describe the same
// job set. It is the pipeline fixture (real workflows, the shapes GPU test 3 measured) plus the two
// job controls test 4 re-checks: N1 (`text`, a job control, never a graph param) and N9 (the upscale
// stage lands on the package frame).
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
export const PACKAGE_ID = "pkg_gpu4dryrun0001";

export function gpu4Package() {
  const pkg = JSON.parse(readFileSync(join(REPO, "pipeline-py", "tests", "fixtures", "package-gpu1-workflows.json"), "utf8"));
  pkg.id = PACKAGE_ID;
  pkg.assets.a_still.gen.inputs.text = true; // N1
  pkg.assets.a_plate1.gen.inputs.upscale = true; // N9
  return pkg;
}

/** Materialise the package (and its workflow dir) so the BYO runner can read it off disk. */
export function writeGpu4Package(dir) {
  const pkg = gpu4Package();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2));
  const workflows = join(dir, "workflows");
  if (!existsSync(workflows)) symlinkSync(join(REPO, "workflows"), workflows);
  return pkg;
}

/** Millisecond-free human line for the console: what a session would cost. */
export function estimateLine(estimate, { budgetUnits = null } = {}) {
  const headroom = budgetUnits === null ? null : Number((budgetUnits - estimate.units).toFixed(2));
  return {
    gpuMinutes: estimate.gpuMinutes,
    overheadMinutes: estimate.overheadMinutes,
    units: estimate.units,
    budgetUnits,
    headroomUnits: headroom,
    slowestJobMinutes: estimate.slowestJobMinutes,
    totalWallMinutes: Number((estimate.gpuMinutes + estimate.overheadMinutes).toFixed(2)),
  };
}
