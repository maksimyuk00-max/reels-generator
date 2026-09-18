"""
Google Flow automation via Playwright.
Використовує окремий Chrome профіль (automation-profile) щоб не конфліктувати з основним Chrome.
Перший запуск: користувач логіниться вручну. Далі — автоматично.
"""
import os
import sys
import time
import asyncio
import tempfile
import subprocess

# Fix Windows console encoding for print statements
if sys.stdout and hasattr(sys.stdout, 'reconfigure'):
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

OUTPUT_DIR    = os.path.join(tempfile.gettempdir(), "reels-generator")

# Файловий лог для дебагу
_LOG_FILE = os.path.join(OUTPUT_DIR, "flow_log.txt")

def _log(msg: str):
    print(msg, flush=True)
    try:
        os.makedirs(OUTPUT_DIR, exist_ok=True)
        with open(_LOG_FILE, "a", encoding="utf-8") as f:
            f.write(f"[{time.strftime('%H:%M:%S')}] {msg}\n")
            f.flush()
    except Exception:
        pass
AUTO_PROFILE  = os.path.join(os.path.expanduser("~"), "reels-flow-profile")
FLOW_URL      = "https://labs.google/fx/uk/tools/flow"
DEBUG_PORT    = 9223  # окремий порт щоб не заважати основному Chrome

os.makedirs(OUTPUT_DIR, exist_ok=True)
os.makedirs(AUTO_PROFILE, exist_ok=True)


def _find_chrome() -> str:
    for p in [
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        os.path.expanduser(r"~\AppData\Local\Google\Chrome\Application\chrome.exe"),
    ]:
        if os.path.exists(p):
            return p
    return "chrome"


def _is_debug_running() -> bool:
    import urllib.request
    try:
        urllib.request.urlopen(f"http://127.0.0.1:{DEBUG_PORT}/json", timeout=2)
        return True
    except Exception:
        return False


def setup_profile() -> dict:
    """Відкриває Chrome з automation-профілем для одноразового логіну."""
    if _is_debug_running():
        return {"ok": True, "message": "Chrome вже запущений з профілем автоматизації"}
    chrome = _find_chrome()
    cmd = [
        chrome,
        f"--remote-debugging-port={DEBUG_PORT}",
        f"--user-data-dir={AUTO_PROFILE}",
        "--no-first-run",
        "--no-default-browser-check",
        FLOW_URL,
    ]
    subprocess.Popen(cmd)
    return {
        "ok": True,
        "message": (
            "Chrome відкрито з профілем автоматизації.\n"
            "1. Залогінься в Google\n"
            "2. Відкрий labs.google/fx\n"
            "3. НЕ закривай цей Chrome\n"
            "4. Тепер можна генерувати"
        )
    }


