/*
 * prime_go.js — go to the Casino Royale detail page, click the exact Resume/Play
 * <button>, wait for the visible player view, ride out any ad, seek to t=0.
 */
const { chromium } = require('playwright-core');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const DETAIL = 'https://www.primevideo.com/detail/0LAX0XFANPXMFOTVAFV5H0LD1H';

(async () => {
  const b = await chromium.connectOverCDP('http://127.0.0.1:9333');
  const ctx = b.contexts()[0];
  const page = ctx.pages().find(p => p.url().includes('primevideo')) || ctx.pages()[0];
  await page.bringToFront();

  const vids = () => page.evaluate(() => [...document.querySelectorAll('video')].map(v => {
    const r = v.getBoundingClientRect();
    return { p: v.paused, t: +v.currentTime.toFixed(1), d: v.duration ? +v.duration.toFixed(0) : 0, w: Math.round(r.width), h: Math.round(r.height), vw: v.videoWidth };
  }));

  // 1) navigate to the detail page
  await page.goto(DETAIL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(8000);
  console.log('at:', page.url().slice(0, 60), '|', await page.title());

  // 2) click the EXACT <button> whose text is Resume/Play/Watch now
  let btn = null;
  for (let attempt = 0; attempt < 6 && !btn; attempt++) {
    btn = await page.evaluate(() => {
      for (const el of document.querySelectorAll('button')) {
        const t = (el.textContent || '').trim().toLowerCase();
        if (['resume', 'play', 'watch now', 'continue', 'start'].includes(t)) {
          const r = el.getBoundingClientRect();
          if (r.width > 60 && r.height > 25 && r.y > 100) return { x: r.x + r.width / 2, y: r.y + r.height / 2, t };
        }
      }
      return null;
    });
    if (!btn) { console.log('  no play button yet, waiting...'); await sleep(3000); }
  }
  if (!btn) { console.log('FAIL: no play button found'); process.exit(1); }
  console.log('clicking button:', JSON.stringify(btn));
  await page.mouse.click(btn.x, btn.y);

  // 3) wait for a VISIBLE playing video (w>500 && vw>0 && !paused)
  let st = await vids(), waited = 0;
  while (waited < 90000) {
    const vis = st.filter(v => v.w > 500 && v.vw > 0 && !v.p);
    if (vis.length) break;
    console.log(`  waiting for player view... (${waited / 1000}s) ${JSON.stringify(st.slice(0, 3))}`);
    await sleep(4000); waited += 4000;
    st = await vids();
  }
  let v = st.filter(x => x.w > 500 && x.vw > 0 && !x.p).sort((a, c) => c.d - a.d)[0];
  if (!v) { console.log('FAIL: no visible playing video. state:', JSON.stringify(await vids())); process.exit(1); }
  console.log('player view open:', JSON.stringify(v));

  // 4) if it's a short ad, wait for the movie
  let adWaited = 0;
  while (v.d < 300 && adWaited < 240000) {
    console.log(`  ad playing (dur ${v.d}s), waiting for movie... (${adWaited / 1000}s)`);
    await sleep(5000); adWaited += 5000;
    const all = await vids();
    v = all.filter(x => x.w > 500 && x.vw > 0 && !x.p).sort((a, c) => c.d - a.d)[0] || null;
    if (!v) { v = { d: 0 }; continue; }
  }
  if (!v || v.d < 300) { console.log('no movie visible yet:', JSON.stringify(await vids())); process.exit(1); }
  console.log('movie playing (visible): t=' + v.t + ' dur=' + v.d);

  // 5) seek visible movie to 0
  const seek = await page.evaluate(() => {
    const m = [...document.querySelectorAll('video')].filter(x => x.duration > 600 && x.getBoundingClientRect().width > 500).sort((a, c) => c.duration - a.duration)[0];
    if (!m) return { err: 'no visible movie video' };
    m.currentTime = 0;
    if (m.paused) m.play();
    return { ok: true, t: m.currentTime, w: Math.round(m.getBoundingClientRect().width), h: Math.round(m.getBoundingClientRect().height) };
  });
  console.log('seek to 0:', JSON.stringify(seek));
  await sleep(4000);

  const fin = await vids();
  console.log('FINAL:', JSON.stringify(fin));
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
