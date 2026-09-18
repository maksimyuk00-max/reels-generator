"""SQLite writer — Python пише у ту саму БД що Electron.

Використовується orchestrator'ом і posting_v2 для прямого запису результатів
сесії, щоб не залежати від того чи Electron живий.

Safe concurrent access:
  - Використовуємо WAL mode якщо не встановлено (кращий для multi-writer)
  - Timeout 10s на lock wait
  - Не тримаємо transaction довго — один UPDATE → commit → close

Не імпортує electron/better-sqlite3. Тільки stdlib.
"""

from __future__ import annotations

import json
import sqlite3
from typing import Any


# ───── Warmup session update ──────────────────────────────────────

def update_warmup_session(db_path: str, session_id: int, data: dict) -> dict:
    """Оновити warmup_sessions row напряму з Python.

    Returns: {"ok": True} або {"ok": False, "error": "..."}
    """
    if not db_path or not session_id:
        return {"ok": False, "error": "missing db_path or session_id"}

    # Serialize JSON-збережувані поля
    data = dict(data)
    if 'ai_decisions' in data and isinstance(data['ai_decisions'], (list, dict)):
        data['ai_decisions'] = json.dumps(data['ai_decisions'],
                                          ensure_ascii=False, default=str)

    allowed = {
        'status', 'finished_at', 'reels_watched', 'likes_given', 'saves_given',
        'error', 'ai_decisions',
        'ai_input_tokens', 'ai_output_tokens', 'ai_cache_read_tokens',
        'ai_cost_usd', 'ai_calls', 'engine',
    }

    fields = []
    values = []
    for k, v in data.items():
        if k in allowed and v is not None:
            fields.append(f"{k} = ?")
            values.append(v)

    if not fields:
        return {"ok": False, "error": "no allowed fields to update"}

    values.append(session_id)
    sql = f"UPDATE warmup_sessions SET {', '.join(fields)} WHERE id = ?"

    return _safe_execute(db_path, sql, values)


# ───── Scheduled post update ──────────────────────────────────────

def update_scheduled_post(db_path: str, post_id: int, data: dict) -> dict:
    """Оновити scheduled_posts row напряму з Python (для posting_v2)."""
    if not db_path or not post_id:
        return {"ok": False, "error": "missing db_path or post_id"}

    allowed = {'status', 'url', 'error', 'published_at'}
    fields = []
    values = []
    for k, v in data.items():
        if k in allowed and v is not None:
            fields.append(f"{k} = ?")
            values.append(v)

    if not fields:
        return {"ok": False, "error": "no allowed fields"}

    values.append(post_id)
    sql = f"UPDATE scheduled_posts SET {', '.join(fields)} WHERE id = ?"

    return _safe_execute(db_path, sql, values)


# ───── Internal ───────────────────────────────────────────────────

def _safe_execute(db_path: str, sql: str, values: list) -> dict:
    """Виконати UPDATE з WAL + timeout, безпечно для concurrent з Electron."""
    conn = None
    try:
        conn = sqlite3.connect(db_path, timeout=10.0)
        # WAL дозволяє Electron читати поки ми пишемо
        try:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA busy_timeout=10000")
        except Exception:
            pass

        cur = conn.execute(sql, values)
        conn.commit()
        updated = cur.rowcount
        return {"ok": True, "rows_updated": updated}
    except sqlite3.OperationalError as e:
        return {"ok": False, "error": f"SQLite locked or error: {e}"}
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}
    finally:
        if conn:
            try: conn.close()
            except Exception: pass


# ───── Read helpers (для debug) ───────────────────────────────────

def get_warmup_session(db_path: str, session_id: int) -> dict | None:
    """Прочитати session row (для verify після write)."""
    conn = None
    try:
        conn = sqlite3.connect(db_path, timeout=5.0)
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            "SELECT * FROM warmup_sessions WHERE id = ?", (session_id,)
        ).fetchone()
        return dict(row) if row else None
    except Exception:
        return None
    finally:
        if conn:
            try: conn.close()
            except Exception: pass
