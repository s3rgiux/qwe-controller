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
segs = []
prev = 0.0
for a, b in m:
    s = kf_le(a)
    if s > prev + 0.5: segs.append((prev, s))
    prev = max(prev, kf_ge(b))
if prev < dur - 0.5: segs.append((prev, dur))
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
else
  echo "[post] cutting + concat $SEGN segments"
  i=0; : > "$TMP/concat.txt"
  while IFS=$'\t' read -r S T; do
    i=$((i+1))
    if (( i == SEGN )); then
      ffmpeg -nostdin -v error -y -ss "$S" -i "$FILE" -c copy -movflags +faststart "$TMP/seg$i.mkv"
    else
      ffmpeg -nostdin -v error -y -ss "$S" -i "$FILE" -t "$T" -c copy "$TMP/seg$i.mkv"
    fi
    echo "file 'seg$i.mkv'" >> "$TMP/concat.txt"
  done < "$TMP/segments.tsv"
  ffmpeg -nostdin -v error -y -f concat -safe 0 -i "$TMP/concat.txt" -c copy -movflags +faststart "$OUT"
fi

echo "[post] output: $OUT ($(du -h "$OUT" | cut -f1), $(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT") s)"
echo "[post] MANDATORY re-scan (gate):"
python3 rescan_bright.py "$OUT" --cadence 2 --mean 100 --grab /tmp/grabs_post
echo "[post] analyze:"
python3 analyze_rec.py "$OUT" /tmp/analysis_post 2>&1 | tail -12
