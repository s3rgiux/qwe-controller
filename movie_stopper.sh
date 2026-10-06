#!/usr/bin/env bash
# movie_stopper.sh — stop a net_record capture exactly when the whole movie ends.
#
# Usage:
#   movie_stopper.sh --mark                    tag the playing movie <video> (do this
#                                              right after playback starts)
#   movie_stopper.sh <wait_seconds> <mp4_path> arm the stopper
#     wait_seconds  sleep before end-polling starts (~ movie_duration - 90)
#     mp4_path      expected final .mp4 (record.sh remux target)
#
# End detection (via CDP :9333):
#   - marked movie video: t within 30s of duration, or paused 2 checks in a row
#     -> end
#   - marked element GONE (player swapped in auto-played next content) -> end,
#     after 2 consecutive checks
#   - t RESET (t jumps backwards >30s while the marked element survives —
#     Prime often reuses the same <video> for the auto-played next title) -> end
#   - still playing after 45 min of polls -> force stop (safety)
#
# Why --mark: when a movie ends, Prime auto-plays the "next" title, so
# "the longest <video>" is no longer the movie we recorded. Tracking the marked
# element by identity avoids recording the next title for another 45 min.
set -u
say() { echo "[stopper] $(date '+%F %T') $*" >&2; }

cd "$(dirname "$0")"   # so require('playwright-core') resolves

NODE_STATE='
const { chromium } = require("playwright-core");
(async () => {
  const b = await chromium.connectOverCDP("http://127.0.0.1:9333");
  const ctx = b.contexts()[0];
  const page = ctx.pages().find(p => p.url().includes("primevideo")) || ctx.pages()[0];
  const mode = process.argv[1];
  const r = await page.evaluate((mode) => {
    const movies = [...document.querySelectorAll("video")].filter(x => x.duration > 600);
    if (mode === "mark") {
      const m = movies.sort((a,c) => c.duration - a.duration)[0];
      if (!m) return "no movie video";
      m.setAttribute("data-qwe-stopwatch", "1");
      return "marked: " + m.duration.toFixed(0) + "s";
    }
    const marked = document.querySelector("video[data-qwe-stopwatch=\"1\"]");
    const m = marked || movies.sort((a,c) => c.duration - a.duration)[0];
    if (!m) return null;
    if (mode === "nudge") {
      // series mode: episode ended but auto-play did not advance. Try to
      // resume: play the movie video, else click a visible Play/Resume/Next
      // control (player interstitial play-next-episode prompt).
      const did = [];
      if (m && m.paused) { try { m.play(); did.push("play()"); } catch (e) {} }
      // ONLY inside the player overlay — a DOM click() ignores visual
      // layering and can hit hero buttons behind the player (2026-10-06
      // smoke test clicked a hidden "Resume S1 E2" span; harmless there but
      // would skip an episode in series mode).
      for (const e of document.querySelectorAll("#dv-web-player span, #dv-web-player button, #dv-web-player [role=button]")) {
        const t = (e.textContent || "").trim();
        if (t.length > 25) continue;
        const tl = t.toLowerCase();
        if (!["play", "resume", "watch", "next", "play next", "play next episode", "再生", "つづきを見る", "次へ"].includes(tl) &&
            !/play|resume|next|再生|次へ/.test(tl)) continue;
        const r = e.getBoundingClientRect();
        if (r.width > 25 && r.width < 400 && r.height > 18 && r.height < 100 && r.y > 100) {
          e.click(); did.push("clicked:" + t); break;
        }
      }
      return did.join(",") || "nothing to nudge";
    }
    return { marked: !!marked, p: m.paused, t: +m.currentTime.toFixed(1), d: +m.duration.toFixed(0) };
  }, mode);
  console.log(JSON.stringify(r));
  process.exit(0);
})().catch(() => { console.log("ERR"); process.exit(1); });
'

state() { timeout 30 node -e "$NODE_STATE" poll 2>/dev/null; }

