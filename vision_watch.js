/*
 * vision_watch.js — EXPERIMENT: per-minute VISUAL verification of a recording.
 *
 * Every 60 s: grab the movie frame (CDP screenshot of the <video> rect),
 * ask Qwen3.52B (:8086, with mmproj) to classify what is on screen, and append
 * a JSONL log line with DOM state + the LLM verdict. If it sees end-credits or
 * clearly-wrong content (storefront / different title card) 2 checks in a row,
 * it kills the ffmpeg capture itself (the VIVANT auto-play defense, visual edition).
 *
 * Usage: node vision_watch.js <log.jsonl> <minutes> <expected_title>
 *   e.g. node vision_watch.js gwh_vision.jsonl 140 "Good Will Hunting"
 *
 * Log line: { i, wall, t, d, paused, marked, nudge, llm_ms,
 *             llm: { scene, title_text, notes }, raw }
 */
const { chromium } = require('playwright-core');
const { execSync } = require('child_process');
const fs = require('fs');

const LLM = 'http://127.0.0.1:8086/v1/chat/completions';
const MODEL = 'Qwen3.52B';
const CDP = 'http://127.0.0.1:9333';

const LOG = process.argv[2] || 'vision_log.jsonl';
const MINUTES = parseInt(process.argv[3] || '140', 10);
const EXPECTED = (process.argv[4] || '').trim();
const INTERVAL_MS = 60000;
const TMP_PNG = '/tmp/vision_watch.png';
const TMP_JPG = '/tmp/vision_watch.jpg';

const PROMPT = `You are a video recorder monitor. I send you ONE frame captured from a screen where a movie plays in a web video player.
${EXPECTED ? `We are recording the movie "${EXPECTED}" (live-action film, color).` : 'We are recording a movie.'}
Classify exactly what is visible in the frame. Reply with ONLY a JSON object, no other text:
{"scene":"...","title_text":"...","notes":"..."}
scene is exactly one of:
 "black" - all black or an empty dark player screen
 "spinner" - a loading circle on a black screen
 "ad" - a commercial: stock footage, product shots, brand logos
 "studio_logo" - a movie studio emblem (MGM lion, Columbia torch woman, etc.)
 "title_card" - a movie or show title shown as text
 "film" - normal live-action movie footage (people acting, scenes, scenery)
 "end_credits" - scrolling credit text over black or over a scene
 "storefront" - a video store web page with rows of movie posters
title_text = the exact movie/show title text visible in the frame (max 6 words), else "".
notes = max 6 words.`;

function parseJSON(text) {
  if (!text) return null;
  let t = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const i = t.indexOf('{');
  if (i < 0) return null;
  t = t.slice(i);
  for (let j = t.length - 1; j > 0; j--) {
    if (t[j] !== '}') continue;
    try { return JSON.parse(t.slice(0, j + 1)); } catch (e) {}
  }
  return null;
}

function killFfmpeg() {
  try {
    const pid = execSync("ps -eo pid,args | awk '/[f]fmpeg.*x11grab/ {print $1; exit}'")
      .toString().trim();
    if (pid) { process.kill(+pid, 'SIGINT'); return pid; }
  } catch (e) {}
  return null;
}

async function classify(b64) {
  const t0 = Date.now();
  const res = await fetch(LLM, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL, temperature: 0, max_tokens: 120,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: [
        { type: 'text', text: PROMPT },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + b64 } },
      ] }],
    }),
  });
  if (!res.ok) throw new Error('LLM HTTP ' + res.status);
  const data = await res.json();
  return { ms: Date.now() - t0, raw: data.choices[0].message.content,
           obj: parseJSON(data.choices[0].message.content) };
}

function logLine(o) {
  fs.appendFileSync(LOG, JSON.stringify(o) + '\n');
  console.log(`[vision] #${o.i} ${o.wall} t=${o.t}/d=${o.d}${o.paused ? ' PAUSED' : ''}${o.nudge ? ' (nudged)' : ''} -> ${o.llm.scene}${o.llm.title_text ? ' "' + o.llm.title_text + '"' : ''} (${o.llm_ms}ms)`);
}

