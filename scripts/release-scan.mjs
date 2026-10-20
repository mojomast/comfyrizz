#!/usr/bin/env node
// Release scan: flags secrets, private hosts and personal paths in tracked files.
// Prints file:line and the rule, never the matched value. Exit 1 when anything is found.
// Usage: node scripts/release-scan.mjs [--all-files] [--allow path-regex]
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

const RULES = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/],
  ['hf-token', /\bhf_[A-Za-z0-9]{30,}\b/],
  ['openai-style-key', /\bsk-(?:proj-|or-v1-)?[A-Za-z0-9_\-]{20,}\b/],
  ['github-token', /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/],
  ['google-api-key', /\bAIza[0-9A-Za-z_\-]{35}\b/],
  ['google-oauth', /\bya29\.[0-9A-Za-z_\-]{20,}/],
  ['aws-key', /\bAKIA[0-9A-Z]{16}\b/],
  ['slack-token', /\bxox[abprs]-[0-9A-Za-z\-]{10,}/],
  ['bearer-literal', /Bearer\s+[A-Za-z0-9_\-.=]{24,}/],
  ['assigned-secret', /\b(?:api[_-]?key|token|secret|password)\b["']?\s*[:=]\s*["'][A-Za-z0-9_\-.\/+=]{20,}["']/i],
  ['tailnet-host', /\b[a-z0-9-]+\.(?:tail[a-z0-9]+\.)?ts\.net\b/i],
  ['tailscale-ip', /\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/],
  ['home-box-path', /\/home\/box\b/],
  ['windows-user-path', /[A-Za-z]:\\\\?Users\\\\?[^\\\s"'<>]+/],
  ['macos-user-path', /\/Users\/[a-z][a-z0-9._-]+\//],
];
const args = process.argv.slice(2);
const allow = args.includes('--allow') ? new RegExp(args[args.indexOf('--allow') + 1]) : null;
const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean)
  .filter((f) => !f.endsWith('pnpm-lock.yaml') && f !== 'scripts/release-scan.mjs' && !(allow && allow.test(f)));
const findings = [];
for (const f of files) {
  let buf;
  try { if (statSync(f).size > 5_000_000) continue; buf = readFileSync(f); } catch { continue; }
  if (buf.includes(0)) continue; // binary
  const lines = buf.toString('utf8').split('\n');
  lines.forEach((line, i) => { for (const [name, re] of RULES) if (re.test(line)) findings.push({ file: f, line: i + 1, rule: name }); });
}
const byRule = {};
for (const x of findings) (byRule[x.rule] ||= []).push(`${x.file}:${x.line}`);
for (const [rule, locs] of Object.entries(byRule)) {
  console.log(`${rule}: ${locs.length}`);
  for (const l of locs.slice(0, 50)) console.log(`  ${l}`);
  if (locs.length > 50) console.log(`  ... ${locs.length - 50} more`);
}
console.log(findings.length ? `\n${findings.length} finding(s) in ${files.length} tracked files (values not shown).` : `clean: ${files.length} tracked files scanned.`);
process.exit(findings.length ? 1 : 0);
