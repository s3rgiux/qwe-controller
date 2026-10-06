#!/usr/bin/env python3
"""
rescan_bright.py — post-trim verification gate: find bright windows in a
full capture (the mandatory ad-free check).

After ANY trim (head/tail/mid), the runbook requires a full-file bright-window
re-scan before a file is called ad-free: the vision watch runs at 60 s
cadence and can miss a 30 s mid-roll (The Boys S1E1: ECOFLOW missed by the
vision pass, caught by this rescan).

Method: decode tiny grayscale frames at a fixed cadence with ffmpeg, flag
frames whose mean brightness exceeds a threshold, group consecutive hits
into candidate windows, and print them as [start, end] ranges. Every reported
window needs a visual confirm (frame grab) before trimming — bright film
content (day exteriors, white rooms) also triggers.

Usage:
  python3 rescan_bright.py <file> [--cadence 2] [--mean 100] [--gap 4]

  cadence   seconds between sampled frames (default 2)
  mean      brightness threshold on 0-255 (default 100)
  gap       max seconds of dim frames to bridge inside a window (default 4)

Output (stdout): one JSON line per window, then a summary line;
  {"start": 1589.0, "end": 1626.0, "frames": 19, "max_mean": 201.3}
exit code: 0 = no bright windows, 1 = windows found (caller must confirm), 2 = error
"""
import argparse
import json
import subprocess
import sys


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("file")
    ap.add_argument("--cadence", type=float, default=2.0)
    ap.add_argument("--mean", type=float, default=100.0)
    ap.add_argument("--gap", type=float, default=4.0)
    ap.add_argument("--width", type=int, default=32)
    ap.add_argument("--height", type=int, default=18)
    a = ap.parse_args()

    # 1x decode of tiny grayscale frames at cadence; rawvideo = trivial parse
    cmd = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-i", a.file,
        "-vf", f"fps=1/{a.cadence},scale={a.width}:{a.height},format=gray",
        "-f", "rawvideo", "-",
    ]
    p = subprocess.run(cmd, stdout=subprocess.PIPE)
    if p.returncode != 0:
        print(json.dumps({"error": "ffmpeg failed", "code": p.returncode}))
        return 2
    raw = p.stdout
    fsz = a.width * a.height
    n = len(raw) // fsz

    hits = []  # (frame_index, mean)
    for i in range(n):
        chunk = raw[i * fsz:(i + 1) * fsz]
        m = sum(chunk) / len(chunk)
        if m > a.mean:
            hits.append((i, m))

    # group into windows, bridging gaps up to --gap seconds
    windows = []
    cur = None
    for i, m in hits:
        t = i * a.cadence
        if cur and t - cur["end_t"] <= a.gap:
            cur["end_t"] = t
            cur["frames"] += 1
            cur["max_mean"] = max(cur["max_mean"], m)
        else:
            if cur:
                windows.append(cur)
            cur = {"start": t, "end_t": t, "frames": 1, "max_mean": m}
    if cur:
        windows.append(cur)

    for w in windows:
        out = {
            "start": round(w["start"], 1),
            "end": round(w["end_t"] + a.cadence, 1),
            "frames": w["frames"],
            "max_mean": round(w["max_mean"], 1),
        }
        print(json.dumps(out))
    print(json.dumps({
        "summary": "scanned",
        "file": a.file,
        "frames": n,
        "cadence": a.cadence,
        "threshold": a.mean,
        "bright_frames": len(hits),
        "windows": len(windows),
    }))
    return 1 if windows else 0


if __name__ == "__main__":
    sys.exit(main())
