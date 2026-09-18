"""Reels actions — перегляд / скрол / лайк / сейв / peek автора.

Handlers:
  - reel_watch            (пасивна пауза з micro-actions)
  - reel_scroll_next      (swipe up)
  - reel_scroll_prev      (swipe down, rare re-watch)
  - reel_like             (double-tap АБО like-button tap)
  - reel_save             (save button — bookmark icon)
  - reel_peek_author      (тап на username → PROFILE_OTHER → виконає policy)
"""

from __future__ import annotations

import random
import re
import time
from xml.etree import ElementTree as ET

from . import _register, ExecutionResult
from ..humanize import (
    human_sleep, human_swipe, human_tap, human_double_tap,
    micro_actions_during_watch, jitter_coords,
)
from ..state_detector import detect_screen, IG_PKG


# ───── reel_watch ──────────────────────────────────────────────────

@_register('reel_watch')
def a_reel_watch(d, planned, state) -> ExecutionResult:
    """Пасивно дивимось current reel 3-12 секунд з human behavior."""
    duration = random.uniform(3.5, 12.0)
    try:
        micro_actions_during_watch(d, duration, reel_mode=True)
        return ExecutionResult(ok=True,
                                side_effects={'watched': True, 'watch_time': duration})
    except Exception as e:
        return ExecutionResult(ok=False, error=f"watch: {e}")


# ───── reel_scroll_next ────────────────────────────────────────────

@_register('reel_scroll_next')
def a_reel_scroll_next(d, planned, state) -> ExecutionResult:
    """Свайп вгору → наступний reel. Спочатку трохи дивимось (як user)."""
    try:
        # Коротка пауза (0-3s "випадковий погляд") — реальний user не скролить
        # миттєво після попереднього reel
        human_sleep(0.3, 2.5)

        human_swipe(d, direction='up',
                    strength=random.uniform(0.60, 0.80),
                    speed=random.choice(['normal', 'normal', 'fast']))
        # Час для завантаження наступного reel
        human_sleep(0.5, 1.2)
        return ExecutionResult(ok=True, side_effects={'reel_advanced': True})
    except Exception as e:
        return ExecutionResult(ok=False, error=f"scroll_next: {e}")


# ───── reel_scroll_prev ────────────────────────────────────────────

@_register('reel_scroll_prev')
def a_reel_scroll_prev(d, planned, state) -> ExecutionResult:
    """Rare re-watch: свайп вниз трохи (повернутись до попереднього)."""
    try:
        human_swipe(d, direction='down',
                    strength=random.uniform(0.55, 0.75),
                    speed='normal')
        human_sleep(0.4, 0.9)
        return ExecutionResult(ok=True, side_effects={'reel_reversed': True})
    except Exception as e:
        return ExecutionResult(ok=False, error=f"scroll_prev: {e}")


# ───── reel_like ───────────────────────────────────────────────────

@_register('reel_like')
def a_reel_like(d, planned, state) -> ExecutionResult:
    """Лайкнути current reel. 50% double-tap, 50% like-button.

    Double-tap — природніший жест (як юзери на iOS/Android).
    """
    # Якщо вже лайкнуто — skip
    if state.current_liked:
        return ExecutionResult(ok=True, side_effects={'liked': False,
                                                        'already_liked': True})

    try:
        info = d.info or {}
        w = info.get('displayWidth', 1080)
        h = info.get('displayHeight', 1920)

        method = random.choice(['double_tap', 'button', 'button'])  # 33/66

        if method == 'double_tap':
            # центр екрану (де reel)
            x = w // 2
            y = int(h * random.uniform(0.42, 0.55))
            human_double_tap(d, x, y, jitter=20)
            human_sleep(0.6, 1.1)
        else:
            # like button — шукаємо через resourceId
            btn = _find_reel_button(d, suffix_candidates=[
                'like_button', 'row_feed_button_like',
            ])
            if btn is None:
                # fallback на double-tap
                x = w // 2
                y = int(h * random.uniform(0.42, 0.55))
                human_double_tap(d, x, y, jitter=20)
            else:
                btn.click()
            human_sleep(0.5, 1.0)

        # Verify via re-detect
        new_state = detect_screen(d)
        liked = new_state.current_liked
        return ExecutionResult(ok=True,
                                side_effects={'liked': liked,
                                              'method': method})
    except Exception as e:
        return ExecutionResult(ok=False, error=f"like: {e}")


# ───── reel_save ───────────────────────────────────────────────────

@_register('reel_save')
def a_reel_save(d, planned, state) -> ExecutionResult:
    """Зберегти reel через save button (bookmark icon)."""
    if state.current_saved:
        return ExecutionResult(ok=True, side_effects={'saved': False,
                                                        'already_saved': True})

    try:
        btn = _find_reel_button(d, suffix_candidates=[
            'save_button', 'row_feed_button_save',
        ])
        if btn is None:
            return ExecutionResult(ok=False, error="save button not found")
        btn.click()
        human_sleep(0.6, 1.2)

        new_state = detect_screen(d)
        return ExecutionResult(ok=True,
                                side_effects={'saved': new_state.current_saved})
    except Exception as e:
        return ExecutionResult(ok=False, error=f"save: {e}")


# ───── reel_peek_author ────────────────────────────────────────────

@_register('reel_peek_author')
def a_reel_peek_author(d, planned, state) -> ExecutionResult:
    """Тап на username автора reel → PROFILE_OTHER.

    Повертатися буде policy (через action=profile_back).
    """
    try:
        # У reels username зазвичай внизу-ліворуч. Шукаємо resourceId варіанти.
        btn = None
        for rid in ('clips_author_username', 'clips_author_info',
                     'reel_viewer_title_text', 'username', 'author_view'):
            try:
                el = d(resourceId=f"{IG_PKG}:id/{rid}")
                if el.exists:
                    btn = el
                    break
            except Exception:
                continue

        if btn is None:
            # Fallback: координати внизу-ліворуч (reel overlay)
            info = d.info or {}
            w = info.get('displayWidth', 1080)
            h = info.get('displayHeight', 1920)
            x = int(w * random.uniform(0.15, 0.30))
            y = int(h * random.uniform(0.78, 0.85))
            human_tap(d, x, y, jitter=8)
        else:
            btn.click()

        human_sleep(1.2, 2.0)
        new_state = detect_screen(d)
        ok = new_state.type == 'PROFILE_OTHER'
        return ExecutionResult(ok=ok,
                                error='' if ok else f'expected PROFILE_OTHER, got {new_state.type}',
                                side_effects={'peeked': ok,
                                              'new_state_type': new_state.type})
    except Exception as e:
        return ExecutionResult(ok=False, error=f"peek: {e}")


# ───── Helpers ─────────────────────────────────────────────────────

def _find_reel_button(d, suffix_candidates: list[str]):
    """Серед кандидатів resourceId повернути перший існуючий selector."""
    for suffix in suffix_candidates:
        try:
            el = d(resourceId=f"{IG_PKG}:id/{suffix}")
            if el.exists:
                return el
        except Exception:
            continue
    return None
