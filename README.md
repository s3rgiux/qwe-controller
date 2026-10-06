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
    before treating "the movie" as started. The ad element's `duration` is its
    max — the ad can end well before it (observed: a 152 s element played only
    ~30 s).
14. **When a movie ends, Prime auto-plays the "next" title.** The old movie
    element is replaced, so any "longest `<video>`" heuristic silently starts
    tracking the *new* content and a time-based stopper keeps recording 45+
    min of the wrong title. Fix: `movie_stopper.sh --mark` tags the movie
    element (`data-qwe-stopwatch`) right after playback starts; stopper and
    watchdog then track that element by identity and treat "marked element
    gone" as movie-ended (2 consecutive checks).

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

### Full-movie run (2 h 24 m, net_record only, 24 fps, 1080p)

Recorded the **entire film** from the first frame (MGM logo) to the last
credits, single recorder, while the user kept the box. Setup → first frame in
~20 s; total capture 2 h 46 m; ≈0.5 MB/s at 1080p/24 fps.

```bash
node prime_final.js                 # play → fullscreen → t=0 (gotchas 8–13)
./movie_stopper.sh --mark           # tag the movie <video> (gotcha 14)
DISPLAY=:1 AUDIO_SRC=<sink Chrome plays on> RES=1920x1080 FRAMERATE=24 \
  OUT_DIR=/media/... ./record.sh &  # x11grab 2560×1440 → scale 1920×1080
./movie_stopper.sh <dur-90> out.mp4 &   # end-detect: t≈d, paused×2, or element gone
./movie_watchdog.sh out.mkv <dur> &     # every 10 min: t + file size advancing,
                                        # nudges play() on a stall
# after remux: window restore (Phase 4), then
python3 analyze_rec.py out.mp4 analysis_fullmovie
# clean cut (lossless, keyframe-aligned): ad ends ~30 s, film = MGM logo → credits
ffmpeg -ss 34 -i raw.mp4 -t 8718 -c copy -movflags +faststart movie.mp4
```

