"""
Android Instagram Reel posting via uiautomator2.

Workflow:
1. Push video to device /sdcard/DCIM/ReelsGen/
2. Trigger media scan so Instagram gallery sees it
3. Open Instagram → tap "+" → tap "REEL"
4. Select most recent video from gallery
5. Next → Next → paste caption → Share
6. Wait for upload confirmation

All taps use resourceId/text lookups (not fixed coordinates) so the script
works across devices. Human-like random delays inserted between actions.
"""
from __future__ import annotations

import os
import time
import random
import shutil
from pathlib import Path

IG_PKG = "com.instagram.android"
REMOTE_DIR = "/sdcard/DCIM/ReelsGen"

# UK/Europe disguise defaults
UK_TIMEZONE = "Europe/London"
UK_LOCALE   = "en-GB"


def _set_proxy(d, host: str, port: int, user: str = "", password: str = "") -> None:
    """Set system-wide HTTP/HTTPS proxy on the device."""
    d.shell(f"settings put global http_proxy {host}:{port}")
    # For HTTPS proxy via global_proxy (Android 10+)
    d.shell(f"settings put global global_http_proxy_host {host}")
    d.shell(f"settings put global global_http_proxy_port {port}")
    if user:
        d.shell(f"settings put global global_http_proxy_username {user}")
        d.shell(f"settings put global global_http_proxy_password {password}")


def _clear_proxy(d) -> None:
    """Remove system proxy settings."""
    d.shell("settings put global http_proxy :0")
    d.shell("settings delete global global_http_proxy_host")
    d.shell("settings delete global global_http_proxy_port")
    d.shell("settings delete global global_http_proxy_username")
    d.shell("settings delete global global_http_proxy_password")


def _set_uk_disguise(d) -> dict:
    """Set timezone and locale to UK. Returns original values for restore."""
    orig_tz = d.shell("getprop persist.sys.timezone").output.strip()
    orig_locale = d.shell("getprop persist.sys.locale").output.strip() or \
                  d.shell("getprop ro.product.locale").output.strip()

    # Set timezone
    d.shell(f"service call alarm 3 s16 {UK_TIMEZONE}")
    d.shell(f"setprop persist.sys.timezone {UK_TIMEZONE}")

    # Set locale (requires root or shell on some devices; works on MIUI)
    d.shell(f"setprop persist.sys.locale {UK_LOCALE}")
    d.shell(f"setprop persist.sys.language en")
    d.shell(f"setprop persist.sys.country GB")

    return {"timezone": orig_tz, "locale": orig_locale}


def _restore_disguise(d, orig: dict) -> None:
    """Restore original timezone and locale."""
    if orig.get("timezone"):
        d.shell(f"service call alarm 3 s16 {orig['timezone']}")
        d.shell(f"setprop persist.sys.timezone {orig['timezone']}")
    if orig.get("locale"):
        d.shell(f"setprop persist.sys.locale {orig['locale']}")


def _pause(lo: float = 1.2, hi: float = 2.8) -> None:
    time.sleep(random.uniform(lo, hi))


def _connect(serial: str | None = None):
    """Connect to an Android device. Returns uiautomator2 Device."""
    import uiautomator2 as u2
    if serial:
        return u2.connect(serial)
    return u2.connect()  # defaults to ADB_SERIAL env or single connected device


def device_status(serial: str | None = None) -> dict:
    """Check if device is reachable and Instagram is installed."""
    try:
        d = _connect(serial)
        info = d.info
        ig_installed = IG_PKG in d.app_list()
        ig_running = False
        try:
            ig_running = d.app_info(IG_PKG).get("versionName") is not None
        except Exception:
            pass
        return {
            "ok": True,
            "device": {
                "model": info.get("productName") or info.get("displayName"),
                "brand": info.get("brand"),
                "sdk": info.get("sdkInt"),
                "screen": f"{info.get('displayWidth')}x{info.get('displayHeight')}",
                "battery": d.shell("dumpsys battery | grep level").output.strip() if hasattr(d.shell("echo"), 'output') else None,
            },
            "instagram_installed": ig_installed,
            "instagram_running": ig_running,
        }
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}


def _push_and_scan(d, local_path: str) -> str:
    """Push video to device and trigger media scanner. Returns remote path."""
    filename = Path(local_path).name
    remote_path = f"{REMOTE_DIR}/{filename}"
    d.shell(f"mkdir -p {REMOTE_DIR}")
    d.push(local_path, remote_path)
    # Force media scanner to pick up the new file
    d.shell(
        f'am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE '
        f'-d file://{remote_path}'
    )
    time.sleep(2)
    return remote_path


def _wait_tap(d, timeout: float = 15, **selector) -> bool:
    """Wait for an element matching selector, then tap it. Returns True on success."""
    el = d(**selector)
    if el.wait(timeout=timeout):
        el.click()
        return True
    return False


def post_reel(
    video_path: str,
    caption: str = "",
    serial: str | None = None,
    dry_run: bool = False,
    proxy: str | None = None,
) -> dict:
    """
    Upload a Reel through the Instagram Android app.

    Args:
        video_path: absolute path to a local .mp4 file
        caption: caption text (may include hashtags)
        serial: optional ADB serial, for multi-device setups
        dry_run: if True, only push the file and open IG, skip posting
        proxy: "host:port" or "host:port:user:pass" — EU/UK proxy for geo-masking

    Returns:
        {"ok": bool, "error"?: str, "step"?: str}
    """
    if not os.path.isfile(video_path):
        return {"ok": False, "error": f"File not found: {video_path}"}

    try:
        d = _connect(serial)
    except Exception as e:
        return {"ok": False, "error": f"Device connect failed: {e}", "step": "connect"}

    orig_disguise = None
    proxy_set = False

    try:
        # 0. Geo-masking: proxy + UK timezone/locale
        if proxy:
            parts = proxy.strip().split(":")
            if len(parts) >= 2:
                try:
                    p_host, p_port = parts[0], int(parts[1])
                    p_user = parts[2] if len(parts) > 2 else ""
                    p_pass = parts[3] if len(parts) > 3 else ""
                    _set_proxy(d, p_host, p_port, p_user, p_pass)
                    proxy_set = True
                except Exception as pe:
                    return {"ok": False, "error": f"Proxy setup failed: {pe}", "step": "proxy"}

        orig_disguise = _set_uk_disguise(d)
        _pause(1, 1.5)

        # 1. Push video
        _push_and_scan(d, video_path)
        _pause(1, 2)

        # 2. Launch Instagram
        d.app_stop(IG_PKG)
        _pause(0.5, 1)
        d.app_start(IG_PKG, use_monkey=True)
        _pause(3, 5)

        if dry_run:
            return {"ok": True, "step": "dry_run_complete"}

        # 3. Tap the "+" (creation) tab
        tapped = (
            _wait_tap(d, 8, resourceId=f"{IG_PKG}:id/creation_tab")
            or _wait_tap(d, 5, description="Create")
            or _wait_tap(d, 5, descriptionContains="reate")
        )
        if not tapped:
            return {"ok": False, "error": "Creation tab not found", "step": "open_creation"}
        _pause(1.5, 2.5)

        # 4. Select REEL tab (Instagram sometimes opens on Post by default)
        reel_tab = d(textMatches="(?i)reel")
        if reel_tab.wait(timeout=5):
            reel_tab.click()
            _pause(1, 2)

        # 5. Grant gallery permissions if prompted
        for txt in ("Allow", "Allow all", "ALLOW", "Дозволити"):
            btn = d(text=txt)
            if btn.exists:
                btn.click()
                _pause(0.5, 1.2)

        # 6. Pick first (most recent) video from the grid
        # Try several known resource ids — they change between IG versions
        grid_ids = [
            f"{IG_PKG}:id/gallery_grid_item_thumbnail",
            f"{IG_PKG}:id/gallery_grid_item",
            f"{IG_PKG}:id/media_picker_grid_item",
        ]
        picked = False
        for rid in grid_ids:
            items = d(resourceId=rid)
            if items.wait(timeout=4):
                items.click()
                picked = True
                break
        if not picked:
            return {"ok": False, "error": "Gallery thumbnail not found", "step": "pick_video"}
        _pause(1.5, 2.5)

        # 7. Next (video trimming / editing screen)
        if not _wait_tap(d, 10, descriptionMatches="(?i)next"):
            if not _wait_tap(d, 5, textMatches="(?i)next|далі"):
                return {"ok": False, "error": "Next (1) not found", "step": "next_1"}
        _pause(2, 3)

        # 8. Next again (audio / clips / effects screen)
        if not _wait_tap(d, 10, descriptionMatches="(?i)next"):
            if not _wait_tap(d, 5, textMatches="(?i)next|далі"):
                return {"ok": False, "error": "Next (2) not found", "step": "next_2"}
        _pause(2, 3)

        # 9. Paste caption
        if caption:
            cap_field = d(resourceId=f"{IG_PKG}:id/caption_input_text_view")
            if not cap_field.exists:
                cap_field = d(textMatches="(?i)write a caption|напишіть підпис")
            if cap_field.wait(timeout=5):
                cap_field.click()
                _pause(0.5, 1)
                d.send_keys(caption, clear=True)
                _pause(0.8, 1.5)
                # Close keyboard by pressing back
                d.press("back")
                _pause(0.5, 1)

        # 10. Share button
        shared = (
            _wait_tap(d, 8, resourceId=f"{IG_PKG}:id/share_footer_button")
            or _wait_tap(d, 5, textMatches="(?i)share|поділитися")
        )
        if not shared:
            return {"ok": False, "error": "Share button not found", "step": "share"}

        # 11. Wait for upload — the creation screen closes and we return to feed
        _pause(5, 8)
        return {"ok": True, "step": "shared"}

    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}", "step": "exception"}

    finally:
        # Cleanup: restore proxy and locale
        try:
            if proxy_set:
                _clear_proxy(d)
            if orig_disguise:
                _restore_disguise(d, orig_disguise)
        except Exception:
            pass


