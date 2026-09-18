from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    b = p.chromium.connect_over_cdp("http://127.0.0.1:9223")
    ctx = b.contexts[0]
    flow = ctx.pages[0]
    flow.wait_for_timeout(1000)
    print("URL:", flow.url)
    # Check if there's a reference image attached in the composer (input area)
    # Look for any image near the prompt input / attached reference
    info = flow.evaluate("""() => {
        const ce = document.querySelector('[contenteditable=true]');
        if(!ce) return 'no composer';
        // walk up to composer container
        let el = ce, container = null;
        for(let i=0;i<6;i++){ el=el.parentElement; if(el && el.querySelectorAll('img').length>0){ container=el; break; } }
        if(!container) return 'no img in composer';
        const imgs = Array.from(container.querySelectorAll('img')).map(i=>({src:(i.src||'').substring(0,80), w:i.width}));
        return imgs;
    }""")
    print("COMPOSER IMGS:", info)
    flow.screenshot(path=r"C:\Users\Admin\AppData\Local\Temp\flow_check_ref.png")
    b.close()
