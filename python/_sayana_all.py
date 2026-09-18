from playwright.sync_api import sync_playwright
import time

# Post codes seen earlier + profile
posts = ["DUBWmJXFK5r","DcpMVXNESBo","DcpjvYKAP0l","DcpwmaZgAuf","DckqzrQj5BI","Dckq0w4j9mu","DckPVP-AdAI","DcjRllVjim_","Dcgzo4CjX-t","DcgswJeiLxI","Dcge96HDwv0","DcfFyS4E4c-","DcexI4BCaJD","DceVtMCDtp4","DcdcKFpEeBH","DcdcKxoEVce","DcdcLXWEYBu","DcbdtLTkdm7"]
with sync_playwright() as p:
    b = p.chromium.launch(headless=True, args=["--disable-blink-features=AutomationControlled"])
    ctx = b.new_context(user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36", locale="en-US")
    page = ctx.new_page()
    results = []
    for pid in posts:
        try:
            page.goto(f"https://www.threads.net/@sayana.meansmillion/post/{pid}", timeout=40000, wait_until="domcontentloaded")
            page.wait_for_timeout(3000)
            txt = page.evaluate("document.body.innerText")
            # Parse: first line has views, then post text, then engagement numbers (likes, comments, reposts/quote)
            lines = [l.strip() for l in txt.split("\n") if l.strip()]
            # Find engagement: after post text, numbers appear. Strategy: capture the block
            # The post text is between "sayana.meansmillion" and the first comment "xxx | time"
            # Engagement numbers typically the 3-4 numbers right after the post text before first username
            first = txt[:1600].replace("\n", " | ")
            results.append((pid, first[:450]))
        except Exception as e:
            results.append((pid, f"ERR {e}"))
    for pid, r in results:
        print(f"\n[{pid}] {r}")
    b.close()
