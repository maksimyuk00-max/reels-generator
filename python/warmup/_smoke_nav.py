"""Smoke test navigation + recovery actions.

Використання:
  cd python
  python -m warmup._smoke_nav 192.168.0.7:5555

Прокрутить по колу: Home → Reels → Explore → Profile → Home.
Друкує elapsed + verify результат для кожної дії.

ПЕРЕКОНАЙСЯ: телефон розблоковано, IG відкрито (якщо ні — почне з open_instagram).
"""

from __future__ import annotations

import sys
import time

import uiautomator2 as u2

from warmup.actions import execute
from warmup.policy import PlannedAction
from warmup.state_detector import detect_screen


def main() -> None:
    serial = sys.argv[1] if len(sys.argv) > 1 else None
    d = u2.connect(serial) if serial else u2.connect()

    print(f"[smoke-nav] connected to {serial or 'default'}\n")

    # 0. Start from whatever state — open IG if needed
    state = detect_screen(d)
    print(f"  initial: {state!r}")

    if state.type == 'SCREEN_LOCKED':
        print("  → waking...")
        r = execute(d, PlannedAction('wake_and_unlock'), state)
        print(f"    {r!r}")
        state = detect_screen(d)

    if state.type == 'INSTAGRAM_NOT_OPEN':
        print("  → opening IG...")
        r = execute(d, PlannedAction('open_instagram'), state)
        print(f"    {r!r}")
        state = detect_screen(d)

    print(f"  ready: {state!r}\n")

    # Порядок: home → reels → explore → profile → home
    sequence = [
        'goto_home',
        'goto_reels',
        'goto_explore',
        'goto_profile_own',
        'goto_home',
    ]

    for kind in sequence:
        print(f"→ {kind}")
        state = detect_screen(d)
        print(f"    before: {state!r}")

        result = execute(d, PlannedAction(kind, reason='smoke'), state)
        print(f"    result: {result!r}")
        if result.side_effects:
            for k, v in result.side_effects.items():
                print(f"      {k}: {v}")

        # Пауза перед наступною дією (як orchestrator би робив)
        time.sleep(1.5)

    print("\n[smoke-nav] done")


if __name__ == "__main__":
    main()
