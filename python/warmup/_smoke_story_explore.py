"""Smoke test story + explore.

Використання:
  python -m warmup._smoke_story_explore 192.168.0.7:5555

Сценарій:
  1. Home → перевірка story tray (чи є unviewed)
  2. Якщо є — відкрити першу unviewed story
  3. Watch → tap_next → swipe_down_exit (повернутися в Home)
  4. Explore → 3x explore_scroll → назад у Home

ПЕРЕД ЗАПУСКОМ: відкрий IG на головній, бажано щоб було кілька непереглянутих
сторіс (попроси друга зробити story або відкрий бота з активним акаунтом).
Якщо unviewed нема — блок story пропуститься, але explore відтестуємо.
"""

from __future__ import annotations

import sys
import time

import uiautomator2 as u2

from warmup.actions import execute
from warmup.policy import PlannedAction
from warmup.state_detector import detect_screen


def run_action(d, kind: str, **params):
    print(f"\n→ {kind}" + (f" {params}" if params else ""))
    state = detect_screen(d)
    print(f"    before: {state!r}")
    pl = PlannedAction(kind, reason='smoke', params=params)
    result = execute(d, pl, state)
    print(f"    result: {result!r}")
    if result.side_effects:
        for k, v in result.side_effects.items():
            print(f"      {k}: {v}")
    return result


def main() -> None:
    serial = sys.argv[1] if len(sys.argv) > 1 else None
    d = u2.connect(serial) if serial else u2.connect()
    print(f"[smoke-story] connected to {serial or 'default'}")

    # Ensure on HOME_FEED
    state = detect_screen(d)
    if state.type == 'SCREEN_LOCKED':
        run_action(d, 'wake_and_unlock')
    if state.type == 'INSTAGRAM_NOT_OPEN':
        run_action(d, 'open_instagram')
    state = detect_screen(d)
    if state.type != 'HOME_FEED':
        run_action(d, 'goto_home')
        time.sleep(1.0)

    # 1. Detect story tray
    state = detect_screen(d)
    print(f"\nHome state: {state!r}")
    print(f"  total_stories_in_tray: {state.total_stories_in_tray}")
    print(f"  unviewed_story_positions: {state.unviewed_story_positions}")

    # 2. Story cycle (тільки якщо є unviewed)
    if state.has_unviewed_stories and state.unviewed_story_positions:
        idx = state.unviewed_story_positions[0]
        r = run_action(d, 'open_unviewed_story', story_index=idx)
        if r.ok:
            time.sleep(1.0)
            run_action(d, 'story_watch')
            time.sleep(0.5)
            run_action(d, 'story_tap_next')
            time.sleep(0.8)
            run_action(d, 'story_tap_next')
            time.sleep(0.8)
            # Exit via swipe down
            run_action(d, 'story_swipe_down_exit')
    else:
        print("\n[story] skip — no unviewed stories")
        # Можна спробувати відкрити переглянуту, але політика це не робить у проді
        # Тут просто нотатка для тестера

    # 3. Explore test
    time.sleep(1.0)
    run_action(d, 'goto_explore')
    time.sleep(1.0)
    for i in range(3):
        run_action(d, 'explore_scroll')
        time.sleep(0.6)

    # 4. Повернення у home
    time.sleep(0.8)
    run_action(d, 'goto_home')

    print("\n[smoke-story] done")


if __name__ == "__main__":
    main()
