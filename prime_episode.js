/*
 * prime_episode.js — deterministic per-episode playback for series.
 *
 * Usage: node prime_episode.js <series-detail-URL> [season] [episode]
 *   series-detail-URL  the SEASON's detail ASIN (Prime gives each season its
 *                      own /detail/<ASIN>; season 1 == the series ASIN)
 *   season             1-based; verifies [data-testid="dp-season-selector"]
 *   episode            1-based; clicks the Nth [data-testid="episode-list-item"]
 *                      card's [data-testid="episodes-playbutton"]
 *
 * Then the exact same proven pipeline as prime_final.js: wait for the visible
 * playing video (dur>600), unstick viewport, window fullscreen, video
 * requestFullscreen, seek t=0, input pass-through test.
 *
 * Why not the agent (Qwen3.52B): the agent search failed on "the boys" class
 * tasks (14-step loop, 2026-10-06 GWH run) — deterministic DOM is the way
 * (README gotcha 17). The episode grid exposes clean data-testids.
 */
const { chromium } = require('playwright-core');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const t0 = Date.now();
function el(...parts) { console.log('  [' + ((Date.now() - t0) / 1000).toFixed(1) + 's]', ...parts); }

const DETAIL = process.argv[2];
const SEASON = +(process.argv[3] || 1);
const EP = +(process.argv[4] || 1);
if (!DETAIL) { console.error('usage: prime_episode.js <detail-url> [season] [episode]'); process.exit(2); }

