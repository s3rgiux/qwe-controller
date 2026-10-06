#!/usr/bin/env node
/**
 * player_audio_check.js — verify the agent-browser player BEFORE arming the recorder.
 *
 * Checks (all via CDP against the agent Chrome, no user-browser access):
 *   1. AUDIO LANGUAGE  — which language the player is actually streaming.
 *      Method: read the content DASH manifest (from performance resource entries),
 *      map the fetched audio segment file names to their AdaptationSet lang,
 *      and report the language(s) present in the fetched segments.
 *   2. SUBTITLES       — the player's closed-captions state:
 *      (a) video.textTracks on the light-DOM video element (DRM content usually
 *          exposes none — the subtitle track is CDM-managed), and
 *      (b) the native media-controls CC button state, read through a CDP
 *          DOM.getDocument(pierce) walk (controls live in a closed shadow root).
 *
 * Usage:
 *   node player_audio_check.js [cdp_url] [required_audio]
 *     cdp_url         default http://127.0.0.1:9333
 *     required_audio  default "en" — exit code 0 only if the playing audio
 *                     matches AND subtitles are off/unknown-no-overlay.
 *
 * Output (stdout, single JSON line):
 *   {"audio":"en","audioSegments":["...audio_30.mp4"],"available":["en","ja"],
 *    "subtitles":"off","video":{"t":12.3,"d":3648,"paused":false},"ok":true}
 *
 * Note: Prime JP web player has no in-player audio menu (native Chrome controls
 * only); the audio language is chosen server-side (GetVodPlaybackResources
 * defaultAudioTrackId, baked in the playback session). The only account-side
 * lever found is Settings > Language > Streaming language (profile
 * language_of_preference, mode=custom, first language = preferred). See README.
 */
const { chromium } = require('playwright-core');

const CDP_URL = process.argv[2] || 'http://127.0.0.1:9333';
const REQUIRED_AUDIO = (process.argv[3] || 'en').toLowerCase();

function log(...a) { process.stderr.write(a.join(' ') + '\n'); }

(async () => {
  const browser = await chromium.connectOverCDP(CDP_URL);
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find(p => p.url().includes('primevideo')) || ctx.pages()[0];
  const cdp = await ctx.newCDPSession(page);

  const result = {
    page: page.url(),
    audio: null,
    audioSegments: [],
    available: [],
    subtitles: 'unknown',
    video: null,
    ok: false,
  };

  // ---- video state -------------------------------------------------------
  result.video = await page.evaluate(() => {
    const v = [...document.querySelectorAll('video')].find(v => v.videoWidth > 0);
    if (!v) return null;
    return {
      t: +v.currentTime.toFixed(1),
      d: v.duration ? +v.duration.toFixed(0) : 0,
      paused: v.paused,
      textTracks: [...v.textTracks].map(t => ({ label: t.label, lang: t.language, mode: t.mode })),
    };
  });

  // ---- audio language from manifest + fetched segments -------------------
  const segs = await page.evaluate(() => {
    const es = performance.getEntriesByType('resource').map(e => e.name);
    const uniq = [...new Set(es.map(u => u.split('?')[0]))];
    // content audio segments only (exclude interstitial/ad manifests)
    return uniq.filter(u => /audio_\d+\.mp4/.test(u) && !/interstitial|avoddash/.test(u)).map(u => u.split('/').pop());
  });
  result.audioSegments = [...new Set(segs)];

  const mpdUrl = await page.evaluate(() =>
    performance.getEntriesByType('resource').map(e => e.name)
      .find(u => /\.mpd/.test(u) && !/interstitial/.test(u)));

  if (mpdUrl) {
    const mpd = await page.evaluate(async (u) => (await fetch(u)).text(), mpdUrl);
    const segToLang = {};
    const langs = new Set();
    for (const blk of mpd.split('<AdaptationSet').slice(1)) {
      const mm = blk.match(/mimeType="([^"]+)"/);
      if (!mm || mm[1] !== 'audio/mp4') continue;
      const lang = (blk.match(/\blang="([^"]+)"/) || [])[1] || '?';
      langs.add(lang);
      for (const rep of blk.split('<Representation').slice(1)) {
        const base = (rep.match(/<BaseURL>([^<]+)<\/BaseURL>/) || [])[1];
        if (base) segToLang[base.split('_').pop()] = lang;
      }
    }
    result.available = [...langs].sort();
    const playing = [...new Set(result.audioSegments
      .map(s => segToLang[s.split('_').pop().replace('.mp4', '')])
      .filter(Boolean))];
    result.audio = playing.length ? (playing.length === 1 ? playing[0] : playing.join('+')) : null;
    result.audioMap = result.audioSegments.map(s => ({ seg: s, lang: segToLang[s.split('_').pop().replace('.mp4', '')] || '???' }));
  }

  // ---- subtitles: native CC button state via shadow-root pierce ----------
  // wake controls (they auto-hide), then pierce the closed shadow roots
  await page.mouse.move(1280, 1000);
  await page.waitForTimeout(250);
  await page.mouse.move(1282, 1002);
  await page.waitForTimeout(1000);
  try {
    const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    let ccOn = null;
    (function walk(n) {
      if (ccOn !== null) return;
      if (n.nodeType === 1) {
        const attrs = n.attributes || [];
        let label = '', cls = '';
        for (let i = 0; i < attrs.length; i += 2) {
          if (attrs[i] === 'aria-label') label = attrs[i + 1];
          if (attrs[i] === 'class') cls = attrs[i + 1];
        }
        if (label === 'show closed captions menu' || /(^|\s)closed-captions(\s|$)/.test(cls)) {
          // Chrome native controls add class "on" when captions are active
          ccOn = /(^|\s)on(\s|$)/.test(cls);
          return;
        }
      }
      for (const c of n.children || []) walk(c);
      for (const c of n.shadowRoots || []) walk(c);
    })(root);
    if (ccOn !== null) result.subtitles = ccOn ? 'on' : 'off';
    // DRM content: textTracks is usually empty; a non-empty enabled track would be authoritative
    if (result.video && result.video.textTracks.some(t => t.mode === 'showing')) result.subtitles = 'on';
  } catch (e) {
    log('subtitle check failed:', e.message);
  }

  await cdp.detach();
  await browser.close();

  // ---- verdict ------------------------------------------------------------
  const audioOk = result.audio !== null && result.audio.toLowerCase() === REQUIRED_AUDIO;
  const subsOk = result.subtitles !== 'on';
  result.ok = audioOk && subsOk;
  console.log(JSON.stringify(result));
  process.exit(result.ok ? 0 : 1);
})().catch(e => {
  log('FATAL', e.message);
  console.log(JSON.stringify({ ok: false, error: e.message }));
  process.exit(2);
});