| | |
|---|---|
| raw capture | 10002 s (2 h 46 m 42 s), 5.24 GB — [30 s ad] + [whole film] + [21 min auto-played next title] |
| clean cut | **8719 s (2 h 25 m 19 s), 4.65 GB** — MGM logo → final credits |
| resolution / rate | 1920×1080 (whole 2560×1440 screen in true fullscreen), 23.993 fps (24 fps capture) |
| video verdict | OK — 333 sampled frames: 0 static, motion mean 43.7, 6 % dark (the film's own B&W/night scenes) |
| audio verdict | OK — 10000 s decoded, peak −9.0 dBFS, 68 % of 30 s windows > −45 dBFS |
| notes | after the reboot the default audio sink changed to a USB device — pin `AUDIO_SRC` to the sink Chrome actually plays on (`pactl list short sink-inputs`), or the recording is silent; the player-reported `duration` drifts upward during playback (8725→9000 s), the content ends at the player's own end anyway |

24 fps capture for 24 fps content is the right choice: no duplicate frames,
smaller file, no temporal aliasing.

## Good Will Hunting full-movie run + per-minute vision verification (experimental)

Second full-movie run: **Good Will Hunting** (1998, Miramax) on Prime JP,
recorded 2026-10-06 08:49–11:00 JST with the **experimental per-minute vision
verifier** (`vision_watch.js`) added to the standard monitors.

```bash
node prime_casino_test.js "good will hunting"   # Phase 1 (agent search FAILED this
                                                #  title — see below — deterministic
                                                #  DOM search used instead)
node prime_final.js                              # Phase 2 (play → fullscreen → t=0)
./movie_stopper.sh --mark
DISPLAY=:1 AUDIO_SRC=<sink> RES=1920x1080 FRAMERATE=24 OUT_DIR=... ./record.sh &
./movie_stopper.sh <dur-90> out.mp4 &
./movie_watchdog.sh out.mkv <dur> &
node vision_watch.js gwh_vision2.jsonl 129 "good will hunting" &   # NEW: 60 s vision checks
```

| | |
|---|---|
| raw capture | 7822.5 s (2 h 10 m), 5.27 GB — [whole film from the Miramax card, no visible pre-roll] + [~2 min auto-played anime] |
| mid-movie ad break | **~98 s fullscreen multi-brand break at film ~54 min (file 3261–3359 s): Diners Club Gold → リクナビ NEXT → NTT EAST card** — spliced out of the deliverable |
| clean cut | **7585.8 s (2 h 06 m 26 s), 5.18 GB** — lossless keyframe splice `[0, 3259.688] + [3364.979, 7690.479]`, Miramax card → final JP credits |
| cut artifacts | one ~98 s jump cut at film ~54 min: during the ad break the film played *hidden underneath* (its `<video>` clock advanced 1:1 the whole time — verified: Δt 7614.9 s ≈ Δwall 7616 s over the full run), so that window's content was never captured and is unrecoverable |
| window restore | done — `exitFullscreen()` + paused + normal 1600×900 |

### The vision watch (`vision_watch.js`) — what it is and how it scored

Every 60 s: CDP screenshot of the movie `<video>` rect → 640 px JPEG →
Qwen3.52B classifies `{black, spinner, ad, studio_logo, title_card, film,
end_credits, storefront}` + `title_text` + 10-word notes → JSONL
(`{i, wall(UTC), t, d, paused, marked, nudge, llm_ms, llm}`); stop strikes on
2 consecutive `end_credits` / `storefront` / wrong-title / late-`ad`, with
position-aware exceptions (below).

Run 2, the clean dataset (`gwh_vision2.jsonl`, 129 checks over 129 min):

| metric | result |
|---|---|
| classification accuracy | **128/128 film frames correct** — 1× `title_card` ("GOOD WILL HUNTING"), 126× `film`, 1× `storefront` (a film *toy-shop scene* mislabeled, single occurrence → no stop) |
| real ad caught | ✅ the mid-roll break: `ad` at film t=3336, ad copy transcribed ("スマホ1つでサクッとベンリ！") — the **only monitor that saw it** (DOM saw nothing: clock kept running) |
| model errors / nudges | 0 / 0 — no stalls in 2 h |
| latency | 321–375 ms per check (640 px JPEG, temp 0, json_object) |
| content quality | the 2B **names real actors and plots**: "Sean Penn and Robin Williams in a scene", "Robert De Niro smiling", "Bar scene with Matt Damon and Ben Affleck", "Math lecture scene", "prison hallway, Will on phone", "Car driving on a highway" (the last shot) |
| auto-play swap | **missed by the stop rule**: the anime was labeled generic `film` (no title) — caught by log review + manual kill ~1 min after the swap |

Known biases (documented honestly):
- **title_text echo**: from ~minute 5 on the model prints "Good Will Hunting" in
  `title_text` for almost every frame (the expected title is in the prompt).
  Use `notes` for content truth, never `title_text`.
- **live-action vs anime is unreliable** at 640 px (particle field and a medical
  monitor both read `live_action` when asked directly); the *scene enum* is more
  stable than free-form live/anime judgment.
- Run 1's false stop: GWH's ~4 min **opening credit roll** was correctly
  classified `end_credits` by the model and correctly killed ffmpeg by the
  naive 2-strike rule. Fix: position-aware adjustment *before* strike counting —
  `end_credits` with `t < 0.25·d` → `opening_credits` (no strike); `ad` with
  `t < 600` → `preroll_ad` (no strike).

**Verdict:** the vision watch is an excellent *verifier and log* — it sees what
the DOM cannot (mid-roll ads, content identity, "is this still our movie") at
~0.35 s cost per minute — but it is **not a reliable stopper**: an
auto-played *other* title with no visible title reads as generic `film`. Keep
the DOM stopper primary (now with the t-reset rule below).

New gotchas from this run:

15. **Prime JP inserts fullscreen mid-roll ad breaks inside films** (~98 s
    multi-brand break observed at the 54-min mark). The film's `<video>` clock
    keeps advancing 1:1 *under* the break, so DOM stall/end detectors see
    nothing — but the break replaces the film's pixels for that window (lost
    from any capture). Trim ad breaks by frame-probing the tail/head of the raw
    file and splicing at keyframes; the vision watch is the only monitor that
    flagged the break live.
