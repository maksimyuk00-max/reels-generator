"""Story viewer actions.

  - open_unviewed_story  (з HOME_FEED → STORY_VIEWER, тап на story tray item)
  - story_watch          (просто дивимось 2-4с)
  - story_tap_next       (тап праворуч → наступна story тієї ж або наступного юзера)
  - story_swipe_down_exit (свайп вниз — як user підказав)
"""

from __future__ import annotations

import random
import time
from xml.etree import ElementTree as ET

from . import _register, ExecutionResult
from ..humanize import human_sleep, human_swipe, jitter_coords, human_tap
from ..state_detector import detect_screen, IG_PKG


# ───── open_unviewed_story ────────────────────────────────────────

@_register('open_unviewed_story')
def a_open_unviewed_story(d, planned, state) -> ExecutionResult:
    """З HOME_FEED тапнути на story tray item у заданому індексі.

    params: {'story_index': int} — індекс непереглянутої сторіс у поточному
    tray (0-based, "Your story" виключено, тільки story items).
    """
    target_idx = int(planned.params.get('story_index', 0))

    try:
        # Ще раз знайдемо координати story у tray через dump_hierarchy,
        # бо positions у state могли застаріти.
        xml = d.dump_hierarchy()
        coords = _find_nth_unviewed_story_coords(xml, target_idx)
        if coords is None:
            return ExecutionResult(ok=False,
                                    error=f"story at index {target_idx} not found in tray")

        x, y = coords
        human_tap(d, x, y, jitter=8)
        human_sleep(1.2, 2.0)  # story зазвичай підвантажується ~1s

        # Verify
        new_state = detect_screen(d)
        if new_state.type == 'STORY_VIEWER':
            return ExecutionResult(ok=True,
                                    side_effects={'new_state_type': 'STORY_VIEWER'})

        return ExecutionResult(ok=False,
                                error=f"expected STORY_VIEWER, got {new_state.type}",
                                side_effects={'new_state_type': new_state.type})
    except Exception as e:
        return ExecutionResult(ok=False,
                                error=f"open_story: {type(e).__name__}: {e}")


# ───── story_watch ─────────────────────────────────────────────────

@_register('story_watch')
def a_story_watch(d, planned, state) -> ExecutionResult:
    """Просто дивимось story без дій. 2-4 сек.

    IG autoadvance'ить story приблизно за 5-7с відео і 7с фото, тому якщо
    чекати довше — перейдемо на наступну. Цей handler робить коротку паузу
    без переходу."""
    human_sleep(1.8, 3.5)
    return ExecutionResult(ok=True, side_effects={'story_watched': True})


# ───── story_tap_next ──────────────────────────────────────────────

@_register('story_tap_next')
def a_story_tap_next(d, planned, state) -> ExecutionResult:
    """Тап на праву частину екрану → наступний story frame або user.

    IG обробляє:
      - лівий тап (<30% ширини)    → попередній frame
      - правий тап (>30% ширини)   → наступний frame
    """
    try:
        info = d.info or {}
        w = info.get('displayWidth', 1080)
        h = info.get('displayHeight', 1920)

        # Правий тап: 80% ширини, десь посередині по висоті
        x = int(w * random.uniform(0.75, 0.92))
        y = int(h * random.uniform(0.40, 0.62))
        human_tap(d, x, y, jitter=15)
        human_sleep(0.5, 1.0)

        # Перевіримо чи все ще у story (інакше закінчились)
        new_state = detect_screen(d)
        return ExecutionResult(ok=True,
                                side_effects={
                                    'story_advanced': True,
                                    'new_state_type': new_state.type,
                                })
    except Exception as e:
        return ExecutionResult(ok=False, error=f"tap_next: {e}")


# ───── story_swipe_down_exit ───────────────────────────────────────

@_register('story_swipe_down_exit')
def a_story_swipe_down_exit(d, planned, state) -> ExecutionResult:
    """Вийти зі сторіс свайпом вниз (як user зазначив — back не спрацьовує)."""
    try:
        info = d.info or {}
        w = info.get('displayWidth', 1080)
        h = info.get('displayHeight', 1920)

        # Свайп згори вниз, ~40% висоти
        x1 = int(w * 0.5) + random.randint(-40, 40)
        y1 = int(h * 0.20)
        x2 = x1 + random.randint(-20, 20)
        y2 = int(h * 0.75)

        d.swipe(x1, y1, x2, y2, duration=random.uniform(0.25, 0.45))
        human_sleep(0.8, 1.3)

        new_state = detect_screen(d, include_stories=False)
        ok = new_state.type != 'STORY_VIEWER'
        return ExecutionResult(ok=ok,
                                error='' if ok else 'still in story viewer',
                                side_effects={'new_state_type': new_state.type})
    except Exception as e:
        return ExecutionResult(ok=False, error=f"swipe_exit: {e}")


