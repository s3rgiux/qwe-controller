/*
 * Qwen3.5-2B computer-use agent — Prime Video task:
 *   "Play any movie."
 * Connects over CDP to a REAL Chrome (user's profile, headful on display :1).
 * The browser is launched detached by the shell, NOT by this script, so the
 * movie keeps playing after the script exits.
 */
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const LLM = 'http://127.0.0.1:8086/v1/chat/completions';
const MODEL = 'Qwen3.52B';
const CDP = 'http://127.0.0.1:9333';
const MAX_STEPS = 20;
const POST_ACTION_WAIT_MS = 3000; // Prime Video is a heavy SPA

async function askLLM(messages, maxTokens = 300) {
  const t0 = Date.now();
  const res = await fetch(LLM, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, messages, temperature: 0.0, max_tokens: maxTokens,
                           response_format: { type: 'json_object' } }),
  });
  if (!res.ok) throw new Error('LLM HTTP ' + res.status + ': ' + (await res.text()).slice(0, 300));
  const data = await res.json();
  const ms = Date.now() - t0;
  const usage = data.usage ? ` prompt=${data.usage.prompt_tokens} compl=${data.usage.completion_tokens}` : '';
  console.log(`  [llm ${ms}ms${usage}]`);
  return data.choices[0].message.content;
}

// robust JSON: first {...}; if unparseable, try progressively shorter prefixes
function parseJSON(text) {
  let t = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const i = t.indexOf('{');
  if (i < 0) return null;
  t = t.slice(i);
  try { return JSON.parse(t); } catch (e) {}
  for (let j = t.length - 1; j > 0; j--) {
    if (t[j] !== '}') continue;
    try { return JSON.parse(t.slice(0, j + 1)); } catch (e) {}
  }
  return null;
}

function toNum(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v))) return Number(v);
  return null;
}

function extractAction(obj) {
  if (!obj) return null;
  if (obj.action && typeof obj.action === 'object') return obj.action;
  if (obj.action && typeof obj.action === 'string') return obj;
  return null;
}

const SYSTEM = `You are a computer-use agent controlling a real browser on Amazon Prime Video.
Task: play a movie (any movie).
Reply format, ONLY JSON, no prose. EVERY reply MUST contain an "action" object — a plan-only reply is INVALID. You may also include your FULL plan (prefix finished steps "done: ").
Actions (one per reply):
- {"action":"click","x":<int>,"y":<int>} click ONE point; x,y single integers, normalized 0-1000 image coordinates (0,0 top-left; 1000,1000 bottom-right). Never arrays.
- {"action":"type","text":"..."} type into the ALREADY focused field.
- {"action":"press","key":"Enter"}
- {"action":"done"}
Useful knowledge about Prime Video:
- The home page shows rows (carousels) of movie posters. Click a POSTER/COVER IMAGE to open its detail page, where a big "Play" button is at the top.
- On the detail page, click the big PLAY button to start the movie.
- If a sign-in page appears, reply {"action":"done"} — the human will handle login.
- NEVER repeat a click that did not change the page.
- If a popup/banner covers the screen, close it (X button) before continuing.`;

async function observe(page) {
  return page.evaluate(() => {
    const active = document.activeElement;
    const focusDesc = active ? (active.tagName + (active.placeholder ? ' ph="' + String(active.placeholder).slice(0, 40) + '"' : '') + (active.id ? ' #' + active.id : '')) : 'none';
    let video = 'none';
    for (const v of document.querySelectorAll('video')) {
      const d = v.duration || 0;
      if (!v.paused && !v.ended && v.currentTime > 0) video = 'PLAYING t=' + v.currentTime.toFixed(1) + 's dur=' + (isFinite(d) ? d.toFixed(0) : '?') + 's';
      else if (!v.paused) video = 'playing t=0 dur=' + (isFinite(d) ? d.toFixed(0) : '?') + 's';
      else if (v.currentTime > 0 || (isFinite(d) && d > 60)) video = 'paused t=' + v.currentTime.toFixed(1) + 's dur=' + (isFinite(d) ? d.toFixed(0) : '?') + 's';
    }
    return {
      url: location.href,
      title: document.title.slice(0, 100),
      focused: focusDesc,
      video,
    };
  });
}

