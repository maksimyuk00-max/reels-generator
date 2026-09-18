"""Dump IG UI hierarchy для debug маркерів.

Використання:
  python -m warmup._dump_ui 192.168.0.7:5555 profile_own
  python -m warmup._dump_ui 192.168.0.7:5555 home_unknown

Зберігає XML + список унікальних resourceId у файл.
Потім я можу подивитись який id реально є для кнопки "Edit Profile"
в твоїй версії IG.
"""

from __future__ import annotations

import os
import re
import sys
import time
from pathlib import Path

import uiautomator2 as u2

IG_PKG = "com.instagram.android"


def main() -> None:
    if len(sys.argv) < 3:
        print("usage: python -m warmup._dump_ui <host:port> <label>")
        sys.exit(1)

    host, label = sys.argv[1], sys.argv[2]
    d = u2.connect(host)
    out_dir = Path(__file__).parent / "_dumps"
    out_dir.mkdir(exist_ok=True)

    ts = time.strftime("%Y%m%d-%H%M%S")
    base = out_dir / f"{label}-{ts}"

    xml = d.dump_hierarchy()
    (base.with_suffix(".xml")).write_text(xml, encoding="utf-8")

    # Збираємо унікальні resourceId + тексти + content-descriptions
    rids = sorted(set(re.findall(r'resource-id="([^"]+)"', xml)))
    texts = sorted({t for t in re.findall(r'text="([^"]+)"', xml) if t})
    descs = sorted({t for t in re.findall(r'content-desc="([^"]+)"', xml) if t})
    app = d.app_current()

    summary = [
        f"# UI DUMP: {label}",
        f"Time: {ts}",
        f"Current app: {app}",
        "",
        f"## resourceId ({len(rids)} total, IG only)",
    ]
    prefix = f"{IG_PKG}:id/"
    for r in rids:
        if r.startswith(prefix):
            summary.append(f"  {r[len(prefix):]}")

    summary += ["", f"## texts ({len(texts)})"]
    for t in texts[:40]:
        summary.append(f"  {t!r}")

    summary += ["", f"## content-desc ({len(descs)})"]
    for t in descs[:40]:
        summary.append(f"  {t!r}")

    summary_path = base.with_suffix(".txt")
    summary_path.write_text("\n".join(summary), encoding="utf-8")

    print(f"[dump] XML:     {base.with_suffix('.xml')}")
    print(f"[dump] Summary: {summary_path}")
    print(f"[dump] rids with prefix '{prefix}': "
          f"{sum(1 for r in rids if r.startswith(prefix))}")


if __name__ == "__main__":
    main()