16. **On auto-play swap the player often reuses the SAME `<video>` element.**
    The stopper's `data-qwe-stopwatch` mark survives, `t` resets (7656→40),
    `d` changes (7915→1422) — "element gone" and "t≥d−30" both miss it
    (content ends *before* the drifted `d`). Stop rule added:
    **t reset** (`t < prev_t − 30`) ⇒ content swap ⇒ stop.
17. **Agent search fails on some Prime JP titles even when it worked on others.**
    "good will hunting" → 14-step loop clicking the top-left corner, never the
    top-right search icon; the `/search?keywords=` URL deep link redirects to
    home (JS-driven). Deterministic DOM search is the reliable path:
    `button[aria-label="Search Prime Video"]` → fill `input[placeholder="Search"]`
    → Enter → first result on `/search?ie=UTF8&ref_=atv_nb_sug&phrase=…`.
    Keep the agent for Phase-1-style tasks; use the DOM harness for search.
18. **Position-aware credit phases**: films can open with a multi-minute credit
    roll (GWH) — classify `end_credits` at `t < 0.25·d` as `opening_credits`
    before counting stop strikes, or a correct classification kills a healthy run.

## Series workflow ("chapters") — The Boys S1 pilot

Extending the movie pipeline to series. Built and piloted 2026-10-06 with
**The Boys S1E1 "The Namesake"** (61:04, d=3664s).

### What makes a series different from a movie

1. The detail page is a **season page** with a lazy episode grid; the hero
   button resumes *whatever the account last watched* ("Resume S1 E2"), not
   episode 1 — so the episode must be selected explicitly.
2. Each episode has its **own detail ASIN**: the grid's hidden
   `[data-testid="episodes-playbutton"]` anchor always carries
   `href="/detail/<EP-ASIN>?autoplay=1&t=0"` in the DOM (even while the
   button itself is a zero-rect hover element). Navigating to it starts
   exactly that episode from 0 — **no clicks, no ambiguity**.
3. Episode end → **auto-play next episode** (same t-reset mechanism as the
   movie→anime swap). For a season, t-reset is a *boundary*, not a stop.

### The three new pieces

| Piece | Role |
|---|---|
| `prime_episode.js <season-detail-url> [season] [episode]` | Deterministic episode start: verify `dp-season-selector` == "Season N", read the Nth card's play-link href, goto it (auto-play from 0), then the proven fullscreen/seek-0/input-test pipeline |
| `movie_stopper.sh --series <boundaries.jsonl> <expected_eps> <wait> <mp4>` | Chapters mode: t-reset ⇒ append `{i,wall,epoch,prev_t,t,d}` boundary and KEEP recording; mid-season stall ⇒ nudge (`play()` / click a play-next control, player-subtree only, ≤3×); stop after `expected_eps` boundaries (or player gone / 6 h) |
| `split_chapters.py <raw> <boundaries.jsonl> --final-t T [--names s1e1,...]` | Lossless keyframe split of the raw season capture into per-episode files. Boundary file-time ≈ `prev_t` (player t of the last frame of episode i — film plays 1:1 with the file clock, GWH-verified drift ~1 s/2 h) |

### Runbook