def take_screenshot(serial: str | None = None) -> bytes | None:
    """Захоплює screenshot телефону як PNG bytes (для дзеркала або AI)."""
    try:
        d = _connect(serial)
        # uiautomator2 повертає PIL Image
        img = d.screenshot()
        if img is None:
            return None
        import io
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        return buf.getvalue()
    except Exception as e:
        print(f"[screenshot] error: {e}", flush=True)
        return None


def read_reel_text(d, min_len: int = 30) -> str:
    """Витягує весь видимий текст з поточного рілсу через uiautomator2.

    Проходить по дереву UI, збирає текст з TextView елементів.
    Фільтрує системні кнопки (Like, Comment, Share, Follow, усі числа і хештеги).

    Returns: злитий текст або "" якщо недостатньо осмисленого контенту (<min_len символів).
    """
    try:
        # UI skip-патерни (системні кнопки і метадані)
        skip_exact = {
            "Like", "Comment", "Share", "Save", "Send", "Follow", "Following",
            "Like count", "More", "Remix", "Audio",
            "Лайк", "Коментар", "Поділитись", "Зберегти", "Підписатись",
            "Reels", "Рілс", "Рилс", "Subscribe", "Автор", "Sponsored", "Реклама",
            "more", "now", "h", "m", "s", "ago",
        }
        # Skip якщо текст виглядає як username (починається з @, без пробілів)
        def _is_junk(t: str) -> bool:
            t = t.strip()
            if not t or len(t) < 3:
                return True
            if t in skip_exact:
                return True
            if t.startswith("@") and " " not in t:
                return True
            # Тільки цифри / мітки часу / підписники
            if t.replace(",", "").replace(".", "").replace("K", "").replace("M", "").replace(" ", "").isdigit():
                return True
            return False

        texts = []
        # Збираємо всі видимі TextView
        try:
            for el in d(className="android.widget.TextView"):
                try:
                    t = (el.info.get("text") or "").strip()
                    if t and not _is_junk(t):
                        texts.append(t)
                except Exception:
                    continue
        except Exception:
            pass

        # Dedup, зберігаючи порядок
        seen = set()
        uniq = []
        for t in texts:
            if t not in seen:
                seen.add(t)
                uniq.append(t)

        merged = " | ".join(uniq)

        if len(merged) < min_len:
            return ""
        return merged[:2000]  # кеп на 2KB
    except Exception as e:
        print(f"[read_text] error: {e}", flush=True)
        return ""


def _ai_decide_reel_text(reel_text: str, niche: dict | None = None) -> dict:
    """Text-only AI decision — набагато швидше ніж vision.

    Args:
        reel_text: caption/overlay текст
        niche: dict {description, keywords, avoid, examples} — якщо є, використовуємо
               замість хардкод промпту
    """
    import sys
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from generate import _find_claude_cli
    import subprocess, re, json as _json

    claude_cli = _find_claude_cli()
    if not claude_cli:
        return {"action": "skip", "reason": "Claude CLI не знайдено"}

    # Будуємо niche prompt block (або hardcoded fallback)
    niche_block = _build_niche_block(niche)

    prompt = (
        f"Оцінюєш Instagram Reel для прогріву акаунту.\n\n"
        f"{niche_block}\n\n"
        f"Текст з рілса (caption + overlay text): «{reel_text}»\n\n"
        f"Поверни ТІЛЬКИ JSON (без markdown):\n"
        f'{{"action": "like", "reason": "..."}}   — релевантний нашій ніші\n'
        f'{{"action": "save", "reason": "..."}}   — дуже цінний (глибокий, унікальний)\n'
        f'{{"action": "skip", "reason": "..."}}   — не наша ніша або в avoid\n\n'
        f"Reason одним реченням українською."
    )

    try:
        result = subprocess.run(
            [claude_cli, "-p", prompt, "--output-format", "text"],
            capture_output=True, text=True, encoding="utf-8", timeout=20,
        )
        if result.returncode != 0:
            return {"action": "skip", "reason": f"CLI rc={result.returncode}"}
        text = (result.stdout or "").strip()
        if not text:
            return {"action": "skip", "reason": "пуста відповідь"}
        m = re.search(r"\{.*\}", text, re.DOTALL)
        if not m:
            return {"action": "skip", "reason": f"no JSON: {text[:80]}"}
        decision = _json.loads(m.group())
        action = decision.get("action", "skip")
        if action not in ("like", "save", "skip"):
            action = "skip"
        return {"action": action, "reason": decision.get("reason", "")}
    except subprocess.TimeoutExpired:
        return {"action": "skip", "reason": "timeout"}
    except Exception as e:
        return {"action": "skip", "reason": f"err: {e}"}