async def _apply_settings(page, aspect: str = "9:16") -> None:
    """Відкриває панель налаштувань і виставляє aspect, x1, Nano Banana Pro.

    aspect: '9:16' (default для Reels) або '1:1' (для Post/Carousel)

    UI структура (перевірено):
    - Кнопка "🍌 Nano Banana Pro x1" відкриває панель
    - Панель містить табби: 16:9 | 4:3 | 1:1 | 3:4 | 9:16  (role=tab)
    - Кнопки кількості: x1 | x2 | x3 | x4
    - Дропдаун моделі: Nano Banana Pro
    """
    # --- Відкриваємо панель ---
    settings_btn = None
    for txt in ["Nano Banana", "nano banana"]:
        try:
            el = page.locator("button").filter(has_text=txt).first
            if await el.is_visible(timeout=2000):
                settings_btn = el
                _log(f"[Flow] Знайдено кнопку налаштувань: '{txt}'")
                break
        except Exception:
            continue

    if not settings_btn:
        _log("[Flow] Кнопку налаштувань не знайдено — пропускаємо")
        return

    await settings_btn.click()
    await page.wait_for_timeout(800)

    # --- Aspect ratio (role=tab) — динамічно з параметра ---
    try:
        btn_aspect = page.locator("[role='tab']").filter(has_text=aspect).first
        if await btn_aspect.is_visible(timeout=2000):
            await btn_aspect.click()
            _log(f"[Flow] OK {aspect} вибрано")
            await page.wait_for_timeout(300)
        else:
            # Fallback: звичайна кнопка
            btn_aspect = page.locator("button").filter(has_text=aspect).first
            if await btn_aspect.is_visible(timeout=1000):
                await btn_aspect.click()
                _log(f"[Flow] OK {aspect} вибрано (fallback)")
                await page.wait_for_timeout(300)
    except Exception as e:
        _log(f"[Flow] 9:16 не знайдено: {e}")

    # --- Count x1 ---
    try:
        btn_x1 = page.locator("[role='tab']").filter(has_text="x1").first
        if not await btn_x1.is_visible(timeout=1000):
            btn_x1 = page.locator("button").filter(has_text="x1").first
        if await btn_x1.is_visible(timeout=1000):
            await btn_x1.click()
            _log("[Flow] OK x1 вибрано")
            await page.wait_for_timeout(300)
    except Exception as e:
        _log(f"[Flow] x1 не знайдено: {e}")

    # --- Закриваємо панель клікнувши поза нею ---
    try:
        await page.keyboard.press("Escape")
        await page.wait_for_timeout(400)
    except Exception:
        pass

    _log("[Flow] Налаштування застосовано: 9:16, x1, Nano Banana Pro")


