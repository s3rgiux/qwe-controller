#!/usr/bin/env bash
# movie_watchdog.sh — health-watch a 2.5 h full-movie capture.
# Every CHECK_INTERVAL s: confirm the movie <video> (d>600) is progressing and
# the .mkv is growing. If progress stalls 2 checks in a row, nudge play().
set -u
MKV="${1:?path to the .mkv}"; DURATION="${2:?expected movie duration s}"
CHECK_INTERVAL="${CHECK_INTERVAL:-600}"
say() { echo "[watchdog] $(date '+%F %T') $*" >&2; }

prev_t=0; prev_size=0; stalls=0
last_t=$(date +%s)
end=$(( $(date +%s) + DURATION + 300 ))

while [[ $(date +%s) -lt $end ]]; do
  sleep "$CHECK_INTERVAL"
  out=$(timeout 40 node -e "
  const { chromium } = require('playwright-core');
  (async () => {
    const b = await chromium.connectOverCDP('http://127.0.0.1:9333');
    const ctx = b.contexts()[0];
    const page = ctx.pages().find(p => p.url().includes('primevideo')) || ctx.pages()[0];
    const r = await page.evaluate(() => {
      // prefer the movie element tagged by `movie_stopper.sh --mark` so the
      // watchdog keeps tracking the right video when Prime auto-plays next
      const movies = [...document.querySelectorAll('video')].filter(x => x.duration > 600);
      const m = document.querySelector('video[data-qwe-stopwatch="1"]') ||
                movies.sort((a,c) => c.duration - a.duration)[0];
      if (!m) return null;
      if (m.paused && m.currentTime < m.duration - 30) m.play();   // nudge on sight of a stall
      return { p: m.paused, t: +m.currentTime.toFixed(1), d: +m.duration.toFixed(0) };
    });
    console.log(JSON.stringify(r));
    process.exit(0);
  })().catch(() => { console.log('ERR'); process.exit(1); });
" 2>/dev/null)
  size=$(stat -c %s "$MKV" 2>/dev/null || echo 0)
  t=$(echo "$out" | sed -n 's/.*"t":\([0-9.]*\).*/\1/p')
  d=$(echo "$out" | sed -n 's/.*"d":\([0-9]*\).*/\1/p')

  if [[ "$out" == "ERR" || -z "$t" ]]; then
    say "WARN: CDP/video check failed (out='$out') — retrying next cycle"
    continue
  fi
  say "t=${t}s / ${d}s | mkv ${size} B"

  dt=$(awk -v a="$t" -v b="$prev_t" 'BEGIN{printf "%.0f", a-b}')
  ds=$(( size - prev_size ))
  if [[ $dt -le 5 && $ds -lt 1000000 ]]; then
    stalls=$((stalls+1))
    say "STALL suspected (dt=${dt}s, dsize=${ds}B) — stall #$stalls"
    [[ $stalls -ge 2 ]] && say "2 consecutive stalls — player likely dead or machine asleep; check manually"
  else
    stalls=0
  fi
  prev_t=$t; prev_size=$size
done
say "watchdog finished (movie window elapsed)"