def _build_niche_block(niche: dict | None) -> str:
    """Будує блок тексту про нішу для AI prompt. Fallback до хардкоду якщо пуста."""
    if not niche or not isinstance(niche, dict):
        return (
            "Ніша: мотивація / воїнська філософія / саморозвиток / стоїцизм.\n"
            "Лайкаємо: цитати, воїни, спорт, дисципліна, успіх.\n"
            "Уникаємо: їжа, котики, мемчики, реклама."
        )

    desc = (niche.get('description') or '').strip()
    keywords = niche.get('keywords') or []
    avoid = niche.get('avoid') or []
    examples = niche.get('examples') or []

    # Якщо взагалі порожня — fallback
    if not desc and not keywords and not avoid:
        return (
            "Ніша: мотивація / воїнська філософія / саморозвиток / стоїцизм.\n"
            "Лайкаємо: цитати, воїни, спорт, дисципліна, успіх.\n"
            "Уникаємо: їжа, котики, мемчики, реклама."
        )

    lines = []
    if desc:
        lines.append(f"Опис ніші: {desc}")
    if keywords:
        lines.append(f"Теми які ЛАЙКАЄМО: {', '.join(keywords)}")
    if avoid:
        lines.append(f"Теми які УНИКАЄМО: {', '.join(avoid)}")
    if examples:
        lines.append(f"Приклади релевантних акаунтів: {', '.join(examples)}")
    return "\n".join(lines)


def _ai_decide_reel(api_key_unused: str, screenshot_png: bytes,
                     model: str = "", niche: dict | None = None) -> dict:
    """Vision via claude.exe CLI: рішення що робити з рілсом.

    Використовує локальну Claude Code CLI (не потребує API ключа — юзерська auth).
    Args:
        niche: dict {description, keywords, avoid, examples} — якщо є, використовуємо
               замість хардкод промпту
    Returns: {"action": "like"|"save"|"skip", "reason": "..."}
    """
    if not screenshot_png:
        return {"action": "skip", "reason": "no screenshot"}

    # Пізнє імпортування щоб уникнути циклу
    import sys
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from generate import _find_claude_cli
    import subprocess
    import tempfile
    import re
    import json as _json

    claude_cli = _find_claude_cli()
    if not claude_cli:
        return {"action": "skip", "reason": "Claude CLI не знайдено"}

    # Зберігаємо screenshot у тимчасовий файл
    tmp = tempfile.NamedTemporaryFile(suffix=".png", delete=False)
    try:
        tmp.write(screenshot_png)
        tmp.close()
        screenshot_path = tmp.name

        niche_block = _build_niche_block(niche)
        prompt = (
            f"Проаналізуй Instagram Reel screenshot для прогріву акаунту.\n\n"
            f"{niche_block}\n\n"
            f"Зображення: @{screenshot_path}\n\n"
            f"Поверни ТІЛЬКИ JSON (без markdown) одним з варіантів:\n"
            f'{{"action": "like", "reason": "..."}}   — релевантний ніші\n'
            f'{{"action": "save", "reason": "..."}}   — дуже цінний контент (глибокий, унікальний)\n'
            f'{{"action": "skip", "reason": "..."}}   — поза нішею або в avoid\n\n'
            f"Reason — одним коротким реченням українською."
        )

        result = subprocess.run(
            [claude_cli, "-p", prompt, "--output-format", "text", "--allowedTools", "Read"],
            capture_output=True, text=True, encoding="utf-8", timeout=30,
        )

        if result.returncode != 0:
            return {"action": "skip", "reason": f"CLI rc={result.returncode}: {(result.stderr or '')[:150]}"}

        text = (result.stdout or "").strip()
        if not text:
            return {"action": "skip", "reason": "CLI порожня відповідь"}

        m = re.search(r"\{.*\}", text, re.DOTALL)
        if not m:
            return {"action": "skip", "reason": f"no JSON in: {text[:100]}"}
        try:
            decision = _json.loads(m.group())
        except _json.JSONDecodeError as e:
            return {"action": "skip", "reason": f"JSON parse: {e}"}

        action = decision.get("action", "skip")
        if action not in ("like", "save", "skip"):
            action = "skip"
        return {"action": action, "reason": decision.get("reason", "")}
    except subprocess.TimeoutExpired:
        return {"action": "skip", "reason": "CLI timeout (30s)"}
    except Exception as e:
        return {"action": "skip", "reason": f"AI error: {e}"}
    finally:
        try:
            os.unlink(screenshot_path)
        except Exception:
            pass


def _dismiss_save_sheet(d) -> None:
    """
    Instagram після save може відкрити "Save to collection" bottom sheet.
    Закриваємо його: шукаємо кнопку Done, інакше press back.
    Це КРИТИЧНО — без цього swipe до наступного рілсу не працює.
    """
    import time
    time.sleep(0.6)  # дати UI намалювати sheet
    try:
        # Варіант 1: кнопка "Done" у bottom sheet
        for label in ("Done", "Готово", "Save", "Зберегти"):
            btn = d(text=label)
            if hasattr(btn, 'exists') and btn.exists:
                btn.click()
                time.sleep(0.4)
                return
        # Варіант 2: діалог "Save to collection" → press back
        # Перевіряємо типові елементи collection picker
        sheet_markers = [
            d(textContains="Save to"),
            d(textContains="Збер"),
            d(textContains="collection"),
            d(textContains="колекц"),
        ]
        if any(hasattr(m, 'exists') and m.exists for m in sheet_markers):
            d.press("back")
            time.sleep(0.4)
            return
        # Варіант 3 (fallback): завжди press back — безпечно, нічого не зламає
        # якщо sheet не відкрився (просто закриє поточний екран, а Instagram
        # одразу відновиться, оскільки Reels — головний tab)
        # НЕ робимо цей fallback — ризик вийти з Reels
    except Exception as e:
        print(f"[save-dismiss] error: {e}", flush=True)


def _save_reel(d) -> bool:
    """Зберегти рілс — тап на кнопку bookmark/save, потім закрити можливий діалог."""
    try:
        save_btn = (
            d(resourceId=f"{IG_PKG}:id/row_feed_button_save")
            or d(descriptionContains="Save")
            or d(descriptionContains="Зберегти")
        )
        if hasattr(save_btn, 'exists') and save_btn.exists:
            save_btn.click()
            # КРИТИЧНО: закрити bottom sheet якщо відкрився
            _dismiss_save_sheet(d)
            return True
    except Exception as e:
        print(f"[save] error: {e}", flush=True)
    return False


