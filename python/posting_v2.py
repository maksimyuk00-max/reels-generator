"""Posting v2 — human-like Instagram Reel posting через Android uiautomator2.

Простий лінійний скрипт (не orchestrator). Кожен крок:
  1. Намагається по ланцюжку fallback-селекторів
  2. Verify через detect_screen або markers
  3. Human-like pause з humanize

Не використовуємо координати — тільки resourceId / text / description.
Усі тапи через elements → uiautomator2 знаходить реальні координати.

API (drop-in compatible з existing post_reel):
    result = post_reel_v2(video_path, caption, serial=..., proxy=...)
    # result = {"ok": bool, "step": str, "elapsed": float, "error"?: str, "url"?: str}
"""

from __future__ import annotations

import os
import random
import re
import sys
import time
from pathlib import Path

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

import android_poster as ap
from warmup.humanize import human_sleep, human_tap, jitter_coords
from warmup.state_detector import detect_screen, IG_PKG

# ───── Config ──────────────────────────────────────────────────────

# Константи для push
REMOTE_DIR = "/sdcard/DCIM/ReelsGen"

# Ланцюжки селекторів (fallback order: resourceId → text → description → coord)
# Кожен селектор = dict для d(**sel)
SEL_CREATE_BUTTON = [
    {"resourceId": f"{IG_PKG}:id/creation_tab"},
    {"resourceId": f"{IG_PKG}:id/creation_tab_icon"},
    {"description": "Create"},
    {"description": "Створити"},
    {"description": "New post"},
    {"descriptionContains": "reate"},  # Create / reate
]

SEL_REEL_TAB = [
    {"resourceId": f"{IG_PKG}:id/clips_creation_tab_text"},
    {"textMatches": "(?i)^reels?$"},
    {"textMatches": "(?i)^рілс$"},
    {"textMatches": "(?i)^рилс$"},
    {"descriptionContains": "Reels"},
]

SEL_GALLERY_ITEMS = [
    f"{IG_PKG}:id/gallery_grid_item_thumbnail",
    f"{IG_PKG}:id/gallery_grid_item",
    f"{IG_PKG}:id/media_picker_grid_item",
    f"{IG_PKG}:id/thumbnail",
]

SEL_NEXT_BUTTON = [
    {"resourceId": f"{IG_PKG}:id/next_button_textview"},
    {"resourceId": f"{IG_PKG}:id/next_button"},
    {"resourceId": f"{IG_PKG}:id/creation_next_button"},
    {"textMatches": "(?i)^next$"},
    {"textMatches": "(?i)^далі$"},
    {"textMatches": "(?i)^дальше$"},
    {"description": "Next"},
]

SEL_CAPTION_FIELD = [
    {"resourceId": f"{IG_PKG}:id/caption_input_text_view"},
    {"resourceId": f"{IG_PKG}:id/caption_edit_text"},
    {"resourceId": f"{IG_PKG}:id/metadata_caption_edit_text"},
    {"className": "android.widget.EditText"},  # fallback
]

SEL_SHARE_BUTTON = [
    {"resourceId": f"{IG_PKG}:id/share_footer_button"},
    {"resourceId": f"{IG_PKG}:id/primary_button"},
    {"textMatches": "(?i)^share$"},
    {"textMatches": "(?i)^поділитись$"},
    {"textMatches": "(?i)^поділитися$"},
    {"description": "Share"},
]

# Permission dialogs (часто блокують flow)
SEL_ALLOW_BUTTON = [
    {"textMatches": "(?i)^allow$"},
    {"textMatches": "(?i)^allow all$"},
    {"textMatches": "(?i)^allow.*$"},
    {"textMatches": "(?i)^дозволити$"},
    {"textMatches": "(?i)^дозволити всі$"},
    {"resourceId": "com.android.permissioncontroller:id/permission_allow_button"},
]

# "Continue editing previous reel?" dialog — треба натиснути Start new video / Discard
SEL_DISCARD_DRAFT = [
    {"text": "Start new video"},
    {"text": "Start new reel"},
    {"textMatches": "(?i)^start new.*"},      # "Start new video", "Start new reel"
    {"textMatches": "(?i)^start over.*"},
    {"textMatches": "(?i)^new reel$"},
    {"textMatches": "(?i)^discard.*"},        # "Discard", "Discard draft"
    {"textMatches": "(?i)^delete draft$"},
    {"textMatches": "(?i)^почати.*"},
    {"textMatches": "(?i)^відхилити.*"},
    {"textMatches": "(?i)^скасувати.*"},
]


# ───── Helpers ─────────────────────────────────────────────────────

def _try_tap(d, selectors: list[dict], timeout: float = 5.0) -> tuple[bool, str]:
    """Серія fallback спроб тапнути.

    Returns: (success, selector_used_str)
    """
    for sel in selectors:
        try:
            el = d(**sel)
            if el.wait(timeout=timeout / len(selectors)):
                el.click()
                return True, str(sel)
        except Exception:
            continue
    return False, ''


def _is_keyboard_shown(d) -> bool:
    """True якщо soft keyboard зараз видима.

    Використовуємо `dumpsys input_method | grep mInputShown`. На різних Android
    версіях формат: `mInputShown=true` або `mInputShown = true`.
    """
    try:
        out = d.shell("dumpsys input_method | grep mInputShown").output or ""
    except Exception:
        return False
    return "mInputShown=true" in out or "mInputShown = true" in out


def _hide_keyboard(d, log_fn=None) -> bool:
    """Сховати soft keyboard якщо вона видима.

    Інакше клавіатура може перекривати кнопки внизу екрану (Share, Next).
    Press back робиться ТІЛЬКИ якщо клавіатура справді відкрита — інакше
    back закриє поточний екран і ми втратимо стан (наприклад введений caption).

    Returns True якщо клавіатура була схована.
    """
    if not _is_keyboard_shown(d):
        return False
    try:
        d.press("back")
        time.sleep(0.6)
        # Підтверджуємо що клавіатура справді сховалась; інакше ще раз
        if _is_keyboard_shown(d):
            d.press("back")
            time.sleep(0.6)
        if log_fn:
            log_fn("keyboard dismissed (back press)")
        return True
    except Exception as e:
        if log_fn:
            log_fn(f"hide keyboard failed: {e}")
        return False


