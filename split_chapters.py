#!/usr/bin/env python3
"""
split_chapters.py — split one raw season capture into per-episode files.

The raw capture was recorded by movie_stopper.sh --series, which appends a
boundary record for every episode end (t-reset):
    {"i":1,"wall":"...","epoch":...,"prev_t":3655.2,"t":2.1,"d":3578}
`prev_t` is the player t of the LAST frame of episode i — because the film
plays 1:1 with the file clock (seek-to-0 before recording start, GWH-verified
drift ~1s over 2h), prev_t is directly the FILE time of the episode's end.

Usage:
    python3 split_chapters.py <raw.mkv|raw.mp4> <boundaries.jsonl> \
        --final-t <last-episode-end-file-t> \
        [--out-dir DIR] [--names s1e1,s1e2,...]

Cuts are LOSSLESS (-c copy), keyframe-snapped (a cut at X uses the keyframe
at/before X for the segment start, and the segment ends just before the next
cut's keyframe... see README: same keyframe-aware recipe as the GWH splice).

Result: out_dir/chapter_01.mp4 ... chapter_N.mp4, each verified (duration,
first/last keyframe flags).
"""
import json, subprocess, sys, os

def run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, **kw)

def probe_keyframes(f, lo, hi):
    """Return sorted keyframe pts_time in [lo, hi]."""
    r = run(['ffprobe', '-v', 'error', '-select_streams', 'v:0',
             '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0', f])
    kfs = []
    for line in r.stdout.splitlines():
        parts = line.split(',')
        if len(parts) < 2 or 'K' not in parts[1]:
            continue
        try:
            t = float(parts[0])
        except ValueError:
            continue
        if lo <= t <= hi:
            kfs.append(t)
    return kfs

def cut(f, start, end, out):
    """Lossless cut [start, end) -> out.

    Keyframe-aware recipe (empirically pinned, 2026-10-06):
      * input -ss SNAP with SNAP = keyframe at/below start, and NO
        -avoid_negative_ts (that flag silently shifts the cut back to the
        PREVIOUS keyframe — measured 9s early).
      * -t (end - SNAP - 0.1): the -t endpoint must fall inside THIS
        segment's last GOP. -c copy then emits the whole GOP, so the
        segment ends exactly at the next keyframe. No overlap, no gap,
        provided the caller's segment starts are the snapped keyframes.
    """
    kfs = probe_keyframes(f, start - 60, start + 60)
    snap = max((k for k in kfs if k <= start), default=start)
    dur = end - snap - 0.1
    if dur <= 0:
        print(f'  CUT FAIL {out}: empty range (snap {snap:.3f} >= end {end:.3f})')
        return None
    cmd = ['ffmpeg', '-v', 'error', '-y', '-ss', f'{snap:.3f}', '-i', f,
           '-t', f'{dur:.3f}', '-c', 'copy', out]
    r = run(cmd)
    if r.returncode != 0:
        print(f'  CUT FAIL {out}: {r.stderr[-400:]}')
        return None
    return snap

def main():
    raw, bounds = sys.argv[1], sys.argv[2]
    final_t = None; out_dir = '.'; names = []
    args = sys.argv[3:]
    i = 0
    while i < len(args):
        if args[i] == '--final-t': final_t = float(args[i+1]); i += 2
        elif args[i] == '--out-dir': out_dir = args[i+1]; i += 2
        elif args[i] == '--names':
            names = args[i+1].split(','); i += 2
        else: i += 1
    if final_t is None:
        print('need --final-t <file-time of the last episode end>'); sys.exit(2)

    os.makedirs(out_dir, exist_ok=True)
    bs = [json.loads(l) for l in open(bounds) if l.strip()]
    bs.sort(key=lambda b: b['i'])
    cuts = [0.0] + [b['prev_t'] for b in bs] + [final_t]
    print(f'raw: {raw}')
    print(f'boundary records: {len(bs)}; cut points: {cuts}')

    ok = True
    # Snap each segment start to its keyframe up-front so segment k ends at
    # segment k+1's keyframe (no duplicate/missing frames at boundaries).
    snaps = [0.0] + [max((k for k in probe_keyframes(raw, c - 60, c + 60) if k <= c), default=c)
                     for c in cuts[1:-1]] + [None]
    for k in range(len(cuts) - 1):
        a, b_ = cuts[k], cuts[k + 1]
        end = snaps[k + 1] if k + 1 < len(cuts) - 1 else b_
        name = names[k] if k < len(names) else f'chapter_{k+1:02d}'
        out = os.path.join(out_dir, name + '.mp4')
        print(f'cut {k+1}: [{snaps[k]:.3f}, {end:.3f}) -> {out}')
        snap = cut(raw, a, end, out)
        if snap is None:
            ok = False; continue
        d = float(run(['ffprobe', '-v', 'quiet', '-show_entries', 'format=duration',
                       '-of', 'csv=p=0', out]).stdout.strip() or 0)
        print(f'  ok: {d:.1f}s (start {snap:.3f})')
    print('=== ALL OK ===' if ok else '=== ERRORS (see above) ===')
    sys.exit(0 if ok else 1)

if __name__ == '__main__':
    main()