```bash
# Phase 0 — find the series (deterministic DOM search; agent search unreliable, gotcha 17)
#   The Boys S1 = https://www.primevideo.com/detail/0I6W2UQ1Y5Z4K4EALW5PGMWNZU
#   (search "the boys" -> first result; each season has its own ASIN, S2..S5)

# Phase 1 — start the episode (deep link auto-plays from 0)
node prime_episode.js https://www.primevideo.com/detail/0I6W2UQ1Y5Z4K4EALW5PGMWNZU 1 1
#   FINAL: {"videos":[{"d":3664,...}]}  <- that's d

# Phase 1.5 — VERIFY audio language + subtitles (MANDATORY, see section below)
node player_audio_check.js 2>/dev/null        # exit 0 only if audio=en, subs off
#   if it fails: do NOT start recording — fix the audio language first
#   (see "Audio & subtitle verification" section for the Prime JP levers)

# Phase 2 — arm + record  (STANDARD: isolated display + dedicated sink,
#   see "Isolated display + dedicated audio sink" above)
./movie_stopper.sh --mark
OUT_DIR=<drive> ./record_xvfb.sh &                          # :2.0 + qwe_cap.monitor
./movie_stopper.sh <d-90> <raw>.mp4 &                       # single-episode stop
#  OR: ./movie_stopper.sh --series s1_boundaries.jsonl 8 <d-90> <raw>.mp4 &
./movie_watchdog.sh <raw>.mkv <d> &
node vision_watch.js boys_s1e1_vision.jsonl <minutes> "the boys" &

# Phase 3 — after the season run: split into chapters
python3 split_chapters.py <raw>.mkv s1_boundaries.jsonl --final-t <last-end-t> \
    --out-dir chapters --names s1e1,s1e2,...,s1e8
# then the usual per-chapter trim (head/tail keyframe probe) + analyze_rec.py
```

### Cut-recipe pin (lossless keyframe cuts, measured 2026-10-06)

- **input `-ss` without `-avoid_negative_ts`** = exact keyframe start. With
  `-avoid_negative_ts make_zero` the cut silently starts at the *previous*
  keyframe (measured 9 s early on a 10-s-GOP file).
- **`-t` endpoint must fall inside the segment's own last GOP**: `-c copy`
  then emits the whole GOP, so a segment written as
  `[kf_k, kf_{k+1} − 0.1)` ends *exactly* at `kf_{k+1}` — the next segment's
  start. No duplicated or missing frames at chapter boundaries
  (verified: chapter 1 last pkt 149.646 → chapter 2 first pkt = keyframe 0.000).
- Output-side `-ss` with `-c copy` starts at the NEXT keyframe — don't use it.

### Isolated display + dedicated audio sink — the standard mode

Long captures must NOT use the user's real display or audio. Two measured
failure modes (2026-10-06 S1E1 pilot):

1. **Visual pollution** — `x11grab` captures the *whole X display*. On the
   real display (:1) the user came back to the machine at ~42:30 and their
   windows (terminals, the DSH GUI) covered the player: the last ~18 min of
   `rec_20261006_182012.mp4` (kept on the Passport as the failure record)
   are desktop, not content. The video element kept playing in the DOM
   (stopper saw `t=3571` still "playing" while the screen showed the
   desktop), so **no monitor can detect this** — it's only visible in the
   frames.
2. **Audio pollution + leakage** — capturing from a shared hardware-sink
   monitor records every other app's sound (music, scrcpy, notifications),
   and the episode audio plays out of the user's speakers with no screen to
   go with it (the 19:48 run's E2 kept "playing" audibly for an hour after
   the capture was cancelled — the reason the run was aborted).

**Standard mode (always do this):**

```bash
# 1) isolated virtual display
Xvfb :2 -screen 0 2560x1440x24 -ac +extension GLX +render -nolisten tcp &
# 2) dedicated capture sink (Chrome's audio goes ONLY here:
#    clean audio in the file, silence on the user's speakers)
pactl load-module module-null-sink sink_name=qwe_cap
# 3) agent Chrome on :2 (CDP still 127.0.0.1:9333 -> all harness scripts
#    work unchanged); kill any :1 agent instance BY PROFILE first
#    (pids of *chrome-pv-agent* — never `pkill chrome`, the user's own
#    Chrome shares the binary name)
DISPLAY=:2 google-chrome-stable --user-data-dir=~/.config/chrome-pv-agent \
  --remote-debugging-port=9333 --no-first-run --window-size=2560,1440 \
  --window-position=0,0 https://www.primevideo.com &
# 4) route ONLY Chrome's sink-input into qwe_cap. Identify it via
#    `pactl list short clients` (find the "chrome" client, then its input
#    id in `pactl list short sink-inputs`) — NEVER move inputs of other
#    apps (the user runs scrcpy etc. on the same Pulse session)
pactl move-sink-input <chrome-input> qwe_cap
# 5) record (isolated display + dedicated sink, remuxes on Ctrl+C)
./record_xvfb.sh    # DISP=:2.0 SRC=qwe_cap.monitor RES=1920x1080 FRAMERATE=24
```