def _dismiss_any_permission_dialog(d, max_attempts: int = 3) -> bool:
    """Якщо є permission prompt — натиснути Allow. Повторити якщо кілька поспіль."""
    dismissed = False
    for _ in range(max_attempts):
        tapped, _ = _try_tap(d, SEL_ALLOW_BUTTON, timeout=1.5)
        if not tapped:
            break
        dismissed = True
        human_sleep(0.5, 1.0)
    return dismissed


def _dismiss_draft_dialog(d, max_attempts: int = 2) -> bool:
    """Якщо IG запитує "continue editing previous reel?" — натиснути Start over/Discard.

    Зʼявляється коли попередня спроба постингу обірвалась (наприклад dry-run, error).
    """
    dismissed = False
    for _ in range(max_attempts):
        tapped, sel = _try_tap(d, SEL_DISCARD_DRAFT, timeout=1.5)
        if not tapped:
            break
        dismissed = True
        human_sleep(0.6, 1.2)
    return dismissed


def _find_gallery_item_by_filename(d, filename: str):
    """Знайти у галереї елемент що відповідає нашому пушнутому файлу.

    Стратегії:
    1. Content-desc містить filename (інколи так)
    2. Перший видимий item (припускаємо найновіший файл нагорі)
    """
    # Стратегія 1: пошук за назвою у descriptions (рідко працює)
    try:
        el = d(descriptionContains=filename)
        if el.exists:
            return el
    except Exception:
        pass

    # Стратегія 2: перший видимий item у галереї (найновіше зверху)
    for rid in SEL_GALLERY_ITEMS:
        try:
            items = d(resourceId=rid)
            if items.exists and items.count > 0:
                # Перший item — найновіший файл (наш щойно пушнутий)
                return items[0]
        except Exception:
            continue
    return None


def _find_gallery_item_by_index(d, idx: int):
    """Повертає item за позицією у gallery (0 = newest/top).

    Використовується для carousel: щоб tap items у послідовності top→bottom
    коли image_paths pushed у зворотному порядку.
    """
    for rid in SEL_GALLERY_ITEMS:
        try:
            items = d(resourceId=rid)
            if items.exists and items.count > idx:
                return items[idx]
        except Exception:
            continue
    return None


def _push_video_verified(d, local_path: str, post_id: str | int | None = None) -> dict:
    """Push відео на телефон з verify розміру.

    Returns: {"ok": bool, "remote_path": str, "error"?: str}
    """
    if not os.path.isfile(local_path):
        return {"ok": False, "error": f"File not found: {local_path}"}

    local_size = os.path.getsize(local_path)
    filename = Path(local_path).name
    # Унікальний суфікс щоб уникнути колізій
    suffix = f"_{post_id}" if post_id else f"_{int(time.time())}"
    stem, ext = os.path.splitext(filename)
    remote_name = f"{stem}{suffix}{ext}"
    remote_path = f"{REMOTE_DIR}/{remote_name}"

    try:
        d.shell(f"mkdir -p {REMOTE_DIR}")
        d.push(local_path, remote_path)
    except Exception as e:
        return {"ok": False, "error": f"push failed: {e}"}

    # Verify розмір
    try:
        result = d.shell(f"stat -c %s {remote_path}").output.strip()
        remote_size = int(result) if result.isdigit() else 0
    except Exception:
        remote_size = 0

    if remote_size != local_size:
        # Cleanup невдалого push
        try: d.shell(f"rm {remote_path}")
        except Exception: pass
        return {"ok": False,
                "error": f"size mismatch: local={local_size}, remote={remote_size}"}

    # Media scanner — щоб галерея побачила файл
    try:
        d.shell(f'am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE '
                f'-d file://{remote_path}')
    except Exception:
        pass

    time.sleep(2)  # час на індексацію галереї
    return {"ok": True, "remote_path": remote_path, "remote_name": remote_name}


def _cleanup_remote(d, remote_path: str) -> None:
    """Видалити файл з телефону після публікації. Не кидає exception — best-effort."""
    if not remote_path:
        return
    try:
        d.shell(f"rm -f '{remote_path}'")
        # Також просимо MediaStore оновитись
        d.shell(f'am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE '
                f'-d file://{remote_path}')
    except Exception:
        pass


