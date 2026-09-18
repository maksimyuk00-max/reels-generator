"""Bottom-tab navigation actions.

Реалізує: goto_home, goto_reels, goto_explore, goto_profile_own.
Кожна дія — тап по bottom tab через resourceId + verify через detect_screen.
"""

from __future__ import annotations

import time

from . import _register, ExecutionResult
from ..state_detector import detect_screen, IG_PKG
from ..humanize import human_sleep

# Відповідність kind → (bottom tab resourceId suffix, очікуваний тип screen)
_TAB_TARGETS = {
    'goto_home':         ('feed_tab',    'HOME_FEED'),
    'goto_reels':        ('clips_tab',   'REELS_FEED'),
    'goto_explore':      ('search_tab',  'EXPLORE'),
    'goto_profile_own':  ('profile_tab', 'PROFILE_OWN'),
}


def _tap_bottom_tab(d, tab_rid_suffix: str) -> bool:
    """Тапнути bottom tab через uiautomator2. Повертає True якщо знайшов.

    Bottom tabs іноді недоступні (ModalActivity на чужому профілі) —
    у цьому випадку повертаємо False, і caller має спершу зробити back.
    """
    try:
        el = d(resourceId=f"{IG_PKG}:id/{tab_rid_suffix}")
        if el.exists:
            el.click()
            return True
    except Exception:
        pass
    return False


def _press_back(d) -> None:
    try:
        d.press("back")
    except Exception:
        pass


def _goto_tab(d, planned, state, kind: str) -> ExecutionResult:
    """Спільна реалізація для всіх goto_* дій."""
    suffix, expected_type = _TAB_TARGETS[kind]

    # Якщо bottom tab не видний (напр. у ModalActivity) — back до 2 разів
    for _ in range(2):
        if _tap_bottom_tab(d, suffix):
            break
        _press_back(d)
        human_sleep(0.4, 0.8)
    else:
        # після 2 back все одно немає tabs — останній шанс
        if not _tap_bottom_tab(d, suffix):
            return ExecutionResult(ok=False,
                                    error=f"{suffix} not found after 2 backs")

    # Чекаємо анімацію переходу
    human_sleep(0.8, 1.4)

    # Verify — детектнули правильний екран?
    new_state = detect_screen(d, include_stories=(expected_type == 'HOME_FEED'))
    new_type = new_state.type

    ok = (new_type == expected_type)
    # PROFILE_OTHER теж OK для goto_profile_own якщо свій профіль іноді визначається як OTHER
    # (edge case — не використовуємо)

    return ExecutionResult(
        ok=ok,
        error='' if ok else f"expected {expected_type}, got {new_type}",
        side_effects={
            'new_state_type': new_type,
            'has_unviewed_stories': new_state.has_unviewed_stories,
            'unviewed_story_positions': new_state.unviewed_story_positions,
        },
    )


@_register('goto_home')
def a_goto_home(d, planned, state) -> ExecutionResult:
    return _goto_tab(d, planned, state, 'goto_home')


@_register('goto_reels')
def a_goto_reels(d, planned, state) -> ExecutionResult:
    return _goto_tab(d, planned, state, 'goto_reels')


@_register('goto_explore')
def a_goto_explore(d, planned, state) -> ExecutionResult:
    return _goto_tab(d, planned, state, 'goto_explore')


@_register('goto_profile_own')
def a_goto_profile_own(d, planned, state) -> ExecutionResult:
    return _goto_tab(d, planned, state, 'goto_profile_own')
