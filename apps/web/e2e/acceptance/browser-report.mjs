/**
 * UX20: report which Playwright engines actually launch on this host, and what
 * they are. Exit code 0 even when an engine is missing: the report is the point.
 *   node e2e/acceptance/browser-report.mjs [--json]
 */
import { chromium, firefox, webkit } from '@playwright/test';

const results = [];
for (const [name, engine] of Object.entries({ chromium, firefox, webkit })) {
  try {
    const browser = await engine.launch();
    const page = await browser.newPage();
    await page.setContent('<p>probe</p>');
    results.push({ engine: name, launches: true, version: browser.version(), userAgent: await page.evaluate(() => navigator.userAgent) });
    await browser.close();
  } catch (error) {
    results.push({ engine: name, launches: false, reason: String(error instanceof Error ? error.message : error).split('\n').filter(Boolean).slice(0, 3).join(' | ') });
  }
}
if (process.argv.includes('--json')) console.log(JSON.stringify(results, null, 2));
else for (const entry of results) console.log(entry.launches ? `${entry.engine}: OK ${entry.version}` : `${entry.engine}: UNAVAILABLE ${entry.reason}`);
