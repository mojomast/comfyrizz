import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from 'node:fs';
const require = createRequire(process.env.PLAYWRIGHT_FROM || import.meta.url);
const { chromium } = require('playwright');
const VID = process.env.VID_DIR || '/workspace/submission-demo/assets/ui-raw';
mkdirSync(VID, { recursive: true });
const token = readFileSync(process.env.COMFYRIZZ_TOKEN_FILE || '/tmp/submission-demo-rt/server-token', 'utf8').trim();
const browser = await chromium.launch({ args: ['--disable-gpu', '--renderer-process-limit=2'] });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1.2, recordVideo: { dir: VID, size: { width: 1920, height: 1080 } } });
let page = await ctx.newPage();
await page.goto(`http://127.0.0.1:59300/#token=${token}`);
const tlog = (m) => writeFileSync('/tmp/sd/timeline.log', `${new Date().toISOString()} ${m}\n`, { flag: 'a' });
tlog('START video');
let n = 0;
for (;;) {
  await new Promise(r => setTimeout(r, 500));
  if (!existsSync('/tmp/sd/cmd.js')) continue;
  const code = readFileSync('/tmp/sd/cmd.js', 'utf8'); unlinkSync('/tmp/sd/cmd.js');
  if (code.trim() === 'QUIT') { tlog('QUIT'); await ctx.close(); await browser.close(); process.exit(0); }
  let out;
  try { const fn = new Function('page', 'ctx', 'tlog', `return (async()=>{${code}})()`); out = await fn(page, ctx, tlog); }
  catch (e) { out = 'ERR ' + e.message; }
  n++;
  try { await page.screenshot({ path: `/tmp/sd/shot.png` }); } catch {}
  writeFileSync('/tmp/sd/out.txt', `#${n} ${typeof out === 'string' ? out : JSON.stringify(out)}`.slice(0, 8000));
}
