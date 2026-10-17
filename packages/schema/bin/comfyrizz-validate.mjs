#!/usr/bin/env node
// B1: CLI validator. `comfyrizz-validate <package.json | ->` [--json] [--defaults]
// Exit 0 = valid, 1 = invalid, 2 = usage/IO error. Prints a human summary unless --json.
import { readFileSync } from "node:fs";
import { validatePackage } from "../src/index.mjs";

const argv = process.argv.slice(2);
const asJson = argv.includes("--json");
const withDefaults = argv.includes("--defaults");
const files = argv.filter((a) => !a.startsWith("--"));

if (files.length === 0) {
  console.error("usage: comfyrizz-validate <package.json | -> [--json] [--defaults]");
  process.exit(2);
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
    reports.push({ file, valid: false, schemaOk: false, errors: [{ source: "parse", code: "PARSE_JSON", path: "", message: err.message }], warnings: [] });
    failed = true;
    continue;
  }
  const result = validatePackage(doc, { defaults: withDefaults });
  reports.push({
    file,
    valid: result.valid,
    schemaOk: result.schemaOk,
    errors: result.errors,
    warnings: result.warnings,
  });
  if (!result.valid) failed = true;
}

if (asJson) {
  console.log(JSON.stringify(reports.length === 1 ? reports[0] : reports, null, 2));
} else {
  for (const report of reports) {
    const status = report.valid ? (report.warnings.length ? "VALID (warnings)" : "VALID") : "INVALID";
    console.log(`${status}  ${report.file}`);
    for (const err of report.errors) console.log(`  error  ${err.code} ${err.path} - ${err.message}`);
    for (const warn of report.warnings) console.log(`  warn   ${warn.code} ${warn.path} - ${warn.message}`);
  }
}
process.exit(failed ? 1 : 0);
