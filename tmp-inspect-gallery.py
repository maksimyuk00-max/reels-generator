"""Open IG → + → POST → dump gallery UI to find multi-select button."""
import uiautomator2 as u2
import time, re

d = u2.connect("192.168.0.7:5555")
d.shell("svc power stayon true")
d.shell("input keyevent KEYCODE_WAKEUP"); time.sleep(0.5)
d.shell("wm dismiss-keyguard"); time.sleep(0.8)
d.shell("input keyevent KEYCODE_HOME"); time.sleep(0.6)

IG = "com.instagram.android"
d.app_stop(IG); time.sleep(1)
d.app_start(IG, use_monkey=True)

# Wait IG ready
for i in range(15):
    time.sleep(1)
    if d(resourceId=f"{IG}:id/tab_bar").exists: break

# Tap + (top-left coord)
w, h = d.window_size()
d.click(int(w * 0.061), int(h * 0.071))
time.sleep(2.5)

# Tap POST
post = d(resourceId=f"{IG}:id/cam_dest_feed")
if post.exists:
    post.click()
    print("POST tab tapped")
    time.sleep(2.5)
else:
    print("POST tab NOT FOUND")

# Dump gallery
xml = d.dump_hierarchy()
print(f"\nXML len: {len(xml)}")

# Find multi-select candidates
print("\n=== resource-id with 'multi' ===")
for m in re.finditer(r'resource-id="([^"]*multi[^"]*)"[^>]*', xml, re.IGNORECASE):
    print(f"  {m.group(0)[:200]}")

print("\n=== content-desc with 'multiple' or 'Select' ===")
for m in re.finditer(r'<node[^>]*content-desc="([^"]*(?:multiple|Select)[^"]*)"[^>]*', xml, re.IGNORECASE):
    rid_m = re.search(r'resource-id="([^"]*)"', m.group(0))
    b_m = re.search(r'bounds="([^"]*)"', m.group(0))
    clk_m = re.search(r'clickable="([^"]*)"', m.group(0))
    print(f"  desc={m.group(1)!r} rid={rid_m.group(1) if rid_m else ''} bounds={b_m.group(1) if b_m else ''} clk={clk_m.group(1) if clk_m else ''}")

print("\n=== Top area elements (y<400) з resource-id ===")
for m in re.finditer(r'<node\s+([^/>]*?)\s*/?>', xml):
    attrs = m.group(1)
    rid = re.search(r'resource-id="([^"]*)"', attrs)
    b = re.search(r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', attrs)
    clk = re.search(r'clickable="([^"]*)"', attrs)
    if not b or not rid or not rid.group(1).startswith(IG): continue
    x1, y1, x2, y2 = map(int, b.groups())
    if y1 > 400: continue
    if clk and clk.group(1) == 'true':
        desc = re.search(r'content-desc="([^"]*)"', attrs)
        print(f"  [{x1},{y1}][{x2},{y2}] rid={rid.group(1)} desc={desc.group(1) if desc else ''!r}")

with open("C:/claude code/reels-generator/tmp-gallery-ui.xml", "w", encoding="utf-8") as f:
    f.write(xml)
print("\nUI dump saved → tmp-gallery-ui.xml")
