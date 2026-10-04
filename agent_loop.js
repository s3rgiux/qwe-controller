/*
 * Qwen3.5-2B computer-use agent: screenshot -> Qwen -> action -> Playwright executes -> repeat.
 * v3: explicit plan first + structured observations (field states, focus, status).
 * Coordinates: Qwen outputs Qwen-VL normalized 0-1000; we rescale to viewport pixels.
 */
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const EXE = '/home/sergio/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const LLM = 'http://127.0.0.1:8086/v1/chat/completions';
const MODEL = 'Qwen3.52B';
const W = 1280, H = 800;
const MAX_STEPS = 20;

async function askLLM(messages, maxTokens = 300) {
  const t0 = Date.now();
  const res = await fetch(LLM, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, messages, temperature: 0.0, max_tokens: maxTokens, response_format: { type: 'json_object' } }),
  });
  if (!res.ok) throw new Error('LLM HTTP ' + res.status + ': ' + (await res.text()).slice(0, 300));
  const data = await res.json();
  const ms = Date.now() - t0;
  const usage = data.usage ? ` prompt=${data.usage.prompt_tokens} compl=${data.usage.completion_tokens}` : '';
  console.log(`  [llm ${ms}ms${usage}]`);
  return data.choices[0].message.content;
}

function parseJSON(text) {
  let t = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const m = t.match(/\{[\s\S]*\}/);
  if (m) t = m[0];
  try { return JSON.parse(t); } catch (e) { return null; }
}

// extract action object from a reply: {"action":{...}} or flat {"action":"click","x":..,"y":..}
function extractAction(obj) {
  if (!obj) return null;
  if (obj.action && typeof obj.action === 'object') return obj.action;
  if (obj.action && typeof obj.action === 'string') return obj; // flat form
  return null;
}

function toNum(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v))) return Number(v);
  return null;
}

const SYSTEM = `You are a computer-use agent that controls a web browser from screenshots.
Reply format, ONLY JSON, no prose. EVERY reply MUST contain an "action" object — a reply with only a plan is INVALID and does nothing. You may also include your FULL plan (do not drop steps, prefix finished steps "done: "):
{"plan":["done: Click Username field","Type 'alice' into Username field",...],"action":{"action":"click","x":500,"y":430}}
Actions (one per reply):
- {"action":"click","x":<int>,"y":<int>} click ONE point; x,y single integers, normalized 0-1000 image coordinates (0,0 top-left; 1000,1000 bottom-right). Never arrays.
- {"action":"type","text":"..."} type into the ALREADY focused field.
- {"action":"press","key":"Enter"}
- {"action":"done"}
STRICT RULE: before every "type" your PREVIOUS reply must have clicked the exact field you want to type in. Never click the submit button while any required field is EMPTY — check the observation first. If an error message is shown, read it and fix the cause instead of repeating the click.`;

async function observe(page) {
  return page.evaluate(() => {
    const active = document.activeElement;
    const fields = {};
    for (const el of document.querySelectorAll('input, textarea')) {
      const id = el.id || el.name || el.placeholder || 'field';
      fields[id] = el.type === 'password'
        ? (el.value ? 'FILLED len=' + el.value.length : 'EMPTY')
        : JSON.stringify(el.value);
    }
    return {
      focused: active ? (active.tagName + (active.id ? '#' + active.id : '')) : 'none',
      fields,
      status: (document.getElementById('status') || { textContent: '' }).textContent,
    };
  });
}