async def _generate_async(prompt: str, project_url: str = None, aspect: str = "9:16") -> dict:
    """
    Алгоритм:
    1. Відкрити Flow
    2. Перевірити налаштування (9:16, Nano Banana)
    3. Вставити промпт
    4. Запустити генерацію
    5. Чекати 30 секунд
    6. Клікнути по крайній генерації (перший thumbnail)
    7. Натиснути Download → 1K
    8. Чекати 10 секунд
    9. Забрати файл із папки Завантаження
    """
    from playwright.async_api import async_playwright

    target_url = project_url if project_url else FLOW_URL
    downloads_dir = os.path.join(os.path.expanduser("~"), "Downloads")
    dbg = os.path.join(OUTPUT_DIR, "flow_debug.png")

    # Запускаємо Chrome якщо не запущений
    if not _is_debug_running():
        chrome = _find_chrome()
        subprocess.Popen([
            chrome,
            f"--remote-debugging-port={DEBUG_PORT}",
            f"--user-data-dir={AUTO_PROFILE}",
            "--no-first-run",
            "--no-default-browser-check",
            target_url,
        ])
        for _ in range(30):
            if _is_debug_running():
                break
            await asyncio.sleep(0.5)
        else:
            return {"ok": False, "error": "Chrome не вдалось запустити"}
        await asyncio.sleep(2)

    async with async_playwright() as pw:
        try:
            browser = await pw.chromium.connect_over_cdp(f"http://127.0.0.1:{DEBUG_PORT}")
        except Exception as e:
            return {"ok": False, "error": f"Не вдалось підключитись до Chrome: {e}"}

        ctx = browser.contexts[0] if browser.contexts else None
        if not ctx:
            return {"ok": False, "error": "Немає активного контексту Chrome"}

        flow_page = None
        for page in ctx.pages:
            if "labs.google" in page.url:
                flow_page = page
                break
        if not flow_page:
            flow_page = await ctx.new_page()

        await flow_page.bring_to_front()

        # ===== 1. ВІДКРИВАЄМО FLOW =====
        cur = flow_page.url
        if target_url not in cur:
            await flow_page.goto(target_url, wait_until="domcontentloaded", timeout=30000)

        # Чекаємо SPA
        _log("[Flow] Чекаємо завантаження UI...")
        for _ in range(20):
            await flow_page.wait_for_timeout(1500)
            try:
                el = flow_page.locator('div[contenteditable="true"], textarea, [aria-label*="prompt" i], [aria-label*="Надіслати"]').first
                if await el.is_visible(timeout=800):
                    _log("[Flow] UI завантажено")
                    break
            except Exception:
                pass

        cur = flow_page.url
        _log(f"[Flow] URL: {cur}")

        if "accounts.google.com" in cur or "signin" in cur:
            return {"ok": False, "error": "Потрібен логін. Натисни 'Відкрити Flow браузер' в налаштуваннях."}

        # ===== 2. НАЛАШТУВАННЯ =====
        await _apply_settings(flow_page, aspect=aspect)
        await flow_page.wait_for_timeout(1000)

        # ===== 3. ВСТАВЛЯЄМО ПРОМПТ =====
        prompt_input = None
        for sel in [
            'div[contenteditable="true"][role="textbox"]',
            'div[contenteditable="true"]',
            'textarea[placeholder*="Describe" i]',
            'textarea[placeholder*="prompt" i]',
            'textarea[placeholder*="Type" i]',
            'textarea',
        ]:
            try:
                el = flow_page.locator(sel).first
                if await el.is_visible(timeout=2000):
                    prompt_input = el
                    _log(f"[Flow] Промпт поле: {sel}")
                    break
            except Exception:
                continue

        if not prompt_input:
            await flow_page.screenshot(path=dbg)
            return {"ok": False, "error": f"Не знайдено поле промпту. URL: {flow_page.url}. Debug: {dbg}"}

        await prompt_input.click()
        await flow_page.keyboard.press("Control+a")
        await flow_page.keyboard.press("Delete")
        await flow_page.wait_for_timeout(200)
        await prompt_input.fill(prompt)
        await flow_page.wait_for_timeout(300)
        _log(f"[Flow] Промпт введено: {prompt[:80]}...")

        # ===== 4. КНОПКА ГЕНЕРАЦІЇ =====
        gen_btn = None
        for sel in [
            'button:has-text("arrow_forward")',
            'button[aria-label*="Submit" i]',
            'button[aria-label*="Надіслати" i]',
            'button[aria-label*="Generate" i]',
            'button:has-text("Надіслати")',
        ]:
            try:
                el = flow_page.locator(sel).first
                if await el.is_visible(timeout=2000):
                    gen_btn = el
                    _log(f"[Flow] Кнопка генерації: {sel}")
                    break
            except Exception:
                continue

        # Fallback — остання кнопка поруч з полем
        if not gen_btn:
            try:
                all_btns = flow_page.locator("button")
                cnt = await all_btns.count()
                if cnt > 0:
                    gen_btn = all_btns.nth(cnt - 1)
                    _log("[Flow] Кнопка генерації — остання на сторінці")
            except Exception:
                pass

        if not gen_btn:
            await flow_page.screenshot(path=dbg)
            return {"ok": False, "error": f"Не знайдено кнопку Generate. Debug: {dbg}"}

        # Запам'ятовуємо поточні thumbnails перед генерацією
        before_imgs = set()
        try:
            imgs_before = flow_page.locator("img[src*='getMediaUrlRedirect']")
            cnt = await imgs_before.count()
            for i in range(cnt):
                src = await imgs_before.nth(i).get_attribute("src") or ""
                before_imgs.add(src)
            _log(f"[Flow] Thumbnails до генерації: {cnt}")
        except Exception:
            pass

        # ===== 4. ЗАПУСКАЄМО ГЕНЕРАЦІЮ =====
        await gen_btn.click()
        _log("[Flow] >> Генерація запущена!")

        # ===== 5. ЧЕКАЄМО 30 СЕКУНД =====
        _log("[Flow] Чекаємо 30 секунд...")
        for i in range(30):
            await flow_page.wait_for_timeout(1000)
            _log(f"[Flow] {i+1}/30с...")

        # ===== 6. КЛІКАЄМО ПО КРАЙНІЙ ГЕНЕРАЦІЇ =====
        _log("[Flow] Шукаємо крайню генерацію...")

        # Переходимо назад на project page якщо Flow перейшов кудись
        cur_url = flow_page.url
        if project_url and "/edit/" in cur_url:
            await flow_page.goto(project_url, wait_until="domcontentloaded", timeout=20000)
            await flow_page.wait_for_timeout(2000)

        # Чекаємо новий thumbnail (до 30с додатково)
        new_img_src = None
        for _ in range(30):
            try:
                imgs_after = flow_page.locator("img[src*='getMediaUrlRedirect']")
                cnt = await imgs_after.count()
                if cnt > 0:
                    src = await imgs_after.first.get_attribute("src") or ""
                    if src and src not in before_imgs:
                        new_img_src = src
                        _log(f"[Flow] Нова картинка знайдена: {src[-50:]}")
                        break
                    elif src and cnt > len(before_imgs):
                        new_img_src = src
                        _log(f"[Flow] Крайня картинка (за кількістю): {src[-50:]}")
                        break
            except Exception:
                pass
            await flow_page.wait_for_timeout(1000)

        # Якщо новий thumbnail не знайшли — беремо перший
        if not new_img_src:
            try:
                imgs_all = flow_page.locator("img[src*='getMediaUrlRedirect']")
                cnt = await imgs_all.count()
                if cnt > 0:
                    new_img_src = await imgs_all.first.get_attribute("src") or ""
                    _log(f"[Flow] Беремо перший thumbnail: {new_img_src[-50:]}")
            except Exception:
                pass

        if not new_img_src:
            await flow_page.screenshot(path=dbg)
            return {"ok": False, "error": f"Не знайдено нову генерацію після 60с. Debug: {dbg}"}

        # Клікаємо по thumbnail (через посилання поруч)
        _log("[Flow] Клікаємо по крайній генерації...")
        try:
            first_link = flow_page.locator("a[href*='/edit/']").first
            if await first_link.is_visible(timeout=2000):
                await first_link.click()
                await flow_page.wait_for_timeout(2000)
                _log(f"[Flow] Перейшли на: {flow_page.url}")
        except Exception as e:
            _log(f"[Flow] Клік по thumbnail: {e}")

        # ===== 7. DOWNLOAD → 1K =====
        _log("[Flow] Шукаємо кнопку Download...")
        before_files = set(os.listdir(downloads_dir)) if os.path.exists(downloads_dir) else set()

        dl_clicked = False
        for dl_sel in [
            'button:has-text("Download")',
            'button:has-text("Завантажити")',
            'button[aria-label*="download" i]',
            'button[aria-label*="завантаж" i]',
        ]:
            try:
                btn = flow_page.locator(dl_sel).first
                if await btn.is_visible(timeout=3000):
                    await btn.click()
                    _log(f"[Flow] Клікнуто Download")
                    dl_clicked = True
                    await flow_page.wait_for_timeout(800)
                    break
            except Exception:
                continue

        if dl_clicked:
            for q_sel in ['button:has-text("1K")', '[role="menuitem"]:has-text("1K")', 'li:has-text("1K")']:
                try:
                    q_btn = flow_page.locator(q_sel).first
                    if await q_btn.is_visible(timeout=2000):
                        await q_btn.click()
                        _log("[Flow] Вибрано 1K")
                        break
                except Exception:
                    continue
        else:
            _log("[Flow] Download кнопка не знайдена — скачуємо напряму")

        # ===== 8. ЧЕКАЄМО 10 СЕКУНД =====
        _log("[Flow] Чекаємо 10 секунд...")
        dest = os.path.join(OUTPUT_DIR, f"flow_{int(time.time())}.png")

        new_file = None
        for i in range(15):
            await flow_page.wait_for_timeout(1000)
            if os.path.exists(downloads_dir):
                after_files = set(os.listdir(downloads_dir))
                new_imgs = [f for f in (after_files - before_files)
                            if f.lower().endswith(('.png', '.jpg', '.jpeg', '.webp'))
                            and not f.endswith('.crdownload')]
                if new_imgs:
                    # Беремо найновіший файл
                    new_file = max(
                        [os.path.join(downloads_dir, f) for f in new_imgs],
                        key=os.path.getmtime
                    )
                    _log(f"[Flow] Файл у Downloads: {new_file}")
                    break
            _log(f"[Flow] Чекаємо файл... {i+1}/15с")

        # ===== 9. ПЕРЕМІЩУЄМО В ПРОГРАМУ =====
        if new_file and os.path.exists(new_file) and os.path.getsize(new_file) > 10000:
            import shutil
            shutil.copy2(new_file, dest)
            _log(f"[Flow] OK! Файл скопійовано: {dest} ({os.path.getsize(dest)} bytes)")
            return {"ok": True, "path": dest, "filename": os.path.basename(dest)}

        # Fallback: скачуємо через media API напряму
        _log("[Flow] Fallback: media API")
        full_url = f"https://labs.google{new_img_src}" if new_img_src.startswith("/") else new_img_src
        try:
            response = await flow_page.request.get(full_url, max_redirects=10)
            if response.ok:
                data = await response.body()
                if len(data) > 10000:
                    with open(dest, "wb") as f:
                        f.write(data)
                    _log(f"[Flow] OK media API: {len(data)} bytes")
                    return {"ok": True, "path": dest, "filename": os.path.basename(dest)}
        except Exception as e:
            _log(f"[Flow] media API помилка: {e}")

        return {"ok": False, "error": "Не вдалось завантажити зображення після генерації."}


