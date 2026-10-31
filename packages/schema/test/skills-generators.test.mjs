// Google Colab e2e 2026-10-30: the title cutout batch died with "/jobs/12/generator JOBS_ENUM: 'birefnet'".
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const schema = JSON.parse(readFileSync(new URL('../jobs-v1.schema.json', import.meta.url)));

test('the jobs schema admits the skills-port generators the ref watch submits', () => {
  const text = JSON.stringify(schema);
  const match = /"generator":\{"enum":(\[[^\]]*\])/.exec(text);
  assert.ok(match);
  const generators = JSON.parse(match[1]);
  for (const id of ['qwen-edit-2511', 'birefnet']) assert.ok(generators.includes(id), id);
});
