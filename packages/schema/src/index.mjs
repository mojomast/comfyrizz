// B1: public API of @comfyrizz/schema - ajv structural validation + shared semantic checks.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
  semanticCheck,
  applyDefaults,
  SEMANTIC_CODES,
  LAYOUTS,
  GENERATED_OUTPUT_LICENSE,
  MODEL_GENERATORS,
  FLEXIBLE_CEILING_FRAMES,
  pathProblem,
} from "./semantic.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const SCHEMA_PATH = join(here, "..", "package-v1.schema.json");

let cachedSchema = null;
export function loadSchema() {
  if (!cachedSchema) cachedSchema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
  return cachedSchema;
}

let cachedValidate = null;
export function compile() {
  if (cachedValidate) return cachedValidate;
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    allowUnionTypes: true,
    validateFormats: true,
  });
  addFormats(ajv);
  cachedValidate = ajv.compile(loadSchema());
  return cachedValidate;
}

/** Map an ajv error onto a stable code independent of the validator library. */
export function schemaCode(err) {
  return `SCHEMA_${String(err.keyword || "unknown").toUpperCase()}`;
}

export function schemaErrors(doc) {
  const validate = compile();
  const ok = validate(doc);
  if (ok) return [];
  return (validate.errors || []).map((err) => ({
    source: "schema",
    code: schemaCode(err),
    path: err.instancePath || "",
    message: `${err.message}${err.params && Object.keys(err.params).length ? ` ${JSON.stringify(err.params)}` : ""}`,
  }));
}

/**
 * Validate a package document.
 * Returns { valid, schemaOk, errors, warnings, semantic } - errors merge structural
 * (ajv) and semantic findings, each tagged with `source`.
 */
export function validatePackage(doc, { defaults = false } = {}) {
  const document = defaults ? applyDefaults(doc, loadSchema()) : doc;
  const schema = schemaErrors(document);
  const { errors: sem, warnings } = semanticCheck(document);
  const errors = [...schema, ...sem].sort((a, b) => (a.path === b.path ? a.code.localeCompare(b.code) : a.path.localeCompare(b.path)));
  return { valid: errors.length === 0, schemaOk: schema.length === 0, errors, warnings, semantic: sem, document };
}

export function parse(text) {
  // Wrap JSON.parse so that a NaN/Infinity literal (only reachable through a
  // permissive parser) is still reported as a semantic finding rather than a crash.
  return JSON.parse(text, (key, value) => value);
}

export {
  semanticCheck,
  applyDefaults,
  SEMANTIC_CODES,
  LAYOUTS,
  GENERATED_OUTPUT_LICENSE,
  MODEL_GENERATORS,
  FLEXIBLE_CEILING_FRAMES,
  pathProblem,
};
