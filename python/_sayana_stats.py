from playwright.sync_api import sync_playwright
import re, time

with sync_playwright() as p:
    b = p.chromium.launch(headless=True, args=["--disable-blink-features=AutomationControlled"])
    ctx = b.new_context(user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36", locale="en-US")
    page = ctx.new_page()
    page.goto("https://www.threads.net/@sayana.meansmillion", timeout=45000, wait_until="domcontentloaded")
    page.wait_for_timeout(6000)
    all_text = []
    for _ in range(25):
        page.mouse.wheel(0, 3000)
        page.wait_for_timeout(1400)
        all_text.append(page.evaluate("document.body.innerText"))
    txt = max(all_text, key=len)
    print("LEN:", len(txt))
    print("=== FULL ===")
    print(txt[2500:9500])
    b.close()
