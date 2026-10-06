#!/usr/bin/env node
// Read-only episode-grid scrape: connects to the agent Chrome over CDP and
// reads [data-testid="episode-list-item"] from the CURRENT page. No clicks,
// no navigation, no input — safe to run while an episode is playing/recording
// (DOM reads paint nothing; the x11grab display is untouched).
// Usage: node grid_readonly.js
const { chromium } = require('playwright-core');

(async () => {
  const b = await chromium.connectOverCDP('http://127.0.0.1:9333');
  const ctx = b.contexts()[0];
  const page = ctx.pages().find(p => p.url().includes('primevideo.com')) || ctx.pages()[0];
  const out = await page.evaluate(() => {
    const items = [...document.querySelectorAll('[data-testid="episode-list-item"]')];
    return items.map((it, i) => {
      const pb = it.querySelector('[data-testid="episodes-playbutton"]')
        || it.querySelector('a[href*="/video/"]') || it.querySelector('a');
      const t = it.querySelector('h2, h3, [data-testid="title"]');
      const txt = (t ? t.textContent : it.textContent || '').replace(/\s+/g, ' ').trim();
      return { n: i + 1, title: txt.slice(0, 90), href: pb ? pb.getAttribute('href') : null };
    });
  });
  console.log(JSON.stringify({ url: page.url(), grid: out }, null, 1));
  await b.close();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