def scroll_reels(
    serial: str | None = None,
    duration_seconds: int = 120,
    like_probability: float = 0.15,
    proxy: str | None = None,
    use_ai: bool = False,
    claude_api_key: str = "",
    niche: dict | None = None,
) -> dict:
    """
    Open Instagram Reels and scroll like a real person.

    Simulates:
    - Random watch time per reel (3–18 s)
    - Human-like swipe speed and distance
    - Occasional likes (like_probability = 0–1)
    - Rare double-tap likes instead of button tap
    - Occasional scroll-back (re-watch a bit)
    - Random micro-pauses mid-scroll

    Args:
        serial: ADB serial (None = auto-detect)
        duration_seconds: total warm-up time in seconds
        like_probability: chance to like each reel (0.15 = 15%)
        proxy: "host:port" EU/UK proxy for geo-masking

    Returns:
        {"ok": bool, "reels_watched": int, "likes_given": int, "duration": float}
    """
    try:
        d = _connect(serial)
    except Exception as e:
        return {"ok": False, "error": f"Device connect failed: {e}"}

    proxy_set = False
    orig_disguise = None

    try:
        if proxy:
            parts = proxy.strip().split(":")
            if len(parts) >= 2:
                try:
                    _set_proxy(d, parts[0], int(parts[1]),
                               parts[2] if len(parts) > 2 else "",
                               parts[3] if len(parts) > 3 else "")
                    proxy_set = True
                except Exception as pe:
                    return {"ok": False, "error": f"Proxy setup failed: {pe}"}

        orig_disguise = _set_uk_disguise(d)

        # ── 0. Wake + unlock screen ───────────────────────────────────
        # Wake screen if off
        d.shell("input keyevent KEYCODE_WAKEUP")
        time.sleep(1)
        # Check if lockscreen is showing — swipe up to dismiss
        screen_on = d.info.get("screenOn", True)
        if not screen_on or d(resourceId="com.android.systemui:id/lockscreen_status_view").exists \
                or d(descriptionContains="unlock").exists \
                or d(textContains="Swipe").exists:
            info = d.info
            w2 = info.get("displayWidth", 1080)
            h2 = info.get("displayHeight", 1920)
            d.swipe(w2 // 2, int(h2 * 0.8), w2 // 2, int(h2 * 0.2), duration=0.4)
            time.sleep(1.2)
        # Second wake attempt (some phones need two presses)
        d.shell("input keyevent KEYCODE_MENU")
        time.sleep(0.5)

        # ── 1. Open Instagram ──────────────────────────────────────────
        d.app_stop(IG_PKG)
        _pause(0.5, 1.2)
        d.app_start(IG_PKG, use_monkey=True)
        _pause(3.5, 5.5)

        # ── 2. Navigate to Reels tab ───────────────────────────────────
        # Try dedicated Reels tab first
        reel_nav = (
            d(resourceId=f"{IG_PKG}:id/clips_tab")
            or d(description="Reels")
            or d(descriptionContains="Reel")
            or d(textMatches="(?i)reel")
        )
        if hasattr(reel_nav, 'wait') and reel_nav.wait(timeout=6):
            reel_nav.click()
            _pause(2, 3.5)
        else:
            # Fallback: swipe from home feed — Reels are in the feed too
            pass

        # Screen dimensions for swipe calculations
        info = d.info
        w = info.get("displayWidth", 1080)
        h = info.get("displayHeight", 1920)
        cx = w // 2

        reels_watched = 0
        likes_given   = 0
        saves_given   = 0
        ai_decisions  = []  # last 5 decisions для діагностики
        start_time    = time.time()

        while (time.time() - start_time) < duration_seconds:
            remaining = duration_seconds - (time.time() - start_time)
            if remaining <= 0:
                break

            # ── Watch current reel ─────────────────────────────────────
            watch_time = random.uniform(3.5, 18.0)
            watch_time = min(watch_time, remaining)
            reels_watched += 1

            # Micro-pause behaviour during watch (simulate thumb movement)
            elapsed = 0.0
            while elapsed < watch_time:
                chunk = random.uniform(1.5, 4.0)
                chunk = min(chunk, watch_time - elapsed)
                time.sleep(chunk)
                elapsed += chunk

                # Rare: scroll up a tiny bit (re-watch gesture)
                if random.random() < 0.08 and elapsed < watch_time - 1:
                    scroll_up_px = random.randint(80, 200)
                    d.swipe(cx, h // 2, cx, h // 2 + scroll_up_px,
                            duration=random.uniform(0.25, 0.5))
                    time.sleep(random.uniform(0.4, 1.0))
                    # Scroll back down immediately
                    d.swipe(cx, h // 2 + scroll_up_px, cx, h // 2 - 50,
                            duration=random.uniform(0.2, 0.4))
                    time.sleep(random.uniform(0.3, 0.8))

            # ── Decide: like / save / skip ─────────────────────────────
            decision_action = None
            if use_ai:
                # Гібрид: спочатку пробуємо швидкий text-only decision
                ai_dec = None
                ai_mode = ""
                reel_text = read_reel_text(d, min_len=30)
                if reel_text:
                    ai_dec = _ai_decide_reel_text(reel_text, niche=niche)
                    ai_mode = "text"
                else:
                    # Fallback на screenshot vision якщо тексту мало/нема
                    shot = take_screenshot(serial)
                    if shot:
                        ai_dec = _ai_decide_reel(claude_api_key, shot, niche=niche)
                        ai_mode = "vision"
                if ai_dec:
                    decision_action = ai_dec.get("action", "skip")
                    ai_dec["mode"] = ai_mode
                    ai_decisions.append(ai_dec)
                    if len(ai_decisions) > 10:
                        ai_decisions.pop(0)
                    print(f"[AI/{ai_mode}] {decision_action}: {ai_dec.get('reason','')}", flush=True)

                    # Stuck detection: 3 однакові skip-причини про "збереження" поспіль = застрягли на save-діалозі
                    recent_reasons = [x.get("reason", "") for x in ai_decisions[-3:]
                                      if x.get("action") == "skip"]
                    if (len(recent_reasons) == 3 and
                        len(set(recent_reasons)) == 1 and
                        any(k in recent_reasons[0].lower()
                            for k in ("збереженн", "save", "колекц", "collect"))):
                        print("[stuck] detected save-dialog loop → press back", flush=True)
                        try:
                            d.press("back")
                            time.sleep(0.5)
                        except Exception:
                            pass
                        ai_decisions.clear()
            else:
                # Random mode (легасі поведінка)
                if random.random() < like_probability:
                    decision_action = "like"

            if decision_action == "like":
                use_double_tap = random.random() < 0.4
                if use_double_tap:
                    tap_x = cx + random.randint(-80, 80)
                    tap_y = h // 2 + random.randint(-100, 100)
                    d.double_click(tap_x, tap_y, duration=0.08)
                else:
                    like_btn = d(resourceId=f"{IG_PKG}:id/row_feed_button_like")
                    if not like_btn.exists:
                        like_btn = d(descriptionContains="Like")
                    if like_btn.exists:
                        like_btn.click()
                likes_given += 1
                _pause(0.4, 1.0)
            elif decision_action == "save":
                if _save_reel(d):
                    saves_given += 1
                    _pause(0.4, 1.0)
                else:
                    # Fallback на лайк якщо save не знайдено
                    like_btn = d(resourceId=f"{IG_PKG}:id/row_feed_button_like")
                    if hasattr(like_btn, 'exists') and like_btn.exists:
                        like_btn.click()
                        likes_given += 1
                        _pause(0.4, 1.0)

            # ── Scroll to next reel ────────────────────────────────────
            if (time.time() - start_time) >= duration_seconds:
                break

            swipe_start_y = int(h * random.uniform(0.72, 0.82))
            swipe_end_y   = int(h * random.uniform(0.12, 0.22))
            swipe_dur     = random.uniform(0.18, 0.42)  # faster = more natural for reels

            d.swipe(cx + random.randint(-20, 20),
                    swipe_start_y,
                    cx + random.randint(-20, 20),
                    swipe_end_y,
                    duration=swipe_dur)

            # Short pause after swipe (feed loads next reel)
            _pause(0.6, 1.8)

        # ── Завершення: home screen → lock phone (природна поведінка) ──
        try:
            d.press("home")                           # Instagram у фон (не kill — реальні юзери так не роблять)
            time.sleep(random.uniform(1.2, 2.5))      # пауза як у живої людини
            d.shell("input keyevent KEYCODE_POWER")    # блокуємо екран
        except Exception as e:
            print(f"[exit] error: {e}", flush=True)

        elapsed_total = time.time() - start_time
        return {
            "ok": True,
            "reels_watched": reels_watched,
            "likes_given": likes_given,
            "saves_given": saves_given,
            "duration": round(elapsed_total, 1),
            "ai_decisions": ai_decisions,
        }

    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}

    finally:
        try:
            if proxy_set:
                _clear_proxy(d)
            if orig_disguise:
                _restore_disguise(d, orig_disguise)
        except Exception:
            pass


