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
| Can it drive a real, complex site (YouTube) end-to-end? | ✅ Yes — opened YouTube, searched "carita bachata", and started playing a result; needed the same scaffolding plus YouTube-specific knowledge and anti-loop feedback |
| Can it use a real streaming service with a logged-in session? | ✅ Yes — in the user's own Chrome profile (Prime Video, JP region) it started a movie with **one clean click** on the hero banner's "Watch now" |
| Can it *search for a specific title* on Prime? | ✅ Yes — search icon → type → click result in 3 steps (but it **loops on the Play button** 2 of 3 times; Play/fullscreen/seek must stay in the CDP harness) |
| Can we record a streamed movie with audio, in full screen? | ✅ Yes — full-monitor CDP fullscreen + video-element `requestFullscreen()` = 2560×1440 edge-to-edge; two independent recorders (net_record x11grab, screenrec mss+NVENC) both capture 1080p video **and** the HDMI system audio cleanly |

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

## YouTube end-to-end test (`youtube_test.js`)

Task: *open YouTube, search "carita bachata", play the first result.* Result:
**SUCCESS** — the video `Aitor y Angelica | Jensen - Carita | Bachata 2026`
started playing (`/watch?v=jmVBRgo5pJU`, `video: PLAYING`). See
`screenshots/yt_results.png` (results page) and `screenshots/yt_playing.png`
(video playing at 0:01/3:10).

What this extra-complex task exposed beyond the login form:

- **Sponsored cards + hover-preview overlays are traps.** The first card is a
  sponsored ad whose thumbnail raises an `#inline-preview-player` overlay that
  swallows clicks (focus lands on a non-interactive `DIV`, URL never changes).
  Fix: tell the model to **click the title text** (right of the thumbnail), not
  the image, and to skip "Sponsored" cards.
- **Anti-loop feedback must be immediate.** On the login form a 3×-repeat stall
  detector sufficed. On YouTube the model repeated one dead click 12+ times and
  even "fixed" it by re-running the search (type + Enter) instead of moving on.
  Fix: after *every* click that did not change the URL, inject a warning right
  away ("your click did NOT navigate — click the TITLE text, don't repeat the
  same point"). That is what finally broke the loop.
- **Search itself was trivial** for the model: it found the search box, typed
  the query, and pressed Enter in 3 clean steps. Navigation into the results
  list was the hard part.
- It took **14 steps** (vs ~10 for the login) because of the loop-recovery
  detours. Every detour was the harness forcing the model out of a repetition,
  not the model self-correcting — reinforcing the "needs scaffolding" verdict.

## Prime Video with a real logged-in session (`prime_video_test.js`)

Task: *play any movie.* Run in the **user's own Chrome profile** (real,
headful browser on display `:1`, JP-region account). Result: **SUCCESS in one
step** — the model saw the storefront, whose hero banner was the film
`８番出口 / Exit 8` ("#2 in Japan", "Included with Prime"), and clicked the big
**"Watch now"** button (px 166,518). The movie started (after a short pre-roll
ad). See `screenshots/pv_storefront.png` (the hero + Watch now button) and
`screenshots/pv_playing.png` (player, `0:00 / 1:34:52`).

Why this one needed *less* help than YouTube:

- **The hero banner is a giant, unambiguous "Watch now" target.** No carousel
  hunting, no sponsored-card traps, no hover previews — the single most
  prominent element on the page does the job. A 2B model's strongest skill
  (pointing at the obvious thing) is exactly what this page rewards.
- **A pre-authenticated session removes the hardest sub-task** (login / 2FA),
  which is where small models usually die.

Two real-world gotchas this test added to the list:

5. **Chrome ≥136 blocks CDP remote-debugging on the *default* user-data-dir**
   ("DevTools remote debugging requires a non-default data directory"). To
   drive the user's *own* profile with Playwright, copy the profile to a
   non-default `--user-data-dir` (e.g. `~/.config/chrome-pv-agent`) and launch
   with `--remote-debugging-port`. The copy preserves cookies/session, so no
   re-login. The original profile stays pristine.
6. **Keep the browser (and the movie) alive after the agent exits.** Launch
   the real Chrome detached from the shell (`setsid nohup … &`) and connect
   with `chromium.connectOverCDP('http://127.0.0.1:9333')`. Do **not** call
   `browser.close()` — just exit the node process; the detached Chrome keeps
   playing. (Playwright only force-kills browsers *it* spawned.)
7. **Detecting "a movie is playing" needs care.** A `video` element that is
   `PLAYING` can be the hero background/teaser on the storefront. Confirm a
   real title by the `dur` being movie-length (e.g. `dur=5772s` ≈ 1h36m) and/or
   the URL moving to a `/detail/<id>` or `/watch` page, not just any playing
   `<video>`.
