/*
 * prime_play.js — complete the playback setup on the Casino Royale detail page:
 *   1. start playback (click the real Play/Watch-now button; fallback video.play())
 *   2. wait until the movie (dur>600) is actually playing (rides out a pre-roll ad)
 *   3. window fullscreen (CDP) + player-stage fullscreen (requestFullscreen)
 *   4. seek the movie to the very beginning (t=0), ensure playing
 *   5. print final state
 */
const { chromium } = require('playwright-core');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const b = await chromium.connectOverCDP('http://127.0.0.1:9333');
  const ctx = b.contexts()[0];
  const page = ctx.pages().find(p => p.url().includes('primevideo')) || ctx.pages()[0];
  await page.bringToFront();

  const movieState = async () => page.evaluate(() => {
    const vids = [...document.querySelectorAll('video')].map(el => ({
      p: el.paused, t: +el.currentTime.toFixed(1), d: el.duration ? +el.duration.toFixed(0) : 0,
    }));
    const movie = vids.filter(v => v.d > 600).sort((a, b2) => b2.d - a.d)[0] || null;
    return { vids, movie };
  });

  console.log('title:', await page.title(), '|', page.url().slice(0, 60));

  // 1) start playback: click the real Play / Watch-now button if present
  let started = false;
  const clicked = await page.evaluate(() => {
    const els = [...document.querySelectorAll('button, [role=button], a, [class*="play" i], [class*="Play" i]')];
    for (const el of els) {
      const t = ((el.getAttribute('aria-label') || '') + ' ' + (el.textContent || '')).trim().toLowerCase();
      if (/(watch now|play|resume|start|再生)/.test(t)) {
        const r = el.getBoundingClientRect();
        if (r.width > 20 && r.height > 20 && r.y > 0) { el.click(); return t.slice(0, 40); }
      }
    }
    return null;
  });
  console.log('clicked play control:', clicked);
  await sleep(2500);
  let st = await movieState();
  if (st.movie && !st.movie.p) started = true;

  // fallback: play the movie video element directly
  if (!started) {
    const r = await page.evaluate(() => {
      const vids = [...document.querySelectorAll('video')].filter(v => v.duration > 600);
      const m = vids.sort((a, b) => b.duration - a.duration)[0];
      if (!m) return null;
      m.play();
      return { ok: true };
    });
    console.log('fallback video.play():', JSON.stringify(r));
    await sleep(2500);
    st = await movieState();
  }

  // 2) wait until the movie (dur>600) is playing (ride out a pre-roll ad, max ~120s)
  let waited = 0;
  while (!(st.movie && !st.movie.p) && waited < 120000) {
    console.log(`  waiting for movie to play (movie=${JSON.stringify(st.movie)}) ${waited / 1000}s`);
    await sleep(4000); waited += 4000;
    st = await movieState();
  }
  if (!(st.movie && !st.movie.p)) { console.log('FAIL: movie not playing. state:', JSON.stringify(st)); process.exit(1); }
  console.log('movie playing at t=' + st.movie.t + 's (dur ' + st.movie.d + 's)');

  // 3a) window fullscreen
  const cdp = await ctx.newCDPSession(page);
  const win = await cdp.send('Browser.getWindowForTarget');
  await cdp.send('Browser.setWindowBounds', { windowId: win.windowId, bounds: { windowState: 'fullscreen' } });
  await sleep(2000);

  // 3b) player-stage fullscreen (trusted click first)
  const d0 = await page.evaluate(() => ({ iw: innerWidth, ih: innerHeight }));
  await page.mouse.click(d0.iw / 2, d0.ih / 2);
  await sleep(800);
  const fsRes = await page.evaluate(async () => {
    const stage = document.querySelector('.dv-player-fullscreen');
    if (!stage) return { err: 'no stage' };
    try { if (!document.fullscreenElement) await stage.requestFullscreen(); return { ok: true }; }
    catch (e) { return { err: e.message }; }
  });
  console.log('stage fullscreen:', JSON.stringify(fsRes));
  await sleep(2000);

  // 4) seek to the very beginning
  const seek = await page.evaluate(() => {
    const m = [...document.querySelectorAll('video')].filter(v => v.duration > 600).sort((a, b) => b.duration - a.duration)[0];
    if (!m) return { err: 'no movie' };
    m.currentTime = 0;
    if (m.paused) m.play();
    return { ok: true, t: m.currentTime };
  });
  console.log('seek to 0:', JSON.stringify(seek));
  await sleep(4000);

  // 5) final state
  const fin = await movieState();
  const rect = await page.evaluate(() => {
    const fe = document.fullscreenElement;
    const r = fe ? fe.getBoundingClientRect() : null;
    return { fs: !!fe, w: r ? Math.round(r.width) : 0, h: r ? Math.round(r.height) : 0 };
  });
  console.log('FINAL:', JSON.stringify({ rect, movie: fin.movie }));
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