def list_devices() -> dict:
    """List all ADB-connected devices. Uses adbutils (bundled with uiautomator2)."""
    try:
        import adbutils
        adb = adbutils.AdbClient()
        devices = [d.serial for d in adb.device_list()]
        return {"ok": True, "devices": devices}
    except Exception as e:
        # Fallback to system adb if adbutils fails
        try:
            import subprocess
            result = subprocess.run(
                ["adb", "devices"], capture_output=True, text=True, timeout=10
            )
            lines = result.stdout.strip().splitlines()[1:]
            devices = [
                parts[0] for line in lines
                if len(parts := line.split()) >= 2 and parts[1] == "device"
            ]
            return {"ok": True, "devices": devices}
        except FileNotFoundError:
            return {"ok": False, "error": f"adbutils failed ({e}), adb not in PATH"}
        except Exception as e2:
            return {"ok": False, "error": str(e2)}


# ───────────────────────── WiFi ADB helpers ──────────────────────────

def _find_adb() -> str:
    """Find adb executable: PATH first, then adbutils bundled binary."""
    import shutil, sys, os
    # 1. System PATH
    found = shutil.which("adb")
    if found:
        return found
    # 2. adbutils bundled adb (installed with uiautomator2)
    try:
        import adbutils
        pkg_dir = os.path.dirname(adbutils.__file__)
        candidates = [
            os.path.join(pkg_dir, "binaries", "adb.exe"),   # Windows
            os.path.join(pkg_dir, "binaries", "adb"),        # Linux/Mac
        ]
        for c in candidates:
            if os.path.isfile(c):
                return c
    except Exception:
        pass
    # 3. Same Python prefix
    prefix = os.path.dirname(sys.executable)
    for rel in (r"Lib\site-packages\adbutils\binaries\adb.exe",
                "lib/python*/site-packages/adbutils/binaries/adb"):
        import glob
        matches = glob.glob(os.path.join(prefix, rel))
        if matches:
            return matches[0]
    return "adb"  # last resort — will fail with clear error


def _run_adb(*args: str, timeout: int = 15) -> dict:
    """Run an adb command and return {"ok", "output"} or {"ok": False, "error"}."""
    import subprocess
    adb_bin = _find_adb()
    cmd = [adb_bin] + list(args)
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        out = (r.stdout + r.stderr).strip()
        if r.returncode != 0:
            return {"ok": False, "error": out or f"adb exited {r.returncode}"}
        return {"ok": True, "output": out}
    except FileNotFoundError:
        return {"ok": False, "error": "adb не знайдено. Встанови Android Platform Tools або uiautomator2."}
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": f"adb timeout ({timeout}s)"}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def adb_pair(host: str, code: str) -> dict:
    """
    Android 11+ wireless pairing: adb pair <host:port> <6-digit-code>.
    host — IP:port shown under «Pair with pairing code» in Developer Options.
    """
    code = code.strip()
    host = host.strip()
    if ":" not in host:
        return {"ok": False, "error": "host має бути у форматі IP:port (напр. 192.168.1.50:41234)"}
    if not code.isdigit() or len(code) != 6:
        return {"ok": False, "error": "Код має бути 6-значним числом"}
    result = _run_adb("pair", host, code, timeout=20)
    if not result["ok"]:
        return result
    out = result["output"]
    # adb pair returns "Successfully paired to …" on success
    if "successfully" in out.lower() or "paired" in out.lower():
        return {"ok": True, "message": out}
    return {"ok": False, "error": out}


def adb_connect(host: str) -> dict:
    """
    Connect to device over WiFi: adb connect <host[:port]>.
    After successful pair (Android 11+) use the main port (usually 5555).
    For legacy tcpip flow use the same port you set with adb_tcpip().
    Tries adbutils first (bundled with uiautomator2), then falls back to adb CLI.
    """
    host = host.strip()
    if ":" not in host:
        host = f"{host}:5555"

    # Try adbutils (no system adb required)
    try:
        import adbutils
        adb = adbutils.AdbClient()
        adb.connect(host, timeout=15)
        return {"ok": True, "serial": host, "message": f"connected to {host}"}
    except Exception:
        pass  # fallback to adb CLI

    result = _run_adb("connect", host, timeout=15)
    if not result["ok"]:
        return result
    out = result["output"]
    if "connected" in out.lower():
        return {"ok": True, "serial": host, "message": out}
    return {"ok": False, "error": out}


def adb_ping_device(host: str, timeout: int = 3) -> dict:
    """
    Реальна перевірка чи пристрій живий. adb connect/devices кешує стан,
    тому єдиний надійний спосіб — виконати команду на пристрої.
    Повертає {"ok": True, "state": "device"} якщо пристрій відповідає,
    {"ok": False, "state": "offline"/"unauthorized"/"missing", "error": ...} інакше.
    """
    host = host.strip()
    if ":" not in host:
        host = f"{host}:5555"

    # Спершу перевіряємо стан у adb devices (швидко, без запиту до пристрою)
    devs = _run_adb("devices", timeout=3)
    if not devs["ok"]:
        return {"ok": False, "state": "adb-error", "error": devs.get("error")}

    state = "missing"
    for line in devs["output"].splitlines():
        line = line.strip()
        if line.startswith(host):
            parts = line.split()
            if len(parts) >= 2:
                state = parts[1]  # device | offline | unauthorized
            break

    if state != "device":
        return {"ok": False, "state": state,
                "error": f"adb state={state} (треба 'device')"}

    # Реальний ping — виконуємо команду на пристрої
    r = _run_adb("-s", host, "shell", "echo", "ok", timeout=timeout)
    if not r["ok"]:
        return {"ok": False, "state": "unreachable", "error": r.get("error")}
    if "ok" not in (r.get("output") or ""):
        return {"ok": False, "state": "unreachable",
                "error": f"unexpected shell output: {r.get('output')}"}

    return {"ok": True, "state": "device", "host": host}


def adb_tcpip(serial: str | None, port: int = 5555) -> dict:
    """
    Legacy approach (Android <11): switch a USB-connected device to TCP mode.
    After this command succeeds, unplug the USB cable, then call adb_connect(phone_ip).
    """
    args = []
    if serial:
        args += ["-s", serial]
    args += ["tcpip", str(port)]
    result = _run_adb(*args, timeout=15)
    if not result["ok"]:
        return result
    out = result["output"]
    if "restarting" in out.lower() or "tcpip" in out.lower():
        return {"ok": True, "port": port, "message": out}
    return {"ok": False, "error": out}


def adb_disconnect(host: str) -> dict:
    """Disconnect a WiFi ADB device. Tries adbutils first, then adb CLI."""
    host = host.strip()
    if ":" not in host:
        host = f"{host}:5555"

    try:
        import adbutils
        adb = adbutils.AdbClient()
        adb.disconnect(host)
        return {"ok": True, "message": f"disconnected {host}"}
    except Exception:
        pass  # fallback to adb CLI

    result = _run_adb("disconnect", host, timeout=10)
    if not result["ok"]:
        return result
    return {"ok": True, "message": result["output"]}


def adb_mdns_discover() -> dict:
    """
    Discover Wireless Debugging (Android 11+) devices on the local network via mDNS.
    Returns list of {"name", "host"} where host is "ip:port" ready for adb connect.
    Requires: Wireless Debugging enabled on phone, laptop+phone on same Wi-Fi.
    """
    import re
    result = _run_adb("mdns", "services", timeout=8)
    if not result["ok"]:
        return {"ok": False, "error": result.get("error", "mdns failed"), "devices": []}

    devices = []
    for line in result["output"].splitlines():
        line = line.strip()
        # Формат рядка: "adb-<name>._adb-tls-connect._tcp\t_adb-tls-connect._tcp\t192.168.0.7:41935"
        # або:          "adb-<name>._adb._tcp\t_adb._tcp\t192.168.0.7:5555"
        # Беремо ТІЛЬКИ _adb-tls-connect (Wireless Debug), ігноруємо _adb._tcp (pairing)
        m = re.search(r"(adb-[\w\-]+)\.(_adb-tls-connect)\._tcp.*?(\d+\.\d+\.\d+\.\d+:\d+)", line)
        if m:
            devices.append({"name": m.group(1), "host": m.group(3)})
    return {"ok": True, "devices": devices}


