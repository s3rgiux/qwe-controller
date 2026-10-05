/*
 * prime_finish_fast.js v2 — after the agent lands on the detail page:
 *   1. play() the movie video (handles paused-resume + post-ad states)
 *   2. wait (up to 4 min) for the VISIBLE movie (rides out any pre-roll ad)
 *   3. unstick viewport (1200x800 -> 2560x1440), window CDP-fullscreen
 *   4. video-element fullscreen (2560x1440)
 *   5. seek to t=0, ensure playing
 *   6. INPUT PASS-THROUGH TEST: mouse move + ESC via CDP (user input not blocked)
 */
const { chromium } = require('playwright-core');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const t0 = Date.now();
function el(...parts) { console.log('  [' + ((Date.now() - t0) / 1000).toFixed(1) + 's]', ...parts); }

(async () => {
  const b = await chromium.connectOverCDP('http://127.0.0.1:9333');
  const ctx = b.contexts()[0];
  const page = ctx.pages().find(p => p.url().includes('primevideo')) || ctx.pages()[0];
  await page.bringToFront();

  const vids = () => page.evaluate(() => [...document.querySelectorAll('video')].map(v => {
    const r = v.getBoundingClientRect();
    return { p: v.paused, t: +v.currentTime.toFixed(1), d: v.duration ? +v.duration.toFixed(0) : 0, w: Math.round(r.width), vw: v.videoWidth };
  }));

  // 1) start the movie (it may be paused at the resume point, hidden)
  const started = await page.evaluate(() => {
    const m = [...document.querySelectorAll('video')].filter(x => x.duration > 600).sort((a, c) => c.duration - a.duration)[0];
    if (!m) return { err: 'no movie video' };
    if (m.paused) m.play();
    return { ok: true, t: m.currentTime };
  });
  el('movie play():', JSON.stringify(started));

  // 2) wait for the VISIBLE movie (d>600, w>500, vw>0, playing)
  let movie = null;
  for (let i = 0; i < 120 && !movie; i++) {
    await sleep(2000);
    const all = await vids();
    const vis = all.filter(x => x.w > 500 && x.vw > 0 && !x.p).sort((a, c) => c.d - a.d);
    if (vis.length) {
      if (vis[0].d > 600) { movie = vis[0]; break; }
      el('ad playing (dur ' + vis[0].d + 's, t ' + vis[0].t + 's)');
    } else if (i % 5 === 0) el('waiting for player view... ' + JSON.stringify(all));
  }
  if (!movie) { el('FAIL: no visible movie. state:', JSON.stringify(await vids())); process.exit(1); }
  el('visible movie playing:', JSON.stringify(movie));

  // 3) unstick viewport + window fullscreen
  const cdp = await ctx.newCDPSession(page);
  const win = await cdp.send('Browser.getWindowForTarget');
  await cdp.send('Browser.setWindowBounds', { windowId: win.windowId, bounds: { windowState: 'normal', left: 0, top: 0, width: 1200, height: 800 } });
  await sleep(1200);
  await cdp.send('Browser.setWindowBounds', { windowId: win.windowId, bounds: { windowState: 'normal', left: 0, top: 0, width: 2560, height: 1440 } });
  await sleep(1500);
  await cdp.send('Browser.setWindowBounds', { windowId: win.windowId, bounds: { windowState: 'fullscreen' } });
  await sleep(1500);
  el('viewport:', await page.evaluate(() => innerWidth + 'x' + innerHeight));

  // 4) video-element fullscreen
  const dims = await page.evaluate(() => ({ iw: innerWidth, ih: innerHeight }));
  await page.mouse.click(dims.iw / 2, dims.ih / 2);
  await sleep(700);
  const fs = await page.evaluate(async () => {
    const m = [...document.querySelectorAll('video')].filter(x => x.duration > 600 && x.getBoundingClientRect().width > 500).sort((a, c) => c.duration - a.duration)[0];
    if (!m) return { err: 'no movie video' };
    if (m.paused) m.play();
    try { if (!document.fullscreenElement) await m.requestFullscreen(); return { ok: true }; }
    catch (e) { return { err: e.message }; }
  });
  el('video fullscreen:', JSON.stringify(fs));
  await sleep(1500);

  // 5) seek to the beginning
  const seek = await page.evaluate(() => {
    const m = [...document.querySelectorAll('video')].filter(x => x.duration > 600).sort((a, c) => c.duration - a.duration)[0];
    if (!m) return { err: 'no movie' };
    m.currentTime = 0;
    if (m.paused) m.play();
    return { ok: true, t: m.currentTime };
  });
  el('seek to 0:', JSON.stringify(seek));
  await sleep(2000);

  // 6) INPUT PASS-THROUGH TEST (same input path as the user's mouse/keyboard)
  await page.evaluate(() => {
    window.__mx2 = false;
    window.addEventListener('mousemove', () => { window.__mx2 = true; }, { once: true });
  });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 700, y: 500 });
  await sleep(400);
  const mouseFired = await page.evaluate(() => window.__mx2);
  el('input test: CDP mousemove -> page mousemove listener fired =', mouseFired, '(true => mouse input reaches the page; user clicks/ESC are NOT blocked)');
  // ESC test: user's ESC should exit the VIDEO fullscreen (native browser behavior)
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(900);
  const escFs = await page.evaluate(() => !!document.fullscreenElement);
  el('ESC test: document fullscreen after ESC =', escFs, '(false => user ESC works: exits video fullscreen, window/desktop stay)');
  if (!escFs) {
    // re-enter video fullscreen for the recording
    await page.mouse.click(dims.iw / 2, dims.ih / 2);
    await sleep(600);
    await page.evaluate(async () => {
      const m = [...document.querySelectorAll('video')].filter(x => x.duration > 600).sort((a, c) => c.duration - a.duration)[0];
      if (m) { if (!document.fullscreenElement) m.requestFullscreen().catch(() => {}); if (m.paused) m.play(); }
    });
    await sleep(1500);
  }

  const fin = await page.evaluate(() => {
    const fe = document.fullscreenElement;
    const r = fe ? fe.getBoundingClientRect() : null;
    return { rect: { fs: !!fe, w: r ? Math.round(r.width) : 0, h: r ? Math.round(r.height) : 0 },
             videos: [...document.querySelectorAll('video')].map(x => ({ p: x.paused, t: +x.currentTime.toFixed(1), d: x.duration ? +x.duration.toFixed(0) : 0, w: Math.round(x.getBoundingClientRect().width) })) };
  });
  el('FINAL:', JSON.stringify(fin));
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
