#!/usr/bin/env python3
"""
Analyze a screen recording for the two failure modes:
  1. BLACK video  — frames dark / no motion
  2. SILENT audio — no RMS energy anywhere
Usage: python3 analyze_rec.py <file> <out_prefix>
"""
import subprocess, sys, os, json, struct
import numpy as np
from PIL import Image

f, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)

# ---------- probe ----------
probe = json.loads(subprocess.run(
    ['ffprobe', '-v', 'quiet', '-print_format', 'json', '-show_streams', '-show_format', f],
    capture_output=True, text=True).stdout)
dur = float(probe['format'].get('duration', 0))
vstreams = [s for s in probe['streams'] if s['codec_type'] == 'video']
astreams = [s for s in probe['streams'] if s['codec_type'] == 'audio']
print(f'file: {f}')
print(f'duration: {dur:.1f}s')
print(f'video: {[(s.get("codec_name"), s.get("width"), s.get("height")) for s in vstreams]}')
print(f'audio: {[(s.get("codec_name"), s.get("sample_rate"), s.get("channels")) for s in astreams]}')

# ---------- video: 1 frame every 30s ----------
subprocess.run(['ffmpeg', '-v', 'error', '-i', f, '-vf', 'fps=1/30',
                '-q:v', '2', f'{out}/frame_%03d.jpg', '-y'], check=True)
frames = sorted(g for g in os.listdir(out) if g.startswith('frame_'))
brightness, contrast, motion = [], [], []
for i, name in enumerate(frames):
    im = np.asarray(Image.open(os.path.join(out, name)).convert('L'), dtype=np.float32)
    brightness.append(im.mean())
    contrast.append(im.std())
    if i > 0:
        prev = np.asarray(Image.open(os.path.join(out, frames[i-1])).convert('L'), dtype=np.float32)
        motion.append(np.abs(im - prev).mean())

black_frac = sum(1 for b in brightness if b < 16) / max(len(brightness), 1)
motion_vals = motion if motion else [0]
static_frac = sum(1 for m in motion_vals if m < 2.0) / len(motion_vals)

print(f'\nVIDEO ({len(frames)} sampled frames, 30s apart):')
print(f'  brightness mean/min/max: {np.mean(brightness):.1f} / {min(brightness):.1f} / {max(brightness):.1f}')
print(f'  black frames (mean<16):  {sum(1 for b in brightness if b < 16)}/{len(frames)}  ({black_frac:.0%})')
print(f'  inter-frame motion (mean abs diff between consecutive samples):')
print(f'    mean {np.mean(motion_vals):.2f} | min {min(motion_vals):.2f} | max {max(motion_vals):.2f}')
print(f'  near-static samples (diff<2.0): {sum(1 for m in motion_vals if m < 2.0)}/{len(motion_vals)}')
video_ok = (black_frac < 0.5) and (np.mean(brightness) > 20) and (np.mean(motion_vals) > 2.0)
print(f'  VIDEO OK: {video_ok}')

# ---------- audio: RMS per 30s window ----------
audio_ok = False
if astreams:
    raw = subprocess.run(
        ['ffmpeg', '-v', 'error', '-i', f, '-vn', '-ac', '1', '-ar', '16000', '-f', 's16le', '-'],
        capture_output=True).stdout
    a = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    win = 16000 * 30
    rms = []
    peak = 0.0
    for i in range(0, len(a), win):
        seg = a[i:i+win]
        r = float(np.sqrt(np.mean(seg**2))) if len(seg) else 0.0
        rms.append(r)
        peak = max(peak, float(np.max(np.abs(seg))) if len(seg) else 0)
    db = lambda x: 20*np.log10(x + 1e-9)
    print(f'\nAUDIO ({len(a)/16000:.1f}s decoded, 30s windows):')
    for i, r in enumerate(rms):
        bar = '#' * int(max(0, min(40, (db(r) + 60) / 60 * 40)))
        print(f'  {i*30:4d}-{i*30+30:4d}s  {db(r):7.1f} dBFS  {bar}')
    loud_frac = sum(1 for r in rms if db(r) > -45) / max(len(rms), 1)
    print(f'  overall peak: {db(peak):.1f} dBFS | windows louder than -45 dBFS: {sum(1 for r in rms if db(r) > -45)}/{len(rms)} ({loud_frac:.0%})')
    audio_ok = loud_frac > 0.5 and peak > 0.01
    print(f'  AUDIO OK: {audio_ok}')
else:
    print('\nAUDIO: NO AUDIO STREAM IN FILE')

print(f'\n=== VERDICT: video={"OK" if video_ok else "BAD"} audio={"OK" if audio_ok else "BAD"} ===')
