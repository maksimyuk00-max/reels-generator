from playwright.sync_api import sync_playwright
import time

posts = ["DcpMVXNESBo", "DcpjvYKAP0l", "DcpwmaZgAuf"]
with sync_playwright() as p:
    b = p.chromium.launch(headless=True, args=["--disable-blink-features=AutomationControlled"])
    ctx = b.new_context(user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36", locale="en-US")
    page = ctx.new_page()
    for pid in posts:
        try:
            page.goto(f"https://www.threads.net/@sayana.meansmillion/post/{pid}", timeout=45000, wait_until="domcontentloaded")
            page.wait_for_timeout(4000)
            for _ in range(4):
                page.mouse.wheel(0, 1500)
                page.wait_for_timeout(1000)
            txt = page.evaluate("document.body.innerText")
            # Print first 800 chars (post title + engagement numbers) and look at comment area
            print(f"\n===== {pid} =====")
            print(txt[:1100].replace("\n", " | ")[:1100])
        except Exception as e:
            print(f"{pid} err: {e}")
    b.close()
