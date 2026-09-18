from playwright.sync_api import sync_playwright
import time

with sync_playwright() as p:
    b = p.chromium.launch(headless=True, args=["--disable-blink-features=AutomationControlled"])
    ctx = b.new_context(user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36", locale="en-US")
    page = ctx.new_page()
    page.goto("https://www.threads.net/@sayana.meansmillion", timeout=45000, wait_until="domcontentloaded")
    page.wait_for_timeout(6000)
    # Scroll aggressively and collect all post links
    all_links = set()
    for _ in range(30):
        page.mouse.wheel(0, 3500)
        page.wait_for_timeout(1500)
        links = page.evaluate("Array.from(document.querySelectorAll('a[href*=\"/post/\"]')).map(a=>a.getAttribute('href'))")
        for l in links:
            if not l.endswith('/media'):
                all_links.add(l)
    print("UNIQUE POST LINKS:", len(all_links))
    for l in sorted(all_links):
        print(l)
    b.close()
