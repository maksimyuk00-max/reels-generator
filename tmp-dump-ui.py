"""Keep screen awake, fully unlock, launch IG, dump."""
import uiautomator2 as u2
import re
import time

d = u2.connect("192.168.0.7:5555")

# Keep screen on
d.shell("svc power stayon true")
d.shell("input keyevent KEYCODE_WAKEUP")
time.sleep(0.5)

# Ensure unlocked — swipe up to dismiss lockscreen (if no PIN)
d.shell("wm dismiss-keyguard")
time.sleep(0.8)
# Also press HOME to get to launcher (if not unlocked yet)
d.shell("input keyevent KEYCODE_HOME")
time.sleep(1)
# Check we're NOT on keyguard
cur = d.app_current()
print(f"After unlock: {cur}")

# Launch IG cold
d.app_stop("com.instagram.android")
time.sleep(1)
d.app_start("com.instagram.android", use_monkey=True)
# Wait for IG to actually render
for i in range(15):
    time.sleep(1)
    cur = d.app_current()
    if cur.get("package") == "com.instagram.android":
        # Wait extra 2s for UI to settle
        time.sleep(2)
        break

cur = d.app_current()
print(f"Before dump: {cur}")

xml = d.dump_hierarchy()
w, h = d.window_size()
print(f"Screen: {w}x{h}, XML: {len(xml)}")

# Save for inspection
with open("C:/claude code/reels-generator/tmp-ig-ui.xml", "w", encoding="utf-8") as f:
    f.write(xml)

def iter_nodes(xml):
    for m in re.finditer(r'<node\s+([^/>]*?)\s*/?>', xml):
        attrs = m.group(1)
        b = re.search(r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', attrs)
        if not b:
            continue
        x1, y1, x2, y2 = map(int, b.groups())
        def get(key):
            m2 = re.search(rf'{key}="([^"]*)"', attrs)
            return m2.group(1) if m2 else ""
        yield {
            "bounds": (x1, y1, x2, y2),
            "rid": get("resource-id"),
            "desc": get("content-desc"),
            "cls": get("class"),
            "text": get("text"),
            "clickable": get("clickable"),
        }

print(f"\n=== Top-left (y<300, x<400) ===")
for n in iter_nodes(xml):
    x1, y1, x2, y2 = n["bounds"]
    if y1 < 300 and x1 < 400:
        cls = n["cls"].split(".")[-1]
        mark = " *CLK*" if n["clickable"] == "true" else ""
        print(f"  [{x1},{y1}][{x2},{y2}] rid={n['rid']!r} desc={n['desc']!r} cls={cls}{mark}")

print(f"\n=== BOTTOM (y>1800) ===")
for n in iter_nodes(xml):
    x1, y1, x2, y2 = n["bounds"]
    if y1 > 1800:
        cls = n["cls"].split(".")[-1]
        mark = " *CLK*" if n["clickable"] == "true" else ""
        if n["rid"] or n["desc"] or n["clickable"]=="true":
            print(f"  [{x1},{y1}][{x2},{y2}] rid={n['rid']!r} desc={n['desc']!r} cls={cls}{mark}")

print(f"\n=== ANY with 'create'/'plus'/'new'/'compose' in rid/desc ===")
for n in iter_nodes(xml):
    s = (n["rid"] + " " + n["desc"]).lower()
    if any(k in s for k in ["create", "new_post", "plus", "compose", "reel"]):
        print(f"  [{n['bounds']}] rid={n['rid']!r} desc={n['desc']!r}")
