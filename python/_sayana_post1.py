from playwright.sync_api import sync_playwright
import time

with sync_playwright() as p:
    b = p.chromium.launch(headless=True, args=["--disable-blink-features=AutomationControlled"])
    ctx = b.new_context(user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36", locale="en-US")
    page = ctx.new_page()
    page.goto("https://www.threads.net/@sayana.meansmillion/post/Dcowd0ID4iB", timeout=45000, wait_until="domcontentloaded")
    page.wait_for_timeout(5000)
    for _ in range(4):
        page.mouse.wheel(0, 1800)
        page.wait_for_timeout(1200)
    txt = page.evaluate("document.body.innerText")
    print("=== FULL POST ===")
    print(txt[:3000])
    b.close()
