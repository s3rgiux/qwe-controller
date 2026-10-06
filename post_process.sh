#!/usr/bin/env bash
# post_process.sh — mechanical half of the per-episode post chain.
#
#   ./post_process.sh scan <file> [grabdir]
#       bright-window rescan + frame grabs. Confirm the windows visually,
#       then build ranges.json from the reported [start,end] pairs.
#   ./post_process.sh cut <file> <ranges.json> <out.mp4>
#       lossless keyframe trim of the ad ranges, then the MANDATORY
#       re-scan of the result + analyze_rec.py.
#
# ranges.json: [[start,end], ...] ad ranges in file seconds (may overlap;
# they are merged). Cuts expand to surrounding keyframes (README
# "Cut-recipe pin": input-side -ss = exact keyframe start; -t endpoint
# inside its own last GOP; concat demuxer + -c copy).
set -u
cd "$(dirname "$0")"

MODE="${1:-}"; shift || true
case "$MODE" in
  scan)
    FILE="${1:?file}"; GRAB="${2:-/tmp/grabs}"
    python3 rescan_bright.py "$FILE" --cadence 2 --mean 100 --grab "$GRAB"
    exit $?
    ;;
  cut)
    FILE="${1:?file}"; RANGES="${2:?ranges.json}"; OUT="${3:?out.mp4}"
    ;;
  *)
    echo "usage: $0 scan <file> [grabdir] | cut <file> <ranges.json> <out.mp4>" >&2
    exit 2
    ;;
esac

TMP=$(mktemp -d /tmp/postproc.XXXX)
trap 'rm -rf "$TMP"' EXIT

# keyframes from packet flags (no decode; -skip_frame nokey + show_entries
# frame= was found to come back empty on some mkv/mp4 with this ffprobe 4.4)
ffprobe -v error -select_streams v:0 -show_entries packet=pts_time,flags \
  -of csv=p=0 "$FILE" | awk -F, '$2 ~ /K/ {print $1}' > "$TMP/kfs.txt"
DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$FILE")

# ranges: inline JSON ([[a,b],...]) or a path to a .json file
if [[ "$RANGES" == \[* ]]; then echo "$RANGES" > "$TMP/ranges.json"; RANGES="$TMP/ranges.json"; fi

python3 - "$TMP/kfs.txt" "$RANGES" "$DUR" <<'EOF'
import json, sys
kfs = [float(l) for l in open(sys.argv[1]) if l.strip()]
ranges = [tuple(map(float, r)) for r in json.load(open(sys.argv[2]))]
dur = float(sys.argv[3])
ranges.sort()
m = []
for a, b in ranges:
    if m and a <= m[-1][1]: m[-1] = (m[-1][0], max(m[-1][1], b))
    else: m.append((a, b))
def kf_le(x):
    best = 0.0
    for k in kfs:
        if k <= x: best = k
        else: break
    return best
def kf_ge(x):
    for k in kfs:
        if k >= x: return k
    return dur
# keep segments:
#  - START must be a keyframe (the output stream must open on an I-frame):
#    kf_ge(ad_end); file head is 0.
#  - END is EXACT (the next ad's start), not keyframe-snapped: with -c copy
#    a -t endpoint may land anywhere inside its last GOP (README cut-recipe
#    pin) — snapping to kf_le would eat up to a GOP of real content before
#    the ad (Fallout E1: kf_le(4330)=4323 would drop the 4324-4330 end logo).
segs = []
prev = 0.0
for a, b in m:
    if a - prev > 0.5: segs.append((prev, a))
    prev = max(prev, kf_ge(b))
if dur - prev > 0.5: segs.append((prev, dur))
segs = [(s, e) for s, e in segs if e - s > 0.5]
with open(sys.argv[1].replace('kfs.txt', 'segments.tsv'), 'w') as f:
    for s, e in segs:
        f.write(f"{s:.3f}\t{e-s:.3f}\n")
print(f"[plan] dur={dur:.1f} ads={len(m)} keep_segments={len(segs)}: " +
      ", ".join(f"[{s:.1f},{e:.1f})" for s, e in segs))
EOF

SEGN=$(wc -l < "$TMP/segments.tsv")
if [[ "$SEGN" -eq 0 ]]; then
  echo "[post] no keep segments — refusing (check ranges)" >&2
  exit 1
fi

if [[ "$SEGN" -eq 1 ]] && awk -F'\t' '$1 < 1' "$TMP/segments.tsv" | grep -q .; then
  T=$(awk -F'\t' '{print $2}' "$TMP/segments.tsv")
  if awk -v a="$T" -v b="$DUR" 'BEGIN{exit !(a < b-1)}'; then
    echo "[post] tail trim [0,$T)"
    ffmpeg -nostdin -v error -y -ss 0 -i "$FILE" -t "$T" -c copy -movflags +faststart "$OUT"
  else
    echo "[post] no trim needed"; cp "$FILE" "$OUT"
  fi
elif [[ "$SEGN" -eq 1 ]]; then
  # single internal keep segment (e.g. E1 = raw minus head-ad minus
  # everything after E1) — cut straight to OUT, no concat
  read -r S T < "$TMP/segments.tsv"
  # NOTE: no $((S+T)) here — bash aborts the WHOLE script (not just the
  # command) on a float arithmetic syntax error inside a compound command
  SS=$(awk -v s="$S" 'BEGIN{printf "%.6f", s+0.5}')
  echo "[post] single segment cut start=$S len=$T (ss=$SS)"
  ffmpeg -nostdin -v error -y -ss "$SS" -i "$FILE" -t "$T" -c copy -movflags +faststart "$OUT"
else
  echo "[post] cutting + concat $SEGN segments"
  i=0; : > "$TMP/concat.txt"
  while IFS=$'\t' read -r S T; do
    i=$((i+1))
    # always -t: the plan's T is the exact keep length for EVERY segment
    # (the old last-segment no-`-t` shortcut was wrong when the keep segment
    # is internal, i.e. an ad range extends to end-of-file — Fallout E1 case)
    # -ss offset +0.5: input -ss with -c copy does a FAST seek that can land
    # on the keyframe BEFORE an exact keyframe target (observed: 7 s early on
    # the E2 splice). Seeking to (keyframe + 0.5) lands on the keyframe itself
    # (min keyframe gap in these captures is 1.0 s), so the segment opens on
    # the intended keyframe and -t T still trims at S+T = the keep end.
    SS=$(awk -v s="$S" 'BEGIN{printf "%.6f", s+0.5}')
    ffmpeg -nostdin -v error -y -ss "$SS" -i "$FILE" -t "$T" -c copy "$TMP/seg$i.mkv"
    echo "file 'seg$i.mkv'" >> "$TMP/concat.txt"
  done < "$TMP/segments.tsv"
  ffmpeg -nostdin -v error -y -f concat -safe 0 -i "$TMP/concat.txt" -c copy -movflags +faststart "$OUT"
fi

echo "[post] output: $OUT ($(du -h "$OUT" | cut -f1), $(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT") s)"
echo "[post] MANDATORY re-scan (gate):"
python3 rescan_bright.py "$OUT" --cadence 2 --mean 100 --grab /tmp/grabs_post
echo "[post] analyze:"
python3 analyze_rec.py "$OUT" /tmp/analysis_post 2>&1 | tail -12
