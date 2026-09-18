"""Safe smoke test Reels actions: scroll/watch/peek, БЕЗ лайку/сейву.

Використання:
  python -m warmup._smoke_reels 192.168.0.7:5555

Сценарій:
  1. Переконатись що в Reels tab
  2. reel_watch (пасивно 4-10с з micro-actions)
  3. reel_scroll_next 3 рази
  4. reel_peek_author → profile_back
  5. reel_scroll_next ще 2 рази

Лайк/сейв тестуємо окремо в _smoke_reels_like.py — щоб ти вирішив коли готовий.
"""

from __future__ import annotations

import sys
import time

import uiautomator2 as u2

from warmup.actions import execute
from warmup.policy import PlannedAction
from warmup.state_detector import detect_screen


def run(d, kind, **params):
    print(f"\n→ {kind}" + (f" {params}" if params else ""))
    state = detect_screen(d)
    print(f"    state: {state!r}")
    r = execute(d, PlannedAction(kind, reason='smoke', params=params), state)
    print(f"    result: {r!r}")
    if r.side_effects:
        for k, v in r.side_effects.items():
            print(f"      {k}: {v}")
    return r


def main() -> None:
    serial = sys.argv[1] if len(sys.argv) > 1 else None
    d = u2.connect(serial) if serial else u2.connect()

    state = detect_screen(d)
    if state.type == 'SCREEN_LOCKED':
        run(d, 'wake_and_unlock')
    if state.type == 'INSTAGRAM_NOT_OPEN':
        run(d, 'open_instagram')
    if detect_screen(d).type != 'REELS_FEED':
        run(d, 'goto_reels')
        time.sleep(1.0)

    # 1. Watch
    run(d, 'reel_watch')

    # 2. Scroll next x3
    for i in range(3):
        run(d, 'reel_scroll_next')
        time.sleep(0.5)

    # 3. Peek author
    r = run(d, 'reel_peek_author')
    time.sleep(1.5)

    # 4. Якщо peek вдався — повернутись
    if r.ok and r.side_effects.get('new_state_type') == 'PROFILE_OTHER':
        # back press — повернутись до reels
        d.press("back")
        time.sleep(1.2)
        print("    (back pressed after peek)")

    # 5. Ще 2 скроли
    for i in range(2):
        run(d, 'reel_scroll_next')
        time.sleep(0.5)

    print("\n[smoke-reels] done — НЕ було лайків/сейвів (safe mode)")


if __name__ == "__main__":
    main()
