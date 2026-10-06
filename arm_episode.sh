#!/usr/bin/env bash
# arm_episode.sh — arm the whole capture stack for one episode in one shot.
#
# Precondition: the episode is ALREADY playing at t≈0 on the agent Chrome
#   (Xvfb :2), and the stopper mark is set. Order per episode:
#     1. node prime_episode.js <series-url> 1 <N>     (starts + seeks 0)
#     2. node player_audio_check.js                   (GATE: en + subs off)
#     3. ./movie_stopper.sh --mark
#     4. ./arm_episode.sh <N> <d>                     <- this
#
# It starts (all backgrounded, logs under /tmp/qwe/):
#   record_xvfb.sh   -> $OUT/rec_<stamp>.mkv -> .mp4
#   movie_stopper.sh <d-90>   <mp4>           (auto-stop + remux at episode end)
#   movie_watchdog.sh <mkv> <d>               (10-min health checks)
#   vision_watch.js  <N>_vision.jsonl <mins>  (60 s ad/content classification)
#
# Prints the output paths as JSON on stdout (capture them).
set -u
cd "$(dirname "$0")"

N="${1:?episode number}"
D="${2:?episode duration seconds}"
OUT_DIR="${OUT_DIR:-/media/sergio/My Passport}"
STOP_MARGIN="${STOP_MARGIN:-90}"   # stopper starts polling at d-margin
TAG="${TAG:-fallout}"              # vision file prefix / label

STAMP="rec_$(date +%Y%m%d_%H%M%S)"
MKV="$OUT_DIR/$STAMP.mkv"; MP4="$OUT_DIR/$STAMP.mp4"
MIN=$(( (D / 60) + 2 ))
LOG=/tmp/qwe; mkdir -p "$LOG"

export OUT_DIR STAMP
./record_xvfb.sh >> "$LOG/record.log" 2>&1 &
echo "[arm] recorder -> $MP4 (pid $!)" >&2
sleep 3   # let the recorder pass its sink sanity check
tail -n1 "$LOG/record.log" | grep -q FATAL && { echo "[arm] FATAL: recorder died"; exit 1; }

./movie_stopper.sh $(( D - STOP_MARGIN )) "$MP4" >> "$LOG/stopper.log" 2>&1 &
echo "[arm] stopper armed: poll at d-$STOP_MARGIN (pid $!)" >&2

./movie_watchdog.sh "$MKV" "$D" >> "$LOG/watchdog.log" 2>&1 &
echo "[arm] watchdog armed: d=$D (pid $!)" >&2

node vision_watch.js "${TAG}_s1e${N}_vision.jsonl" "$MIN" "fallout" >> "$LOG/vision.log" 2>&1 &
echo "[arm] vision armed: $MIN min (pid $!)" >&2

echo "{\"mkv\":\"$MKV\",\"mp4\":\"$MP4\",\"stop_after_s\":$(( D - STOP_MARGIN ))}"