8. **The detail-page viewport can freeze at the launch-time window size.**
   Even with the browser window maximized/fullscreen, the page's render
   viewport can stay at the `--window-size` from Chrome launch (here: 1600×900),
   so the player renders as a 1600×900 box in the corner — the user sees "the
   image with most of the screen black". Fix: send *real resize events* via
   CDP `Browser.setWindowBounds` — normal 1200×800, then 2560×1440 — and the
   viewport follows. This must be redone after **every page transition**
   (storefront → detail re-freezes it).
9. **True full-monitor fullscreen is CDP `windowState: 'fullscreen'` + the
   video element's own `requestFullscreen()`.** F11 via `page.keyboard` does
   nothing (the player swallows it). `requestFullscreen()` needs a trusted
   mouse click first (user activation) — one center click, which only toggles
   the player's controls (it does not pause).
10. **`windowState: 'fullscreen'` has no keyboard exit — and the player also
    swallows ESC.** So a human at the screen is *locked in*: mouse works (clicks
    reach the page, verified), ESC does not exit the video fullscreen, and the
    window state cannot be left with any key. Alt+Tab (OS level) always works.
    **Always restore the window** (`exitFullscreen()` + `setWindowBounds`
    normal) when the test ends — the workflow now does this automatically.
11. **The Play/Resume control on a detail page is a `<span>`, not a
    `<button>`.** Match by exact short text ("resume"/"play") on
    span/button/[role=button], with a button-sized rect filter — matching the
    text of a *container* div is what once clicked "Go ad free" by accident.
12. **Never touch the hidden `<video>` element before the player view is
    open.** Prime's player keeps the movie media in a hidden 0×0 element
    (audio plays, nothing shows). Calling `play()`/`pause()`/seek on it while
    the player UI is closed desynchronizes the player's state machine — the
    player view then refuses to show the media. The only reliable path:
    reload the detail page (clean state) → click the Play/Resume span → wait
    for the *visible* playing video → only then seek.
13. **Pre-roll ads vary (0–2.5 min) and are a separate short `<video>`
    (dur<300s).** Wait for a *visible* video with `dur>600s` that is playing
    before treating "the movie" as started.

## Prime full workflow — search → play → fullscreen → start → record (runbook)

The complete, tested pipeline for: *open Prime, pick a specific title, play it
in full screen from the very beginning, and record 5 min of video+audio at
1080p with two independent recorders.* Setup → recording starts in **~20 s**.

```
Phase 1  node prime_casino_test.js     agent: storefront → search → pick title (3-4 steps)
Phase 2  node prime_final.js           harness: play → 2560×1440 fullscreen → seek t=0
Phase 3  record.sh + screenrec (5 s stagger)   5 min @ 1920×1080, HDMI audio
Phase 4  restore window (normal 1600×900)      user gets the desktop back
Phase 5  python3 analyze_rec.py <mp4> <dir>    black-frames / motion / dBFS verdict
```

**Phase 1 — the agent (`prime_casino_test.js`).** Qwen3.52B drives the real
Chrome over CDP: click the search icon → type the title → click the first
search result → detail page. Reliable in 3–4 steps. It is **not** reliable on
the Play button (reproducible A/B loop in 2 of 3 runs), so Play is the
harness's job — by design.

**Phase 2 — the harness (`prime_final.js`), ~20 s:**
1. reload the detail page (guarantees a clean player state machine — see
   gotcha 12),
2. click the Play/Resume `<span>` (dynamic exact-text lookup, gotcha 11),
3. wait for the **visible** playing movie, riding out any pre-roll ad
   (gotcha 13),
4. unstick the frozen viewport (gotcha 8) and go `windowState: 'fullscreen'`,
5. trusted center click + `requestFullscreen()` on the movie `<video>` →
   full-monitor 2560×1440 (gotcha 9),