def _wake_and_unlock(d) -> dict:
    """Будить екран і намагається розблокувати (без PIN — лише swipe up)."""
    import time
    try:
        # Перевіряємо стан
        power_out = d.shell("dumpsys power | grep mWakefulness").output
        if "Asleep" in power_out or "Dozing" in power_out:
            d.shell("input keyevent KEYCODE_WAKEUP")
            time.sleep(1.5)
        # Якщо екран заблокований — свайп вгору
        info = d.info
        w = info.get("displayWidth", 1080)
        h = info.get("displayHeight", 1920)
        # Універсальний swipe від низу до верху (прибирає lock screen без PIN)
        d.swipe(w // 2, int(h * 0.85), w // 2, int(h * 0.25), duration=0.25)
        time.sleep(1.0)
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def get_all_ig_accounts(serial: str | None = None) -> dict:
    """
    Знаходить ВСІ залогінені IG акаунти на пристрої.
    Надійний flow: cold-launch IG → tap profile_tab (only via resource-id) →
    wait profile_header_container → read action_bar_title → open switcher → parse.
    Повертає {ok, active, all: [username, ...], debug?}.
    """
    import time, re
    try:
        d = _connect(serial)
    except Exception as e:
        return {"ok": False, "error": f"connect fail: {e}"}

    try:
        # Крок 0: розблокувати/розбудити (більш наполегливо, для Xiaomi-MIUI)
        try:
            d.shell("svc power stayon true")
        except Exception: pass
        _wake_and_unlock(d)
        # Ще одна спроба: KEYCODE_WAKEUP + перевірка Display Power
        try:
            for _ in range(3):
                power = d.shell("dumpsys power | grep 'Display Power'").output
                if "state=ON" in power:
                    break
                d.shell("input keyevent KEYCODE_WAKEUP")
                time.sleep(1.0)
                d.shell("wm dismiss-keyguard")
                time.sleep(0.5)
        except Exception: pass
        # Якщо після наших спроб екран досі OFF — повідомляємо користувача
        try:
            power = d.shell("dumpsys power | grep 'Display Power'").output
            if "state=OFF" in power:
                return {"ok": False,
                        "error": "Телефон не прокидається через Wi-Fi ADB. Натисни Power button фізично і спробуй знову."}
        except Exception: pass

        if not d.app_info(IG_PKG).get("versionName"):
            return {"ok": False, "error": "Instagram не встановлено на пристрої"}

        # Cold start IG (не полагаємось на current state)
        d.app_stop(IG_PKG)
        time.sleep(1)
        d.app_start(IG_PKG, use_monkey=True)

        # Чекаємо завантаження tab_bar (готовність IG)
        ig_ready = False
        for i in range(20):   # 20s — для повільніших пристроїв / cold start
            time.sleep(1)
            try:
                if d(resourceId=f"{IG_PKG}:id/tab_bar").exists:
                    ig_ready = True
                    break
            except Exception:
                continue
        if not ig_ready:
            return {"ok": False,
                    "error": "IG не завантажився (tab_bar не видно). Можливо IG показує login/update screen — відкрий вручну."}

        # Крок 1: Tap Profile tab ТІЛЬКИ через resource-id (стабільно, не натрапить на reel)
        try:
            tab = d(resourceId=f"{IG_PKG}:id/profile_tab")
            if not tab.exists:
                return {"ok": False, "error": "profile_tab не знайдено — IG UI оновлено?"}
            tab.click()
        except Exception as e:
            return {"ok": False, "error": f"profile_tab click: {e}"}

        # Крок 2: Чекаємо Profile screen (перевіряємо profile_header_container)
        on_profile = False
        for i in range(12):
            time.sleep(0.6)
            try:
                if d(resourceId=f"{IG_PKG}:id/profile_header_container").exists:
                    on_profile = True
                    break
            except Exception:
                continue
        if not on_profile:
            return {"ok": False,
                    "error": "Profile screen не завантажився (profile_header_container not visible)"}

        # Крок 3: Читаємо username з action_bar_title (тільки на Profile воно = username)
        active_username = None
        title_el = None
        try:
            el = d(resourceId=f"{IG_PKG}:id/action_bar_title")
            if el.exists:
                t_text = (el.get_text() or "").strip().lstrip('@')
                # content-desc на Profile має збігатись з text (подвійна перевірка)
                try:
                    t_desc = (el.info.get("contentDescription") or "").strip().lstrip('@')
                except Exception:
                    t_desc = ""
                if re.match(r'^[a-z0-9._]{1,30}$', t_text.lower()):
                    if not t_desc or t_desc.lower() == t_text.lower():
                        active_username = t_text.lower()
                        title_el = el
        except Exception:
            pass
        if not active_username:
            return {"ok": False, "error": "Username не знайдено в action_bar_title на Profile"}

        # Крок 3: кілька спроб відкрити account switcher
        # Sheet markers щоб переконатись що він реально відкрився:
        sheet_markers = ["Add account", "Log in to existing account",
                         "Створити новий", "Увійти до існуючого",
                         "Switch accounts"]

        def sheet_is_open():
            try:
                hier = d.dump_hierarchy()
                return any(m in hier for m in sheet_markers)
            except Exception:
                return False

        switcher_opened = False
        # Спроба 1: тап на title
        try:
            title_el.click()
            time.sleep(1.8)
            switcher_opened = sheet_is_open()
        except Exception:
            pass

        # Спроба 2: long-press на title (відкриває switcher на деяких версіях)
        if not switcher_opened:
            try:
                bounds = title_el.info.get('bounds', {})
                if bounds:
                    cx = (bounds['left'] + bounds['right']) // 2
                    cy = (bounds['top'] + bounds['bottom']) // 2
                    d.long_click(cx, cy, duration=0.5)
                    time.sleep(1.8)
                    switcher_opened = sheet_is_open()
            except Exception:
                pass

        # Спроба 3: тап на chevron arrow праворуч від title
        if not switcher_opened:
            try:
                # Зазвичай chevron справа від username у action bar
                bounds = title_el.info.get('bounds', {})
                if bounds:
                    chevron_x = bounds['right'] + 40
                    chevron_y = (bounds['top'] + bounds['bottom']) // 2
                    d.click(chevron_x, chevron_y)
                    time.sleep(1.8)
                    switcher_opened = sheet_is_open()
            except Exception:
                pass

        # Крок 4: парс
        accounts_found = {active_username.lower()}
        debug_hits = []

        # Regex для валідного IG username
        username_re = re.compile(r'^[a-z0-9](?:[a-z0-9._]{0,28}[a-z0-9])?$')

        blacklist = {
            'profile','follow','message','edit','share','settings','home','search',
            'reels','activity','shop','following','followers','posts','tagged',
            'dashboard','insights','professional','creator','personal','add','done',
            'close','cancel','ok','save','next','continue','switch','logout','log',
            'stories','notes','video','tag','new','see','all','your','my','about',
            'profile','bio','link','accounts','login','сторінки','профіль',
        }

        if switcher_opened:
            try:
                hierarchy = d.dump_hierarchy()

                # Парсимо тільки текст що ВИГЛЯДАЄ як username:
                # Має бути РІВНО lowercase у оригіналі (не full name)
                # і матчити regex
                node_pattern = re.compile(r'<node[^>]*text="([^"]+)"', re.IGNORECASE)

                for m in node_pattern.finditer(hierarchy):
                    text = m.group(1).strip().lstrip('@')
                    if not text or len(text) < 3 or len(text) > 30:
                        continue
                    # КРИТИЧНО: original text має бути lowercase (без Full Name)
                    if text != text.lower():
                        continue
                    if text in blacklist:
                        continue
                    if not username_re.match(text):
                        continue
                    if text.isdigit():
                        continue
                    # Ще фільтр: real usernames мають '.', '_' АБО довжину 5+
                    if '.' not in text and '_' not in text and len(text) < 5:
                        continue
                    accounts_found.add(text)
                    debug_hits.append(text)
            except Exception as e:
                print(f"[ig-accounts] dump fail: {e}", flush=True)
        # Якщо switcher не відкрився — повертаємо тільки active (не гадаємо)

        # Закриваємо sheet
        try:
            d.press("back")
            time.sleep(0.5)
        except Exception:
            pass

        return {
            "ok": True,
            "active": active_username.lower() if active_username else None,
            "all": sorted(accounts_found),
            "debug": {
                "switcher_opened": switcher_opened,
                "hits": debug_hits[:20],
            },
        }

    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}


