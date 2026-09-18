"""Explore tab — просто скроллимо (як юзер просив, без тапів у результати)."""

from __future__ import annotations

import random

from . import _register, ExecutionResult
from ..humanize import human_sleep, human_swipe


@_register('explore_scroll')
def a_explore_scroll(d, planned, state) -> ExecutionResult:
    """Скролл сітки Explore вгору-вниз з human easing."""
    try:
        # 90% скрол вниз (дивимось далі), 10% трохи вгору
        direction = 'up' if random.random() < 0.9 else 'down'
        strength = random.uniform(0.55, 0.85)
        speed = random.choice(['normal', 'normal', 'slow'])
        human_swipe(d, direction=direction, strength=strength, speed=speed)
        human_sleep(0.8, 2.2)   # дивимось сітку
        return ExecutionResult(ok=True, side_effects={'explored': True})
    except Exception as e:
        return ExecutionResult(ok=False, error=f"explore_scroll: {e}")