6. `video.currentTime = 0; play()` → **at the beginning of the content**,
7. input pass-through test: CDP mousemove → page listener fires (`true` = the
   user's mouse is NOT blocked); ESC stays swallowed by the player (gotcha 10).

**Phase 3 — record (5 min, 1920×1080, staggered 5 s):**

```bash
# net_record (ffmpeg x11grab + pulse monitor) — RES flag scales the capture
DISPLAY=:1 AUDIO_SRC=alsa_output.pci-0000_01_00.1.hdmi-stereo \
  RES=1920x1080 OUT_DIR=/media/sergio/NEW2TB ./record.sh &
# after ~5 s:
screenrec record --duration 300 --source full --resolution 1920x1080 --fps 30 \
  --audio system --device "GA102 High Definition Audio Controller Digital Stereo (HDMI)" \
  --out /media/sergio/NEW2TB/rec_cr_5min_1080.mp4
# stop net_record at ~298 s:
kill -INT $(ps -eo pid,args | awk '/[f]fmpeg.*x11grab/ {print $1; exit}')   # auto-remuxes to .mp4
```

The 5 s stagger matters: starting both recorders in the same second produced a
one-off −61 dBFS loopback dip in the first 5 s of audio on screenrec.

**Phase 4 — restore the user's control (mandatory):** `exitFullscreen()` +
`setWindowBounds` normal 1600×900. Without this the human is locked in
(gotcha 10). Mid-test escape hatch: Alt+Tab.

**Phase 5 — verify (`analyze_rec.py`):** probes streams, samples a frame every
30 s (brightness < 16 = black, inter-frame mean-abs-diff < 2.0 = static),
decodes audio to 16 kHz mono and reports dBFS per 30 s window. Verdict:
video OK = <0.5 % black + motion > 2.0; audio OK = >50 % of windows above
−45 dBFS + real peak.

### Results (Casino Royale, JP region, display `:1`, 2560×1440 monitor)

| 1080p run | **net_record** | **screenrec** |
|---|---|---|
| 5-min clip from the start | 313 s, 188 MB | 300 s, 192 MB, self-verified |
| black frames (30 s sampling) | 0/10 | 2/10 — the film's own B&W opening (verified by eye) |
| static frames | 0/9 | 0/9 |
| motion (mean inter-frame diff) | 61.7 | 52.3 |
| audio | 11/11 windows loud, peak −15.0 dBFS | 11/11 windows loud, peak −14.5 dBFS |
| first frame | Columbia logo / opening shots | same |

Earlier 1440p→1080p size savings: net_record 400→352 MB (−12 %), screenrec
730→547 MB (−25 %). Casino Royale is 2.39:1 scope, so the letterbox bars in a
16:9 frame are the film's own aspect, not a defect. Evidence:
`cr_step*.png` (agent run), `fs_final.png` (fullscreen), `analysis_*/`
(sampled frames).

## What's in the repo

| File | Purpose |
|---|---|
| `test_page.html` | Synthetic login page (username + password + Log In) used as the browser task |
| `vision_test.js` | Screenshot → Qwen: "list interactive elements as JSON" (pure vision check) |
| `agent_loop.js` | Closed-loop computer-use agent: screenshot → Qwen action → Playwright executes → structured observation → repeat |
| `youtube_test.js` | YouTube end-to-end agent: search a song and play the first result, with URL + video-state observations and per-click anti-loop feedback |
| `prime_video_test.js` | Prime Video agent using the user's real Chrome profile over CDP (detached browser, movie keeps playing after the script exits) |
| `prime_casino_test.js` | Prime search+select agent: storefront → search "casino royale" → click result → detail page (Phase 1 of the runbook) |
| `prime_final.js` | Prime playback harness: reload detail → click Play span → wait out ads → 2560×1440 fullscreen → seek t=0 → input pass-through test (Phase 2 of the runbook) |
| `analyze_rec.py` | Recording verifier: 30 s frame sampling (black/static/motion) + per-30 s audio dBFS → video/audio verdict (Phase 5 of the runbook) |
| `desktop_click_test.py` | Opens a real X11 window (RED/BLUE buttons) on display `:1`, screenshots the whole desktop, asks Qwen for the RED button center, synthesizes the click via XTEST |
| `debug/` | Superseded Prime playback experiments (start/play/resume/go/finish_fast) kept for the failure-mode record |
| `screenshots/` | Evidence: `shot1.png` (page), `step1/5/10.png` (agent run), `desktop_window_crop.png` (window on the live desktop), `yt_results.png` + `yt_playing.png` (YouTube), `pv_storefront.png` + `pv_playing.png` (Prime Video) |
| `cr_*.png`, `fs_*.png`, `page_state*.png` | Prime evidence: agent steps, fullscreen verification, player states |
| `analysis_*/` | Sampled frames from the 1440p/1080p recording comparisons (net_record vs screenrec) |
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
# edit EXE in agent_loop.js / youtube_test.js if your chromium path differs
node agent_loop.js   # expect: SUCCESS: true, status "LOGGED IN: alice (pw len 9)"
node youtube_test.js # expect: SUCCESS: true, video: PLAYING on a /watch URL (needs internet)
```

Prime Video (uses your real Chrome profile — it closes/relaunches Chrome):

```bash
# 1. copy the profile to a NON-default dir (Chrome >=136 blocks CDP on the default dir)
cp -a ~/.config/google-chrome ~/.config/chrome-pv-agent && rm -f ~/.config/chrome-pv-agent/SingletonLock
# 2. launch it detached with CDP on :9333 (adjust binary/profile paths as needed)
setsid nohup /opt/google/chrome/chrome --profile-directory=Default \
  --user-data-dir="$HOME/.config/chrome-pv-agent" --remote-debugging-port=9333 \
  --no-first-run --no-default-browser-check "https://www.primevideo.com" >/tmp/chrome_pv.log 2>&1 &
# 3. run the agent (connects over CDP, leaves the browser playing on exit)
node prime_video_test.js
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