stop_ffmpeg() {
  local pid; pid=$(ps -eo pid,args | awk '/[f]fmpeg.*x11grab/ {print $1; exit}')
  if [[ -n "$pid" ]]; then
    say "movie ended — kill -INT ffmpeg pid=$pid"
    kill -INT "$pid"
  else
    say "no x11grab ffmpeg found (already stopped?)"
  fi
  # let the recorder's ffmpeg fully exit (on INT it flushes the mkv trailer;
  # the mkv is still being written until it does)
  if [[ -n "$pid" ]]; then
    for i in $(seq 1 120); do ps -p "$pid" > /dev/null 2>&1 || break; sleep 1; done
  fi
  # then wait for the recorder's remux to actually FINISH: mp4 exists and its
  # size is stable (2026-10-07: the old version reported "remux complete (13M)"
  # — the size of the recorder's in-progress remux one second after it started)
  local prev=-1 cur
  for i in $(seq 1 360); do
    [[ -f "$MP4" ]] || { sleep 2; continue; }
    cur=$(stat -c %s "$MP4" 2>/dev/null || echo 0)
    if [[ "$cur" -gt 0 && "$cur" == "$prev" ]]; then
      say "remux complete: $MP4 ($(du -h "$MP4" | cut -f1))"
      return 0
    fi
    prev=$cur
    sleep 3
  done
  say "ERROR: remuxed file not ready: $MP4"
  return 1
}

if [[ "${1:-}" == "--mark" ]]; then
  out=$(timeout 30 node -e "$NODE_STATE" mark 2>/dev/null)
  say "mark: $out"
  [[ "$out" == *"marked:"* ]] || exit 1
  exit 0
fi