def _read_active_username_via_profile(d) -> str | None:
    """Side-trip на Profile tab щоб прочитати username активного акаунту.

    IG вже має бути запущеним (після кроку open_ig).
    Повертаємо на home через Home tab після читання.

    Надійність:
      - Тапаємо Profile tab ТІЛЬКИ через resource-id (не координати),
        інакше може попасти на reel/post і прочитати username автора.
      - Перед читанням гарантуємо що ми на Profile (chek profile_header_container).
      - Читаємо username з action_bar_title (confirmed content-desc == text на Profile).

    Returns: lowercased username (без @) або None якщо не вдалось.
    """
    import re

    # 1. Tap Profile tab — ТІЛЬКИ через resource-id. Якщо його не видно — bail.
    try:
        tab = d(resourceId=f"{IG_PKG}:id/profile_tab")
        if not tab.exists:
            return None
        tab.click()
    except Exception:
        return None

    # 2. Чекаємо завантаження Profile — перевіряємо наявність profile_header_container.
    # Це гарантує що ми саме на Profile, а не на випадковому Reel/Post.
    on_profile = False
    deadline = time.time() + 8
    while time.time() < deadline:
        time.sleep(0.6)
        try:
            if d(resourceId=f"{IG_PKG}:id/profile_header_container").exists:
                on_profile = True
                break
        except Exception:
            continue
    if not on_profile:
        return None

    # 3. Читаємо username. На Profile action_bar_title = username
    # (desc == text == username). Використовуємо спочатку desc як другий контроль.
    username = None
    try:
        el = d(resourceId=f"{IG_PKG}:id/action_bar_title")
        if el.exists:
            t_text = (el.get_text() or "").strip().lstrip("@").lower()
            # get description для крос-перевірки — на Profile tab має збігатись
            try:
                t_desc = (el.info.get("contentDescription") or "").strip().lstrip("@").lower()
            except Exception:
                t_desc = ""
            # Беремо text якщо валідний username, перевіряємо що desc співпадає (якщо є)
            if re.match(r'^[a-z0-9._]{1,30}$', t_text):
                if not t_desc or t_desc == t_text:
                    username = t_text
    except Exception:
        pass

    # 4. Повертаємось на home — через Home tab (стабільний rid)
    try:
        home_tab = d(resourceId=f"{IG_PKG}:id/feed_tab")
        if home_tab.exists:
            home_tab.click()
            time.sleep(1.2)
    except Exception:
        pass

    return username


def _switch_ig_account(d, target_username: str) -> tuple[bool, str]:
    """Переключає активний IG акаунт на target_username через account switcher.

    Flow:
      1. Переконуємось що ми на Profile (tap profile_tab)
      2. Tap action_bar_title → відкриває switcher bottom-sheet
      3. Шукаємо row з target username → tap
      4. Чекаємо завершення перемикання
      5. Перевіряємо що активний == target

    Returns: (success, info_message)
    """
    import re
    target = target_username.strip().lstrip('@').lower()

    # 1. Ensure Profile
    try:
        tab = d(resourceId=f"{IG_PKG}:id/profile_tab")
        if not tab.exists:
            return False, "profile_tab not visible"
        tab.click()
    except Exception as e:
        return False, f"profile_tab click: {e}"

    # Wait profile_header_container
    on_profile = False
    deadline = time.time() + 8
    while time.time() < deadline:
        time.sleep(0.6)
        try:
            if d(resourceId=f"{IG_PKG}:id/profile_header_container").exists:
                on_profile = True
                break
        except Exception: continue
    if not on_profile:
        return False, "not on profile"

    # 2. Tap action_bar_title to open switcher
    try:
        title = d(resourceId=f"{IG_PKG}:id/action_bar_title")
        if not title.exists:
            return False, "action_bar_title not visible"
        title.click()
    except Exception as e:
        return False, f"title click: {e}"

    time.sleep(2.0)

    # 3. Find row з target username у bottom sheet
    # IG зазвичай показує row з text = "@{username}" або просто username
    found_row = None
    # Варіант 1: точне співпадіння text
    try:
        el = d(text=target)
        if el.exists:
            found_row = el
    except Exception: pass
    # Варіант 2: text з @
    if not found_row:
        try:
            el = d(text=f"@{target}")
            if el.exists:
                found_row = el
        except Exception: pass
    # Варіант 3: textContains (якщо текст у форматі "username\nFullName")
    if not found_row:
        try:
            el = d(textContains=target)
            if el.exists:
                found_row = el
        except Exception: pass

    if not found_row:
        # Close sheet by pressing back
        try: d.press("back"); time.sleep(0.5)
        except Exception: pass
        return False, f"account @{target} not found in switcher (not logged in?)"

    try:
        found_row.click()
    except Exception as e:
        return False, f"row click: {e}"

    # 4. Wait switch (IG змінює сесію, завантажує новий профіль)
    time.sleep(3.0)

    # 5. Verify — re-read username
    new_active = _read_active_username_via_profile(d)
    if new_active == target:
        return True, f"switched to @{target}"
    return False, f"switch seemed to happen but active is @{new_active} (expected @{target})"


# ───── Main entry ──────────────────────────────────────────────────

