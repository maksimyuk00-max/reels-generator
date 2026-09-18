"""Smoke test posting v2 (dry_run + real).

Використання:
  # DRY RUN — пройти все окрім Share
  python -m warmup._smoke_posting 192.168.0.7:5555 /path/to/video.mp4 --dry

  # REAL — справжня публікація (обережно!)
  python -m warmup._smoke_posting 192.168.0.7:5555 /path/to/video.mp4 "test caption" --real

ПЕРЕД ЗАПУСКОМ:
  - Розблокуй телефон
  - (опц) Відкрий IG — скрипт сам відкриє

Скрипт друкує progress по кожному кроку, щоб бачити де саме впало якщо fail.
"""

from __future__ import annotations

import os
import sys
import time

# Додаємо python/ у sys.path для доступу до posting_v2
_HERE = os.path.dirname(os.path.abspath(__file__))
_PY_DIR = os.path.dirname(_HERE)
if _PY_DIR not in sys.path:
    sys.path.insert(0, _PY_DIR)

import posting_v2


def main():
    if len(sys.argv) < 3:
        print("usage:")
        print("  DRY:  python -m warmup._smoke_posting <serial> <video.mp4> [caption] --dry")
        print("  REAL: python -m warmup._smoke_posting <serial> <video.mp4> [caption] --real")
        sys.exit(1)

    serial = sys.argv[1]
    video = sys.argv[2]
    caption = ""
    dry = True

    # Parse args
    for i, arg in enumerate(sys.argv[3:], start=3):
        if arg == '--dry':
            dry = True
        elif arg == '--real':
            dry = False
        elif arg.startswith('-'):
            continue
        else:
            caption = arg

    if not caption:
        caption = "test post 🧪"

    if not os.path.isfile(video):
        print(f"❌ Video not found: {video}")
        sys.exit(1)

    size_mb = os.path.getsize(video) / 1024 / 1024
    mode = "🧪 DRY RUN" if dry else "🚀 REAL POST"

    print(f"{mode}")
    print(f"  Serial:  {serial}")
    print(f"  Video:   {video} ({size_mb:.1f} MB)")
    print(f"  Caption: {caption[:80]}")
    print()

    if not dry:
        print("⚠️  REAL POST буде опубліковано через 5 секунд. Ctrl+C для скасування.")
        for i in range(5, 0, -1):
            print(f"  {i}...", end=' ', flush=True)
            time.sleep(1)
        print()

    t0 = time.time()
    result = posting_v2.post_reel_v2(
        video_path=video,
        caption=caption,
        serial=serial,
        proxy=None,
        post_id=None,
        dry_run=dry,
    )
    elapsed = time.time() - t0

    print()
    print("=" * 60)
    if result.get('ok'):
        print(f"✅ OK — step={result.get('step')}")
        if result.get('message'):
            print(f"   {result['message']}")
    else:
        print(f"❌ FAIL on step '{result.get('step')}'")
        print(f"   error: {result.get('error')}")
        if result.get('remote_path'):
            print(f"   ⚠️  Файл залишився на телефоні: {result['remote_path']}")
    print(f"   elapsed: {elapsed:.1f}s (internal: {result.get('elapsed', 0):.1f}s)")


if __name__ == "__main__":
    main()
