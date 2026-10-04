# qwe-controller — Qwen3.5-2B computer-use test

Test harness proving that **Qwen3.5-2B** (GGUF, running under `llama.cpp`'s
`llama-server` with a vision `mmproj`) can be used as the "brain" of a
computer-use agent: driving a browser through **Playwright**, and clicking on a
**real X11 desktop** from screenshots.

Everything runs against a local OpenAI-compatible endpoint on port **8086**.

## Findings (TL;DR)

| Question | Result |
|---|---|
| Can we send requests to the model on port 8086? | ✅ Yes — OpenAI-compatible chat API, ~217 tok/s generation on a single GPU (Q6_K, 65k ctx, flash-attn) |
| Can it see UI screenshots? | ✅ Yes — with mmproj it detects inputs/buttons/links; grounding error < 5 px at 1280×800, ~15 px at 2560×1440 |
| Can it drive a browser via Playwright? | ✅ Yes — completed a 2-field login end-to-end in 10 LLM calls (~5 s), **with harness scaffolding** |
| Can it control the PC from a desktop screenshot? | ✅ Yes — found the right button on a real 2560×1440 X display and a synthesized XTEST click hit it |

### Key gotchas discovered

1. **Coordinates are Qwen-VL normalized 0–1000, not pixels.** The model always
   answers in the 0–1000 space regardless of the prompt. Rescale in the
   harness: `x_px = x/1000 * width`, `y_px = y/1000 * height`.
   Verification: its box `[351,412,646,455]` for the username field rescales
   to x:449–827, y:330–364 vs ground truth x:450–830, y:330–366.
2. **XTEST clicks must be preceded by a pointer motion.** Send
   `X.MotionNotify` to the target point *before* `ButtonPress`/`ButtonRelease`,
   otherwise the server delivers the click at the pointer's *current* position.
3. **A 2B model needs scaffolding to be reliable.** Observed failure modes and
   the fixes that worked:
   - *Skips plan steps* (clicked the password field, then jumped to the login
     button without typing) → force the model to re-emit its full plan every
     reply, completed steps prefixed `done:`.
   - *Action loops* (same click 3–10× while the page showed an error) → harness
     **stall detection**: same action 3× in a row ⇒ inject a corrective hint
     derived from the observed field states.
   - *Format drift* (plan-only replies, string numbers, `[x,y]` arrays, two
     JSON objects in one reply) → `response_format: {type:"json_object"}`,
     tolerant parsers (regex out the first `{...}`, `raw_decode`, accept
     numeric strings and arrays).
   - *Types without focus* → observation feedback: report `document.activeElement`
     after every action so the model sees where text actually landed.
4. **Verdict:** usable for *guided/assisted* control with a robust harness;
   for unattended autonomy expect a ≥7B VLM.

## What's in the repo

| File | Purpose |
|---|---|
| `test_page.html` | Synthetic login page (username + password + Log In) used as the browser task |
| `vision_test.js` | Screenshot → Qwen: "list interactive elements as JSON" (pure vision check) |
| `agent_loop.js` | Closed-loop computer-use agent: screenshot → Qwen action → Playwright executes → structured observation → repeat |
| `desktop_click_test.py` | Opens a real X11 window (RED/BLUE buttons) on display `:1`, screenshots the whole desktop, asks Qwen for the RED button center, synthesizes the click via XTEST |
| `screenshots/` | Evidence: `shot1.png` (page), `step1/5/10.png` (agent run), `desktop_window_crop.png` (the window Qwen found on the live desktop) |
| `package.json` | Node deps (`playwright-core` only; reuses your Playwright browser cache) |
| `requirements.txt` | Python deps (`python-xlib`, `pillow`) |

## Server used

```bash
CUDA_DEVICE_ORDER=PCI_BUS_ID CUDA_VISIBLE_DEVICES=2 \
  /path/to/llama-server \
  --model /path/to/Qwen3.5-2B-UD-Q6_K_XL.gguf \
  --mmproj /path/to/mmproj-BF16.gguf \
  --host 0.0.0.0 --port 8086 \
  --n-gpu-layers all --alias Qwen3.52B \
  --ctx-size 65536 --parallel 1 --flash-attn on \
  --cache-type-k q8_0 --cache-type-v q8_0 \
  --batch-size 4096 --ubatch-size 1024 \
  --temp 1.0 --top-p 0.95 --top-k 20 --min-p 0.0 \
  --chat-template-kwargs '{"enable_thinking":false}' \
  --jinja --reasoning-preserve --ctx-checkpoints 8 --fit off
```

Verify: `curl http://127.0.0.1:8086/v1/models` → model id `Qwen3.52B`.

## Running the tests

Browser agent (Node 18+, `fetch` built-in):

```bash
npm install          # installs playwright-core; uses the ms-playwright browser cache
# edit EXE in agent_loop.js if your chromium path differs
node agent_loop.js   # expect: SUCCESS: true, status "LOGGED IN: alice (pw len 9)"
```

Desktop click (Python 3.10+, X11 display `:1`):

```bash
pip install python-xlib pillow
python3 desktop_click_test.py   # expect: click landed on RED ... SUCCESS: True
```

## Example agent trace (successful run)

```
step 1: plan + click(500,430)   -> click px (640,344)  focused INPUT#username
step 2: type "alice"            -> username="alice"
step 3: click(500,520)          -> click px (640,416)  focused INPUT#password
step 4: type "secret123"        -> password=FILLED len=9
...  (2 stalls broken by harness hints) ...
step 9: click(500,570)          -> click px (640,456)  status "LOGGED IN: alice (pw len 9)"
SUCCESS: true   (10 LLM calls, ~5 s total)
```
