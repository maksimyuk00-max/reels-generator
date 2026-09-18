"""Recovery actions — коли ми в поганому/невідомому стані.

Реалізує: wait, wake_and_unlock, recover_back, close_modal, open_instagram,
skip_ad.
"""

from __future__ import annotations

import random
import re
import time

from . import _register, ExecutionResult
from ..state_detector import detect_screen, IG_PKG
from ..humanize import human_sleep, human_swipe, jitter_coords

IG_PACKAGE = IG_PKG


# ───── wait ────────────────────────────────────────────────────────

@_register('wait')
def a_wait(d, planned, state) -> ExecutionResult:
    """Просто пауза — для transient UNKNOWN / completion анімацій."""
    human_sleep(1.0, 2.5)
    return ExecutionResult(ok=True)


# ───── wake & unlock ───────────────────────────────────────────────

@_register('wake_and_unlock')
def a_wake_and_unlock(d, planned, state) -> ExecutionResult:
    """Розбудити екран і зняти lockscreen.

    Кроки:
      1. KEYCODE_WAKEUP (увімкнути екран)
      2. Чекаємо 1с — lockscreen зʼявляється
      3. Якщо треба — свайп знизу вгору щоб зняти lock
      4. Verify: screenOn=True
    """
    try:
        d.shell("input keyevent KEYCODE_WAKEUP")
        time.sleep(1.0)

        info = d.info or {}
        if not info.get('screenOn', False):
            # другий wake (деякі девайси вимагають)
            d.shell("input keyevent KEYCODE_MENU")
            time.sleep(0.8)
            info = d.info or {}

        # Якщо lockscreen — swipe up
        w = info.get('displayWidth', 1080)
        h = info.get('displayHeight', 1920)

        # Spirit evidence: є lockscreen_status_view, або текст "Swipe" / "Unlock"
        has_lock = False
        try:
            if d(resourceId="com.android.systemui:id/lockscreen_status_view").exists:
                has_lock = True
            elif d(descriptionContains="unlock").exists:
                has_lock = True
            elif d(textContains="Swipe").exists:
                has_lock = True
        except Exception:
            pass

        if has_lock:
            d.swipe(w // 2, int(h * 0.8), w // 2, int(h * 0.2),
                    duration=random.uniform(0.35, 0.55))
            time.sleep(1.2)

        # Перевірка
        info = d.info or {}
        screen_on = info.get('screenOn', True)
        if not screen_on:
            return ExecutionResult(ok=False, error="screen still off after wake")

        return ExecutionResult(ok=True)
    except Exception as e:
        return ExecutionResult(ok=False, error=f"wake: {type(e).__name__}: {e}")


# ───── recover_back ────────────────────────────────────────────────

@_register('recover_back')
def a_recover_back(d, planned, state) -> ExecutionResult:
    """Натиснути back 1-3 рази щоб вийти з невідомого екрану."""
    try:
        presses = random.choice([1, 1, 2])  # переважно 1
        for i in range(presses):
            d.press("back")
            human_sleep(0.5, 0.9)
        return ExecutionResult(ok=True, side_effects={'presses': presses})
    except Exception as e:
        return ExecutionResult(ok=False, error=f"back: {e}")


# ───── close_modal ─────────────────────────────────────────────────

_CLOSE_TEXT_RE = re.compile(
    r"(?i)^(close|dismiss|not now|cancel|skip|maybe later|ok|ні дякую)$"
)


@_register('close_modal')
def a_close_modal(d, planned, state) -> ExecutionResult:
    """Закрити невідому модалку: шукаємо Close / Dismiss / X / Not now."""
    try:
        # 1. Шукаємо видиму кнопку з текстом close/dismiss
        for text_variant in ('Close', 'Dismiss', 'Not now', 'Not Now',
                              'Cancel', 'Skip', 'Maybe later', 'OK', 'Ok'):
            try:
                btn = d(text=text_variant)
                if btn.exists:
                    btn.click()
                    human_sleep(0.6, 1.0)
                    return ExecutionResult(ok=True,
                                            side_effects={'closed_via': text_variant})
            except Exception:
                continue

        # 2. Шукаємо content-description close/dismiss
        for desc_variant in ('Close', 'Dismiss', 'Close dialog'):
            try:
                btn = d(descriptionContains=desc_variant)
                if btn.exists:
                    btn.click()
                    human_sleep(0.6, 1.0)
                    return ExecutionResult(ok=True,
                                            side_effects={'closed_via_desc': desc_variant})
            except Exception:
                continue

        # 3. Fallback — натиснути back
        d.press("back")
        human_sleep(0.6, 1.0)
        return ExecutionResult(ok=True, side_effects={'closed_via': 'back'})
    except Exception as e:
        return ExecutionResult(ok=False, error=f"close_modal: {e}")


# ───── open_instagram ──────────────────────────────────────────────

@_register('open_instagram')
def a_open_instagram(d, planned, state) -> ExecutionResult:
    """Запустити IG якщо він не foreground. З retry + verify."""
    try:
        # 1. Спочатку force-stop (раптом IG в поганому стані)
        try:
            d.app_stop(IG_PACKAGE)
            time.sleep(0.8)
        except Exception:
            pass

        # 2. Запускаємо через monkey (main launcher intent)
        try:
            d.app_start(IG_PACKAGE, use_monkey=True)
        except Exception as e:
            return ExecutionResult(ok=False, error=f"app_start: {e}")

        # 3. Чекаємо з retry + verify — spam тривалістю до 15s
        deadline = time.time() + 15
        while time.time() < deadline:
            time.sleep(1.2)
            try:
                app = d.app_current()
                if app.get('package') == IG_PACKAGE:
                    # IG foreground — дай йому час завантажити UI
                    time.sleep(2.0)
                    return ExecutionResult(ok=True,
                                            side_effects={'launched_in_s': round(15 - (deadline - time.time()), 1)})
            except Exception:
                continue

        return ExecutionResult(ok=False, error="IG did not reach foreground in 15s")
    except Exception as e:
        return ExecutionResult(ok=False, error=f"open_ig: {e}")


# ───── skip_ad ─────────────────────────────────────────────────────

@_register('skip_ad')
def a_skip_ad(d, planned, state) -> ExecutionResult:
    """Пропустити рекламу — скролимо як звичайний reel."""
    try:
        # Коротка пауза «удав би увагу» але прокрутив
        human_sleep(0.8, 1.8)
        # Реклама може бути у reels або у home — обидві скроляться up
        direction = 'up' if state.type == 'REELS_FEED' else 'up'
        human_swipe(d, direction=direction, strength=0.65, speed='normal')
        human_sleep(0.5, 1.0)
        return ExecutionResult(ok=True)
    except Exception as e:
        return ExecutionResult(ok=False, error=f"skip_ad: {e}")
