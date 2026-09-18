"""Перший живий тест orchestrator v2.

Використання:
  python -m warmup._smoke_orchestrator 192.168.0.7:5555 60

Параметри:
  serial: host:port
  duration_seconds: скільки (default 60)

ПЕРЕД ЗАПУСКОМ:
  - Розблокуй телефон
  - (Опц) Відкрий IG — orchestrator сам зробить app_start, але швидше якщо IG вже є

Скрипт прочитає niche з БД для активного акаунту на девайсі і запустить сесію.
"""

from __future__ import annotations

import json
import sqlite3
import sys
import os
import time

# Додаємо python/ щоб warmup.* працював
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from warmup.orchestrator import run_warmup_session
from warmup.ai_relevance import NicheProfile


DB_PATH = r'C:\Users\Admin\AppData\Roaming\reels-generator\reels-generator.db'


def load_niche_for_device(serial: str) -> tuple[NicheProfile, str]:
    """Знайти активний акаунт на девайсі і завантажити niche."""
    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row

    # Знаходимо device по serial
    dev = db.execute('SELECT id FROM devices WHERE serial=?', (serial,)).fetchone()
    if not dev:
        return NicheProfile(), '(no device)'

    # Акаунт прив'язаний до девайсу (беремо перший)
    acc = db.execute('SELECT id, username FROM accounts WHERE device_id=? LIMIT 1',
                      (dev['id'],)).fetchone()
    if not acc:
        return NicheProfile(), '(no account)'

    cfg = db.execute('''
        SELECT niche_description, niche_keywords, niche_avoid, niche_examples
        FROM account_warmup_configs WHERE account_id=?
    ''', (acc['id'],)).fetchone()
    if not cfg:
        return NicheProfile(), f'@{acc["username"]} (no config)'

    def _parse(s):
        if not s: return []
        try:
            v = json.loads(s)
            return v if isinstance(v, list) else []
        except Exception: return []

    niche = NicheProfile(
        description=cfg['niche_description'] or '',
        keywords=_parse(cfg['niche_keywords']),
        avoid=_parse(cfg['niche_avoid']),
        examples=_parse(cfg['niche_examples']),
    )
    return niche, f'@{acc["username"]}'


def main():
    serial = sys.argv[1] if len(sys.argv) > 1 else None
    duration = int(sys.argv[2]) if len(sys.argv) > 2 else 60

    print(f"[smoke-v2] serial={serial}, duration={duration}s")

    niche, label = load_niche_for_device(serial)
    print(f"[smoke-v2] account: {label}")
    print(f"[smoke-v2] niche configured: {niche.is_configured()}")
    if niche.is_configured():
        print(f"  description: {niche.description[:80]}")
        print(f"  keywords:    {niche.keywords}")
        print(f"  avoid:       {niche.avoid}")
        print(f"  examples:    {niche.examples}")

    print(f"\n[smoke-v2] STARTING session ({duration}s)...\n")
    t0 = time.time()
    result = run_warmup_session(
        serial=serial,
        duration_seconds=duration,
        niche=niche,
        proxy=None,       # тест без проксі
        use_ai=True,
    )
    elapsed = time.time() - t0

    print(f"\n[smoke-v2] === RESULT (wall {elapsed:.1f}s) ===")
    print(f"  ok: {result['ok']}")
    print(f"  error: {result.get('error')}")
    print(f"  reels_watched: {result['reels_watched']}")
    print(f"  likes_given: {result['likes_given']}")
    print(f"  saves_given: {result['saves_given']}")
    print(f"  stories_watched: {result['stories_watched']}")
    print(f"  profile_peeks: {result['profile_peeks']}")
    print(f"  tab_switches: {result['tab_switches']}")
    print(f"  duration: {result['duration']:.1f}s")
    print(f"  time_in_tab: {result['time_in_tab']}")
    print(f"  total actions: {len(result['actions'])}")

    if result['ai_decisions']:
        print(f"\n  AI decisions ({len(result['ai_decisions'])}):")
        for d in result['ai_decisions'][:10]:
            tokens = f"in={d.get('tokens_in',0)} out={d.get('tokens_out',0)} cache={d.get('cache_read',0)}"
            dur = f"{d.get('duration_ms',0)/1000:.1f}s"
            print(f"    [{d.get('mode','?')}] {d['action']:<5} ({dur}, {tokens}) | {d.get('reason','')[:70]}")

    stats = result.get('ai_stats', {})
    if stats:
        print(f"\n  === AI cost stats (via claude.exe subscription) ===")
        print(f"  total calls:        {stats['calls']}")
        print(f"  input tokens:       {stats['input_tokens']:,}")
        print(f"  output tokens:      {stats['output_tokens']:,}")
        print(f"  cache read tokens:  {stats['cache_read_tokens']:,}")
        print(f"  TOTAL tokens:       {stats['total_tokens']:,}")
        print(f"  cost if API:        ${stats['cost_usd_if_api']:.4f}")
        print(f"  cost via subscrip:  $0.00 (included)")

    print(f"\n  Action sequence:")
    from collections import Counter
    kinds = Counter(result['actions'])
    for k, n in sorted(kinds.items(), key=lambda x: -x[1])[:15]:
        print(f"    {k:<28} {n}")


if __name__ == "__main__":
    main()
