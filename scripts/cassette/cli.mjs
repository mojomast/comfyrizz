#!/usr/bin/env node
/**
 * CASSETTE C07: command-line tools for comfyrizz.cassette/v1 files.
 *
 *   node scripts/cassette/cli.mjs validate <file>
 *   node scripts/cassette/cli.mjs stats <file>
 *   node scripts/cassette/cli.mjs diff <a> <b> [--md]
 *   node scripts/cassette/cli.mjs redact <in> <out>
 *
 * Invalid input exits with status 1. Request bodies are never printed in
 * full: only counts, key prefixes, tool names and previews of at most 80
 * characters. Secret values are never printed; redaction reports only how
 * many entries changed. The module is side-effect free at import time and
 * takes its filesystem, environment and streams as injected dependencies.
 */

import { readFile as fsReadFile, writeFile as fsWriteFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { validateCassette } from './format.mjs';
import { diffCassettes, renderDiffMarkdown, toolCallSummary } from './diff.mjs';
import { redactCassette } from './redact.mjs';

const PREVIEW_LIMIT = 80;

const USAGE = `Usage:
  node scripts/cassette/cli.mjs validate <file>
  node scripts/cassette/cli.mjs stats <file>
  node scripts/cassette/cli.mjs diff <a> <b> [--md]
  node scripts/cassette/cli.mjs redact <in> <out>

Cassette schema: comfyrizz.cassette/v1`;

function previewText(value) {
  const text = String(value).replaceAll(/\s+/g, ' ').trim();
  if (text.length <= PREVIEW_LIMIT) return text;
  return `${text.slice(0, PREVIEW_LIMIT - 1)}…`;
}

function writeLine(stream, text = '') {
  stream.write(`${text}\n`);
}

function formatErrors(file, errors) {
  const lines = [`invalid cassette: ${file}`];
  for (const item of errors) lines.push(`  ${item.path}: ${item.message}`);
  return lines.join('\n');
}

async function readCassette(path, deps) {
  const readFile = deps.readFile || fsReadFile;
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    return { error: `cannot read ${path}: ${error.code || error.message}` };
  }
  let cassette;
  try {
    cassette = JSON.parse(text);
  } catch (error) {
    return { error: `invalid JSON in ${path}: ${error.message}` };
  }
  const result = validateCassette(cassette);
  if (!result.ok) {
    return { error: formatErrors(path, result.errors) };
  }
  return { cassette };
}

function commandValidate(args, deps) {
  if (args.length !== 1) {
    writeLine(deps.stderr, 'validate expects exactly one file');
    return 1;
  }
  return readCassette(args[0], deps).then((loaded) => {
    if (loaded.error) {
      writeLine(deps.stderr, loaded.error);
      return 1;
    }
    const cassette = loaded.cassette;
    writeLine(
      deps.stdout,
      `valid ${cassette.schema}: ${cassette.entries.length} entries (model ${cassette.model}, provider ${cassette.provider})`,
    );
    return 0;
  });
}

function commandStats(args, deps) {
  if (args.length !== 1) {
    writeLine(deps.stderr, 'stats expects exactly one file');
    return 1;
  }
  return readCassette(args[0], deps).then((loaded) => {
    if (loaded.error) {
      writeLine(deps.stderr, loaded.error);
      return 1;
    }
    const cassette = loaded.cassette;
    const keys = new Set();
    const statuses = new Map();
    const toolNames = new Map();
    let messages = 0;
    let toolCalls = 0;
    for (const entry of cassette.entries) {
      keys.add(entry.key);
      const status = entry.response.status;
      statuses.set(status, (statuses.get(status) || 0) + 1);
      messages += Array.isArray(entry.request.messages) ? entry.request.messages.length : 0;
      const calls = toolCallSummary(entry);
      toolCalls += calls.length;
      for (const call of calls) toolNames.set(call.name, (toolNames.get(call.name) || 0) + 1);
    }
    const duplicateKeys = cassette.entries.length - keys.size;
    const statusLine = [...statuses.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([status, count]) => `${status}=${count}`)
      .join(', ');
    const toolLine = [...toolNames.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([name, count]) => `${name} x${count}`)
      .join(', ');

    writeLine(deps.stdout, `file: ${args[0]}`);
    writeLine(deps.stdout, `schema: ${cassette.schema}`);
    writeLine(deps.stdout, `model: ${cassette.model}`);
    writeLine(deps.stdout, `provider: ${cassette.provider}`);
    writeLine(deps.stdout, `createdAt: ${cassette.createdAt}`);
    writeLine(deps.stdout, `entries: ${cassette.entries.length}`);
    writeLine(deps.stdout, `unique keys: ${keys.size}`);
    writeLine(deps.stdout, `duplicate keys: ${duplicateKeys}`);
    writeLine(deps.stdout, `messages: ${messages}`);
    writeLine(deps.stdout, `tool calls: ${toolCalls}${toolLine ? ` (${toolLine})` : ''}`);
    writeLine(deps.stdout, `responses by status: ${statusLine || '(none)'}`);
    return 0;
  });
}