# ---- SERIES / CHAPTERS MODE -------------------------------------------------
# Records a whole season in ONE capture; episode ends are BOUNDARIES, not stops.
#
#   movie_stopper.sh --series <boundary.jsonl> <expected_eps> <wait_seconds> <mp4_path>
#
#   wait_seconds     sleep before polling starts (~ last_episode_duration - 90;
#                    episode 1 is assumed to already be playing and marked)
#
# Boundary = t-RESET (t jumps backwards >30s while the marked element survives:
# Prime reuses the same <video> for the auto-played next episode). Each boundary
# appends {i, wall, epoch, prev_t, t, d, marked} to boundary.jsonl.
#
# Stop conditions:
#   - n-th boundary observed (n == expected_eps) => season done
#   - marked element gone / player gone 2 checks in a row
#   - t>=d-30 or paused x2 on the LAST expected episode (auto-play off)
#   - mid-season stall (t>=d-30 or paused x2 before the last episode):
#     nudge (play()/click next) up to 3 times, then give up and stop
#   - 6 h of polls => force stop (safety)
if [[ "${1:-}" == "--series" ]]; then
  BOUNDARY="${2:?boundary.jsonl}"; EXPECTED="${3:?expected_eps}"
  WAIT="${4:?wait_seconds}"; MP4="${5:?mp4_path}"
  : > "$BOUNDARY"
  say "SERIES mode: $EXPECTED episodes, boundary log: $BOUNDARY, wait ${WAIT}s"
  sleep "$WAIT"

  n=0; prev_t=""; consec=0; nudges=0; stalled=0
  for i in $(seq 1 360); do   # 360 x 60s = 6 h safety cap
    st=$(timeout 30 node -e "$NODE_STATE" poll 2>/dev/null)
    say "series poll $i (ep $((n+1))): state=$st"
    case "$st" in
      ERR|'') say "CDP unreachable — retrying"; sleep 60; continue ;;
      'null')
        consec=$((consec+1))
        [[ $consec -ge 2 ]] && { say "player gone 2 checks in a row — stop (ep $((n+1)), n=$n boundaries)"; stop_ffmpeg; exit 0; }
        sleep 60; continue
        ;;
      *)
        t=$(echo "$st" | sed -n 's/.*"t":\([0-9.]*\).*/\1/p')
        d=$(echo "$st" | sed -n 's/.*"d":\([0-9]*\).*/\1/p')
        p=$(echo "$st" | sed -n 's/.*"p":\(true\|false\).*/\1/p')
        marked=$(echo "$st" | sed -n 's/.*"marked":\(true\|false\).*/\1/p')
        if [[ "$marked" == "false" ]]; then
          consec=$((consec+1))
          [[ $consec -ge 2 ]] && { say "marked element gone 2 checks in a row — stop (n=$n boundaries)"; stop_ffmpeg; exit 0; }
          sleep 60; continue
        fi
        # --- t-RESET: episode boundary -------------------------------------
        if [[ -n "$prev_t" ]] && awk -v t="$t" -v pt="$prev_t" 'BEGIN{exit !(t < pt - 30)}'; then
          wall=$(date -u '+%Y-%m-%dT%H:%M:%SZ'); epoch=$(date +%s)
          printf '{"i":%d,"wall":"%s","epoch":%s,"prev_t":%s,"t":%s,"d":%s}\n' \
            "$((n+1))" "$wall" "$epoch" "$prev_t" "$t" "$d" >> "$BOUNDARY"
          n=$((n+1)); prev_t="$t"; consec=0
          say "BOUNDARY $n: ep $n ended (t $prev_t->$t, d=$d) — next episode auto-played"
          if [[ $n -ge $EXPECTED ]]; then
            say "all $EXPECTED episodes done — season complete"
            stop_ffmpeg; exit 0
          fi
          sleep 60; continue
        fi
        prev_t="$t"; consec=0
        # --- last episode end (auto-play off) ------------------------------
        end_like=0
        awk -v t="$t" -v d="$d" 'BEGIN{exit !(t >= d-30)}' && end_like=1
        [[ "$p" == "true" ]] && end_like=1
        if [[ $end_like -eq 1 && $((n+1)) -ge $EXPECTED ]]; then
          say "last expected episode ended (t=$t/d=$d p=$p) — season complete"
          stop_ffmpeg; exit 0
        fi
        # --- mid-season stall: nudge up to 3 times --------------------------
        if [[ $end_like -eq 1 && $((n+1)) -lt $EXPECTED ]]; then
          if [[ $stalled -eq 0 ]]; then stalled=1; fi
          if [[ $nudges -lt 3 ]]; then
            nudges=$((nudges+1))
            say "episode $((n+1)) stalled at end (t=$t/d=$d p=$p) — nudge $nudges/3"
            timeout 30 node -e "$NODE_STATE" nudge 2>/dev/null | sed 's/^/[stopper] nudge: /'
          else
            say "still stalled after 3 nudges — cannot continue season; stopping (n=$n boundaries)"
            stop_ffmpeg; exit 0
          fi
        fi
        ;;
    esac
    sleep 60
  done
  say "6 h of polls — force stop (safety, n=$n boundaries)"
  stop_ffmpeg
  exit 0
fi

WAIT="${1:?wait_seconds}"; MP4="${2:?mp4_path}"

