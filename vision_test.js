const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const EXE = '/home/sergio/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const LLM = 'http://127.0.0.1:8086/v1/chat/completions';

async function askLLM(messages, maxTokens = 400) {
  const res = await fetch(LLM, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'Qwen3.52B', messages, temperature: 0.1, max_tokens: maxTokens }),
  });
  if (!res.ok) throw new Error('LLM HTTP ' + res.status + ': ' + (await res.text()).slice(0, 300));
  const data = await res.json();
  return data.choices[0].message.content;
}

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto('file://' + path.resolve(__dirname, 'test_page.html'));
  await page.waitForTimeout(500);
  const png = await page.screenshot({ fullPage: false });
  fs.writeFileSync(path.join(__dirname, 'shot1.png'), png);
  console.log('screenshot saved: shot1.png (' + png.length + ' bytes)');

  const b64 = png.toString('base64');
  const answer = await askLLM([
    { role: 'system', content: 'You are a precise UI understanding model. Analyze the screenshot and list every interactive element (inputs, buttons, links) with its bounding box center in {x, y} pixel coordinates. Reply with ONLY a JSON array, no prose. Example: [{"type":"input","label":"Username","x":640,"y":300,"w":300,"h":36}]' },
    { role: 'user', content: [
      { type: 'text', text: 'List the interactive elements in this screenshot as JSON.' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,' + b64 } },
    ]},
  ]);
  console.log('--- Qwen vision answer ---');
  console.log(answer);
  await browser.close();
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