def get_active_ig_account(serial: str | None = None) -> dict:
    """
    Визначає активний IG акаунт. Просто:
      1. Відкрити IG
      2. Тап на Profile tab у НИЖНЬОМУ ПРАВОМУ куті (по координатах — найнадійніше)
      3. Прочитати username з action_bar_large_title
    """
    import time
    try:
        d = _connect(serial)
    except Exception as e:
        return {"ok": False, "error": f"connect fail: {e}"}

    try:
        # Wake + unlock якщо треба
        _wake_and_unlock(d)

        if not d.app_info(IG_PKG).get("versionName"):
            return {"ok": False, "error": "Instagram не встановлено на пристрої"}

        d.app_start(IG_PKG, use_monkey=True)
        time.sleep(3)

        # Розміри екрану
        info = d.info
        w = info.get("displayWidth", 1080)
        h = info.get("displayHeight", 1920)

        # Тап на Profile tab — нижній ПРАВИЙ кут
        # IG bottom nav: 5 іконок рівномірно, остання — Profile
        # Координати: ~90% ширини, ~97% висоти
        profile_x = int(w * 0.9)
        profile_y = int(h * 0.97)

        # Спроба 1: resource-id (якщо є — найкраще)
        tab = d(resourceId=f"{IG_PKG}:id/profile_tab")
        clicked = False
        if hasattr(tab, 'exists') and tab.exists:
            try:
                tab.click()
                clicked = True
            except Exception:
                pass

        # Спроба 2: по координатах (нижній правий)
        if not clicked:
            d.click(profile_x, profile_y)
            clicked = True

        time.sleep(2.5)

        # Читаємо username з хедера Profile
        title_selectors = [
            f"{IG_PKG}:id/action_bar_large_title_auto_size",
            f"{IG_PKG}:id/action_bar_large_title",
            f"{IG_PKG}:id/action_bar_title",
            f"{IG_PKG}:id/title",
        ]
        for rid in title_selectors:
            el = d(resourceId=rid)
            if hasattr(el, 'exists') and el.exists:
                try:
                    text = el.get_text()
                    if text:
                        username = text.strip().lstrip('@').lower()
                        # Валідація username IG: a-z, 0-9, ., _
                        import re
                        if re.match(r'^[a-z0-9._]{1,30}$', username):
                            return {"ok": True, "username": username}
                except Exception:
                    continue

        return {"ok": False,
                "error": "Username не знайдено. Переконайся що ти у Profile tab на IG."}

    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}


def _list_usb_devices() -> list[str]:
    """Повертає список USB серійників (не IP-адреси) з `adb devices`."""
    r = _run_adb("devices", timeout=5)
    if not r["ok"]:
        return []
    usb = []
    for line in r["output"].splitlines():
        line = line.strip()
        if not line or line.startswith("List of") or "offline" in line or "unauthorized" in line:
            continue
        parts = line.split()
        if len(parts) >= 2 and parts[1] == "device":
            serial = parts[0]
            # USB serial: БЕЗ крапки в імені (не IP:port)
            if "." not in serial:
                usb.append(serial)
    return usb


def _get_device_wifi_ip(serial: str | None = None) -> str | None:
    """Витягує Wi-Fi IP з телефону через `adb shell ip`."""
    args = []
    if serial:
        args += ["-s", serial]
    args += ["shell", "ip", "-f", "inet", "addr", "show", "wlan0"]
    r = _run_adb(*args, timeout=5)
    if not r["ok"]:
        return None
    import re
    m = re.search(r"inet (\d+\.\d+\.\d+\.\d+)/", r["output"])
    return m.group(1) if m else None


def _get_device_wifi_mac(serial: str | None = None) -> str | None:
    """Витягує WiFi MAC адресу пристрою. Використовується для rediscover при зміні DHCP IP.

    Спершу пробує `cat /sys/class/net/wlan0/address` (надійно на всіх Android).
    Fallback: parse з `ip link show wlan0`. Повертає lowercase з двокрапками: 'aa:bb:cc:dd:ee:ff'.
    """
    args_base = []
    if serial:
        args_base += ["-s", serial]
    # Strategy 1: read /sys file
    r = _run_adb(*args_base, "shell", "cat", "/sys/class/net/wlan0/address", timeout=5)
    if r["ok"]:
        mac = (r["output"] or "").strip().lower()
        if len(mac) == 17 and mac.count(":") == 5:
            return mac
    # Strategy 2: parse ip link
    r = _run_adb(*args_base, "shell", "ip", "link", "show", "wlan0", timeout=5)
    if r["ok"]:
        import re
        m = re.search(r"link/ether ([0-9a-f:]{17})", r["output"] or "", re.IGNORECASE)
        if m:
            return m.group(1).lower()
    return None


def scan_usb_devices() -> dict:
    """
    Сканує підключені по USB Android пристрої і повертає інфо про кожний:
    {serial, model, wifi_ip, android_version}
    """
    usb_serials = _list_usb_devices()
    devices = []
    for serial in usb_serials:
        info = {"serial": serial}
        try:
            r = _run_adb("-s", serial, "shell", "getprop", "ro.product.model", timeout=3)
            info["model"] = r["output"].strip() if r["ok"] else None
        except Exception:
            info["model"] = None
        try:
            r = _run_adb("-s", serial, "shell", "getprop", "ro.build.version.release", timeout=3)
            info["android_version"] = r["output"].strip() if r["ok"] else None
        except Exception:
            info["android_version"] = None
        info["wifi_ip"] = _get_device_wifi_ip(serial)
        info["wifi_mac"] = _get_device_wifi_mac(serial)
        devices.append(info)
    return {"ok": True, "devices": devices}


