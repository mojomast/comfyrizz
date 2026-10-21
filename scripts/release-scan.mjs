#!/usr/bin/env node
// Release scan: flags secrets, private hosts and personal paths in tracked files.
// Prints file:line and the rule, never the matched value. Exit 1 when anything
// that is not explicitly allowlisted is found.
// Usage: node scripts/release-scan.mjs [--json] [--all-files] [--allow path-regex]
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const RULES = [
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
  ['workspace-path', /\/workspace\/[A-Za-z0-9._-]+/],
  ['home-box-path', /\/home\/box\b/],
  ['windows-user-path', /[A-Za-z]:\\\\?Users\\\\?[^\\\s"'<>]+/],
  ['macos-user-path', /\/Users\/[a-z][a-z0-9._-]+\//],
];

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ALLOW_FILE = join(SCRIPT_DIR, 'release-scan.allow.json');

function globToRegExp(pattern) {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        out += '.*';
        i++;
        if (pattern[i + 1] === '/') i++;
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${out}$`);
}

function matchesPath(file, pattern) {
  if (!/[*?]/.test(pattern)) {
    const prefix = pattern.replace(/\/+$/, '');
    return file === prefix || file.startsWith(`${prefix}/`);
  }
  return globToRegExp(pattern.replace(/\/+$/, '/**')).test(file);
}

export function loadAllowlist(file = DEFAULT_ALLOW_FILE) {
  if (!existsSync(file)) return [];
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const entries = Array.isArray(raw) ? raw : raw.allow;
  if (!Array.isArray(entries)) throw new Error(`${file}: expected an array or { "allow": [...] }`);
  for (const entry of entries) {
    if (typeof entry?.path !== 'string' || !Array.isArray(entry.rules) || typeof entry.reason !== 'string') {
      throw new Error(`${file}: each entry needs { path, rules, reason }`);
    }
  }
  return entries;
}

function allowEntry(file, rule, allowlist) {
  return allowlist.find((entry) =>
    (entry.rules.includes(rule) || entry.rules.includes('*')) && matchesPath(file, entry.path));
}

export function scan({ cwd = process.cwd(), allowlist = loadAllowlist(), allow = null } = {}) {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)
    .filter((f) => !f.endsWith('pnpm-lock.yaml') && f !== 'scripts/release-scan.mjs' && !(allow && allow.test(f)));
  const findings = [];
  const allowed = [];
  for (const file of files) {
    let buf;
    try {
      if (statSync(join(cwd, file)).size > 5_000_000) continue;
      buf = readFileSync(join(cwd, file));
    } catch {
      continue;
    }
    if (buf.includes(0)) continue; // binary
    const lines = buf.toString('utf8').split('\n');
    lines.forEach((line, i) => {
      for (const [rule, re] of RULES) {
        if (!re.test(line)) continue;
        const hit = { file, line: i + 1, rule };
        const entry = allowEntry(file, rule, allowlist);
        if (entry) allowed.push({ ...hit, reason: entry.reason });
        else findings.push(hit);
      }
    });
  }
  return { findings, allowed, filesScanned: files.length };
}

function groupByRule(hits) {
  const byRule = {};
  for (const hit of hits) (byRule[hit.rule] ||= []).push(hit);
  return byRule;
}

function printFindings(findings) {
  for (const [rule, hits] of Object.entries(groupByRule(findings))) {
    console.log(`${rule}: ${hits.length}`);
    for (const hit of hits.slice(0, 50)) console.log(`  ${hit.file}:${hit.line}`);
    if (hits.length > 50) console.log(`  ... ${hits.length - 50} more`);
  }
}

function printAllowed(allowed) {
  if (!allowed.length) return;
  console.log(`\nallowed (not failing): ${allowed.length}`);
  for (const [rule, hits] of Object.entries(groupByRule(allowed))) {
    console.log(`  ${rule}: ${hits.length}`);
    const reasons = new Map();
    for (const hit of hits) reasons.set(hit.reason, (reasons.get(hit.reason) || 0) + 1);
    for (const [reason, count] of reasons) console.log(`    ${count} x ${reason}`);
  }
}

function main() {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const allow = args.includes('--allow') ? new RegExp(args[args.indexOf('--allow') + 1]) : null;
  const { findings, allowed, filesScanned } = scan({ allow });
  if (json) {
    const plain = (hits) => hits.map(({ file, line, rule }) => ({ file, line, rule }));
    console.log(JSON.stringify({ findings: plain(findings), allowed: plain(allowed) }, null, 2));
  } else {
    printFindings(findings);
    printAllowed(allowed);
    console.log(findings.length
      ? `\n${findings.length} finding(s) in ${filesScanned} tracked files (values not shown).`
      : `clean: ${filesScanned} tracked files scanned, ${allowed.length} allowed hit(s).`);
  }
  process.exit(findings.length ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