# ───── Helpers ─────────────────────────────────────────────────────

def _find_nth_unviewed_story_coords(xml: str, target_idx: int) -> tuple[int, int] | None:
    """Знайти координати N-го непереглянутого story item у tray.

    target_idx — індекс серед непереглянутих (0 = перший unviewed).

    Сумісно з state_detector._scan_story_tray: той самий формат парсингу
    "<name>'s story, N of M, Seen/Unseen." + дедуп по username + виключення
    власної сторіс ("0 of N" placeholder).
    """
    import re

    try:
        root = ET.fromstring(xml)
    except ET.ParseError:
        return None

    # Шукаємо tray у двох варіантах resourceId (сучасний + legacy)
    tray_rids = (f"{IG_PKG}:id/reels_tray_container",
                  f"{IG_PKG}:id/reel_tray_recycler_view")
    tray_node = None
    for node in root.iter():
        if node.attrib.get('resource-id') in tray_rids:
            tray_node = node
            break
    if tray_node is None:
        return None

    # Regex для modern format
    story_desc_re = re.compile(
        r"^(.*?)'s story,\s*(\d+)\s*of\s*(\d+),\s*(Seen|Unseen)\.?$",
        re.IGNORECASE,
    )
    legacy_unseen = re.compile(r"(?i)\bnot seen\b|\bunseen\b|не переглянут|новая история")
    legacy_seen = re.compile(r"(?i)\bseen\b|переглянут")
    your_re = re.compile(r"(?i)your story|ваша истор|ваша історі")
    # "Add to story" placeholder у tray містить слово "story" — треба виключити
    exclude_re = re.compile(
        r"(?i)^(add to (your )?story|create|create story|create new)$"
    )
    bounds_re = re.compile(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]')

    # username -> (cx, cy) для одного item (беремо найбільший видимий bounds)
    per_user: dict[str, tuple[int, int, int]] = {}  # uname_key -> (cx, cy, area)
    unviewed_users: list[str] = []                  # порядок знайдення

    for child in tray_node.iter():
        if child is tray_node:
            continue
        desc = child.attrib.get('content-desc', '').strip()
        if not desc or your_re.search(desc) or exclude_re.match(desc):
            continue

        bounds_str = child.attrib.get('bounds', '')
        bm = bounds_re.match(bounds_str)
        if not bm:
            continue
        x1, y1, x2, y2 = map(int, bm.groups())
        w = x2 - x1
        h = y2 - y1
        if w < 60 or h < 60:
            continue
        area = w * h
        cx, cy = (x1 + x2) // 2, (y1 + y2) // 2

        # Modern format
        m = story_desc_re.match(desc)
        if m:
            username = m.group(1).strip()
            n_watched = int(m.group(2))
            total = int(m.group(3))
            state_word = m.group(4).lower()

            # Виключаємо власну (0 of N placeholder)
            if n_watched == 0 and total > 0:
                continue

            uname_key = username.lower()
            is_unseen = state_word == 'unseen'

            # Беремо найбільший bounds на того самого користувача
            prev = per_user.get(uname_key)
            if prev is None or area > prev[2]:
                per_user[uname_key] = (cx, cy, area)

            if is_unseen and uname_key not in unviewed_users:
                unviewed_users.append(uname_key)
            continue

        # Legacy fallback (якщо modern не знайдено)
        if not per_user and 'story' in desc.lower():
            is_unseen = bool(legacy_unseen.search(desc))
            is_seen = bool(legacy_seen.search(desc))
            fake_key = f"legacy_{len(per_user)}"
            per_user[fake_key] = (cx, cy, area)
            if (is_unseen or not is_seen) and fake_key not in unviewed_users:
                unviewed_users.append(fake_key)

    if not unviewed_users:
        return None

    idx = min(target_idx, len(unviewed_users) - 1)
    target_user = unviewed_users[idx]
    cx, cy, _ = per_user[target_user]
    return (cx, cy)