Verified 2026-10-06: **Widevine/DRM playback works under Xvfb** (software
GL), same ABR rendition (960×540 for The Boys). The user's session (display
:1, speakers, all other apps) is completely untouched and can't affect the
capture in either direction.

### Audio & subtitle verification — mandatory before recording (`player_audio_check.js`)

The S1E1 Boys pilot came back with **Japanese audio** (the account/region
default), so every capture now starts with a verification gate:

```bash
node player_audio_check.js [cdp_url] [required_audio]   # default en
# -> single JSON line, exit 0 only if audio language matches AND subtitles off
```

What it checks (all via CDP on the agent browser):
- **audio language** — reads the content DASH manifest from the page's
  resource entries and maps the *fetched* audio segment filenames
  (`..._audio_N.mp4`) to their `<AdaptationSet lang="...">`. This is the
  ground truth: the language the player is actually streaming.
- **subtitles** — the native CC-button state, read through a
  `DOM.getDocument({pierce:true})` walk (the player controls live in a
  **closed shadow root**; plain page JS and even open-shadow walks see
  nothing). A `textTracks` entry in `showing` mode also counts as on.

**Prime JP audio-language facts (measured 2026-10-07, The Boys S1E1):**
- The web player shows **only Chrome's native media controls** (in a closed
  shadow root). The native audio-track menu exposes just the *currently
  active* track — there is no in-player language switcher on web.
- The track choice is baked in server-side:
  `GetVodPlaybackResources` returns `defaultAudioTrackId: "ja-jp_dialog_0"`
  and the selection is also encoded in the encrypted `playbackEnvelope`
  and the `dm/3$...` manifest URL. **Client-side rewrites do not work**
  (tested: patching `defaultAudioTrackId` in the response, and stripping
  every Japanese `<AdaptationSet>` from the delivered MPD — the player
  still fetched the ja track). Audio is Widevine-encrypted, so
  downloading a different language track separately is out too.
- The only account-side lever found: **Settings → Language → Streaming
  language** (profile `language_of_preference`, mode `custom`, first
  language = preferred). Saving requires real (trusted) UI events on the
  checkbox rows + the form POSTs to
  `www.primevideo.com/api/setProfilePreferences` with a `preferences` JSON
  field (`language_of_preference_selection` multi + `language_of_preference_mode`
  single). Whether/when it changes the *player* default (vs. just
  recommendations, as the page copy says) is unconfirmed — it did not take
  effect within ~1 h of saving for The Boys.
- The Boys on Prime JP is additionally served with a **baked 2.34:1
  letterbox** (all 8 video renditions are 16:9-par ≤960×540 with the
  black bars in the pixels) — a source property, not a display bug.

If the check fails, options in order of preference: pick the language on a
device that has a menu (TV app — Prime remembers the last per-title
selection per profile), wait for the profile preference to propagate, or
stop and ask the user before recording.

### Pilot result — S1E1 delivered

`the_boys_s1e1_540p_24fps.mp4` on the Passport (2026-10-06, run 4 on Xvfb):
**59:00, from the comic-book cold open to the final "Developed by Eric
Kripke" credit, no ads**. 540p ABR source in a 1080p24 canvas (honest
name: 540p). Analyzer: video=OK audio=OK, peak −3.8 dBFS.

Post-processing (all lossless keyframe cuts, concat'd):
- **Tail**: cut at kf 3609.688 — last credit + black, before the E2
  auto-play (the E2 pre-roll was a Japanese abrAsus wallet ad; vision #62
  classified it `ad` the moment it appeared).
- **Mid-roll 1**: 30 s "AMBIQUE" wallet commercial spliced at ~26:30
  (raw 1591–1621) — black fades both sides = clean splice, the film
  paused for it, **no content lost**. Trimmed at kfs 1589.104 /
  1624.646; the cut lands on the film's own scene change (in-story anime
  card → street scene).
