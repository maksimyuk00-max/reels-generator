"""Home feed actions — перегляд стрічки, лайки постів, peek автора.

Handlers:
  - home_scroll_down
  - home_scroll_up_slightly   (re-read)
  - home_like_current         (лайк поста що зараз у фокусі)
  - home_save_current
  - home_peek_author
  - home_open_current_post    (тап на пост → POST_DETAIL)
"""

from __future__ import annotations

import random
import re
from xml.etree import ElementTree as ET

from . import _register, ExecutionResult
from ..humanize import (
    human_sleep, human_swipe, human_tap, human_double_tap,
    jitter_coords,
)
from ..state_detector import detect_screen, IG_PKG


# ───── scroll ──────────────────────────────────────────────────────

@_register('home_scroll_down')
def a_home_scroll_down(d, planned, state) -> ExecutionResult:
    """Скрол вниз на 1-1.5 поста. Human speed."""
    try:
        # Розглядаємо поточний пост 1-4с, потім скролимо
        human_sleep(1.0, 3.5)
        human_swipe(d, direction='up',
                    strength=random.uniform(0.55, 0.75),
                    speed=random.choice(['normal', 'normal', 'slow']))
        human_sleep(0.6, 1.4)
        return ExecutionResult(ok=True, side_effects={'scrolled': 'down'})
    except Exception as e:
        return ExecutionResult(ok=False, error=f"scroll: {e}")


@_register('home_scroll_up_slightly')
def a_home_scroll_up_slightly(d, planned, state) -> ExecutionResult:
    """Невеликий скрол назад — re-read попереднього поста."""
    try:
        human_swipe(d, direction='down',
                    strength=random.uniform(0.30, 0.50),
                    speed='slow')
        human_sleep(1.0, 2.5)
        return ExecutionResult(ok=True, side_effects={'scrolled': 'up_slight'})
    except Exception as e:
        return ExecutionResult(ok=False, error=f"scroll_up: {e}")


# ───── like ────────────────────────────────────────────────────────