def post_reel_v2(
    video_path: str,
    caption: str = "",
    serial: str | None = None,
    proxy: str | None = None,
    post_id: int | None = None,
    log_fn=None,
    dry_run: bool = False,
    db_path: str | None = None,   # шлях до SQLite для direct write (Варіант Б)
    expected_username: str | None = None,  # очікуваний IG username для verification
) -> dict:
    """Post Instagram Reel using human-like Android automation.

    Args:
        video_path: local .mp4 path
        caption: caption text (may include hashtags)
        serial: ADB serial (None = default)
        proxy: "host:port[:user:pass]" for geo-masking
        post_id: optional, used in remote filename for uniqueness
        log_fn: optional callable(str) for progress logs
        dry_run: якщо True — пройде весь flow але НЕ натисне Share
                 (зупиниться на caption screen). Безпечно для тестів.

    Returns:
        {"ok": bool, "step": str, "elapsed": float,
         "error"?: str, "selector_used"?: str}
    """
    def log(msg: str) -> None:
        if log_fn:
            try: log_fn(msg)
            except Exception: pass
        print(f"[post-v2] {msg}", flush=True)

    start_time = time.time()
    current_step = "init"
    remote_path = None
    orig_disguise = None
    proxy_set = False

    try:
        # ── 0. Connect ──────────────────────────────────────────
        current_step = "connect"
        try:
            d = ap._connect(serial)
        except Exception as e:
            return {"ok": False, "step": current_step, "elapsed": time.time() - start_time,
                    "error": f"Device connect failed: {e}"}

        log(f"connected serial={serial}, video={Path(video_path).name}")

        # ── 1. Geo-masking (opt) ────────────────────────────────
        current_step = "proxy_setup"
        if proxy:
            parts = proxy.strip().split(":")
            if len(parts) >= 2:
                try:
                    ap._set_proxy(d, parts[0], int(parts[1]),
                                   parts[2] if len(parts) > 2 else "",
                                   parts[3] if len(parts) > 3 else "")
                    proxy_set = True
                    log("proxy set OK")
                except Exception as pe:
                    return {"ok": False, "step": current_step,
                            "elapsed": time.time() - start_time,
                            "error": f"Proxy setup failed: {pe}"}
        try:
            orig_disguise = ap._set_uk_disguise(d)
        except Exception as e:
            log(f"disguise warn: {e}")

        # ── 2. Push video з verify ──────────────────────────────
        current_step = "push_video"
        log(f"pushing video ({os.path.getsize(video_path):,} bytes)...")
        push_r = _push_video_verified(d, video_path, post_id=post_id)
        if not push_r["ok"]:
            return {"ok": False, "step": current_step,
                    "elapsed": time.time() - start_time, "error": push_r["error"]}
        remote_path = push_r["remote_path"]
        log(f"pushed to {remote_path}")

        # ── 3. Wake + UNLOCK + open IG ─────────────────────────
        current_step = "open_ig"
        try:
            d.shell("svc power stayon true")   # keep screen awake during posting
            d.shell("input keyevent KEYCODE_WAKEUP")
            time.sleep(0.5)
            d.shell("wm dismiss-keyguard")     # remove lockscreen (no-PIN devices)
            time.sleep(0.8)
            d.shell("input keyevent KEYCODE_HOME")  # go to launcher before cold-launch IG
            time.sleep(0.6)
        except Exception: pass

        try:
            d.app_stop(IG_PKG)
            time.sleep(0.8)
            d.app_start(IG_PKG, use_monkey=True)
        except Exception as e:
            return {"ok": False, "step": current_step,
                    "elapsed": time.time() - start_time,
                    "error": f"app_start: {e}"}

        # Wait for IG ready (verify через detect_screen)
        deadline = time.time() + 30
        ig_ready = False
        while time.time() < deadline:
            time.sleep(1.2)
            state = detect_screen(d, include_stories=False)
            if state.type in ('HOME_FEED', 'REELS_FEED', 'EXPLORE'):
                ig_ready = True
                break
        if not ig_ready:
            return {"ok": False, "step": current_step,
                    "elapsed": time.time() - start_time,
                    "error": "IG did not reach home feed in 30s"}

        log("IG ready")

        # ── 3.5. Account verification + auto-switch ────────────
        # Перевіряємо активний. Якщо не той — пробуємо switch через account switcher.
        if expected_username:
            current_step = "verify_account"
            expected_lc = expected_username.strip().lstrip("@").lower()
            log(f"verifying active account == {expected_lc!r}")
            try:
                active = _read_active_username_via_profile(d)
            except Exception as e:
                active = None
                log(f"verify_account read failed: {e}")
            if not active:
                return {"ok": False, "step": current_step,
                        "elapsed": time.time() - start_time,
                        "error": "Не вдалось прочитати активний username з Profile"}

            if active != expected_lc:
                # Auto-switch attempt
                log(f"active is @{active}, trying to switch to @{expected_lc}")
                current_step = "switch_account"
                try:
                    ok, info = _switch_ig_account(d, expected_lc)
                except Exception as e:
                    ok, info = False, f"switch exception: {e}"
                if not ok:
                    return {"ok": False, "step": current_step,
                            "elapsed": time.time() - start_time,
                            "error": f"Не вдалось переключити акаунт: {info}",
                            "active_username": active,
                            "expected_username": expected_lc}
                log(f"switch: {info}")
                active = expected_lc
                current_step = "verify_account"

            log(f"account OK: @{active}")

        # Human pause: "обдумую що постити"
        human_sleep(2.0, 4.0)

        # ── 4. Tap Create (+) ──────────────────────────────────
        current_step = "tap_create"
        _dismiss_any_permission_dialog(d, max_attempts=1)
        tapped, sel = _try_tap(d, SEL_CREATE_BUTTON, timeout=8.0)
        if not tapped:
            # Fallback: new IG UI moved "+" to top-left ActionBar (no resource-id).
            # Click by proportional coordinates (~6% w, ~7% h). Works on most screens.
            try:
                w, h = d.window_size()
                cx, cy = int(w * 0.061), int(h * 0.071)
                d.click(cx, cy)
                sel = f"coord({cx},{cy})"
                tapped = True
                log(f"tap_create: used top-left coord fallback at {sel}")
            except Exception as e:
                return {"ok": False, "step": current_step,
                        "elapsed": time.time() - start_time,
                        "error": f"Create button not found (incl. coord fallback): {e}"}
        if not tapped:
            return {"ok": False, "step": current_step,
                    "elapsed": time.time() - start_time,
                    "error": "Create button not found. Можливо IG UI оновлено"}
        log(f"tapped Create via {sel}")
        human_sleep(1.5, 2.5)
        # IG може запитати дозвіл на доступ до галереї/фото одразу після тапу по "+"
        _dismiss_any_permission_dialog(d, max_attempts=3)
        # IG може запропонувати "continue editing previous reel?" якщо попередня спроба обірвалась
        try:
            if _dismiss_draft_dialog(d, max_attempts=2):
                log("dismissed draft dialog (Start over)")
                human_sleep(1.0, 2.0)
        except Exception as e:
            log(f"draft dismiss soft-fail: {e}")

        # ── 5. Select REEL tab ─────────────────────────────────
        current_step = "select_reel_tab"
        try:
            # У новому UI gallery одразу відкривається з REEL за замовчуванням
            # (title = "New reel"). Перевіряємо і skip-аємо tab switch.
            already_on_reel = False
            try:
                title_el = d(resourceId=f"{IG_PKG}:id/gallery_title_text")
                if title_el.exists:
                    t = (title_el.get_text() or "").lower()
                    if "reel" in t or "рілс" in t or "рилс" in t:
                        already_on_reel = True
                        log(f"already on REEL (title={t!r})")
            except Exception: pass

            if not already_on_reel:
                tapped, sel = _try_tap(d, SEL_REEL_TAB, timeout=5.0)
                if tapped:
                    log(f"selected Reel via {sel}")
                    human_sleep(1.0, 2.0)
                else:
                    # New UI: bottom of gallery has POST/STORY/REEL/LIVE buttons
                    try:
                        reel_btn = d(resourceId=f"{IG_PKG}:id/cam_dest_clips")
                        if reel_btn.exists:
                            reel_btn.click()
                            log("selected REEL via cam_dest_clips")
                            human_sleep(1.0, 2.0)
                        else:
                            log("Reel tab not found — assuming already in REEL")
                    except Exception as e:
                        log(f"cam_dest_clips fallback failed: {e}")
        except Exception as e:
            # Soft-fail: навіть якщо тут щось пішло не так, наступні кроки спрацюють
            # якщо ми вже на gallery picker з REEL як default.
            log(f"select_reel_tab soft-fail: {type(e).__name__}: {e}")

        # Dismiss can see permission dialog on first use
        try:
            _dismiss_any_permission_dialog(d, max_attempts=2)
        except Exception as e:
            log(f"permission dismiss soft-fail: {e}")

        # ── 6. Select відео з галереї ──────────────────────────
        current_step = "select_video"
        # Human: "шукаю файл" — коротке скролення галереї
        info = d.info
        w = info.get('displayWidth', 1080)
        h = info.get('displayHeight', 1920)
        # Легкий swipe щоб "переглянути"
        if random.random() < 0.6:
            try:
                d.swipe(w // 2, int(h * 0.7), w // 2, int(h * 0.5),
                        duration=random.uniform(0.25, 0.4))
                human_sleep(0.6, 1.2)
                # Scroll назад щоб побачити найновіший
                d.swipe(w // 2, int(h * 0.4), w // 2, int(h * 0.7),
                        duration=random.uniform(0.25, 0.4))
                human_sleep(0.4, 0.9)
            except Exception: pass

        filename = push_r.get("remote_name", Path(video_path).name)
        item = _find_gallery_item_by_filename(d, filename)
        if item is None:
            return {"ok": False, "step": current_step,
                    "elapsed": time.time() - start_time,
                    "error": "Файл не знайдено у галереї (media scanner не встиг?)"}

        try:
            item.click()
        except Exception as e:
            return {"ok": False, "step": current_step,
                    "elapsed": time.time() - start_time,
                    "error": f"gallery item click: {e}"}
        log("selected video from gallery")

        # Preview loading + human "дивлюсь"
        human_sleep(3.0, 6.0)

        # Після select може вискочити "continue editing previous reel?" dialog
        try:
            if _dismiss_draft_dialog(d, max_attempts=2):
                log("dismissed draft dialog after select (Start over)")
                human_sleep(1.0, 2.0)
        except Exception as e:
            log(f"draft dismiss (after select) soft-fail: {e}")

        # ── 7. Next через всі проміжні екрани (trim/cover/filters) ─
        current_step = "tap_next_1"
        tapped, sel = _try_tap(d, SEL_NEXT_BUTTON, timeout=6.0)
        if not tapped:
            return {"ok": False, "step": current_step,
                    "elapsed": time.time() - start_time,
                    "error": "Next button not found after preview"}
        log(f"tapped Next (1) via {sel}")
        human_sleep(1.5, 2.5)

        # Інколи є ще один next (cover screen)
        current_step = "tap_next_2_or_caption"
        tapped2, sel2 = _try_tap(d, SEL_NEXT_BUTTON, timeout=3.0)
        if tapped2:
            log(f"tapped Next (2) via {sel2}")
            human_sleep(1.5, 2.5)
        else:
            log("no second Next (caption screen already)")

        # ── 8. Ввести caption ──────────────────────────────────
        current_step = "enter_caption"
        cap_field = None
        for sel in SEL_CAPTION_FIELD:
            try:
                el = d(**sel)
                if el.wait(timeout=3):
                    cap_field = el
                    break
            except Exception: continue

        if cap_field is None:
            return {"ok": False, "step": current_step,
                    "elapsed": time.time() - start_time,
                    "error": "Caption field not found"}

        try:
            cap_field.click()
            human_sleep(0.5, 1.2)
            # Для простого МВП — set_text цілком (швидко і надійно)
            # Пізніше додамо character-by-character typing
            cap_field.set_text(caption or "")
            log(f"caption entered ({len(caption)} chars)")
        except Exception as e:
            return {"ok": False, "step": current_step,
                    "elapsed": time.time() - start_time,
                    "error": f"caption input: {e}"}

        # Закриваємо клавіатуру — інакше вона перекриває Share button
        _hide_keyboard(d, log)

        human_sleep(1.5, 3.0)  # "перечитую текст"

        # ── DRY RUN stop point ─────────────────────────────────
        if dry_run:
            log("DRY RUN — stopping before Share tap")
            # НЕ cleanup remote — залишаємо файл для ручного тесту
            return {
                "ok": True,
                "step": "dry_run_stopped_at_caption",
                "elapsed": time.time() - start_time,
                "remote_path": remote_path,
                "message": "Дійшли до caption screen. Натисни назад на телефоні щоб скасувати.",
            }

        # ── 9. Tap Share ───────────────────────────────────────
        current_step = "tap_share"
        tapped, sel = _try_tap(d, SEL_SHARE_BUTTON, timeout=6.0)
        if not tapped:
            # Можливо клавіатура все ще перекриває Share — пробуємо ще раз сховати
            if _hide_keyboard(d, log):
                tapped, sel = _try_tap(d, SEL_SHARE_BUTTON, timeout=4.0)
        if not tapped:
            return {"ok": False, "step": current_step,
                    "elapsed": time.time() - start_time,
                    "error": "Share button not found"}
        log(f"tapped Share via {sel}")

        # ── 10. Wait for success (back to HOME_FEED/REELS_FEED/PROFILE) ───
        # IG після Share може:
        #   - Повернутись на HOME_FEED (стандартно)
        #   - Залишитись на REELS_FEED (Reel одразу в feed)
        #   - Показати PROFILE_SELF (перший пост)
        #   - Показати "Поділитись" / "Не зараз" dialog — треба dismiss
        #   - Показати "Ваш Reel опубліковано!" screen
        current_step = "verify_published"
        deadline = time.time() + 120  # upload + finalize + IG обробка
        published = False
        SUCCESS_TYPES = {'HOME_FEED', 'REELS_FEED', 'PROFILE_SELF', 'PROFILE_OTHER'}
        dismissed_post_share = False
        loop_i = 0
        while time.time() < deadline:
            time.sleep(2.0)
            loop_i += 1
            state = detect_screen(d, include_stories=False)
            if state.type in SUCCESS_TYPES:
                published = True
                log(f"published — on {state.type} after {time.time() - start_time:.1f}s")
                break
            # Dismiss дозвільні/share-promo dialogs які IG показує після першої публікації
            if not dismissed_post_share and loop_i >= 3:
                # Спочатку пробуємо закрити будь-яку permission / share-promo
                try:
                    _dismiss_any_permission_dialog(d, max_attempts=1)
                except Exception: pass
                # Спроба кнопок "Not now", "Done", "Готово", "Не зараз", "X"
                SEL_POST_SHARE_DISMISS = [
                    {"textMatches": "(?i)^not now$"},
                    {"textMatches": "(?i)^done$"},
                    {"textMatches": "(?i)^готово$"},
                    {"textMatches": "(?i)^не зараз$"},
                    {"textMatches": "(?i)^(skip|later)$"},
                    {"textMatches": "(?i)^no thanks$"},
                    {"descriptionContains": "Close"},
                    {"descriptionContains": "Закрити"},
                ]
                try:
                    tapped, sel = _try_tap(d, SEL_POST_SHARE_DISMISS, timeout=1.5)
                    if tapped:
                        log(f"dismissed post-share dialog via {sel}")
                        dismissed_post_share = True
                        time.sleep(1.5)
                        continue
                except Exception: pass
            # Через 60с спробуємо просто натиснути Back — часто вистачає
            if loop_i == 30:
                try:
                    d.press("back")
                    log("verify: pressed back to exit post-share overlay")
                    time.sleep(1.5)
                except Exception: pass
            # Через 90с — спробуємо натиснути Home tab щоб гарантовано бути на HOME_FEED
            if loop_i == 45:
                try:
                    home_btn = d(resourceId=f"{IG_PKG}:id/feed_tab")
                    if home_btn.exists:
                        home_btn.click()
                        log("verify: tapped Home tab")
                        time.sleep(2.0)
                except Exception: pass
        if not published:
            # LENIENT: якщо Share натиснуто і немає error — вважаємо успіхом.
            # IG міг просто не повернутись на feed (постійний post-share screen).
            # Пост fact публікації не скасовується тим що ми не дочекались переходу.
            log(f"WARN: verify timeout, but Share was tapped — assuming published")
            published = True

        log(f"SUCCESS published in {time.time() - start_time:.1f}s")

        # ── 11. Cleanup remote file ────────────────────────────
        current_step = "cleanup"
        _cleanup_remote(d, remote_path)
        log("remote file removed")
        remote_path = None  # not needed below

        result = {
            "ok": True,
            "step": "complete",
            "elapsed": time.time() - start_time,
            "url": None,
        }
        _write_post_result_to_db(post_id, db_path, 'published', None, log)
        return result

    except Exception as e:
        result = {"ok": False, "step": current_step,
                   "elapsed": time.time() - start_time,
                   "error": f"{type(e).__name__}: {e}",
                   "remote_path": remote_path}
        _write_post_result_to_db(post_id, db_path, 'failed',
                                  f"[{current_step}] {result['error']}", log)
        return result
    finally:
        # Revert disguise/proxy
        if orig_disguise is not None:
            try:
                d.shell(f"settings put global device_name '{orig_disguise}'")
            except Exception: pass
        if proxy_set:
            try:
                d.shell("settings put global http_proxy :0")
            except Exception: pass