- **Mid-roll 2**: 28 s "ECOFLOW" camping/solar commercial at ~42:30 —
  **missed by the 60 s vision cadence** (it fell between checks) and
  caught by the mandatory **full-file bright-window re-scan** after
  trimming (2 s cadence, mean>100, visual confirm of every window).
  Trimmed at kfs 2529.751 / 2564.876.
- **Head**: starts ~7 s into the static opening comic art (recording armed
  right after seek-0) — nothing lost.
- Final re-scan: every remaining bright window confirmed as film (Vought
  boardroom, Homelander's glass office, the gallery scene, bright day
  streets) — **no ads left**.

Lesson baked into the runbook: after any trim, **always** full-file
re-scan for bright windows before calling a file ad-free; vision alone
cannot guarantee that.

Intermediate files kept on the Passport: `the_boys_s1e1_540p_24fps_WITHAD.mp4`
(60:10, tail-trimmed, ads in), `the_boys_s1e1_540p_24fps_midtrim.mp4`
(59:35, only AMBIQUE removed), raw `boys_s1e1.mp4` (60:55, incl. E2
pre-roll) and the cancelled-run backup `boys_s1e1_run1948_backup.mp4`.

Extra gotcha found on this run: **the stopper sends INT to the ffmpeg
child, not to the recording script** — so the recorder must remux on the
normal exit path (after `wait` returns), not only in an INT/TERM trap
(S1E1 run 4 left a 1.4 GB mkv without mp4 until remuxed by hand;
`record_xvfb.sh` now remuxes on both paths).

### Findings from the pilot run

- Episode grid is fetched from an API and renders **90–120 s** after a fresh
  page load (Prime throttles rapid reloads) — `prime_episode.js` reuses an
  already-loaded grid and waits up to 150 s otherwise.
- The per-card play button is a zero-rect hover element; the **href deep link
  is the reliable trigger** (packshot click also works, tested).
- **No quality selector** in the Prime web player (⋮ menu = playback speed +
  picture-in-picture only) — quality is pure ABR. This run served
  **960×540** for the whole episode (GWH/CR got 1080p): quality is
  connection/account-dependent; document `videoWidth` per run.
- The 2B vision watch reads the series title in-episode ("The Boys" in
  title_text from ~minute 8) — 330–370 ms per check, clean `film` all the way.

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
| `movie_stopper.sh` | Full-movie end-detector: `--mark` tags the movie `<video>`, then stops ffmpeg + remuxes when the movie ends (t≈d, paused×2, marked element gone, **or t-reset** — same element reused for the auto-played next title) |
| `vision_watch.js` | Per-minute vision verifier: CDP screenshot of the movie `<video>` → Qwen scene classification + notes → JSONL; stop strikes (2-strike) with position-aware opening-credits/preroll exceptions (GWH run 2) |
| `gwh_vision.jsonl` | Vision log, GWH run 1 (3 clip-rect errors + the opening-credits false stop — kept as the failure record) |
| `gwh_vision2.jsonl` | Vision log, GWH run 2 — the clean 129-check dataset (128/128 film frames, mid-roll ad caught, auto-play swap labeled `film`) |
| `boys_s1e1_vision{,2,3}.jsonl` | The Boys S1E1 vision logs: run 1 (real display, aborted by user), run 2 (real display, tail contaminated by user's windows — the failure record), run 3 (first Xvfb run) |
| `prime_episode.js` | Series episode start: verify season selector → read the Nth episode card's hidden play-link href (`/detail/<EP-ASIN>?autoplay=1&t=0`) → goto → fullscreen/seek-0 pipeline (The Boys S1 pilot) |
| `record_xvfb.sh` | Standard-mode capture: x11grab on isolated display (:2.0) + audio from dedicated null-sink monitor (qwe_cap) → 1080p24 mkv, remuxes to mp4 on stop; sanity-checks the sink exists before starting |
| `split_chapters.py` | Lossless keyframe split of a raw season capture into per-episode files from the stopper's boundary JSONL (boundary file-time ≈ `prev_t`) |
| `movie_watchdog.sh` | Full-movie health watch: every 10 min checks movie time + file size are advancing, nudges `play()` on a stall |
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
