// X1: the social pack that rides along with an export bundle.
// thumb.jpg is the contact-sheet hero frame plus the scene headline,
// preview.gif is an ffmpeg palettegen preview, card.png is a 1200×630 still,
// and chapters.txt is scene titles with their start times.
// CPU only: ffmpeg, no browser, no model, no Google Colab.
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contactFrames, SHEET_FONT } from '../../renderer/scripts/contact-sheet.mjs';

export const SOCIAL_PIXEL_FILES = ['thumb.jpg', 'preview.gif', 'card.png'];
export const SOCIAL_FILE_NAMES = [...SOCIAL_PIXEL_FILES, 'chapters.txt'];
export const SOCIAL_CARD_WIDTH = 1200;
export const SOCIAL_CARD_HEIGHT = 630;

function ffmpeg(args) {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || 'ffmpeg failed').trim());
}

/** The frame the contact sheet would call the hero: its settle beat, else the first beat. */
export function pickHeroFrame(timeline) {
  const beats = contactFrames(timeline);
  if (beats.length === 0) return null;
  const scenes = timeline.scenes ?? [];
  const hero = scenes.find(scene => scene.layout === 'hero') ?? scenes[0];
  return beats.find(beat => beat.sceneId === hero?.id && beat.kind === 'settle')
    ?? beats.find(beat => beat.sceneId === hero?.id)
    ?? beats[0];
}

function sceneHeadline(timeline, beat, pkg) {
  const scene = (timeline.scenes ?? []).find(item => item.id === beat?.sceneId);
  const headline = scene?.copy?.headline;
  if (typeof headline === 'string' && headline.trim()) return headline.trim();
  if (typeof pkg?.title === 'string' && pkg.title.trim()) return pkg.title.trim();
  return 'Comfyrizz';
}

/** YouTube-style clock. Fractional seconds are kept so a mid-frame start stays exact. */
export function formatChapterTime(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  const whole = Math.floor(safe);
  const millis = Math.round((safe - whole) * 1000);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  const clock = hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
    : `${minutes}:${String(secs).padStart(2, '0')}`;
  return millis > 0 ? `${clock}.${String(millis).padStart(3, '0')}` : clock;
}

export function sceneTitle(scene) {
  const headline = scene?.copy?.headline;
  if (typeof headline === 'string' && headline.trim()) return headline.trim().replace(/\s+/g, ' ');
  return scene?.id ?? 'Scene';
}

/** One line per scene: start time, then the title. The first line is 0:00. */
export function chaptersText(timeline) {
  const fps = timeline.fps || 30;
  const lines = (timeline.scenes ?? []).map(scene => {
    const start = scene.from / fps;
    return `${formatChapterTime(start)} ${sceneTitle(scene)}`;
  });
  return `${lines.join('\n')}\n`;
}

function drawText(text, font) {
  const clipped = text.replace(/\s+/g, ' ').trim().slice(0, 80);
  const escaped = clipped
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/%/g, '%%');
  const fontfile = font ? `fontfile=${font}:` : '';
  return `drawtext=${fontfile}text='${escaped}':x=48:y=h-88:fontsize=42:fontcolor=white:box=1:boxcolor=0x00000099:boxborderw=16`;
}

function fileRecord(name, path) {
  return { name, path, bytes: statSync(path).size };
}

/**
 * Write the social pack next to the MP4. chapters.txt always lands.
 * Pixel files need a decodable video; a stub MP4 skips them instead of failing the export.
 */
export function buildSocialPack({ mp4, timeline, pkg, outDir, onLog = () => {} }) {
  const chaptersPath = join(outDir, 'chapters.txt');
  writeFileSync(chaptersPath, chaptersText(timeline));
  const files = [fileRecord('chapters.txt', chaptersPath)];
  const hero = pickHeroFrame(timeline);
  if (!hero || !mp4) {
    onLog('social images skipped: no hero frame');
    return files;
  }
  const tmp = join(tmpdir(), `comfyrizz-social-${process.pid}-${Date.now()}`);
  mkdirSync(tmp, { recursive: true });
  try {
    const fps = timeline.fps || 30;
    const headline = sceneHeadline(timeline, hero, pkg);
    const frame = join(tmp, 'hero.png');
    ffmpeg(['-ss', String(hero.frame / fps), '-i', mp4, '-frames:v', '1', '-y', frame]);
    const font = SHEET_FONT;
    const label = drawText(headline, font);
    const thumb = join(outDir, 'thumb.jpg');
    ffmpeg(['-i', frame, '-vf', `scale=1280:-2,${label}`, '-q:v', '3', '-frames:v', '1', '-y', thumb]);
    const card = join(outDir, 'card.png');
    ffmpeg([
      '-i', frame,
      '-vf', `scale=${SOCIAL_CARD_WIDTH}:${SOCIAL_CARD_HEIGHT}:force_original_aspect_ratio=increase,crop=${SOCIAL_CARD_WIDTH}:${SOCIAL_CARD_HEIGHT},${label}`,
      '-frames:v', '1',
      '-y', card,
    ]);
    const palette = join(tmp, 'palette.png');
    const seconds = Math.max(0.5, Math.min(4, (timeline.durationInFrames || fps) / fps));
    const gifFilter = 'fps=8,scale=480:-2:flags=lanczos';
    ffmpeg(['-t', String(seconds), '-i', mp4, '-vf', `${gifFilter},palettegen`, '-y', palette]);
    const gif = join(outDir, 'preview.gif');
    ffmpeg(['-t', String(seconds), '-i', mp4, '-i', palette, '-lavfi', `${gifFilter}[x];[x][1:v]paletteuse`, '-loop', '0', '-y', gif]);
    files.unshift(fileRecord('thumb.jpg', thumb), fileRecord('preview.gif', gif), fileRecord('card.png', card));
    onLog(`social pack: hero frame ${hero.frame} (${hero.sceneId}), ${files.map(file => file.name).join(', ')}`);
  } catch (error) {
    onLog(`social images skipped: ${error.message}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return files;
}
