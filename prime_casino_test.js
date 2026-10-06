/*
 * Qwen3.5-2B agent — Prime Video: search a movie title and open its detail page.
 * Usage: node prime_casino_test.js "movie title"   (default: "casino royale")
 * Connects over CDP to the user's real (detached) Chrome.
 */
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const LLM = 'http://127.0.0.1:8086/v1/chat/completions';
const MODEL = 'Qwen3.52B';
const CDP = 'http://127.0.0.1:9333';
const MAX_STEPS = 14;
const POST_ACTION_WAIT_MS = 3000;

const TITLE = (process.argv[2] || 'casino royale').trim();
const PREFIX = TITLE.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 12);
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const TITLE_RE = new RegExp(esc(TITLE.trim()), 'i');

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
  console.log(`  [llm ${Date.now() - t0}ms prompt=${data.usage.prompt_tokens} compl=${data.usage.completion_tokens}]`);
  return data.choices[0].message.content;
}

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
Task: search for the movie "${TITLE}" and open its detail page.
Reply format, ONLY JSON, no prose. EVERY reply MUST contain an "action" object — a plan-only reply is INVALID.
Actions (one per reply):
- {"action":"click","x":<int>,"y":<int>} click ONE point; x,y single integers, normalized 0-1000 image coordinates (0,0 top-left; 1000,1000 bottom-right). Never arrays.
- {"action":"type","text":"..."} type into the ALREADY focused field.
- {"action":"press","key":"Enter"}
- {"action":"done"}
Useful knowledge:
- The search is the magnifier (lens) icon in the TOP-RIGHT corner of the Prime Video header, left of the grid/bookmark/profile icons. Click it to open the search field.
- After typing the title press Enter (or click the search arrow).
- On the results page, click the movie's POSTER/cover image or its TITLE to open the detail page (stop there — do NOT press Play; the harness plays it).
- If a "Continue watching" or hero banner shows a different movie, ignore it — you must search for "${TITLE}".
- If several results look similar, pick the one whose title text most closely matches "${TITLE}" (the correct movie/series, not a show or a different release).
- NEVER repeat a click that did not change the page.`;

async function observe(page) {
  return page.evaluate(() => {
    const active = document.activeElement;
    const focusDesc = active ? (active.tagName + (active.placeholder ? ' ph="' + String(active.placeholder).slice(0, 40) + '"' : '') + (active.id ? ' #' + active.id : '')) : 'none';
    let video = 'none';
    for (const v of document.querySelectorAll('video')) {
      const d = v.duration || 0;
      if (!v.paused && !v.ended && v.currentTime > 0) video = 'PLAYING t=' + v.currentTime.toFixed(1) + 's dur=' + (isFinite(d) ? d.toFixed(0) : '?') + 's';
      else if (v.currentTime > 0 || (isFinite(d) && d > 60)) video = 'paused t=' + v.currentTime.toFixed(1) + 's dur=' + (isFinite(d) ? d.toFixed(0) : '?') + 's';
    }
    return { url: location.href, title: document.title.slice(0, 100), focused: focusDesc, video };
  });
}

(async () => {
  const task = `Search Prime Video for the movie "${TITLE}" and open its detail page.`;
  const browser = await chromium.connectOverCDP(CDP);
  const context = browser.contexts()[0];
  let page = context.pages().find(p => p.url().includes('primevideo')) || context.pages()[0];
  await page.bringToFront();
  await page.goto('https://www.primevideo.com/gp/video/storefront', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(5000);
  console.log('harness: at', page.url(), '|', await page.title());

  const history = [{ role: 'user', content: [
    { type: 'text', text: `Task: ${task}\nThe browser is on the Prime Video home page. Give your plan and first action.` },
  ]}];

  let success = false;
  const actionLog = [];
  for (let step = 1; step <= MAX_STEPS; step++) {
    const png = await page.screenshot();
    fs.writeFileSync(path.join(__dirname, `${PREFIX}_step${step}.png`), png);
    history[history.length - 1].content.push({ type: 'image_url', image_url: { url: 'data:image/png;base64,' + png.toString('base64') } });

    const raw = await askLLM([{ role: 'system', content: SYSTEM }, ...history]);
    console.log(`step ${step}: ${raw.trim().slice(0, 300)}`);
    const obj = parseJSON(raw);
    const act = obj && extractAction(obj);
    if (!act) {
      if (obj && Array.isArray(obj.plan)) {
        console.log('  plan only — demanding action');
        if (step === MAX_STEPS) break;
        history.push({ role: 'assistant', content: raw });
        history.push({ role: 'user', content: [{ type: 'text', text:
          'You gave a plan but NO action. Execute the NEXT unfinished step now. Reply with ONLY {"action":{...}}. No plan, no prose.' }] });
        continue;
      }
      console.log('UNPARSEABLE, aborting'); break;
    }

    let feedback = '';
    const urlBefore = page.url();
    if (act.action === 'click') {
      let cx = null, cy = null;
      const ax = act.x, ay = act.y;
      if (Array.isArray(ax) && ax.length === 4) { cx = (toNum(ax[0])+toNum(ax[2]))/2; cy = (toNum(ax[1])+toNum(ax[3]))/2; }
      else if (Array.isArray(ax) && ax.length === 2) { cx = toNum(ax[0]); cy = toNum(ax[1]); }
      else { cx = toNum(ax); cy = toNum(ay); }
      if (cx === null || cy === null || isNaN(cx) || isNaN(cy)) { console.log('  -> BAD click coords, aborting'); break; }
      const vp = page.viewportSize() || { width: 1600, height: 900 };
      const x = Math.round(cx / 1000 * vp.width), y = Math.round(cy / 1000 * vp.height);
      console.log(`  -> click at px (${x}, ${y})`);
      await page.mouse.click(x, y);
    } else if (act.action === 'type') {
      console.log(`  -> type ${JSON.stringify(act.text)}`);
      await page.keyboard.type(act.text, { delay: 25 });
      const obs = await observe(page);
      if (!obs.focused.startsWith('INPUT') && !obs.focused.startsWith('TEXTAREA')) {
        feedback = ' WARNING: no input was focused; your text went NOWHERE. Click the search field first, then type.';
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

    const onDetail = /\/detail\/[A-Z0-9]+/.test(obs.url);
    const playingLong = obs.video.startsWith('PLAYING') && /dur=[1-9]\d{2,}/.test(obs.video);
    // success = we reached THIS title's detail page (play is the harness's job)
    if (onDetail && TITLE_RE.test(obs.title)) { success = true; break; }
    if (playingLong && (onDetail || TITLE_RE.test(obs.title))) { success = true; break; }

    if (act.action === 'click' && page.url() === urlBefore && !feedback) {
      feedback = ' WARNING: your click did NOT change the page (same URL). Click a different element. Do not repeat the same point.';
    }

    const sig = JSON.stringify(act);
    actionLog.push(sig);
    let stall = '';
    if (actionLog.length >= 3 && actionLog.slice(-3).every(s => s === sig)) {
      stall = '\nHARNESS: STOP. You repeated the same action 3x with NO change. Do not repeat it. URL: ' + obs.url +
        '. Take the NEXT step of your plan (search icon -> type -> Enter -> poster -> Play).';
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
  await page.screenshot().then(b => fs.writeFileSync(path.join(__dirname, `${PREFIX}_final.png`), b));
  console.log('Browser LEFT OPEN.');
})().catch(e => { console.error('FAIL:', e); process.exit(1); });