async def _download_latest_async(project_url: str) -> dict:
    """Знаходить останню генерацію в Flow проекті і скачує через media API."""
    if not _is_debug_running():
        _start_chrome_debug()
        for _ in range(20):
            if _is_debug_running():
                break
            await asyncio.sleep(0.5)
        else:
            return {"ok": False, "error": "Chrome не вдалось запустити"}
        await asyncio.sleep(2)

    async with async_playwright() as pw:
        try:
            browser = await pw.chromium.connect_over_cdp(f"http://127.0.0.1:{DEBUG_PORT}")
        except Exception as e:
            return {"ok": False, "error": f"Не вдалось підключитись до Chrome: {e}"}

        ctx = browser.contexts[0] if browser.contexts else None
        if not ctx:
            return {"ok": False, "error": "Немає активного контексту Chrome"}

        flow_page = None
        for page in ctx.pages:
            if "labs.google" in page.url:
                flow_page = page
                break
        if not flow_page:
            flow_page = await ctx.new_page()

        await flow_page.bring_to_front()

        # Переходимо на project page якщо потрібно
        cur = flow_page.url
        _log(f"[Flow:latest] URL: {cur}")
        if project_url and project_url not in cur:
            await flow_page.goto(project_url, wait_until="domcontentloaded", timeout=30000)
            await flow_page.wait_for_timeout(3000)

        # Чекаємо thumbnails (img з getMediaUrlRedirect)
        media_src = None
        for _ in range(15):
            try:
                imgs = flow_page.locator("img[src*='getMediaUrlRedirect']")
                cnt = await imgs.count()
                if cnt > 0:
                    src = await imgs.first.get_attribute("src")
                    if src:
                        media_src = src
                        _log(f"[Flow:latest] Знайдено {cnt} thumbnails, перший: {src[-60:]}")
                        break
            except Exception:
                pass
            await flow_page.wait_for_timeout(1000)
            _log(f"[Flow:latest] Чекаємо thumbnails...")

        if not media_src:
            dbg = os.path.join(OUTPUT_DIR, "flow_debug.png")
            await flow_page.screenshot(path=dbg, timeout=8000)
            return {"ok": False, "error": f"Не знайдено генерацій у проекті. Debug: {dbg}"}

        # Завантажуємо через page.request (використовує cookies браузера)
        full_url = f"https://labs.google{media_src}" if media_src.startswith("/") else media_src
        _log(f"[Flow:latest] Скачуємо: {full_url[-80:]}")

        dest = os.path.join(OUTPUT_DIR, f"flow_{int(time.time())}.png")
        try:
            response = await flow_page.request.get(full_url, max_redirects=10)
            if response.ok:
                data = await response.body()
                if len(data) > 10000:
                    with open(dest, "wb") as f:
                        f.write(data)
                    _log(f"[Flow:latest] OK {len(data)} bytes → {dest}")
                    return {"ok": True, "path": dest, "filename": os.path.basename(dest)}
                else:
                    _log(f"[Flow:latest] Відповідь замала: {len(data)} bytes")
            else:
                _log(f"[Flow:latest] HTTP {response.status}")
        except Exception as e:
            _log(f"[Flow:latest] Помилка завантаження: {e}")

        return {"ok": False, "error": "Не вдалось завантажити останню генерацію"}


