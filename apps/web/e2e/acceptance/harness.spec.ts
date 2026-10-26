/**
 * UX20 harness self-checks, run in every engine. They prove the acceptance
 * environment itself is trustworthy before any packet hangs a regression on it:
 *  - outbound paid/external requests fail closed (browser route + server guard);
 *  - labelled media decodes to its own identity in this engine's decoders;
 *  - the environment handed to the server held no credentials.
 */
import { readFileSync } from 'node:fs';
import { expect, test } from './fixtures.ts';
import { decodedAudioId, decodedImageId, decodedVideoFrameId, labelId, mediaUrl } from './helpers/media.ts';

test.describe('fail-closed egress', () => {
  test('requests that leave loopback are aborted and recorded; loopback still works', async ({ page, env, egress }) => {
    await page.goto(`${env.mediaBase}/blank.html`);
    egress.expectBlocked(3);
    const outcomes = await page.evaluate(async () => {
      const targets = ['https://colab.research.google.com/tun/m/assignments', 'https://api.openai.com/v1/chat/completions', 'http://93.184.216.34/'];
      return Promise.all(targets.map(url => fetch(url, { mode: 'no-cors' }).then(() => 'reached', () => 'blocked')));
    });
    expect(outcomes).toEqual(['blocked', 'blocked', 'blocked']);
    expect(egress.blocked.map(entry => new URL(entry.split(' ')[1]).hostname).sort()).toEqual(['93.184.216.34', 'api.openai.com', 'colab.research.google.com']);
    const local = await page.evaluate(async (url: string) => (await fetch(url)).status, `${env.mediaBase}/blank.html`);
    expect(local).toBe(200);
  });

  test('the acceptance server runs behind the egress preload with a scrubbed environment', async ({ env }) => {
    expect(readFileSync(env.egressLog, 'utf8')).toBe('');
    // The harness removes provider and Google Colab settings from the server's environment; the list is names only.
    expect(Array.isArray(env.scrubbedEnvNames)).toBe(true);
    for (const name of env.scrubbedEnvNames) expect(name).toMatch(/KEY|SECRET|TOKEN|COLAB|GOOGLE|OPENAI|ANTHROPIC|HF_|AWS|AZURE|NOUS|OPENROUTER|GEMINI|GROQ/i);
  });
});

test.describe('labelled media decodes to its own identity in this engine', () => {
  test('audio: distinct takes decode to distinct ids, and a seek lands on the same take', async ({ page, env }) => {
    await page.goto(`${env.mediaBase}/blank.html`);
    const a = await decodedAudioId(page, mediaUrl(env, 'take-intro-a', 'wav'));
    test.skip(a === null, 'this engine/host cannot decode WAV (Linux WebKit needs the GStreamer plugin packages); nothing was decoded');
    const b = await decodedAudioId(page, mediaUrl(env, 'take-intro-b', 'wav'));
    expect(a).toBe(labelId('take-intro-a'));
    expect(b).toBe(labelId('take-intro-b'));
    expect(a).not.toBe(b);
    expect(await decodedAudioId(page, mediaUrl(env, 'take-intro-a', 'wav'), 1.7)).toBe(a);
  });

  test('pictures: the decoded pixels name the shot plate', async ({ page, env }) => {
    await page.goto(`${env.mediaBase}/blank.html`);
    expect(await decodedImageId(page, mediaUrl(env, 'shot-1-plate', 'png'))).toBe(labelId('shot-1-plate'));
    expect(await decodedImageId(page, mediaUrl(env, 'shot-2-plate', 'png'))).toBe(labelId('shot-2-plate'));
  });

  test('video: the frame this engine decodes after a seek names the take (H.264 required)', async ({ page, env }) => {
    test.skip(!env.media['take-outro-a']?.mp4, env.media['take-outro-a']?.mp4Skipped ?? 'no MP4 fixture');
    await page.goto(`${env.mediaBase}/blank.html`);
    const id = await decodedVideoFrameId(page, mediaUrl(env, 'take-outro-a', 'mp4'), 1);
    test.skip(id === null, 'this engine cannot play H.264 or exposes no decoded video pixels to canvas; nothing was decoded');
    expect(id).toBe(labelId('take-outro-a'));
  });
});
