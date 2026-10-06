#!/usr/bin/env bash
# record_xvfb.sh — full-movie/episode screen capture on an ISOLATED virtual
# display, with audio from a DEDICATED capture sink.
#
# Why (2026-10-06, The Boys S1E1 pilot):
#   * x11grab captures the WHOLE X display. Recording on the user's real
#     display (:1) failed twice when the user's windows covered the player
#     (desktop frames in the file — the monitors cannot detect this, the
#     video element keeps playing in the DOM). Recording on a virtual
#     display (:2, Xvfb) isolates the capture from all user activity.
#   * The capture audio must be ONLY the player. Recording from a shared
#     hardware-sink monitor also picks up every other app (music, scrcpy,
#     notifications). A dedicated null sink (qwe_cap) that Chrome is routed
#     into gives clean audio AND keeps the user's speakers silent (no
#     invisible episode audio playing in the room).
#
# Setup once per machine (see README "Isolated display + dedicated sink"):
#   Xvfb :2 -screen 0 2560x1440x24 -ac +extension GLX +render -nolisten tcp &
#   pactl load-module module-null-sink sink_name=qwe_cap
#   DISPLAY=:2 google-chrome-stable --user-data-dir=~/.config/chrome-pv-agent \
#     --remote-debugging-port=9333 ... &
#   pactl move-sink-input <chrome's-input> qwe_cap   # identify via
#     `pactl list short clients` — NEVER move inputs of other apps
#
# Usage:  ./record_xvfb.sh            (Ctrl+C / SIGINT stops + remuxes)
# Env:    DISP (:2.0) SRC (qwe_cap.monitor) RES FRAMERATE OUT_DIR
set -u
STAMP="rec_$(date +%Y%m%d_%H%M%S)"
OUT_DIR="${OUT_DIR:-/media/sergio/My Passport}"
RES="${RES:-1920x1080}"
FRAMERATE="${FRAMERATE:-24}"
DISP="${DISP:-:2.0}"
SRC="${SRC:-qwe_cap.monitor}"
MKV="$OUT_DIR/$STAMP.mkv"; MP4="$OUT_DIR/$STAMP.mp4"
echo "[record] output: $MKV (-> $MP4)  display=$DISP audio=$SRC"

# sanity: the capture sink must exist, else we'd record silence
# (2026-10-07: the old check compared the monitor name "qwe_cap.monitor"
# against bare sink names and could NEVER pass — it failed every launch)
SINK_NAME="${SRC%.monitor}"
pactl list short sinks | awk -v s="$SINK_NAME" '$2==s {found=1} END {exit !found}' \
  || { echo "[record] FATAL: sink '$SINK_NAME' not found (is the null sink loaded?)"; exit 1; }

ffmpeg -hide_banner -loglevel warning -stats -f x11grab -thread_queue_size 256 \
  -framerate "$FRAMERATE" -video_size 2560x1440 -i "$DISP" \
  -f pulse -i "$SRC" \
  -map 0:v:0 -map 1:a:0 -c:a aac -b:a 192k \
  -c:v libx264 -preset veryfast -crf 18 -tune film \
  -vf "scale=1920:1080" -pix_fmt yuv420p -y "$MKV" &
FFPID=$!
# REMUX MUST RUN ON BOTH EXIT PATHS (2026-10-06 bug, The Boys S1E1 run 4):
# the stopper sends INT to the ffmpeg CHILD, not to this script — so the
# script exits normally (wait returns) with no trap firing. Remuxing only
# in the trap left a 1.4 GB mkv with no mp4.
remux() {
  [[ -f "$MP4" ]] && return 0   # already remuxed
  echo "[record] remuxing to .mp4 (no re-encode)..."
  if ffmpeg -v error -y -i "$MKV" -c copy -movflags +faststart "$MP4"; then
    rm -f "$MKV"
    echo "[record] done: $MP4 ($(du -h "$MP4" | cut -f1))"
  else
    echo "[record] REMUX FAILED — keeping $MKV"
  fi
}
trap 'kill -INT $FFPID 2>/dev/null' INT TERM
wait $FFPID
remux
