#!/usr/bin/env node
// B1: CLI validator. `comfyrizz-validate <package.json | jobs.json | ->` [--json] [--defaults] [--jobs] [--package]
// Exit 0 = valid, 1 = invalid, 2 = usage/IO error. Prints a human summary unless --json.
//
// GPU test 2, issue 7: handing this CLI a `jobs.json` used to report the plan's job ids as
// "missing required property scenes", which reads as a broken plan. A document with `jobs` and no
// `scenes` is now recognised as a plan (or forced with --jobs) and checked against the same
// structural + semantic rules the runner applies before it submits anything.
import { readFileSync } from "node:fs";
import { validateJobsDoc, validatePackage, looksLikeAPlan } from "../src/index.mjs";
import { checkJobsDoc } from "../../jobs/src/index.mjs";

const argv = process.argv.slice(2);
const asJson = argv.includes("--json");
const withDefaults = argv.includes("--defaults");
const forceJobs = argv.includes("--jobs");
const forcePackage = argv.includes("--package");
const files = argv.filter((a) => !a.startsWith("--"));

if (files.length === 0) {
  console.error("usage: comfyrizz-validate <package.json | jobs.json | -> [--json] [--defaults] [--jobs] [--package]");
  process.exit(2);
}
if (forceJobs && forcePackage) {
  console.error("error: --jobs and --package are mutually exclusive");
  process.exit(2);
}

function jobsReport(file, doc, forced) {
  const structural = validateJobsDoc(doc);
  const semantic = checkJobsDoc(doc).map((message) => ({ source: "semantic", code: "JOBS_SEMANTIC", path: "", message }));
  const errors = [...structural, ...semantic];
  return {
    file,
    kind: "jobs",
    detected: !forced,
    valid: errors.length === 0,
    schemaOk: structural.length === 0,
    errors,
    warnings: [],
  };
}

let failed = false;
const reports = [];
for (const file of files) {
  let text;
  try {
    text = file === "-" ? readFileSync(0, "utf8") : readFileSync(file, "utf8");
  } catch (err) {
    console.error(`cannot read ${file}: ${err.message}`);
    process.exit(2);
  }
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    reports.push({ file, kind: "unknown", valid: false, schemaOk: false, errors: [{ source: "parse", code: "PARSE_JSON", path: "", message: err.message }], warnings: [] });
    failed = true;
    continue;
  }
  const asJobs = forceJobs || (!forcePackage && looksLikeAPlan(doc));
  if (asJobs) {
    const report = jobsReport(file, doc, forceJobs);
    reports.push(report);
    if (!report.valid) failed = true;
    continue;
  }
  const result = validatePackage(doc, { defaults: withDefaults });
  reports.push({
    file,
    kind: "package",
    valid: result.valid,
    schemaOk: result.schemaOk,
    errors: result.errors,
    warnings: result.warnings,
    motion: result.motion,
  });
  if (!result.valid) failed = true;
}

if (asJson) {
  console.log(JSON.stringify(reports.length === 1 ? reports[0] : reports, null, 2));
} else {
  for (const report of reports) {
    const status = report.valid ? (report.warnings.length ? "VALID (warnings)" : "VALID") : "INVALID";
    const kind = report.kind === "jobs" ? " (jobs)" : "";
    console.log(`${status}  ${report.file}${kind}`);
    for (const err of report.errors) console.log(`  error  ${err.code} ${err.path} - ${err.message}`);
    for (const warn of report.warnings) console.log(`  warn   ${warn.code} ${warn.path} - ${warn.message}`);
    // MS2: advisory motion lint (never changes the verdict); info findings only in --json.
    for (const item of report.motion || []) {
      if (item.severity !== "info") console.log(`  motion ${item.severity} ${item.code} ${item.path} - ${item.message}${item.autofix ? " [autofix]" : ""}`);
    }
  }
}
process.exit(failed ? 1 : 0);
