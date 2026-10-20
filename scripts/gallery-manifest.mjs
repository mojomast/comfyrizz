#!/usr/bin/env node
// Gallery manifest generator: scans examples/*/ and writes docs/gallery/gallery.json.
//
// Per example (docs/specs/SUBMISSION.md S09):
//   id          directory name under examples/
//   title       package.json "title", else the directory name
//   description package.json "description", else the first README paragraph
//   durationSec timeline.json durationInFrames / fps (null when no timeline)
//   video       examples/<id>/out/<id>.mp4, else the first out/*.mp4 (null when absent)
//   poster      examples/<id>/out/poster|<id>|<id>-poster.(jpg|jpeg|png|webp) (null when absent)
//   readme      repo-relative path to the example's README.md (null when absent)
//   tags        package.json "tags" (empty array when absent)
//
// Renders live under out/ and are git-ignored, so video/poster are usually null
// until you render locally. Every emitted path is repo-relative with forward
// slashes; nothing is emitted for a file that is not on disk.
//
// Usage: node scripts/gallery-manifest.mjs [--stdout] [--root <dir>]
//   --stdout   print the manifest instead of writing docs/gallery/gallery.json
//   --root     scan <dir>/examples and write <dir>/docs/gallery/gallery.json
//              (defaults to the repository root; used by the tests)
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');

export const DEFAULT_OUTPUT = 'docs/gallery/gallery.json';

const POSTER_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp'];

function toPosix(path) {
  return path.split(sep).join('/');
}

function isFile(file) {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function isDirectory(dir) {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

// First prose block of a markdown file: skip the leading heading and blanks,
// take lines until the next blank line or block-level markup, collapse to one
// line and strip link/code formatting.
export function firstParagraph(markdown) {
  if (typeof markdown !== 'string') return null;
  const lines = [];
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('```') || line.startsWith('~~~')) break;
    if (lines.length === 0) {
      if (!line || line.startsWith('#') || /^(-{3,}|\*{3,}|_{3,})$/.test(line)) continue;
    } else if (!line || line.startsWith('#') || /^[-*+]\s/.test(line) || /^\d+\.\s/.test(line)) {
      break;
    }
    lines.push(line);
  }
  const text = lines
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .trim();
  return text || null;
}

export function durationSeconds(timeline) {
  const frames = Number(timeline?.durationInFrames);
  const fps = Number(timeline?.fps);
  if (!Number.isFinite(frames) || !Number.isFinite(fps) || frames < 0 || fps <= 0) return null;
  return Math.round((frames / fps) * 100) / 100;
}

function findVideo(outDir, name) {
  const preferred = join(outDir, `${name}.mp4`);
  if (isFile(preferred)) return preferred;
  if (!isDirectory(outDir)) return null;
  const mp4s = readdirSync(outDir)
    .filter((file) => file.toLowerCase().endsWith('.mp4') && isFile(join(outDir, file)))
    .sort();
  return mp4s.length > 0 ? join(outDir, mp4s[0]) : null;
}

function findPoster(outDir, name) {
  if (!isDirectory(outDir)) return null;
  for (const stem of ['poster', name, `${name}-poster`]) {
    for (const extension of POSTER_EXTENSIONS) {
      const candidate = join(outDir, `${stem}.${extension}`);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

function repoRelative(root, absolute) {
  return toPosix(relative(root, absolute));
}

function buildEntry(root, name) {
  const dir = join(root, 'examples', name);
  const packageFile = join(dir, 'package.json');
  const pkg = isFile(packageFile) ? readJson(packageFile) : null;

  const readmeFile = join(dir, 'README.md');
  const readmePresent = isFile(readmeFile);
  const readmeText = readmePresent ? readFileSync(readmeFile, 'utf8') : null;

  const timelineFile = join(dir, 'timeline.json');
  const timeline = isFile(timelineFile) ? readJson(timelineFile) : null;

  const outDir = join(dir, 'out');
  const video = findVideo(outDir, name);
  const poster = findPoster(outDir, name);

  return {
    id: name,
    title: nonEmptyString(pkg?.title) ?? name,
    description: nonEmptyString(pkg?.description) ?? firstParagraph(readmeText),
    durationSec: durationSeconds(timeline),
    video: video ? repoRelative(root, video) : null,
    poster: poster ? repoRelative(root, poster) : null,
    readme: readmePresent ? repoRelative(root, readmeFile) : null,
    tags: Array.isArray(pkg?.tags)
      ? pkg.tags.filter((tag) => nonEmptyString(tag)).map((tag) => tag.trim())
      : [],
  };
}

export function buildManifest(rootDir = REPO_ROOT) {
  const root = resolve(rootDir);
  const examplesDir = join(root, 'examples');
  if (!isDirectory(examplesDir)) return [];
  const names = readdirSync(examplesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  return names.map((name) => buildEntry(root, name));
}

export function serializeManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function parseArgs(argv) {
  const options = { stdout: false, help: false, root: REPO_ROOT };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--stdout') options.stdout = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--root') {
      const value = argv[i + 1];
      if (!value) throw new Error('--root requires a directory');
      options.root = resolve(value);
      i++;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  if (options.help) {
    console.log('Usage: node scripts/gallery-manifest.mjs [--stdout] [--root <dir>]');
    return 0;
  }

  let manifest;
  try {
    manifest = buildManifest(options.root);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  const json = serializeManifest(manifest);
  if (options.stdout) {
    process.stdout.write(json);
    return 0;
  }
  const outputFile = join(options.root, DEFAULT_OUTPUT);
  mkdirSync(dirname(outputFile), { recursive: true });
  writeFileSync(outputFile, json);
  console.log(`wrote ${repoRelative(options.root, outputFile)} (${manifest.length} entries)`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main();
}
