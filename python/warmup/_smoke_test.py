"""Smoke test для state_detector. Не запускається автоматично.

Використання:
  cd python
  python -m warmup._smoke_test 192.168.0.7:5555

Увімкни IG на телефоні й переходь між екранами — скрипт буде друкувати
виявлений стан кожні 2 секунди. Це швидка ручна перевірка: чи правильно
детектор впізнає HOME_FEED / REELS_FEED / STORY_VIEWER / тощо.
"""

from __future__ import annotations

import sys
import time

import uiautomator2 as u2

from warmup.state_detector import detect_screen


def main() -> None:
    serial = sys.argv[1] if len(sys.argv) > 1 else None
    d = u2.connect(serial) if serial else u2.connect()
    print(f"[smoke] Connected to {d.serial if hasattr(d, 'serial') else serial}")
    print("[smoke] Переходь між екранами IG; Ctrl+C для виходу\n")

    prev_repr = None
    while True:
        try:
            state = detect_screen(d)
            cur_repr = repr(state)
            if cur_repr != prev_repr:
                print(f"  {time.strftime('%H:%M:%S')}  {cur_repr}")
                if state.type == 'HOME_FEED' and state.has_unviewed_stories:
                    print(f"      unviewed stories: {state.unviewed_story_positions}")
                if state.markers_found:
                    print(f"      markers: {state.markers_found}")
                prev_repr = cur_repr
        except KeyboardInterrupt:
            print("\n[smoke] bye")
            return
        except Exception as e:
            print(f"  error: {type(e).__name__}: {e}")
        time.sleep(2.0)


if __name__ == "__main__":
    main()
