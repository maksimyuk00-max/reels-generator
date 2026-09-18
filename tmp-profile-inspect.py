"""Test _read_active_username_via_profile directly."""
import sys
sys.path.insert(0, 'C:/claude code/reels-generator/python')
import uiautomator2 as u2
import time

d = u2.connect("192.168.0.7:5555")
d.shell("svc power stayon true")
d.shell("input keyevent KEYCODE_WAKEUP")
time.sleep(0.4)
d.shell("wm dismiss-keyguard")
time.sleep(0.8)
d.shell("input keyevent KEYCODE_HOME")
time.sleep(0.6)

d.app_stop("com.instagram.android")
time.sleep(1)
d.app_start("com.instagram.android", use_monkey=True)

# Wait for IG ready
for i in range(15):
    time.sleep(1)
    if d(resourceId="com.instagram.android:id/tab_bar").exists:
        break

from posting_v2 import _read_active_username_via_profile
result = _read_active_username_via_profile(d)
print(f"Active username: {result!r}")
