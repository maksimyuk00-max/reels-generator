import uiautomator2 as u2
import time

d = u2.connect("AA7LMFKJI7PVNNGQ")
btn = d(resourceId="com.adguard.vpn:id/continue_button")
print(f"Continue exists: {btn.exists}")
if btn.exists:
    btn.click()
    print("clicked")
time.sleep(3)
print(f"Now: {d.app_current()}")