(async () => {
  fs.writeFileSync(LOG, '');
  console.log(`[vision] watching for ${MINUTES} min (expected: "${EXPECTED || 'n/a'}") -> ${LOG}`);
  const b = await chromium.connectOverCDP(CDP);
  const ctx = b.contexts()[0];
  const page = ctx.pages().find(p => p.url().includes('primevideo')) || ctx.pages()[0];

  let streakEnd = 0, streakWrong = 0;
  const endAt = Date.now() + MINUTES * 60000;

  for (let i = 1; Date.now() < endAt; i++) {
    // 1) DOM state (prefer the element tagged by movie_stopper.sh --mark)
    const st = await page.evaluate(() => {
      const movies = [...document.querySelectorAll('video')].filter(x => x.duration > 600);
      const m = document.querySelector('video[data-qwe-stopwatch="1"]') ||
                movies.sort((a, c) => c.duration - a.duration)[0];
      if (!m) return null;
      let nudged = false;
      if (m.paused && m.currentTime < m.duration - 60) { m.play(); nudged = true; }
      const r = m.getBoundingClientRect();
      return { marked: !!m.hasAttribute('data-qwe-stopwatch'), p: m.paused,
               t: +m.currentTime.toFixed(1), d: +m.duration.toFixed(0),
               rect: { x: r.x, y: r.y, w: r.width, h: r.height }, nudged };
    }).catch(e => ({ err: e.message }));

    let rec = { i, wall: new Date().toISOString().slice(11, 19),
                t: st && st.t, d: st && st.d, paused: st && st.p,
                marked: st && st.marked, nudge: st && st.nudged };

    // 2) frame + LLM classification
    let llm = { scene: 'error', title_text: '', notes: st && st.err ? st.err : 'no movie video' };
    let llm_ms = 0;
    if (st && st.rect && st.rect.w > 100) {
      try {
        const png = await page.screenshot({ clip: { x: st.rect.x, y: st.rect.y, width: st.rect.w, height: st.rect.h } });
        fs.writeFileSync(TMP_PNG, png);
        execSync(`ffmpeg -v error -y -i ${TMP_PNG} -vf scale=640:-2 -q:v 5 ${TMP_JPG}`);
        const b64 = fs.readFileSync(TMP_JPG).toString('base64');
        const c = await classify(b64);
        llm_ms = c.ms;
        if (c.obj) llm = { scene: String(c.obj.scene || '?').slice(0, 20),
                           title_text: String(c.obj.title_text || '').slice(0, 60),
                           notes: String(c.obj.notes || '').slice(0, 80) };
        else llm = { scene: 'error', title_text: '', notes: 'unparsable: ' + c.raw.slice(0, 80) };
      } catch (e) { llm = { scene: 'error', title_text: '', notes: String(e.message).slice(0, 80) }; }
    }
    rec.llm_ms = llm_ms; rec.llm = llm;
    logLine(rec);

    // 3) stop rules (2 consecutive strikes)
    // position-aware scene: rolling credits in the first quarter of the movie
    // are OPENING credits (Good Will Hunting opens with a ~4 min credit roll)
    let scene = llm.scene;
    if (scene === 'end_credits' && st.t != null && st.d && st.t < st.d * 0.25) scene = 'opening_credits';
    if (scene === 'ad' && st.t != null && st.t < 600) scene = 'preroll_ad';
    const wrongTitle = llm.scene === 'title_card' && llm.title_text &&
      !llm.title_text.toLowerCase().includes(EXPECTED.toLowerCase().split(' ')[0]);
    // pre-roll ads only exist at the start; an "ad" frame 10+ min in means the
    // player swapped in other content (e.g. a different title's intro card)
    const adLate = scene === 'ad' && i > 10;
    if (scene === 'end_credits') streakEnd++; else streakEnd = 0;
    if (scene === 'storefront' || wrongTitle || adLate) streakWrong++; else streakWrong = 0;

    if (streakEnd >= 2 || streakWrong >= 2) {
      const why = streakEnd >= 2 ? 'END CREDITS seen 2 min in a row'
                                 : 'wrong content (storefront/different title) 2 min in a row';
      const pid = killFfmpeg();
      console.log(`[vision] *** STOP: ${why} — kill -INT ffmpeg pid=${pid || '(not found)'} ***`);
      fs.appendFileSync(LOG, JSON.stringify({ i: i + 1, wall: new Date().toISOString().slice(11, 19), stop: why, ffmpeg_pid: pid }) + '\n');
      break;
    }
    await new Promise(r => setTimeout(r, INTERVAL_MS - (Date.now() % INTERVAL_MS)));
  }
  console.log('[vision] done');
  process.exit(0);
})().catch(e => { console.error('vision_watch FAIL:', e); process.exit(1); });