(async () => {
  const task = 'Play a movie on Prime Video: pick any movie and start it.';
  const browser = await chromium.connectOverCDP(CDP);
  const context = browser.contexts()[0] || await browser.newContext();
  let page = context.pages()[0];
  if (!page) page = await context.newPage();
  if (page.viewportSize() === null) await page.setViewportSize({ width: 1600, height: 900 });
  await page.bringToFront();
  if (!page.url() || page.url() === 'about:blank') {
    await page.goto('https://www.primevideo.com', { waitUntil: 'domcontentloaded', timeout: 60000 });
  }
  await page.waitForTimeout(4000);
  console.log('harness: at', page.url(), '|', await page.title());

  const history = [{ role: 'user', content: [
    { type: 'text', text: `Task: ${task}\nThe browser is on Prime Video (or its landing page). Give your plan and first action.` },
  ]}];

  let success = false;
  const actionLog = [];
  for (let step = 1; step <= MAX_STEPS; step++) {
    const png = await page.screenshot();
    fs.writeFileSync(path.join(__dirname, `pv_step${step}.png`), png);
    history[history.length - 1].content.push({ type: 'image_url', image_url: { url: 'data:image/png;base64,' + png.toString('base64') } });

    const raw = await askLLM([{ role: 'system', content: SYSTEM }, ...history]);
    console.log(`step ${step}: ${raw.trim().slice(0, 400)}`);
    const obj = parseJSON(raw);
    const act = obj && extractAction(obj);
    if (!act) {
      if (obj && Array.isArray(obj.plan)) {
        console.log('  plan only — demanding action');
        if (step === MAX_STEPS) break;
        history.push({ role: 'assistant', content: raw });
        history.push({ role: 'user', content: [{ type: 'text', text:
          'You gave a plan but NO action. Execute the NEXT unfinished step now. Reply with ONLY: {"action":{"action":"click","x":500,"y":430}} or {"action":{"action":"type","text":"..."}} or {"action":{"action":"press","key":"Enter"}} or {"action":{"action":"done"}}. No plan, no prose.' }] });
        continue;
      }
      console.log('UNPARSEABLE, aborting'); break;
    }
    if (obj.plan) console.log('  plan: ' + obj.plan.join(' -> '));

    let feedback = '';
    const urlBefore = page.url();
    if (act.action === 'click') {
      let cx = null, cy = null;
      const ax = act.x, ay = act.y;
      if (Array.isArray(ax) && ax.length === 4) { cx = (toNum(ax[0])+toNum(ax[2]))/2; cy = (toNum(ax[1])+toNum(ax[3]))/2; }
      else if (Array.isArray(ax) && ax.length === 2) { cx = toNum(ax[0]); cy = toNum(ax[1]); }
      else { cx = toNum(ax); cy = toNum(ay); }
      if (cx === null || cy === null || isNaN(cx) || isNaN(cy)) { console.log('  -> BAD click coords, aborting'); break; }
      const x = Math.round(cx / 1000 * 1600), y = Math.round(cy / 1000 * 900);
      console.log(`  -> click at px (${x}, ${y})`);
      await page.mouse.click(x, y);
    } else if (act.action === 'type') {
      console.log(`  -> type ${JSON.stringify(act.text)}`);
      await page.keyboard.type(act.text, { delay: 15 });
      const obs = await observe(page);
      if (!obs.focused.startsWith('INPUT') && !obs.focused.startsWith('TEXTAREA')) {
        feedback = ' WARNING: no input was focused; your text went NOWHERE. Click the target field first, then type.';
      }
    } else if (act.action === 'press') {
      console.log(`  -> press ${act.key}`);
      await page.keyboard.press(act.key);
    } else if (act.action === 'done') {
      console.log('  -> agent reports done');
    }

    await page.waitForTimeout(POST_ACTION_WAIT_MS);
    const obs = await observe(page);
    console.log(`  obs: ${obs.url}\n        focused=${obs.focused} video=${obs.video} title=${JSON.stringify(obs.title)}`);

    const playingLong = obs.video.startsWith('PLAYING') && /dur=[1-9]\d{2,}/.test(obs.video);
    const onWatch = /watch|videos|amzn-vod/.test(obs.url);
    if (playingLong || (obs.video.startsWith('PLAYING') && onWatch)) { success = true; break; }

    if (act.action === 'click' && page.url() === urlBefore && !feedback) {
      feedback = ' WARNING: your click did NOT change the page (same URL). Click a different element (e.g. a movie poster, or the big Play button). Do not repeat the exact same point.';
    }

    const sig = JSON.stringify(act);
    actionLog.push(sig);
    let stall = '';
    if (actionLog.length >= 3 && actionLog.slice(-3).every(s => s === sig)) {
      stall = '\nHARNESS: STOP. You repeated the same action 3x with NO change. Do not repeat it. URL: ' + obs.url +
        '. Video: ' + obs.video + '. Take the NEXT step of your plan (poster -> detail page -> big Play button).';
      console.log('  [harness: stall detected]');
    }

    history.push({ role: 'assistant', content: raw });
    history.push({ role: 'user', content: [
      { type: 'text', text:
        `Observation after your action:\n` +
        `- url: ${obs.url}\n` +
        `- page title: ${obs.title}\n` +
        `- focused: ${obs.focused}\n` +
        `- video state: ${obs.video}\n` +
        feedback + stall + '\n' +
        `Next single action (follow your plan; do not repeat a failed action):` },
    ]});
  }

  const obs = await observe(page);
  console.log('\n=== RESULT ===');
  console.log(`url:    ${obs.url}`);
  console.log(`title:  ${obs.title}`);
  console.log(`video:  ${obs.video}`);
  console.log(`SUCCESS: ${success}`);
  await page.screenshot().then(b => fs.writeFileSync(path.join(__dirname, 'pv_final.png'), b));
  // IMPORTANT: do NOT close the browser — leave the movie playing for the user.
  // (No browser.close(): just exit; the detached Chrome keeps running.)
  console.log('Browser LEFT OPEN (movie keeps playing). Close the Chrome window when you are done.');
})().catch(e => { console.error('FAIL:', e); process.exit(1); });