# Arm-time-INDEPENDENT wait (2026-10-07 Fallout E1 bug: the old fixed
# `sleep d-90` assumed arming at t=0. Armed 29 min late, it slept PAST the
# episode end and never saw the E1->E2 t-reset; the recorder then captured
# the next episode too). Now: wait until the marked video's t actually
# reaches d-90, checking every 30 s, and bail immediately on a t-reset or
# a vanished element (= marked episode already ended). WAIT stays as a
# hard cap so a stalled clock can't hold the stopper forever.
say "movie stopper armed: wait until t>=d-90, hard cap ${WAIT}s (target: $MP4)"
deadline=$(( $(date +%s) + WAIT ))
prev_wait_t=""
nulls=0
while :; do
  st=$(state)
  case "$st" in
    ERR|'')
      sleep 30 ;;
    'null')
      nulls=$((nulls+1))
      if [[ $nulls -ge 2 ]]; then
        say "element gone 2 checks in a row during wait — episode ended"
        stop_ffmpeg; exit 0
      fi
      sleep 30 ;;
    *)
      nulls=0
      t=$(echo "$st" | sed -n 's/.*"t":\([0-9.]*\).*/\1/p')
      d=$(echo "$st" | sed -n 's/.*"d":\([0-9]*\).*/\1/p')
      if [[ -n "$t" && -n "$d" ]]; then
        if [[ -n "$prev_wait_t" ]] && awk -v t="$t" -v pt="$prev_wait_t" 'BEGIN{exit !(t < pt - 30)}'; then
          say "t reset during wait (t=$t after $prev_wait_t) — marked episode ended"
          stop_ffmpeg; exit 0
        fi
        prev_wait_t="$t"
        if awk -v t="$t" -v d="$d" 'BEGIN{exit !(t >= d-90)}'; then
          say "t=$t reached d-90 (d=$d) — entering end-poll"
          break
        fi
      fi
      sleep 30 ;;
  esac
  if (( $(date +%s) > deadline )); then
    say "wait cap (${WAIT}s) reached — entering end-poll"
    break
  fi
done

consec=0
prev_t=""
for i in $(seq 1 45); do
  st=$(state)
  say "poll $i: state=$st"
  case "$st" in
    ERR|'')
      say "CDP unreachable — retrying (browser may be busy)"
      sleep 60; continue
      ;;
    'null')
      consec=$((consec+1))
      [[ $consec -ge 2 ]] && { say "movie element gone 2 checks in a row — movie ended"; stop_ffmpeg; exit 0; }
      ;;
    *)
      t=$(echo "$st" | sed -n 's/.*"t":\([0-9.]*\).*/\1/p')
      d=$(echo "$st" | sed -n 's/.*"d":\([0-9]*\).*/\1/p')
      p=$(echo "$st" | sed -n 's/.*"p":\(true\|false\).*/\1/p')
      marked=$(echo "$st" | sed -n 's/.*"marked":\(true\|false\).*/\1/p')
      # the marked movie element disappeared (player swapped in next content)
      if [[ "$marked" == "false" ]]; then
        consec=$((consec+1))
        [[ $consec -ge 2 ]] && { say "marked movie element gone (auto-play next title?) 2 checks in a row — movie ended"; stop_ffmpeg; exit 0; }
        sleep 60; continue
      fi
      consec=0
      # t-RESET: when the movie ends Prime auto-plays the next title and often
      # REUSES THE SAME <video> ELEMENT — the mark survives, t just jumps
      # backwards (e.g. 7656 -> 40). No other rule catches this. (GWH run 2,
      # 2026-10-06: anime auto-played on the marked element, stopper would
      # have kept polling 45 more min.)
      if [[ -n "$prev_t" ]] && awk -v t="$t" -v pt="$prev_t" 'BEGIN{exit !(t < pt - 30)}'; then
        say "t reset ($prev_t -> $t): player swapped in next content on the same element — movie ended"
        stop_ffmpeg; exit 0
      fi
      prev_t="$t"
      if awk -v t="$t" -v d="$d" 'BEGIN{exit !(t >= d-30)}'; then
        say "t=$t within 30s of end (d=$d)"; stop_ffmpeg; exit 0
      fi
      if [[ "$p" == "true" ]]; then
        say "paused (t=$t/d=$d)"
        # brief player pauses happen; only end after 2 consecutive paused checks
        consec_pause=$(( ${consec_pause:-0} + 1 ))
        [[ $consec_pause -ge 2 ]] && { say "paused 2 checks in a row — movie ended"; stop_ffmpeg; exit 0; }
      else
        consec_pause=0
      fi
      ;;
  esac
  sleep 60
done
say "still playing after 45 min of polls — force stop (safety)"
stop_ffmpeg
exit 0