(async () => {
  const b = await chromium.connectOverCDP('http://127.0.0.1:9333');
  const ctx = b.contexts()[0];
  const page = ctx.pages().find(p => p.url().includes('primevideo')) || ctx.pages()[0];
  await page.bringToFront();
  el('detail URL:', DETAIL, 'season:', SEASON, 'episode:', EP);

  const vids = () => page.evaluate(() => [...document.querySelectorAll('video')].map(v => {
    const r = v.getBoundingClientRect();
    return { p: v.paused, t: +v.currentTime.toFixed(1), d: v.duration ? +v.duration.toFixed(0) : 0, w: Math.round(r.width), vw: v.videoWidth };
  }));

  // 1) detail page: reuse the current page if it is ALREADY the target detail
  //    page with no player open — Prime throttles the episode-list API after
  //    rapid repeated reloads (2026-10-06: grid needed 90-120s after the 3rd
  //    reload in 4 min). Fresh goto only when needed (clean player state,
  //    gotcha 12).
  const asin = (DETAIL.match(/\/detail\/([A-Z0-9]+)/) || [])[1];
  // reuse iff we are on the target detail page AND the episode grid is
  // actually rendered (an open player view has no grid, so this is self-
  // checking). Do NOT reject on '#dv-web-player video' — a hidden player
  // container lingers in the DOM after a previous run.
  const reuse = await page.evaluate((a) => {
    if (!location.href.includes(a)) return false;
    return document.querySelectorAll('[data-testid="episode-list-item"]').length > 0;
  }, asin);
  if (reuse) {
    el('reusing current detail page (grid already loaded)');
  } else {
    el('reloading detail page...');
    await page.goto(DETAIL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(7000);
  }

  // 2) verify the season selector; switch if needed
  let seasonTxt = await page.evaluate(() => {
    const s = document.querySelector('[data-testid="dp-season-selector"]');
    return s ? (s.innerText || '').trim() : null;
  });
  if (seasonTxt !== 'Season ' + SEASON) {
    el('selector shows', JSON.stringify(seasonTxt), '-> switching to Season', SEASON);
    const switched = await page.evaluate((n) => {
      const a = document.querySelector('a[href*="season_select_s' + n + '"]');
      if (!a) return false;
      a.click();
      return true;
    }, SEASON);
    if (!switched) { el('FAIL: no season link for season', SEASON); process.exit(1); }
    await sleep(6000);
    seasonTxt = await page.evaluate(() => {
      const s = document.querySelector('[data-testid="dp-season-selector"]');
      return s ? (s.innerText || '').trim() : null;
    });
    el('selector now:', JSON.stringify(seasonTxt));
  }
  el('season selector OK:', JSON.stringify(seasonTxt));

  // 3) reveal the episode grid (lazy: needs the Episodes tab + a scroll),
  //    then scroll episode N into view and click its play button.
  //    The episode list is fetched from an API and can take 90-120s after a
  //    fresh goto (measured 2026-10-06) — wait up to 150s.
  // Each episode card's [data-testid="episodes-playbutton"] is a HIDDEN <a>
  // (zero rect, shown only on hover in some states) — but its HREF is always
  // in the DOM: /detail/<EPISODE-ASIN>?autoplay=1&t=0&ref_=...
  // Navigating to it starts exactly that episode from 0. No clicks needed.
  // (2026-10-06: The Boys — S1E1 = /detail/0MVRE0SAOF8O1AXLKVW0QHBR7Z)
  let epLink = null;
  for (let i = 0; i < 100 && !epLink; i++) {
    epLink = await page.evaluate((n) => {
      const items = document.querySelectorAll('[data-testid="episode-list-item"]');
      const item = items[n - 1];
      if (!item) return { count: items.length };
      const pb = item.querySelector('[data-testid="episodes-playbutton"]');
      if (!pb || !pb.getAttribute('href')) return { count: items.length };
      return { count: items.length, href: pb.getAttribute('href'),
               ar: pb.getAttribute('aria-label'),
               title: (item.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 60) };
    }, EP);
    if (!epLink || !epLink.href) {
      el('waiting for episode grid... (items: ' + (epLink ? epLink.count : 0) + ')');
      await page.evaluate(() => window.scrollTo(0, 1200));
      await sleep(1500);
    }
  }
  if (!epLink || !epLink.href) { el('FAIL: episode', EP, 'play link not found'); process.exit(1); }
  el('episode', EP, 'deep link:', JSON.stringify(epLink));
  await page.goto('https://www.primevideo.com' + epLink.href, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(5000);

  // 4) wait patiently for the VISIBLE episode (ride out any ad up to 5 min)
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
  if (!movie) { el('FAIL: no visible episode after 5 min. state:', JSON.stringify(await vids())); process.exit(1); }
  el('VISIBLE EPISODE PLAYING:', JSON.stringify(movie));

  // 5) unstick viewport + window fullscreen (gotchas 8-9)
  const cdp = await ctx.newCDPSession(page);
  const win = await cdp.send('Browser.getWindowForTarget');
  await cdp.send('Browser.setWindowBounds', { windowId: win.windowId, bounds: { windowState: 'normal', left: 0, top: 0, width: 1200, height: 800 } });
  await sleep(1200);
  await cdp.send('Browser.setWindowBounds', { windowId: win.windowId, bounds: { windowState: 'normal', left: 0, top: 0, width: 2560, height: 1440 } });
  await sleep(1500);
  await cdp.send('Browser.setWindowBounds', { windowId: win.windowId, bounds: { windowState: 'fullscreen' } });
  await sleep(1500);
  el('viewport:', await page.evaluate(() => innerWidth + 'x' + innerHeight));

  // 6) video-element fullscreen
  const dims = await page.evaluate(() => ({ iw: innerWidth, ih: innerHeight }));
  await page.mouse.click(dims.iw / 2, dims.ih / 2); // trusted activation (controls only)
  await sleep(700);
  const fs = await page.evaluate(async () => {
    const m = [...document.querySelectorAll('video')].filter(x => x.duration > 600 && x.getBoundingClientRect().width > 500).sort((a, c) => c.duration - a.duration)[0];
    if (!m) return { err: 'no visible episode video' };
    if (m.paused) m.play();
    try { if (!document.fullscreenElement) await m.requestFullscreen(); return { ok: true }; }
    catch (e) { return { err: e.message }; }
  });
  el('video fullscreen:', JSON.stringify(fs));
  await sleep(1500);

  // 7) seek to the very beginning
  const seek = await page.evaluate(() => {
    const m = [...document.querySelectorAll('video')].filter(x => x.duration > 600).sort((a, c) => c.duration - a.duration)[0];
    if (!m) return { err: 'no episode' };
    m.currentTime = 0;
    if (m.paused) m.play();
    return { ok: true, t: m.currentTime };
  });
  el('seek to 0:', JSON.stringify(seek));
  await sleep(2500);

  // 8) INPUT PASS-THROUGH TEST (same as prime_final.js)
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