function describeToolCalls(calls) {
  if (calls === null) return '—';
  if (calls.length === 0) return '(no tools)';
  return calls.map((call) => `${call.name}(${call.argKeys.join(', ')})`).join('; ');
}

function commandDiff(args, deps) {
  const markdown = args.includes('--md');
  const files = args.filter((arg) => arg !== '--md');
  if (files.length !== 2) {
    writeLine(deps.stderr, 'diff expects two cassette files (and optional --md)');
    return 1;
  }
  return Promise.all(files.map((file) => readCassette(file, deps))).then((loaded) => {
    const failed = loaded.find((item) => item.error);
    if (failed) {
      writeLine(deps.stderr, failed.error);
      return 1;
    }
    const [a, b] = loaded.map((item) => item.cassette);
    const labelA = a.model || files[0];
    const labelB = b.model || files[1];
    const diff = diffCassettes(a, b);

    if (markdown) {
      writeLine(deps.stdout, renderDiffMarkdown(diff, { labelA, labelB }));
      return 0;
    }

    writeLine(deps.stdout, `a: ${labelA} (${a.provider})`);
    writeLine(deps.stdout, `b: ${labelB} (${b.provider})`);
    writeLine(deps.stdout, `identical: ${diff.sameKeys.length}`);
    writeLine(deps.stdout, `only in a: ${diff.onlyA.length}`);
    writeLine(deps.stdout, `only in b: ${diff.onlyB.length}`);
    writeLine(deps.stdout, `changed: ${diff.changed.length}`);
    for (const item of diff.changed) {
      const preview = item.preview ? previewText(item.preview) : item.key.slice(0, 12);
      const tools = `a ${describeToolCalls(item.toolCallsA)} | b ${describeToolCalls(item.toolCallsB)}`;
      writeLine(
        deps.stdout,
        `- ${item.key.slice(0, 12)} ${JSON.stringify(preview)} textChanged=${item.textChanged ? 'yes' : 'no'} ${tools}`,
      );
    }
    return 0;
  });
}

function commandRedact(args, deps) {
  if (args.length !== 2) {
    writeLine(deps.stderr, 'redact expects an input and an output file');
    return 1;
  }
  const [inputPath, outputPath] = args;
  return readCassette(inputPath, deps).then(async (loaded) => {
    if (loaded.error) {
      writeLine(deps.stderr, loaded.error);
      return 1;
    }
    const redacted = redactCassette(loaded.cassette, { env: deps.env || {} });
    const result = validateCassette(redacted);
    if (!result.ok) {
      writeLine(deps.stderr, formatErrors('redacted cassette', result.errors));
      return 1;
    }
    const writeFile = deps.writeFile || fsWriteFile;
    try {
      await writeFile(outputPath, `${JSON.stringify(redacted, null, 2)}\n`, 'utf8');
    } catch (error) {
      writeLine(deps.stderr, `cannot write ${outputPath}: ${error.code || error.message}`);
      return 1;
    }
    writeLine(deps.stdout, `redacted ${redacted.entries.length} entries -> ${outputPath}`);
    return 0;
  });
}

/**
 * Run the CLI. Returns the process exit code.
 * @param {string[]} argv arguments after the script path
 * @param {{readFile?, writeFile?, env?, stdout?, stderr?}} [deps]
 */
export async function main(argv = [], deps = {}) {
  const resolved = {
    readFile: deps.readFile,
    writeFile: deps.writeFile,
    env: deps.env || process.env,
    stdout: deps.stdout || process.stdout,
    stderr: deps.stderr || process.stderr,
  };
  const [command, ...args] = argv;
  if (!command) {
    writeLine(resolved.stderr, USAGE);
    return 1;
  }
  switch (command) {
    case 'validate':
      return commandValidate(args, resolved);
    case 'stats':
      return commandStats(args, resolved);
    case 'diff':
      return commandDiff(args, resolved);
    case 'redact':
      return commandRedact(args, resolved);
    case 'help':
    case '--help':
    case '-h':
      writeLine(resolved.stdout, USAGE);
      return 0;
    default:
      writeLine(resolved.stderr, `unknown command: ${command}`);
      writeLine(resolved.stderr, USAGE);
      return 1;
  }
}

const invokedDirectly =
  typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2));
}