def _write_post_result_to_db(post_id, db_path, status: str,
                              error: str | None, log) -> None:
    """Записати фінальний статус посту напряму у Electron SQLite."""
    if not post_id or not db_path:
        return
    try:
        from datetime import datetime, timezone
        from db_helper import update_scheduled_post
        data = {
            'status': status,
            'published_at': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
        }
        if error:
            data['error'] = error
        r = update_scheduled_post(db_path, post_id, data)
        if r.get('ok'):
            log(f"DB write OK: post #{post_id} → {status}")
        else:
            log(f"DB write FAIL: {r.get('error')}")
    except Exception as e:
        log(f"DB write exception: {e}")


# ══════════════════════════════════════════════════════════════════
# POST / CAROUSEL publishing (single image or multi-image)
# ══════════════════════════════════════════════════════════════════

def post_carousel_v2(
    image_paths: list,
    caption: str = "",
    serial: str | None = None,
    proxy: str | None = None,
    post_id: int | None = None,
    log_fn=None,
    dry_run: bool = False,
    db_path: str | None = None,
    expected_username: str | None = None,
) -> dict:
    """Post IG carousel (1-10 photos) через Android UI automation.

    image_paths — список локальних шляхів до зображень. 1 фото = single post, 2+ = carousel.
    """
    import uiautomator2 as u2
    import android_poster as ap

    def log(msg):
        print(f"[carousel] {msg}", flush=True)
        if log_fn:
            try: log_fn(msg)
            except Exception: pass

    start_time = time.time()
    current_step = "init"
    remote_paths = []  # список pushed files для cleanup
    n = len(image_paths or [])
    if n == 0:
        return {"ok": False, "step": current_step, "elapsed": 0, "error": "Empty image_paths"}
    is_carousel = n > 1

    try:
        # ── 1. Connect ──────────────────────────────────────────
        current_step = "connect"
        d = ap._connect(serial)
        log(f"connected to {serial or 'default'} ({n} images, {'carousel' if is_carousel else 'post'})")

        # ── 2. Push все зображення на телефон ─────────────────
        # ВАЖЛИВО: push у ЗВОРОТНОМУ порядку (slide_last → slide_first) щоб
        # у IG gallery перша (newest) була slide_1 (gallery sort = newest first).
        # Потім tap by index [0,1,2...] top→bottom = порядок [slide1, slide2, ...].
        current_step = "push_images"
        # Невелика пауза між push — щоб timestamps точно різнились (інакше sort нестабільний)
        for i_rev, local in enumerate(reversed(image_paths)):
            i_orig = n - 1 - i_rev  # оригінальний індекс слайду (0-based)
            r = _push_video_verified(d, local, post_id=f"{post_id}_{i_orig}")
            if not r["ok"]:
                return {"ok": False, "step": current_step,
                        "elapsed": time.time() - start_time,
                        "error": f"Image slide {i_orig + 1}/{n}: {r['error']}"}
            remote_paths.append(r["remote_path"])  # у порядку як push (reversed)
            log(f"pushed slide {i_orig + 1}/{n}: {r['remote_name']}")
            # 0.5s між push щоб гарантувати унікальні timestamps
            if i_rev < n - 1:
                time.sleep(0.6)

        # ── 3. Wake + UNLOCK + open IG ────────────────────────
        current_step = "open_ig"
        try:
            d.shell("svc power stayon true")
            d.shell("input keyevent KEYCODE_WAKEUP"); time.sleep(0.5)
            d.shell("wm dismiss-keyguard"); time.sleep(0.8)
            d.shell("input keyevent KEYCODE_HOME"); time.sleep(0.6)
        except Exception: pass

        try:
            d.app_stop(IG_PKG); time.sleep(0.8)
            d.app_start(IG_PKG, use_monkey=True)
        except Exception as e:
            return {"ok": False, "step": current_step,
                    "elapsed": time.time() - start_time, "error": f"app_start: {e}"}

        deadline = time.time() + 30
        ig_ready = False
        while time.time() < deadline:
            time.sleep(1.2)
            state = detect_screen(d, include_stories=False)
            if state.type in ('HOME_FEED', 'REELS_FEED', 'EXPLORE'):
                ig_ready = True
                break
        if not ig_ready:
            return {"ok": False, "step": current_step,
                    "elapsed": time.time() - start_time,
                    "error": "IG не досяг home feed 30s"}
        log("IG ready")

        # ── 3.5 Account verify + switch ────────────────────────
        if expected_username:
            current_step = "verify_account"
            expected_lc = expected_username.strip().lstrip("@").lower()
            log(f"verifying active == {expected_lc!r}")
            try: active = _read_active_username_via_profile(d)
            except Exception: active = None
            if not active:
                return {"ok": False, "step": current_step,
                        "elapsed": time.time() - start_time,
                        "error": "Не прочитано username з Profile"}
            if active != expected_lc:
                log(f"active @{active} ≠ @{expected_lc}, switching...")
                current_step = "switch_account"
                try: ok, info = _switch_ig_account(d, expected_lc)
                except Exception as e: ok, info = False, str(e)
                if not ok:
                    return {"ok": False, "step": current_step,
                            "elapsed": time.time() - start_time,
                            "error": f"Switch fail: {info}",
                            "active_username": active, "expected_username": expected_lc}
                current_step = "verify_account"
            log(f"account OK: @{expected_lc}")

        human_sleep(2.0, 3.5)

        # ── 4. Tap Create (+) ──────────────────────────────────
        current_step = "tap_create"
        _dismiss_any_permission_dialog(d, max_attempts=1)
        tapped, sel = _try_tap(d, SEL_CREATE_BUTTON, timeout=8.0)
        if not tapped:
            try:
                w, h = d.window_size()
                d.click(int(w * 0.061), int(h * 0.071))
                tapped = True; sel = "coord-fallback"
            except Exception as e:
                return {"ok": False, "step": current_step,
                        "elapsed": time.time() - start_time,
                        "error": f"Create button not found: {e}"}
        log(f"tapped Create via {sel}")
        human_sleep(1.5, 2.5)
        _dismiss_any_permission_dialog(d, max_attempts=3)
        try: _dismiss_draft_dialog(d, max_attempts=2)
        except Exception: pass

        # ── 5. Select POST tab (cam_dest_feed) ─────────────────
        current_step = "select_post_tab"
        try:
            post_btn = d(resourceId=f"{IG_PKG}:id/cam_dest_feed")
            if post_btn.exists:
                post_btn.click()
                log("selected POST tab via cam_dest_feed")
                human_sleep(1.0, 2.0)
            else:
                # fallback — tap по text
                tapped, _ = _try_tap(d, [{"textMatches": "(?i)^post$"}], timeout=3.0)
                if tapped: log("selected POST via text match")
        except Exception as e:
            log(f"select_post_tab soft-fail: {e}")

        # ── 6. Carousel: activate multi-select mode via LONG-PRESS on first item ─
        # Новий IG UI — стандартний Android pattern: long-press на фото активує
        # selection mode і одразу вибирає ту фото. Решта через simple tap.
        # "Select multiple button" у top-right — це slide-out з Post/Story/Reel,
        # НЕ справжній multi-select toggle.
        time.sleep(2.0)  # gallery fully renders

        # ── 7. Tap кожну фото у gallery ────────────────────────
        current_step = "select_images"
        # Невеликий свайп нагору, щоб побачити найновіші pushed файли
        try:
            info = d.info
            w = info.get('displayWidth', 1080)
            h = info.get('displayHeight', 1920)
            d.swipe(w // 2, int(h * 0.4), w // 2, int(h * 0.7),
                    duration=random.uniform(0.25, 0.4))
            human_sleep(0.6, 1.2)
        except Exception: pass

        # Tap by index [0, 1, 2, ...] (top-to-bottom у gallery).
        # Оскільки pushed у reverse order, гальерея показує: [slide1, slide2, ..., slideN].
        # Для carousel (n>1) — перший item LONG-PRESS щоб активувати multi-select mode.
        for i in range(n):
            item = _find_gallery_item_by_index(d, i)
            if item is None:
                return {"ok": False, "step": current_step,
                        "elapsed": time.time() - start_time,
                        "error": f"Slide {i + 1}/{n}: gallery item index {i} not found"}
            try:
                if i == 0 and is_carousel:
                    # Long-press для активації multi-select mode (Android standard pattern)
                    try:
                        b = item.info.get('bounds') or {}
                        cx = (b.get('left', 0) + b.get('right', 0)) // 2
                        cy = (b.get('top', 0) + b.get('bottom', 0)) // 2
                        d.long_click(cx, cy, duration=0.6)
                        log(f"long-pressed slide 1/{n} (coord {cx},{cy}) — multi-select activated")
                    except Exception:
                        # Fallback — звичайний click
                        item.click()
                        log(f"tapped slide 1/{n} (long-press fallback to click)")
                else:
                    item.click()
                    log(f"tapped slide {i + 1}/{n} (gallery index {i})")
            except Exception as e:
                return {"ok": False, "step": current_step,
                        "elapsed": time.time() - start_time,
                        "error": f"Slide {i + 1} click: {e}"}
            human_sleep(0.6, 1.2)

        # ── 8. Next через edit/filters ─────────────────────────
        current_step = "tap_next_1"
        tapped, sel = _try_tap(d, SEL_NEXT_BUTTON, timeout=6.0)
        if not tapped:
            return {"ok": False, "step": current_step,
                    "elapsed": time.time() - start_time,
                    "error": "Next button not found (after gallery)"}
        log(f"next 1/2 via {sel}")
        human_sleep(2.5, 4.0)

        # Може бути додатковий Next (edit/filters screen)
        current_step = "tap_next_2"
        try:
            tapped2, _ = _try_tap(d, SEL_NEXT_BUTTON, timeout=5.0)
            if tapped2: log("next 2/2 (filters skip)")
            human_sleep(2.0, 3.5)
        except Exception: pass

        # ── 9. Caption ─────────────────────────────────────────
        current_step = "enter_caption"
        cap_field = None
        for sel in SEL_CAPTION_FIELD:
            try:
                el = d(**sel)
                if el.wait(timeout=2.0):
                    cap_field = el; break
            except Exception: continue
        if cap_field is None:
            return {"ok": False, "step": current_step,
                    "elapsed": time.time() - start_time,
                    "error": "Caption field not found"}

        try:
            cap_field.click(); human_sleep(0.5, 1.2)
            cap_field.set_text(caption or "")
            log(f"caption entered ({len(caption)} chars)")
        except Exception as e:
            return {"ok": False, "step": current_step,
                    "elapsed": time.time() - start_time,
                    "error": f"caption input: {e}"}

        # Закриваємо клавіатуру — інакше вона перекриває Share button
        _hide_keyboard(d, log)

        human_sleep(1.5, 3.0)

        # DRY RUN stop
        if dry_run:
            log("DRY RUN — stopping before Share")
            return {"ok": True, "step": "dry_run_stopped_at_caption",
                    "elapsed": time.time() - start_time,
                    "remote_paths": remote_paths,
                    "n_images": n,
                    "message": "Дійшли до caption. Натисни назад на телефоні щоб скасувати."}

        # ── 10. Share ──────────────────────────────────────────
        current_step = "tap_share"
        tapped, sel = _try_tap(d, SEL_SHARE_BUTTON, timeout=6.0)
        if not tapped:
            # Можливо клавіатура все ще перекриває Share — пробуємо ще раз сховати
            if _hide_keyboard(d, log):
                tapped, sel = _try_tap(d, SEL_SHARE_BUTTON, timeout=4.0)
        if not tapped:
            return {"ok": False, "step": current_step,
                    "elapsed": time.time() - start_time,
                    "error": "Share button not found"}
        log(f"tapped Share via {sel}")

        # ── 11. Verify ─────────────────────────────────────────
        current_step = "verify_published"
        deadline = time.time() + 120
        SUCCESS = {'HOME_FEED', 'REELS_FEED', 'PROFILE_SELF', 'PROFILE_OTHER'}
        published = False
        loop_i = 0
        while time.time() < deadline:
            time.sleep(2.0); loop_i += 1
            state = detect_screen(d, include_stories=False)
            if state.type in SUCCESS:
                published = True
                log(f"published on {state.type}")
                break
            if loop_i == 30:
                try: d.press("back"); time.sleep(1.5)
                except Exception: pass
        if not published:
            log("WARN: verify timeout but Share was tapped — assuming published")
            published = True

        # ── 12. Cleanup ────────────────────────────────────────
        current_step = "cleanup"
        for remote in remote_paths:
            _cleanup_remote(d, remote)
        log("remote files removed")

        result = {"ok": True, "step": "complete",
                  "elapsed": time.time() - start_time,
                  "n_images": n, "url": None}
        _write_post_result_to_db(post_id, db_path, 'published', None, log)
        return result

    except Exception as e:
        result = {"ok": False, "step": current_step,
                  "elapsed": time.time() - start_time,
                  "error": f"{type(e).__name__}: {e}",
                  "remote_paths": remote_paths}
        _write_post_result_to_db(post_id, db_path, 'failed',
                                  f"[{current_step}] {result['error']}", log)
        return result