(async () => {
  const task = 'Sign in: type "alice" into the Username field, type "secret123" into the Password field, then click the Log In button.';
  const browser = await chromium.launch({ executablePath: EXE, headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  await page.goto('file://' + path.resolve(__dirname, 'test_page.html'));
  await page.waitForTimeout(300);

  const history = [{ role: 'user', content: [
    { type: 'text', text: `Task: ${task}\nGive your plan and first action.` },
  ]}];

  let success = false, lastClickedField = null;
  const actionLog = []; // for stall detection
  for (let step = 1; step <= MAX_STEPS; step++) {
    const png = await page.screenshot();
    fs.writeFileSync(path.join(__dirname, `step${step}.png`), png);
    history[history.length - 1].content.push({ type: 'image_url', image_url: { url: 'data:image/png;base64,' + png.toString('base64') } });

    const raw = await askLLM([{ role: 'system', content: SYSTEM }, ...history]);
    console.log(`step ${step}: ${raw.trim()}`);
    const obj = parseJSON(raw);
    const act = extractAction(obj);
    if (!act) {
      if (obj && Array.isArray(obj.plan)) {
        console.log('  plan only, no action — demanding an action');
        if (step === MAX_STEPS) break;
        history.push({ role: 'assistant', content: raw });
        history.push({ role: 'user', content: [{ type: 'text', text:
          'You gave a plan but NO action. A plan alone does nothing. Execute the NEXT unfinished step of your plan right now. ' +
          'Reply with ONLY this exact shape and nothing else: {"action":{"action":"click","x":500,"y":430}} — or {"action":{"action":"type","text":"..."}} or {"action":{"action":"done"}}. No plan, no prose.' }] });
        continue;
      }
      console.log('UNPARSEABLE, aborting');
      break;
    }
    if (obj && obj.plan) console.log('  plan: ' + obj.plan.join(' -> '));

    let feedback = '';
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
      lastClickedField = obs.focused.startsWith('INPUT') ? obs.focused : null;
      console.log(`  (now focused: ${obs.focused})`);
    } else if (act.action === 'type') {
      const before = await observe(page);
      console.log(`  -> type ${JSON.stringify(act.text)} (focused: ${before.focused})`);
      await page.keyboard.type(act.text, { delay: 15 });
      const after = await observe(page);
      const changed = JSON.stringify(before.fields) !== JSON.stringify(after.fields);
      console.log(`  (after: ${JSON.stringify(after.fields)})`);
      if (!after.focused.startsWith('INPUT')) {
        feedback = ' WARNING: no input was focused; your text went NOWHERE. Click the target field first, then type.';
      } else if (!changed) {
        feedback = ` WARNING: nothing changed after typing into ${after.focused}. Verify you are typing into the RIGHT field.`;
      } else if (after.focused !== lastClickedField) {
        feedback = ` WARNING: you typed into ${after.focused} but your last click focused ${lastClickedField || 'nothing'}. Click the intended field first.`;
      }
    } else if (act.action === 'press') {
      console.log(`  -> press ${act.key}`);
      await page.keyboard.press(act.key);
    } else if (act.action === 'done') {
      console.log('  -> agent reports done');
    }

    await page.waitForTimeout(250);
    const obs = await observe(page);
    console.log(`  obs: focused=${obs.focused} fields=${JSON.stringify(obs.fields)} status=${JSON.stringify(obs.status)}`);
    if (obs.status.startsWith('LOGGED IN')) { success = true; break; }

    // stall detection: same action repeated -> break the loop with a corrective hint
    const sig = JSON.stringify(act);
    actionLog.push(sig);
    let stall = '';
    if (actionLog.length >= 3 && actionLog.slice(-3).every(s => s === sig)) {
      const emptyFields = Object.entries(obs.fields).filter(([, v]) => v === 'EMPTY' || v === '""').map(([k]) => k);
      if (emptyFields.length) {
        stall = '\nHARNESS: STOP. You repeated the same action 3x with NO change. Do not repeat it. This field is still empty: ' +
          emptyFields.join(', ') + '. Click it, then type its required text from the task.';
      } else {
        stall = '\nHARNESS: STOP. You repeated the same action 3x with NO change and every field is now filled correctly. Do NOT click any field again. The remaining task step is to click the submit / Log In button, then reply {"action":{"action":"done"}}.';
      }
      console.log('  [harness: stall detected, corrective hint injected]');
    }

    history.push({ role: 'assistant', content: raw });
    history.push({ role: 'user', content: [
      { type: 'text', text:
        `Observation after your action:\n` +
        `- focused: ${obs.focused}\n` +
        `- fields: ${JSON.stringify(obs.fields)}\n` +
        `- page status line: ${JSON.stringify(obs.status)}\n` +
        feedback + stall + '\n' +
        `Next single action (follow your plan; do not repeat a failed action):` },
    ]});
  }

  const obs = await observe(page);
  console.log('\n=== RESULT ===');
  console.log(`fields: ${JSON.stringify(obs.fields)}`);
  console.log(`status: ${JSON.stringify(obs.status)}`);
  console.log(`SUCCESS: ${success || obs.status.startsWith('LOGGED IN')}`);
  await browser.close();
})().catch(e => { console.error('FAIL:', e); process.exit(1); });
