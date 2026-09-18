"""Click checkboxes + Continue."""
import uiautomator2 as u2
import time

d = u2.connect("AA7LMFKJI7PVNNGQ")
time.sleep(1)

# Try clicking via uiautomator2 (uses UIAutomator service, not 'input' shell cmd)
print("Click policy checkbox...")
try:
    boxes = d(resourceId="com.adguard.vpn:id/check_box")
    print(f"  found {boxes.count} checkboxes")
    for i in range(boxes.count):
        boxes[i].click()
        print(f"  clicked #{i}")
        time.sleep(0.4)
except Exception as e:
    print(f"  fail: {e}")

time.sleep(1)
print("\nClick Continue...")
try:
    btn = d(resourceId="com.adguard.vpn:id/continue_button")
    if btn.exists:
        btn.click()
        print("  clicked")
    else:
        print("  not found")
except Exception as e:
    print(f"  fail: {e}")

time.sleep(3)
cur = d.app_current()
print(f"\nNow: {cur}")
