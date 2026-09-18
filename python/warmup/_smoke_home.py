"""Safe smoke test Home actions: scroll/peek/open_post, БЕЗ лайку/сейву.

Використання:
  python -m warmup._smoke_home 192.168.0.7:5555

Сценарій:
  1. Home → scroll_down x3
  2. scroll_up_slightly (re-read)
  3. peek_author → back
  4. open_current_post → back
  5. scroll_down x2
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
    if detect_screen(d).type != 'HOME_FEED':
        run(d, 'goto_home')
        time.sleep(1.0)

    # 1. Scroll down 3 times
    for i in range(3):
        run(d, 'home_scroll_down')
        time.sleep(0.5)

    # 2. Re-read gesture
    run(d, 'home_scroll_up_slightly')
    time.sleep(0.8)

    # 3. Peek author → back
    r = run(d, 'home_peek_author')
    time.sleep(1.5)
    if r.ok and r.side_effects.get('new_state_type') == 'PROFILE_OTHER':
        d.press("back")
        time.sleep(1.2)
        print("    (back pressed after peek)")

    # 4. Open post → back
    r = run(d, 'home_open_current_post')
    time.sleep(1.5)
    new_state = detect_screen(d)
    print(f"    after open_post: {new_state!r}")
    if new_state.type != 'HOME_FEED':
        d.press("back")
        time.sleep(1.2)
        print("    (back pressed after open_post)")

    # 5. Ще 2 скроли
    for i in range(2):
        run(d, 'home_scroll_down')
        time.sleep(0.5)

    print("\n[smoke-home] done — НЕ було лайків/сейвів (safe mode)")


if __name__ == "__main__":
    main()
