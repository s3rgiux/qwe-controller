#!/usr/bin/env bash
# start_episode.sh — deterministic per-episode start with the mandatory gate.
#
# Usage: ./start_episode.sh <series-detail-URL> <N>
#   1. prime_episode.js <url> 1 <N>   — open grid, click episode N, play, seek 0
#   2. wait for ABR to fetch audio segments
#   3. player_audio_check.js          — GATE: English audio + subtitles off
#   4. movie_stopper.sh --mark        — tag the video for end-detection
#
# On success prints FINAL d (duration) as the last line:  DURATION=<s>
# On gate failure it ABORTS (no mark, nothing armed) — fix the audio
# language first, then re-run for the same episode.
set -u
cd "$(dirname "$0")"

URL="${1:?series detail URL}"
N="${2:?episode number}"

echo "[start] launching episode $N ..." >&2
OUT=$(node prime_episode.js "$URL" 1 "$N" 2>&1)
echo "$OUT" | sed 's/^/[episode] /' >&2
if ! echo "$OUT" | grep -q "FINAL"; then
  echo "[start] FATAL: prime_episode.js did not report FINAL" >&2
  exit 1
fi

D=$(echo "$OUT" | grep -o '"d":[0-9]*' | tail -1 | cut -d: -f2)
if ! [[ "$D" =~ ^[0-9]+$ ]] || (( D < 600 )); then
  echo "[start] FATAL: could not parse a sane duration from FINAL" >&2
  exit 1
fi

echo "[start] letting ABR settle (25 s) ..." >&2
sleep 25

echo "[start] GATE: player_audio_check.js ..." >&2
GATE=$(node player_audio_check.js 2>/dev/null)
echo "$GATE" >&2
if ! echo "$GATE" | grep -q '"ok":true'; then
  echo "[start] GATE FAILED — not arming. Fix audio language/subtitles first." >&2
  exit 1
fi

./movie_stopper.sh --mark >&2

echo "DURATION=$D"
