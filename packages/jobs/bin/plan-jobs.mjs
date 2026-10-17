#!/usr/bin/env node
// B2: `comfyrizz-plan <package.json> [--out jobs.json] [--check] [--include-ready]`
//
// Prints the planned jobs.json (or writes it with --out). --check re-reads the file and
// verifies its recorded hash, so a stale or hand-edited jobs.json fails.
import { readFileSync, writeFileSync } from "node:fs";
import { planJobs, checkJobsDoc, canonical, sha256Hex } from "../src/plan.mjs";

const argv = process.argv.slice(2);
const file = argv.find((a) => !a.startsWith("--"));
const outIndex = argv.indexOf("--out");
const outFile = outIndex >= 0 ? argv[outIndex + 1] : null;
const check = argv.includes("--check");
const includeReady = argv.includes("--include-ready");

if (!file) {
  console.error("usage: comfyrizz-plan <package.json> [--out jobs.json] [--check] [--include-ready]");
  process.exit(2);
}

const pkg = JSON.parse(readFileSync(file, "utf8"));
if (check) {
  if (!outFile) {
    console.error("--check needs --out <jobs.json>");
    process.exit(2);
  }
  const doc = JSON.parse(readFileSync(outFile, "utf8"));
  const problems = checkJobsDoc(doc);
  const expected = sha256Hex(canonical({ ...doc, hash: undefined }));
  if (doc.hash !== expected) problems.push(`recorded hash ${doc.hash} does not match the document (${expected})`);
  const fresh = planJobs(pkg, { includeReady });
  if (fresh.hash !== doc.hash) problems.push(`jobs.json is stale: a fresh plan hashes to ${fresh.hash}`);
  if (problems.length) {
    for (const problem of problems) console.error(`  ${problem}`);
    process.exit(1);
  }
  console.log(`jobs.json is current (${doc.jobs.length} jobs, hash ${doc.hash.slice(0, 12)})`);
  process.exit(0);
}

const doc = planJobs(pkg, { includeReady });
const text = `${JSON.stringify(doc, null, 2)}\n`;
if (outFile) {
  writeFileSync(outFile, text);
  console.log(`${doc.jobs.length} jobs -> ${outFile} (hash ${doc.hash.slice(0, 12)})`);
} else {
  process.stdout.write(text);
}
