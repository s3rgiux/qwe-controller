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
    return { marked: !!marked, p: m.paused, t: +m.currentTime.toFixed(1), d: +m.duration.toFixed(0) };
  }, mode);
  console.log(JSON.stringify(r));
  process.exit(0);
})().catch(() => { console.log("ERR"); process.exit(1); });
'

if [[ "${1:-}" == "--mark" ]]; then
  out=$(timeout 30 node -e "$NODE_STATE" mark 2>/dev/null)
  say "mark: $out"
  [[ "$out" == *"marked:"* ]] || exit 1
  exit 0
fi

WAIT="${1:?wait_seconds}"; MP4="${2:?mp4_path}"

state() { timeout 30 node -e "$NODE_STATE" poll 2>/dev/null; }

stop_ffmpeg() {
  local pid; pid=$(ps -eo pid,args | awk '/[f]fmpeg.*x11grab/ {print $1; exit}')
  if [[ -n "$pid" ]]; then
    say "movie ended — kill -INT ffmpeg pid=$pid"
    kill -INT "$pid"
  else
    say "no x11grab ffmpeg found (already stopped?)"
  fi
  for i in $(seq 1 120); do [[ -f "$MP4" ]] && break; sleep 1; done
  if [[ -f "$MP4" ]]; then say "remux complete: $MP4 ($(du -h "$MP4" | cut -f1))"
  else say "ERROR: remuxed file not found: $MP4"; fi
}

say "movie stopper armed: wait ${WAIT}s then poll (target: $MP4)"
sleep "$WAIT"

consec=0
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
