#!/usr/bin/env node
// B1: generate packages/schema/types.ts from package-v1.schema.json.
//
// The generated file is committed and a test regenerates it in memory and compares
// byte-for-byte, so types.ts can never drift from the schema. It is a small,
// deliberate generator for the JSON Schema subset this schema actually uses
// (objects, properties, required, arrays, enums, const, local $refs, oneOf,
// patternProperties, additionalProperties, unevaluatedProperties, type arrays).
//
// Usage: node scripts/gen-types.mjs [--check]
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const SCHEMA_PATH = join(root, "package-v1.schema.json");
const TYPES_PATH = join(root, "types.ts");

export const GENERATOR_VERSION = "1.0.0";

export function readSchema() {
  return JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
}

const pascal = (s) =>
  String(s)
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");

const camel = (s) => {
  const p = pascal(s);
  return p.charAt(0).toLowerCase() + p.slice(1);
};

const INDENT = "  ";

function refName(ref) {
  const m = /^#\/\$defs\/(.+)$/.exec(ref);
  if (!m) throw new Error(`unsupported $ref: ${ref}`);
  return pascal(m[1]);
}

function literal(v) {
  return JSON.stringify(v);
}

// Render one JSON Schema node as a TS type expression. `defs` name resolution is
// handled by the caller for $ref (interfaces are emitted separately).
function tsType(node, ctx) {
  const pad = INDENT.repeat(ctx.depth);
  if (node === true) return "unknown";
  if (node === false) return "never";
  if (node.$ref) return refName(node.$ref);
  if (node.const !== undefined) return literal(node.const);
  if (Array.isArray(node.enum)) return node.enum.map(literal).join(" | ");
  if (Array.isArray(node.oneOf)) {
    return node.oneOf
      .map((b) => (b.type === "null" ? "null" : tsType(b, ctx)))
      .join(" | ");
  }
  if (Array.isArray(node.anyOf)) {
    return node.anyOf.map((b) => tsType(b, ctx)).join(" | ");
  }
  if (Array.isArray(node.type)) {
    return node.type
      .map((t) => tsType({ ...node, type: t }, ctx))
      .filter((v, i, a) => a.indexOf(v) === i)
      .join(" | ");
  }
  switch (node.type) {
    case "object": {
      return objectType(node, ctx);
    }
    case "array": {
      const items = node.items ? tsType(node.items, { ...ctx, depth: ctx.depth }) : "unknown";
      return `Array<${items}>`;
    }
    case "integer":
    case "number":
      return "number";
    case "string":
      return "string";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    default: {
      if (node.properties || node.patternProperties || node.additionalProperties) {
        return objectType(node, ctx);
      }
      return "unknown";
    }
  }
}

function commentFor(node, pad) {
  const parts = [];
  const put = (text) => {
    if (!text) return;
    const flat = String(text).replace(/\s+/g, " ").trim();
    if (!flat) return;
    parts.push(flat);
  };
  put(node.description);
  if (Array.isArray(node.enum) && !node.description) put(`One of ${node.enum.map(literal).join(", ")}.`);
  const constraints = [];
  if (node.minimum !== undefined) constraints.push(`min ${node.minimum}`);
  if (node.maximum !== undefined) constraints.push(`max ${node.maximum}`);
  if (node.minLength !== undefined) constraints.push(`minLength ${node.minLength}`);
  if (node.maxLength !== undefined) constraints.push(`maxLength ${node.maxLength}`);
  if (node.minItems !== undefined) constraints.push(`minItems ${node.minItems}`);
  if (node.maxItems !== undefined) constraints.push(`maxItems ${node.maxItems}`);
  if (node.pattern) constraints.push(`pattern ${node.pattern}`);
  if (node.default !== undefined) constraints.push(`default ${literal(node.default)}`);
  if (constraints.length) put(`[${constraints.join(", ")}]`);
  if (!parts.length) return "";
  const lines = [];
  for (const part of parts) {
    // wrap at ~92 columns of payload after the " * " prefix
    let rest = part;
    while (rest.length > 96) {
      let cut = rest.lastIndexOf(" ", 96);
      if (cut <= 0) cut = 96;
      lines.push(pad + " * " + rest.slice(0, cut));
      rest = rest.slice(cut).trimStart();
    }
    lines.push(pad + " * " + rest);
  }
  return `${pad}/**\n${lines.join("\n")}\n${pad} */\n`;
}

