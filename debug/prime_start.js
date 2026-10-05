/*
 * prime_start.js — after the agent has started a movie on the detail page:
 *   1. window fullscreen via CDP (windowState: 'fullscreen')
 *   2. player-stage fullscreen (requestFullscreen on .dv-player-fullscreen, trusted click first)
 *   3. if a pre-roll AD is playing (no long-duration video playing yet), wait for it to end
 *   4. seek the movie to t=0, ensure playing
 *   5. print final state JSON
 */
const { chromium } = require('playwright-core');
(async () => {
  const b = await chromium.connectOverCDP('http://127.0.0.1:9333');
  const ctx = b.contexts()[0];
  const page = ctx.pages().find(p => p.url().includes('primevideo')) || ctx.pages()[0];
  await page.bringToFront();

  const state = async () => page.evaluate(() => {
    const vs = [...document.querySelectorAll('video')].map(el => ({
      p: el.paused, t: +el.currentTime.toFixed(1), d: el.duration ? +el.duration.toFixed(0) : 0,
    }));
    const playing = vs.filter(v => !v.p && v.t > 0);
    const longest = vs.reduce((m, v) => Math.max(m, v.d), 0);
    return { vs, longest, somePlaying: playing.length > 0 };
  });

  // 1) window fullscreen
  const cdp = await ctx.newCDPSession(page);
  const win = await cdp.send('Browser.getWindowForTarget');
  await cdp.send('Browser.setWindowBounds', { windowId: win.windowId, bounds: { windowState: 'fullscreen' } });
  await page.waitForTimeout(2000);

  // 2) player-stage fullscreen (trusted click for user activation, then requestFullscreen)
  const d0 = await page.evaluate(() => ({ iw: innerWidth, ih: innerHeight }));
  await page.mouse.click(d0.iw / 2, d0.ih / 2);
  await page.waitForTimeout(800);
  const fsRes = await page.evaluate(async () => {
    const stage = document.querySelector('.dv-player-fullscreen');
    if (!stage) return { err: 'no stage' };
    try { if (!document.fullscreenElement) await stage.requestFullscreen(); return { ok: true }; }
    catch (e) { return { err: e.message }; }
  });
  console.log('stage fullscreen:', JSON.stringify(fsRes));
  await page.waitForTimeout(2000);

  // 3) wait out a pre-roll ad if one is playing (movie = duration > 600s playing)
  let st = await state();
  let waited = 0;
  while (waited < 240 && !(st.somePlaying && st.longest > 600)) {
    console.log(`  ad/waiting: longest=${st.longest}s somePlaying=${st.somePlaying} (${waited}s)`);
    await page.waitForTimeout(5000);
    waited += 5000;
    st = await state();
  }
  if (!(st.somePlaying && st.longest > 600)) {
    console.log('FINAL (no movie playing yet):', JSON.stringify(st));
    process.exit(0);
  }

  // 4) seek movie to the very beginning
  const seek = await page.evaluate(() => {
    const movie = [...document.querySelectorAll('video')].filter(v => v.duration > 600).sort((a, b) => b.duration - a.duration)[0];
    if (!movie) return { err: 'no movie video' };
    try {
      movie.currentTime = 0;
      if (movie.paused) movie.play();
      return { ok: true, t: movie.currentTime, d: +movie.duration.toFixed(0) };
    } catch (e) { return { err: e.message }; }
  });
  console.log('seek to 0:', JSON.stringify(seek));
  await page.waitForTimeout(4000);

  // 5) final state
  const final = await state();
  const rect = await page.evaluate(() => {
    const fe = document.fullscreenElement;
    const r = fe ? fe.getBoundingClientRect() : null;
    return { fs: !!fe, w: r ? Math.round(r.width) : 0, h: r ? Math.round(r.height) : 0 };
  });
  console.log('FINAL STATE:', JSON.stringify({ rect, ...final }));
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
