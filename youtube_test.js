/*
 * Qwen3.5-2B computer-use agent — YouTube task:
 *   "Search for 'carita bachata' and play the first result."
 * Same scaffolding as agent_loop.js, plus URL + video-state observations.
 */
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const EXE = '/home/sergio/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const LLM = 'http://127.0.0.1:8086/v1/chat/completions';
const MODEL = 'Qwen3.52B';
const W = 1280, H = 800;
const MAX_STEPS = 20;
const POST_ACTION_WAIT_MS = 2500; // let pages / results load

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

// robust JSON: strip fences, take first {...}; if still unparseable, try progressively
// shorter prefixes ending at each '}' (handles accidental trailing second object)
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

const SYSTEM = `You are a computer-use agent that controls a web browser from screenshots.
You are on YouTube. Task: search for a song and play it.
Reply format, ONLY JSON, no prose. EVERY reply MUST contain an "action" object — a plan-only reply is INVALID. You may also include your FULL plan (prefix finished steps "done: ").
Actions (one per reply):
- {"action":"click","x":<int>,"y":<int>} click ONE point; x,y single integers, normalized 0-1000 image coordinates (0,0 top-left; 1000,1000 bottom-right). Never arrays.
- {"action":"type","text":"..."} type into the ALREADY focused field (your previous reply must have clicked it).
- {"action":"press","key":"Enter"}
- {"action":"done"}
Useful knowledge: on the YouTube home page the search box is the long rounded box at the top center of the page (left of the magnifier icon). On search results, videos are cards: thumbnail on the left, and to the RIGHT of it the big video TITLE text, channel name, and view count. To open a video, CLICK THE TITLE TEXT, not the thumbnail image (hovering a thumbnail raises a preview overlay that swallows clicks). Skip cards that say "Sponsored" — pick the first real (non-sponsored) result. On a watch page the video player is the big area at the top.
STRICT RULES: before every "type" click the target first. Never repeat an action that had no effect. If the video is not playing yet, do NOT spam clicks — take the next plan step.`;

async function observe(page) {
  return page.evaluate(() => {
    const active = document.activeElement;
    const focusDesc = active ? (active.tagName + (active.placeholder ? ' ph="' + active.placeholder.slice(0, 40) + '"' : '') + (active.id ? ' #' + active.id : '')) : 'none';
    let video = 'none';
    const v = document.querySelector('video');
    if (v) {
      if (!v.paused && !v.ended) video = 'PLAYING t=' + v.currentTime.toFixed(1) + 's';
      else video = 'paused t=' + v.currentTime.toFixed(1) + 's';
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
  const task = 'Search YouTube for "carita bachata" and play the first video result.';
  const browser = await chromium.launch({ executablePath: EXE, headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: W, height: H },
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36' });
  await page.goto('https://www.youtube.com', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);

  // harness-side: dismiss consent dialog if this IP gets one
  const url = page.url();
  if (url.includes('consent')) {
    for (const label of ['Accept all', 'Reject all', 'I agree']) {
      const b = page.getByRole('button', { name: label, exact: false }).first();
      if (await b.isVisible().catch(() => false)) { await b.click(); console.log('harness: clicked "' + label + '" consent'); break; }
    }
    await page.waitForTimeout(2500);
  }
  console.log('harness: at', page.url(), '|', await page.title());

  const history = [{ role: 'user', content: [
    { type: 'text', text: `Task: ${task}\nThe browser is already on the YouTube home page. Give your plan and first action.` },
  ]}];

  let success = false, lastClickedField = null;
  const actionLog = [];
  for (let step = 1; step <= MAX_STEPS; step++) {
    const png = await page.screenshot();
    fs.writeFileSync(path.join(__dirname, `yt_step${step}.png`), png);
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
      const x = Math.round(cx / 1000 * W), y = Math.round(cy / 1000 * H);
      console.log(`  -> click at px (${x}, ${y})`);
      await page.mouse.click(x, y);
      const obs = await observe(page);
      lastClickedField = obs.focused;
      console.log(`  (now focused: ${obs.focused})`);
    } else if (act.action === 'type') {
      console.log(`  -> type ${JSON.stringify(act.text)}`);
      await page.keyboard.type(act.text, { delay: 15 });
      const obs = await observe(page);
      if (!obs.focused.startsWith('INPUT') && !obs.focused.startsWith('TEXTAREA')) {
        feedback = ' WARNING: no input was focused; your text went NOWHERE. Click the target field first (previous reply), then type.';
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
    if (obs.video.startsWith('PLAYING') && obs.url.includes('/watch')) {
      success = true; break;
    }
    // immediate feedback when a click did not navigate
    if (act.action === 'click' && page.url() === urlBefore && !feedback) {
      feedback = ' WARNING: your click did NOT change the page (same URL). If you clicked a video thumbnail, a hover-preview overlay likely swallowed it. CLICK THE TITLE TEXT to the right of the thumbnail instead. Do not repeat the exact same point.';
    }

    // stall detection
    const sig = JSON.stringify(act);
    actionLog.push(sig);
    let stall = '';
    if (actionLog.length >= 3 && actionLog.slice(-3).every(s => s === sig)) {
      stall = '\nHARNESS: STOP. You repeated the same action 3x with NO change. Do not repeat it. Current URL: ' + obs.url +
        '. Video state: ' + obs.video + '. Take the NEXT step of your plan instead (search box -> type -> Enter -> first result -> done).';
      console.log('  [harness: stall detected, corrective hint injected]');
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
  console.log(`SUCCESS: ${success || (obs.video.startsWith('PLAYING') && obs.url.includes('/watch'))}`);
  await page.screenshot().then(b => fs.writeFileSync(path.join(__dirname, 'yt_final.png'), b));
  await browser.close();
})().catch(e => { console.error('FAIL:', e); process.exit(1); });