def register_usb_device(serial: str) -> dict:
    """
    Підключає USB-пристрій як Wi-Fi ADB. Робить:
      1. adb tcpip 5555 на USB пристрої
      2. Отримує Wi-Fi IP пристрою
      3. adb connect <ip>:5555
    Повертає WiFi host, model, android_version.
    """
    import time
    wifi_ip = _get_device_wifi_ip(serial)
    if not wifi_ip:
        return {"ok": False, "error": f"Пристрій {serial} не підключений до Wi-Fi"}

    # Tcpip 5555
    r = adb_tcpip(serial, 5555)
    if not r.get("ok"):
        return {"ok": False, "error": f"adb tcpip 5555 fail: {r.get('error')}"}
    time.sleep(2)

    # Connect через WiFi
    wifi_host = f"{wifi_ip}:5555"
    conn = adb_connect(wifi_host)
    if not conn.get("ok"):
        return {"ok": False, "error": f"WiFi connect fail: {conn.get('error')}"}

    # Беремо модель
    model = None
    try:
        mr = _run_adb("-s", wifi_host, "shell", "getprop", "ro.product.model", timeout=3)
        if mr["ok"]: model = mr["output"].strip()
    except Exception:
        pass

    # Беремо MAC для майбутнього auto-rediscover при DHCP-зміні IP
    wifi_mac = _get_device_wifi_mac(serial)

    return {"ok": True, "wifi_host": wifi_host, "model": model or serial,
            "wifi_mac": wifi_mac,
            "message": f"Зареєстровано: {model} ({wifi_host})"}


def rediscover_by_mac(wifi_mac: str, port: int = 5555, timeout_per_ip: float = 0.4) -> dict:
    """Знайти пристрій у локальній мережі за збереженою WiFi MAC адресою.

    Корисно коли DHCP видав новий IP — стара saved_host не працює.
    Алгоритм:
      1. Визначити локальну /24 підмережу з IP цього PC
      2. Ping sweep усіх IP щоб заповнити ARP таблицю
      3. Прочитати arp -a, знайти збережений MAC → новий IP
      4. Спробувати adb connect <new_ip>:5555
      5. Повернути новий host

    Args:
        wifi_mac: MAC адреса (формат 'aa:bb:cc:dd:ee:ff' lowercase)
        port: ADB порт (default 5555)
        timeout_per_ip: таймаут для ping одного IP

    Returns:
        {ok: True, wifi_host: 'ip:port'} або {ok: False, error: str}
    """
    import socket, subprocess, re

    if not wifi_mac:
        return {"ok": False, "error": "wifi_mac не вказано"}

    target_mac = wifi_mac.lower().replace("-", ":")
    if not re.match(r"^[0-9a-f:]{17}$", target_mac):
        return {"ok": False, "error": f"Невалідний MAC: {wifi_mac}"}

    # 1. Визначаємо локальну /24
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        local_ip = s.getsockname()[0]
        s.close()
    except Exception as e:
        return {"ok": False, "error": f"Не вдалось визначити локальну IP: {e}"}

    parts = local_ip.split(".")
    if len(parts) != 4:
        return {"ok": False, "error": f"Дивна локальна IP: {local_ip}"}
    subnet_prefix = ".".join(parts[:3])

    # 2. Ping sweep (паралельно для швидкості)
    import concurrent.futures as cf
    def _ping(ip):
        try:
            subprocess.run(
                ["ping", "-n", "1", "-w", str(int(timeout_per_ip * 1000)), ip],
                capture_output=True, timeout=timeout_per_ip + 1,
            )
        except Exception:
            pass

    ips = [f"{subnet_prefix}.{i}" for i in range(2, 255) if f"{subnet_prefix}.{i}" != local_ip]
    with cf.ThreadPoolExecutor(max_workers=32) as pool:
        list(pool.map(_ping, ips))

    # 3. ARP table → шукаємо MAC
    try:
        r = subprocess.run(["arp", "-a"], capture_output=True, text=True, timeout=10,
                           encoding="utf-8", errors="replace")
    except Exception as e:
        return {"ok": False, "error": f"arp -a fail: {e}"}

    found_ip = None
    # Windows формат: "  192.168.0.5           9c-bc-f0-3d-12-d7     dynamic"
    for line in r.stdout.splitlines():
        m = re.match(r"\s*(\d+\.\d+\.\d+\.\d+)\s+([0-9a-fA-F-]{17})\s+", line)
        if not m:
            continue
        ip = m.group(1)
        mac = m.group(2).lower().replace("-", ":")
        if mac == target_mac:
            found_ip = ip
            break

    if not found_ip:
        return {"ok": False, "error": f"MAC {target_mac} не знайдено в ARP таблиці після sweep"}

    # 4. ADB connect
    new_host = f"{found_ip}:{port}"
    conn = adb_connect(new_host)
    if not conn.get("ok"):
        return {"ok": False, "error": f"Знайдено {new_host} але adb connect fail: {conn.get('error')}"}

    return {"ok": True, "wifi_host": new_host, "wifi_ip": found_ip,
            "message": f"Знайдено за MAC: {new_host}"}


def ensure_wifi_connection(saved_host: str | None, allow_usb_recovery: bool = True) -> dict:
    """
    Гарантує активне Wi-Fi ADB з'єднання. Стратегія:
      1. Пробує saved_host (з retry для transient fail).
      2. На фейл — mDNS discovery (Android 11+, на старих ігнорується).
      3. На фейл — якщо підключено USB, автоматично робить `tcpip 5555` і reconnect.
      4. Повертає {ok, host, method, message} або {ok: False, error, need_usb}.
    """
    import time

    # Step 1: try saved host з коротким retry + реальний ping
    if saved_host:
        for attempt in range(2):
            r = adb_connect(saved_host)
            if r.get("ok"):
                ping = adb_ping_device(saved_host, timeout=4)
                if ping.get("ok"):
                    return {"ok": True, "host": saved_host, "method": "saved",
                            "message": f"reused {saved_host}"}
                # adb connect сказав OK, але пристрій не відповідає на shell —
                # стара запис у кеші. Disconnect і повторимо або підемо на mDNS
                adb_disconnect(saved_host)
            if attempt == 0:
                time.sleep(1.5)

    # Step 2: mDNS (Android 11+)
    disc = adb_mdns_discover()
    if disc.get("ok") and disc.get("devices"):
        for dev in disc["devices"]:
            r = adb_connect(dev["host"])
            if r.get("ok"):
                return {"ok": True, "host": dev["host"], "method": "mdns",
                        "message": f"discovered {dev['host']}"}

    # Step 3: USB auto-recovery (Android 10 fallback)
    if allow_usb_recovery:
        usb_serials = _list_usb_devices()
        if usb_serials:
            usb_serial = usb_serials[0]
            # Дістаємо IP телефону через USB
            wifi_ip = _get_device_wifi_ip(usb_serial)
            if not wifi_ip:
                return {"ok": False, "need_usb": False,
                        "error": f"USB пристрій {usb_serial} знайдено, але Wi-Fi IP не отримано. "
                                 "Переконайся що телефон підключений до Wi-Fi."}
            # Переключаємо у tcpip 5555
            tcp_r = adb_tcpip(usb_serial, 5555)
            if not tcp_r.get("ok"):
                return {"ok": False, "need_usb": False,
                        "error": f"adb tcpip 5555 fail: {tcp_r.get('error')}"}
            time.sleep(2)  # adb daemon перезапускається
            new_host = f"{wifi_ip}:5555"
            conn_r = adb_connect(new_host)
            if conn_r.get("ok"):
                return {"ok": True, "host": new_host, "method": "usb-recovery",
                        "message": f"USB auto-recovery → {new_host}"}
            return {"ok": False, "need_usb": False,
                    "error": f"tcpip 5555 встановлено, але connect fail: {conn_r.get('error')}"}

    # Всі шляхи вичерпано
    return {"ok": False, "need_usb": True,
            "error": "Wi-Fi ADB недоступний. Підключи телефон по USB на 5 сек — система відновить автоматично."}
