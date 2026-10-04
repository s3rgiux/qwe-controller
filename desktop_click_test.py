#!/usr/bin/env python3
"""
Closed-loop PC-control test on X display :1.
1. Open a window titled QWEN-CLICK-TEST with a big RED and a big BLUE button.
2. Screenshot the whole desktop and ask Qwen3.5-2B where the RED button center is (0-1000 coords).
3. Synthesize a real X click at that point via XTEST.
4. The window's event loop records which button was hit.
"""
import json, base64, sys, time, urllib.request
from Xlib import display, X
from Xlib.ext import xtest
from PIL import Image

LLM = 'http://127.0.0.1:8086/v1/chat/completions'
DWIDTH, DHEIGHT = 2560, 1440

def ask_qwen(messages, max_tokens=300):
    body = json.dumps({'model': 'Qwen3.52B', 'messages': messages,
                       'temperature': 0.0, 'max_tokens': max_tokens}).encode()
    req = urllib.request.Request(LLM, data=body, headers={'Content-Type': 'application/json'})
    return json.load(urllib.request.urlopen(req, timeout=180))['choices'][0]['message']['content']

d = display.Display(':1')
root = d.screen().root
screen = d.screen()

# ---- 1. create the test window ----
WX, WY, WW, WH = 1080, 600, 480, 240
RED_RECT = (20, 50, 200, 150)   # x,y,w,h inside window
BLUE_RECT = (260, 50, 200, 150)

def draw(w, gc_w, gc_red, gc_blue, gc_text):
    w.clear_area()
    w.fill_rectangle(gc_red, RED_RECT[0], RED_RECT[1], RED_RECT[2], RED_RECT[3])
    w.fill_rectangle(gc_blue, BLUE_RECT[0], BLUE_RECT[1], BLUE_RECT[2], BLUE_RECT[3])
    w.poly_text(gc_text, RED_RECT[0]+45, RED_RECT[1]+65, 'RED')
    w.poly_text(gc_text, BLUE_RECT[0]+40, BLUE_RECT[1]+65, 'BLUE')
    w.poly_text(gc_text, 90, 20, 'QWEN-CLICK-TEST')

# override_redirect=True: bypass the WM so the window stays exactly at (WX,WY)
w = root.create_window(WX, WY, WW, WH, 0, screen.root_depth, X.InputOutput, X.CopyFromParent,
                       background_pixel=0x202020,
                       override_redirect=True,
                       event_mask=X.ExposureMask | X.ButtonPressMask | X.StructureNotifyMask | X.PropertyChangeMask)
w.map()
d.flush()

gc_w = w.create_gc()
gc_red = w.create_gc(foreground=0xE53935)
gc_blue = w.create_gc(foreground=0x1E88E5)
f = d.open_font('fixed')
gc_text = w.create_gc(foreground=0xFFFFFF, font=f)

# pump events; draw on every expose until we've drawn at least twice (map can race)
draws = 0
t_end = time.time() + 5
while draws < 2 and time.time() < t_end:
    while d.pending_events():
        ev = d.next_event()
        if ev.type == X.Expose:
            draw(w, gc_w, gc_red, gc_blue, gc_text)
            d.flush()
            draws += 1
    time.sleep(0.1)
if draws == 0:
    draw(w, gc_w, gc_red, gc_blue, gc_text)
    d.flush()
time.sleep(0.8)
draw(w, gc_w, gc_red, gc_blue, gc_text)
d.flush()

# ---- 2. screenshot the whole desktop, ask Qwen for the RED button ----
root2 = root
geo = root.get_geometry()
img = root.get_image(0, 0, geo.width, geo.height, X.ZPixmap, 0xFFFFFFFF)
data = img.data if isinstance(img.data, bytes) else img.data.encode('latin1')
Image.frombytes('RGBA', (geo.width, geo.height), data, 'raw', 'BGRA').save('desktop_click.png')
b64 = base64.b64encode(open('desktop_click.png', 'rb').read()).decode()

answer = ask_qwen([
    {'role': 'system', 'content': 'You are a computer-use agent. You see a full desktop screenshot. '
     'Find the window titled QWEN-CLICK-TEST. It contains a big RED button and a big BLUE button. '
     'Reply with ONLY JSON: {"x":<int>,"y":<int>} = the CENTER of the RED button, in normalized 0-1000 image coordinates.'},
    {'role': 'user', 'content': [
        {'type': 'text', 'text': 'Give the center of the RED button in the QWEN-CLICK-TEST window.'},
        {'type': 'image_url', 'image_url': {'url': 'data:image/png;base64,' + b64}},
    ]},
])
print('Qwen answered:', answer.strip())
import re
import json as _json
dec = _json.JSONDecoder()
s = answer[answer.index('{'):]
obj, _ = dec.raw_decode(s)  # parse first JSON object only
def to_num(v):
    return float(v) if isinstance(v, (int, float)) or (isinstance(v, str) and v.strip().isdigit()) else None
if isinstance(obj['x'], list) and len(obj['x']) >= 2:
    cx, cy = obj['x'][0], obj['x'][1]
else:
    cx, cy = obj['x'], obj.get('y')
px = round(to_num(cx) / 1000 * geo.width)
py = round(to_num(cy) / 1000 * geo.height)
print(f'-> click target px ({px}, {py})  [display {geo.width}x{geo.height}]')

# ground truth: where the red button actually is
win_geo = w.get_geometry()
red_cx = win_geo.x + RED_RECT[0] + RED_RECT[2] // 2
red_cy = win_geo.y + RED_RECT[1] + RED_RECT[3] // 2
blue_cx = win_geo.x + BLUE_RECT[0] + BLUE_RECT[2] // 2
print(f'ground truth: window at ({win_geo.x},{win_geo.y}) red_center=({red_cx},{red_cy}) blue_center=({blue_cx},{red_cy})')

# ---- 3. synthesize the click via XTEST ----
xtest.fake_input(d, X.MotionNotify, x=px, y=py)   # move the pointer first
d.flush()
time.sleep(0.15)
xtest.fake_input(d, X.ButtonPress, detail=1, x=px, y=py)
d.flush()
time.sleep(0.1)
xtest.fake_input(d, X.ButtonRelease, detail=1, x=px, y=py)
d.flush()
print('XTEST click sent')

# ---- 4. event pump: which button was hit? ----
hit = None
t_end = time.time() + 15
while time.time() < t_end and hit is None:
    while d.pending_events():
        ev = d.next_event()
        if ev.type == X.ButtonPress and ev.window == w:
            lx, ly = ev.event_x, ev.event_y
            def inside(r, x, y): return r[0] <= x < r[0]+r[2] and r[1] <= y < r[1]+r[3]
            if inside(RED_RECT, lx, ly):
                hit = f'RED (local {lx},{ly})'
            elif inside(BLUE_RECT, lx, ly):
                hit = f'BLUE (local {lx},{ly})'
            else:
                hit = f'window background (local {lx},{ly})'
    time.sleep(0.1)
w.destroy()
d.flush()
print(f'\nRESULT: click landed on {hit}')
print('SUCCESS: %s' % (hit is not None and hit.startswith('RED')))
sys.exit(0 if (hit and hit.startswith('RED')) else 1)
