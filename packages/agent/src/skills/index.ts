import { readFileSync } from 'node:fs';

export const SKILL_CATALOG_VERSION = '1.1.0';

export const BUNDLED_SKILL_IDS = [
  'video-brief',
  'explainer-script',
  'storyboard-direction',
  'project-revision',
] as const;

export type SkillId = typeof BUNDLED_SKILL_IDS[number];

export interface ConversationSkillContext {
  hasPlan: boolean;
  hasProject: boolean;
  mode?: string;
}

export interface ConversationSkills {
  text: string;
  skills: Array<{ id: string; version: string }>;
}

interface BundledSkill {
  id: SkillId;
  version: string;
  body: string;
}

function readMarkdown(id: SkillId): string {
  // tsc does not copy Markdown. Published packages include src alongside dist.
  const candidates = [
    new URL(`./${id}/SKILL.md`, import.meta.url),
    new URL(`../../../src/skills/${id}/SKILL.md`, import.meta.url),
  ];
  for (const file of candidates) {
    try {
      return readFileSync(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  throw new Error(`Missing bundled skill: ${id}`);
}

function loadSkill(id: SkillId): BundledSkill {
  const markdown = readMarkdown(id).replace(/\r\n/g, '\n');
  const frontmatter = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(markdown);
  if (!frontmatter) throw new Error(`Missing skill metadata: ${id}`);
  const metadata = new Map<string, string>();
  for (const line of frontmatter[1].split('\n')) {
    if (line === 'metadata:') continue;
    const field = /^(name|description): (.+)$/.exec(line) ?? /^  (version): "([^"]+)"$/.exec(line);
    if (!field || metadata.has(field[1])) throw new Error(`Invalid skill metadata: ${id}`);
    metadata.set(field[1], field[2]);
  }
  const version = metadata.get('version');
  if (metadata.get('name') !== id || !version || !/^\d+\.\d+\.\d+$/.test(version) || !metadata.get('description')) {
    throw new Error(`Invalid skill metadata: ${id}`);
  }
  // Sources document provenance for maintainers; they are not model instructions.
  const body = frontmatter[2].split(/^## Sources\s*$/m)[0].trim();
  if (!body) throw new Error(`Empty bundled skill: ${id}`);
  return { id, version, body };
}

// Only this fixed allowlist reaches the filesystem; mode and caller data never do.
const catalog = new Map(BUNDLED_SKILL_IDS.map(id => [id, loadSkill(id)]));

export function composeConversationSkills(context: ConversationSkillContext): ConversationSkills {
  const ids: SkillId[] = [
    context.hasPlan ? 'project-revision' : 'video-brief',
    'explainer-script',
    'storyboard-direction',
  ];
  const selected = ids.map(id => catalog.get(id)!);
  const contextNotes = [
    context.hasProject
      ? 'An existing project is present: reconcile the current snapshot and preserve manual edits, even when reconstructing a missing draft.'
      : 'No existing project is present: save a complete draft before building.',
    context.mode === 'express'
      ? 'Express mode: minimize questions and proceed with reasonable defaults once the topic and intent are clear.'
      : 'Collaborate naturally; ask only questions that materially affect the result.',
  ];
  return {
    text: [...contextNotes, ...selected.map(skill => skill.body)].join('\n\n'),
    skills: selected.map(({ id, version }) => ({ id, version })),
  };
}
