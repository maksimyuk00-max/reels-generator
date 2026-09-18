"""Profile actions (для PROFILE_OWN та PROFILE_OTHER).

Handlers:
  - profile_back    — повернутись (press back)
  - profile_scroll  — трохи прокрутити профіль (peek-поведінка)
"""

from __future__ import annotations

import random

from . import _register, ExecutionResult
from ..humanize import human_sleep, human_swipe
from ..state_detector import detect_screen


@_register('profile_back')
def a_profile_back(d, planned, state) -> ExecutionResult:
    """Press back to leave profile."""
    try:
        d.press("back")
        human_sleep(0.7, 1.2)
        new_state = detect_screen(d, include_stories=False)
        return ExecutionResult(
            ok=True,
            side_effects={'new_state_type': new_state.type},
        )
    except Exception as e:
        return ExecutionResult(ok=False, error=f"profile_back: {e}")


@_register('profile_scroll')
def a_profile_scroll(d, planned, state) -> ExecutionResult:
    """Невеликий скрол по профілю (як реальний peek)."""
    try:
        # переважно скрол вниз (дивимось grid постів), інколи вгору
        direction = 'up' if random.random() < 0.85 else 'down'
        strength = random.uniform(0.40, 0.65)
        human_swipe(d, direction=direction, strength=strength, speed='slow')
        human_sleep(0.8, 2.0)
        return ExecutionResult(ok=True, side_effects={'scrolled': True})
    except Exception as e:
        return ExecutionResult(ok=False, error=f"profile_scroll: {e}")
