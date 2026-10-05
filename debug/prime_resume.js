/*
 * prime_resume.js — click the big Resume/Play button on the detail page so the
 * player view actually opens, ride out any pre-roll ad, then seek to t=0.
 * Window is already in CDP browser-fullscreen (2560x1440 viewport).
 */
const { chromium } = require('playwright-core');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const b = await chromium.connectOverCDP('http://127.0.0.1:9333');
  const ctx = b.contexts()[0];
  const page = ctx.pages().find(p => p.url().includes('primevideo'));
  await page.bringToFront();

  const vids = () => page.evaluate(() => [...document.querySelectorAll('video')].map(v => {
    const r = v.getBoundingClientRect();
    return { p: v.paused, t: +v.currentTime.toFixed(1), d: v.duration ? +v.duration.toFixed(0) : 0, w: Math.round(r.width), h: Math.round(r.height), vw: v.videoWidth };
  }));

  // 1) find + trusted-click the big Resume/Play button
  const btn = await page.evaluate(() => {
    const els = [...document.querySelectorAll('button, [role=button], a, div')];
    for (const el of els) {
      const t = ((el.getAttribute('aria-label') || '') + ' ' + (el.textContent || '')).trim().toLowerCase();
      if (/^(resume|play|watch now|continue|再生|再開)/.test(t) || t === 'resume') {
        const r = el.getBoundingClientRect();
        if (r.width > 80 && r.height > 30 && r.y > 200) return { x: r.x + r.width / 2, y: r.y + r.height / 2, t: t.slice(0, 30) };
      }
    }
    return null;
  });
  console.log('resume button:', JSON.stringify(btn));
  if (!btn) { console.log('no resume button found'); process.exit(1); }
  await page.mouse.click(btn.x, btn.y);
  console.log('clicked resume at', Math.round(btn.x), Math.round(btn.y));

  // 2) wait for a VISIBLE playing video (w>500 && vw>0 && !paused)
  let st = await vids(), waited = 0;
  while (waited < 90000) {
    const vis = st.filter(v => v.w > 500 && v.vw > 0 && !v.p);
    if (vis.length) { st = vis; break; }
    console.log(`  waiting for player view... ${JSON.stringify(st)} (${waited / 1000}s)`);
    await sleep(4000); waited += 4000;
    st = await vids();
  }
  if (!st.length) { console.log('FAIL: no visible playing video. state:', JSON.stringify(await vids())); process.exit(1); }
  console.log('player view open, playing:', JSON.stringify(st));

  // 3) if what's playing is a short ad (d<300), wait for it to end
  let v = st[0], adWaited = 0;
  while (v.d < 300 && adWaited < 240000) {
    console.log(`  ad playing (${v.d}s), waiting for movie... (${adWaited / 1000}s)`);
    await sleep(5000); adWaited += 5000;
    const all = await vids();
    v = all.filter(x => x.w > 500 && x.vw > 0 && !x.p).sort((a, c) => c.d - a.d)[0] || null;
    if (!v) { v = { d: 0 }; continue; }
  }
  if (!v || v.d < 300) { console.log('no long movie visible yet:', JSON.stringify(await vids())); process.exit(1); }
  console.log('movie playing (visible): t=' + v.t + ' dur=' + v.d);

  // 4) seek the visible movie video to 0
  const seek = await page.evaluate(() => {
    const m = [...document.querySelectorAll('video')].filter(x => x.duration > 600 && x.getBoundingClientRect().width > 500).sort((a, c) => c.duration - a.duration)[0];
    if (!m) return { err: 'no visible movie video' };
    m.currentTime = 0;
    if (m.paused) m.play();
    return { ok: true, t: m.currentTime, w: Math.round(m.getBoundingClientRect().width) };
  });
  console.log('seek to 0:', JSON.stringify(seek));
  await sleep(4000);

  // 5) final state
  const fin = await vids();
  console.log('FINAL:', JSON.stringify(fin));
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