@_register('home_like_current')
def a_home_like_current(d, planned, state) -> ExecutionResult:
    """Лайк видимого поста. Пріоритет:
       1. Double-tap на media зображення (природно)
       2. Tap по like button (row_feed_button_like)
    """
    if state.current_liked:
        return ExecutionResult(ok=True, side_effects={'liked': False,
                                                        'already_liked': True})

    try:
        # Знаходимо видимий пост у фіді (найближчий до центру)
        post_bounds = _find_visible_feed_post_bounds(d)

        method = random.choice(['double_tap', 'button', 'button'])  # 33/66

        if method == 'double_tap' and post_bounds:
            x1, y1, x2, y2 = post_bounds
            cx = (x1 + x2) // 2
            cy = (y1 + y2) // 2
            human_double_tap(d, cx, cy, jitter=15)
        else:
            # Tap по button (шукаємо like button у tree)
            btn = _find_feed_button(d, 'row_feed_button_like')
            if btn is None and post_bounds:
                # fallback double-tap
                x1, y1, x2, y2 = post_bounds
                human_double_tap(d, (x1+x2)//2, (y1+y2)//2, jitter=15)
            elif btn is None:
                return ExecutionResult(ok=False, error="like button not found")
            else:
                btn.click()

        human_sleep(0.6, 1.2)
        new_state = detect_screen(d)
        return ExecutionResult(ok=True,
                                side_effects={'liked': new_state.current_liked,
                                              'method': method})
    except Exception as e:
        return ExecutionResult(ok=False, error=f"like: {e}")


# ───── save ────────────────────────────────────────────────────────

@_register('home_save_current')
def a_home_save_current(d, planned, state) -> ExecutionResult:
    """Save (bookmark) видимий пост."""
    if state.current_saved:
        return ExecutionResult(ok=True, side_effects={'saved': False,
                                                        'already_saved': True})

    try:
        btn = _find_feed_button(d, 'row_feed_button_save')
        if btn is None:
            return ExecutionResult(ok=False, error="save button not found")
        btn.click()
        human_sleep(0.6, 1.2)
        new_state = detect_screen(d)
        return ExecutionResult(ok=True,
                                side_effects={'saved': new_state.current_saved})
    except Exception as e:
        return ExecutionResult(ok=False, error=f"save: {e}")


# ───── peek author ─────────────────────────────────────────────────

@_register('home_peek_author')
def a_home_peek_author(d, planned, state) -> ExecutionResult:
    """Тап на username/avatar автора видимого поста → PROFILE_OTHER."""
    try:
        # Варіанти resourceId для username
        btn = None
        for rid in ('row_feed_photo_profile_name', 'row_feed_profile_header_username',
                     'username', 'profile_name_view'):
            try:
                el = d(resourceId=f"{IG_PKG}:id/{rid}")
                if el.exists:
                    btn = el
                    break
            except Exception:
                continue

        if btn is None:
            # Fallback: тап на верх видимого поста (там зазвичай header)
            bounds = _find_visible_feed_post_bounds(d)
            if bounds is None:
                return ExecutionResult(ok=False, error="no visible post")
            x1, y1, x2, y2 = bounds
            # верхня частина поста = header з username
            x = x1 + int((x2 - x1) * 0.30)
            y = y1 + int((y2 - y1) * 0.08)
            human_tap(d, x, y, jitter=6)
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


# ───── open current post ───────────────────────────────────────────

@_register('home_open_current_post')
def a_home_open_current_post(d, planned, state) -> ExecutionResult:
    """Тап на media поста → POST_DETAIL.

    Не робимо double-tap (це лайк). Короткий single-tap на зображення.
    """
    try:
        bounds = _find_visible_feed_post_bounds(d)
        if bounds is None:
            return ExecutionResult(ok=False, error="no visible post")
        x1, y1, x2, y2 = bounds
        cx = (x1 + x2) // 2
        cy = int((y1 + y2) / 2)
        human_tap(d, cx, cy, jitter=10)
        human_sleep(0.8, 1.4)
        new_state = detect_screen(d)
        return ExecutionResult(ok=True,
                                side_effects={'new_state_type': new_state.type})
    except Exception as e:
        return ExecutionResult(ok=False, error=f"open_post: {e}")


# ───── Helpers ─────────────────────────────────────────────────────

def _find_feed_button(d, rid_suffix: str):
    try:
        el = d(resourceId=f"{IG_PKG}:id/{rid_suffix}")
        if el.exists:
            return el
    except Exception:
        pass
    return None


def _find_visible_feed_post_bounds(d) -> tuple[int, int, int, int] | None:
    """Знайти координати видимого поста у фіді.

    Шукаємо найбільший контейнер поста (row_feed_photo_imageview / main_media)
    який перетинає центр екрану.
    """
    try:
        xml = d.dump_hierarchy()
        root = ET.fromstring(xml)
    except Exception:
        return None

    info = d.info or {}
    w = info.get('displayWidth', 1080)
    h = info.get('displayHeight', 1920)
    screen_cy = h // 2

    media_rids = [
        f"{IG_PKG}:id/row_feed_photo_imageview",
        f"{IG_PKG}:id/carousel_image",
        f"{IG_PKG}:id/media_view",
        f"{IG_PKG}:id/main_media_view",
    ]

    candidates: list[tuple[int, tuple[int, int, int, int]]] = []
    for node in root.iter():
        rid = node.attrib.get('resource-id', '')
        if rid not in media_rids:
            continue
        bounds_str = node.attrib.get('bounds', '')
        m = re.match(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]', bounds_str)
        if not m:
            continue
        x1, y1, x2, y2 = map(int, m.groups())
        if x2 - x1 < 100 or y2 - y1 < 100:
            continue
        # Пріоритет — бали близькості центру поста до центру екрану
        post_cy = (y1 + y2) // 2
        distance = abs(post_cy - screen_cy)
        candidates.append((distance, (x1, y1, x2, y2)))

    if not candidates:
        return None
    candidates.sort(key=lambda x: x[0])
    return candidates[0][1]
