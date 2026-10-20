import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  BUNDLED_SKILL_IDS,
  SKILL_CATALOG_VERSION,
  composeConversationSkills,
} from '../src/skills/index.js';

const readSource = (id: string) => readFileSync(new URL(`../../src/skills/${id}/SKILL.md`, import.meta.url), 'utf8');
const words = (text: string) => text.trim().split(/\s+/).length;
const VERSIONS: Record<string, string> = {
  'video-brief': '1.0.0',
  'explainer-script': '1.0.0',
  'storyboard-direction': '1.1.0',
  'project-revision': '1.0.0',
};

test('skills: deterministic selection includes drafting guidance and at most three skills', () => {
  for (const hasProject of [false, true]) {
    for (const hasPlan of [false, true]) {
      for (const mode of [undefined, 'chat', 'express', '../../untrusted']) {
        const context = { hasPlan, hasProject, mode };
        const composed = composeConversationSkills(context);
        assert.deepEqual(composed.skills, [
          { id: hasPlan ? 'project-revision' : 'video-brief', version: VERSIONS[hasPlan ? 'project-revision' : 'video-brief'] },
          { id: 'explainer-script', version: VERSIONS['explainer-script'] },
          { id: 'storyboard-direction', version: VERSIONS['storyboard-direction'] },
        ]);
        assert.deepEqual(composeConversationSkills(context), composed);
        assert.ok(!composed.text.includes('../../untrusted'));
        if (hasProject) assert.match(composed.text, /preserve manual edits/);
        if (mode === 'express') assert.match(composed.text, /Express mode/);
      }
    }
  }
  assert.equal(SKILL_CATALOG_VERSION, '1.1.0');
});

test('skills: compiled loader includes canonical bodies and excludes metadata and research links', () => {
  const seen = new Set<string>();
  for (const hasPlan of [false, true]) {
    const composed = composeConversationSkills({ hasPlan, hasProject: hasPlan });
    for (const { id, version } of composed.skills) {
      const source = readSource(id);
      const body = source.replace(/^---\n[\s\S]*?\n---\n/, '').split(/^## Sources\s*$/m)[0].trim();
       assert.match(source, new RegExp(`^name: ${id}$`, 'm'));
       assert.match(source, new RegExp(`^  version: "${version.replaceAll('.', '\\.')}"$`, 'm'));
      assert.ok(composed.text.includes(body), `${id}: full instructional body is present`);
      assert.ok(body.length > 500, `${id}: more than a metadata stub`);
      seen.add(id);
    }
    assert.doesNotMatch(composed.text, /## Sources|https:\/\/|^description:|^version:/m);
    assert.ok(words(composed.text) <= 1100, 'selected instructions stay compact');
    assert.ok(composed.text.length <= 8500, 'character budget bounds prompt overhead');
  }
  assert.deepEqual([...seen].sort(), [...BUNDLED_SKILL_IDS].sort());
});

test('skills: every bundle is compact, self-contained, and refers only to supported tools', () => {
  const allowedTools = new Set(['project_update_plan', 'project_patch_plan', 'project_build']);
  for (const id of BUNDLED_SKILL_IDS) {
    const source = readSource(id);
    const count = words(source);
    assert.ok(count >= 200 && count <= 400, `${id}: ${count} words including metadata and sources`);
    assert.match(source, /^## Sources$/m);
    const links = [...source.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map(match => match[1]);
    assert.ok(links.length > 0, `${id}: documented sources`);
    assert.ok(links.every(link => new URL(link).protocol === 'https:'), `${id}: no missing local references`);
    assert.doesNotMatch(source, /\[[^\]]+\]\[[^\]]*\]|references\/|scripts\//);
    for (const [name] of source.matchAll(/\bproject_[a-z_]+\b/g)) {
      assert.ok(allowedTools.has(name), `${id}: unsupported tool ${name}`);
    }
  }
});

test('skills: returned metadata cannot mutate the bundled catalog', () => {
  const context = { hasPlan: true, hasProject: true };
  const result = composeConversationSkills(context);
  result.skills[0].version = 'tampered';
  result.skills.pop();
  const fresh = composeConversationSkills(context);
  assert.equal(fresh.skills.length, 3);
  assert.ok(fresh.skills.every(skill => skill.version === VERSIONS[skill.id]));
});