function objectType(node, ctx) {
  const pad = INDENT.repeat(ctx.depth);
  const lines = [];
  const props = node.properties || {};
  const required = new Set(node.required || []);
  const keys = Object.keys(props);
  for (const key of keys) {
    const child = props[key];
    const optional = required.has(key) ? "" : "?";
    const safeKey = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : literal(key);
    if (child && typeof child === "object" && child.description) {
      lines.push(commentFor(child, pad).trimEnd());
    }
    lines.push(`${pad}${safeKey}${optional}: ${tsType(child, { ...ctx, depth: ctx.depth + 1 })};`);
  }
  const extra = [];
  if (node.patternProperties) {
    for (const [pattern, child] of Object.entries(node.patternProperties)) {
      extra.push(`${pad}[key: \`${pattern}\`]: ${tsType(child, ctx)};`);
    }
  }
  if (node.additionalProperties && typeof node.additionalProperties === "object") {
    extra.push(`${pad}[key: string]: ${tsType(node.additionalProperties, ctx)};`);
  }
  if (extra.length) {
    if (lines.length) lines.push("");
    lines.push(...extra);
  }
  if (!lines.length) return "Record<string, never>";
  return `{\n${lines.join("\n")}\n${pad}}`;
}

export function renderTypes(schema) {
  const defs = schema.$defs || {};
  const shape = { ...schema };
  delete shape.$defs;
  const names = Object.keys(defs);
  const blocks = [];

  blocks.push(objectInterface("PackageV1", shape));
  for (const name of names) {
    blocks.push(renderDef(name, defs));
  }

  const sha = createHash("sha256")
    .update(readFileSync(SCHEMA_PATH))
    .digest("hex");

  const header = [
    "// GENERATED FILE - do not edit by hand.",
    "//",
    "// Source:        packages/schema/package-v1.schema.json",
    `// Schema sha256: ${sha}`,
    `// Generator:     packages/schema/scripts/gen-types.mjs (v${GENERATOR_VERSION})`,
    "//",
    "// Regenerate: pnpm --filter @comfyrizz/schema gen:types",
    "// CI check:   pnpm --filter @comfyrizz/schema check:types",
    `// TypeScript: ${'tsc --noEmit --strict types.ts'} must stay green.`,
    "",
    "export const SCHEMA_ID = " + JSON.stringify(schema.$id) + " as const;",
    "export const SCHEMA_VERSION = 1 as const;",
    "",
  ].join("\n");

  return header + blocks.join("\n\n") + "\n";
}

function renderDef(name, defs) {
  return objectInterface(pascal(name), defs[name]);
}

function objectInterface(typeName, node) {
  if (node.type && node.type !== "object" && !node.properties) {
    // alias types: enum unions, scalars, arrays
    const doc = commentFor(node, "");
    return `${doc}export type ${typeName} = ${tsType(node, { depth: 0, ctxDefs: true })};`;
  }
  const body = objectType(node, { depth: 1 });
  return `export interface ${typeName} ${body}`;
}

export function generate() {
  const schema = readSchema();
  return renderTypes(schema);
}

function main() {
  const check = process.argv.includes("--check");
  const out = generate();
  const current = (() => {
    try {
      return readFileSync(TYPES_PATH, "utf8");
    } catch {
      return null;
    }
  })();
  if (check) {
    if (current !== out) {
      console.error("types.ts is stale: run `pnpm --filter @comfyrizz/schema gen:types`");
      process.exit(1);
    }
    console.log("types.ts is up to date with package-v1.schema.json");
    return;
  }
  if (current === out) {
    console.log("types.ts already up to date");
    return;
  }
  writeFileSync(TYPES_PATH, out);
  console.log(`wrote ${TYPES_PATH} (${out.split("\n").length} lines)`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