def generate_flow_image(prompt: str, cookies_raw: str = "", project_url: str = None, headless: bool = False, aspect: str = "9:16") -> dict:
    return asyncio.run(_generate_async(prompt, project_url, aspect=aspect))


def download_latest_flow(project_url: str) -> dict:
    return asyncio.run(_download_latest_async(project_url))


async def _upload_media_async(image_path: str, project_url: str = None) -> dict:
    """Завантажує локальне зображення в медіа-бібліотеку Google Flow.

    Flow UI: верхня кнопка "add / Додати медіафайл" → панель праворуч →
    кнопка "upload / Додати медіафайли" відкриває file chooser → подаємо файл.

    ПРИМІТКА: передаємо файл у бібліотеку. Щоб Nano Banana використала його як
    стиль-референс, потрібен HTML5 drag-drop з панелі на робочу область — це
    Playwright НЕ може синтезувати надійно. Тому ця функція покриває upload у
    бібліотеку (файл зберігається, його видно в "Додані файли"), далі вручну
    треба перетягнути в редактор.
    """
    import asyncio
    from playwright.async_api import async_playwright

    target_url = project_url if project_url else FLOW_URL

    if not _is_debug_running():
        chrome = _find_chrome()
        subprocess.Popen([
            chrome,
            f"--remote-debugging-port={DEBUG_PORT}",
            f"--user-data-dir={AUTO_PROFILE}",
            "--no-first-run",
            "--no-default-browser-check",
            target_url,
        ])
        for _ in range(30):
            if _is_debug_running():
                break
            await asyncio.sleep(0.5)
        await asyncio.sleep(2)

    if not os.path.isfile(image_path):
        return {"ok": False, "error": f"Image not found: {image_path}"}

    async with async_playwright() as pw:
        try:
            browser = await pw.chromium.connect_over_cdp(f"http://127.0.0.1:{DEBUG_PORT}")
        except Exception as e:
            return {"ok": False, "error": f"CDP connect fail: {e}"}

        ctx = browser.contexts[0] if browser.contexts else None
        if not ctx:
            return {"ok": False, "error": "No browser context"}

        flow_page = None
        for page in ctx.pages:
            if "labs.google" in page.url:
                flow_page = page
                break
        if not flow_page:
            flow_page = await ctx.new_page()

        # Ensure on project page
        if target_url not in flow_page.url:
            await flow_page.goto(target_url, wait_until="domcontentloaded", timeout=30000)
            await flow_page.wait_for_timeout(4000)

        await flow_page.bring_to_front()

        # Open the "add media" panel (top-right icon "add")
        try:
            await flow_page.mouse.click(1445, 38)
            await flow_page.wait_for_timeout(1800)
        except Exception as e:
            return {"ok": False, "error": f"Click add-media: {e}"}

        # Click "upload / Додати медіафайли" button with file chooser
        try:
            async with flow_page.expect_file_chooser(timeout=6000) as fc_info:
                await flow_page.mouse.click(1366, 84)
            fc = fc_info.value
            await fc.set_files(image_path)
            await flow_page.wait_for_timeout(4000)
            return {"ok": True, "message": "Файл завантажено в медіа-бібліотеку Flow. Перетягни його в редактор вручну (drag-drop не автоматизується надійно)."}
        except Exception as e:
            return {"ok": False, "error": f"Upload fail: {str(e)[:200]}"}


def upload_flow_media(image_path: str, project_url: str = None) -> dict:
    """Синхронна обгортка для upload у медіа-бібліотеку Flow."""
    return asyncio.run(_upload_media_async(image_path, project_url))
