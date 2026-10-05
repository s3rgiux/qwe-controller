/*
 * prime_final.js — clean run: reload detail page, ONE click on Resume, wait
 * patiently for the visible movie (ride out any ad up to 5 min), then
 * viewport unstick + fullscreen + seek to 0 + input pass-through test.
 * Do NOT touch the hidden media element before the player view is open.
 */
const { chromium } = require('playwright-core');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const t0 = Date.now();
function el(...parts) { console.log('  [' + ((Date.now() - t0) / 1000).toFixed(1) + 's]', ...parts); }
const DETAIL = 'https://www.primevideo.com/detail/0LAX0XFANPXMFOTVAFV5H0LD1H';

(async () => {
  const b = await chromium.connectOverCDP('http://127.0.0.1:9333');
  const ctx = b.contexts()[0];
  const page = ctx.pages().find(p => p.url().includes('primevideo')) || ctx.pages()[0];
  await page.bringToFront();

  const vids = () => page.evaluate(() => [...document.querySelectorAll('video')].map(v => {
    const r = v.getBoundingClientRect();
    return { p: v.paused, t: +v.currentTime.toFixed(1), d: v.duration ? +v.duration.toFixed(0) : 0, w: Math.round(r.width), vw: v.videoWidth };
  }));

  // 1) fresh detail page
  el('reloading detail page...');
  await page.goto(DETAIL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(6000);

  // 2) find + click the Resume/Play control exactly ONCE
  let btn = null;
  for (let i = 0; i < 10 && !btn; i++) {
    btn = await page.evaluate(() => {
      for (const e of document.querySelectorAll('span, button, [role=button]')) {
        const t = (e.textContent || '').trim().toLowerCase();
        if (!['resume', 'play', 'watch now', 'continue', 'start'].includes(t)) continue;
        const r = e.getBoundingClientRect();
        if (r.width > 25 && r.width < 300 && r.height > 18 && r.height < 80 && r.y > 100)
          return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), t };
      }
      return null;
    });
    if (!btn) { el('waiting for play control...'); await sleep(1500); }
  }
  if (!btn) { el('FAIL: no play control'); process.exit(1); }
  el('clicking:', JSON.stringify(btn));
  await page.mouse.click(btn.x, btn.y);

  // 3) wait patiently for the VISIBLE movie (ride out ads up to 5 min)
  let movie = null, lastLog = 0;
  for (let i = 0; i < 150 && !movie; i++) {
    await sleep(2000);
    const all = await vids();
    const vis = all.filter(x => x.w > 500 && x.vw > 0 && !x.p).sort((a, c) => c.d - a.d);
    if (vis.length) {
      if (vis[0].d > 600) { movie = vis[0]; break; }
      if (Date.now() - lastLog > 10000) { el('ad playing (dur ' + vis[0].d + 's, t ' + vis[0].t + 's)'); lastLog = Date.now(); }
    } else if (i % 5 === 0) el('waiting for player view... ' + JSON.stringify(all.slice(0, 2)));
  }
  if (!movie) { el('FAIL: no visible movie after 5 min. state:', JSON.stringify(await vids())); process.exit(1); }
  el('VISIBLE MOVIE PLAYING:', JSON.stringify(movie));

  // 4) unstick viewport + window fullscreen
  const cdp = await ctx.newCDPSession(page);
  const win = await cdp.send('Browser.getWindowForTarget');
  await cdp.send('Browser.setWindowBounds', { windowId: win.windowId, bounds: { windowState: 'normal', left: 0, top: 0, width: 1200, height: 800 } });
  await sleep(1200);
  await cdp.send('Browser.setWindowBounds', { windowId: win.windowId, bounds: { windowState: 'normal', left: 0, top: 0, width: 2560, height: 1440 } });
  await sleep(1500);
  await cdp.send('Browser.setWindowBounds', { windowId: win.windowId, bounds: { windowState: 'fullscreen' } });
  await sleep(1500);
  el('viewport:', await page.evaluate(() => innerWidth + 'x' + innerHeight));

  // 5) video-element fullscreen
  const dims = await page.evaluate(() => ({ iw: innerWidth, ih: innerHeight }));
  await page.mouse.click(dims.iw / 2, dims.ih / 2); // trusted activation (controls only)
  await sleep(700);
  const fs = await page.evaluate(async () => {
    const m = [...document.querySelectorAll('video')].filter(x => x.duration > 600 && x.getBoundingClientRect().width > 500).sort((a, c) => c.duration - a.duration)[0];
    if (!m) return { err: 'no visible movie video' };
    if (m.paused) m.play();
    try { if (!document.fullscreenElement) await m.requestFullscreen(); return { ok: true }; }
    catch (e) { return { err: e.message }; }
  });
  el('video fullscreen:', JSON.stringify(fs));
  await sleep(1500);

  // 6) seek to the very beginning
  const seek = await page.evaluate(() => {
    const m = [...document.querySelectorAll('video')].filter(x => x.duration > 600).sort((a, c) => c.duration - a.duration)[0];
    if (!m) return { err: 'no movie' };
    m.currentTime = 0;
    if (m.paused) m.play();
    return { ok: true, t: m.currentTime };
  });
  el('seek to 0:', JSON.stringify(seek));
  await sleep(2500);

  // 7) INPUT PASS-THROUGH TEST (same input path as user's mouse/keyboard)
  await page.evaluate(() => {
    window.__mx2 = false;
    window.addEventListener('mousemove', () => { window.__mx2 = true; }, { once: true });
  });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 700, y: 500 });
  await sleep(400);
  const mouseFired = await page.evaluate(() => window.__mx2);
  el('input test: CDP mousemove -> page listener fired =', mouseFired, '(true => user mouse/ESC reach the page)');
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(900);
  const escFs = await page.evaluate(() => !!document.fullscreenElement);
  el('ESC test: video-fullscreen after ESC =', escFs, '(false => user can always ESC out of the video)');
  if (!escFs) {
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
