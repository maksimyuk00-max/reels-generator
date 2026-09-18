"""
Threads feed monitor — збереження побачених постів зі стрічки Threads,
генерація відповідей та оригінальних thread-постів через персону.

Аналог reddit_monitor.py, але адаптований під специфіку Threads:
- 500 символів ліміт, без заголовка — лише текст
- Казуальний, розмовний тон (не промо)
- Без хештегів (алгоритм Threads їх карає)
- Можна lowercase, перенесення рядків
- Оригінальні пости vs відповіді — різні промпти

DB: ті ж таблиці що в electron/database.js (threads_found_posts, threads_drafts, threads_generated)
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
import subprocess
import sys
from pathlib import Path
from typing import Any

# Дозволяємо імпорт reddit_monitor для пере використання утиліт
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from reddit_monitor import (
    _resolve_db_path,
    find_claude_cli,
    generate_draft_raw,
)


# ─── DB helpers ────────────────────────────────────────────────────────────


def _connect() -> sqlite3.Connection:
    path = _resolve_db_path()
    conn = sqlite3.connect(str(path))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def _row_to_dict(row: sqlite3.Row) -> dict:
    return {k: row[k] for k in row.keys()}


# ─── Found posts (збережені зі стрічки) ────────────────────────────────────


def get_thread_posts(status: str | None = None, limit: int = 200) -> list[dict]:
    conn = _connect()
    wheres = []
    args: list[Any] = []
    if status:
        wheres.append("status = ?")
        args.append(status)
    where = ("WHERE " + " AND ".join(wheres)) if wheres else ""
    args.append(limit)
    rows = conn.execute(
        f"""SELECT * FROM threads_found_posts {where}
            ORDER BY
              CASE status WHEN 'new' THEN 0 WHEN 'drafted' THEN 1 ELSE 2 END,
              found_at DESC
            LIMIT ?""",
        args,
    ).fetchall()
    conn.close()
    return [_row_to_dict(r) for r in rows]


def set_thread_post_status(post_id: int, status: str) -> bool:
    conn = _connect()
    cur = conn.execute(
        "UPDATE threads_found_posts SET status = ?, updated_at = datetime('now') WHERE id = ?",
        (status, post_id),
    )
    conn.commit()
    ok = cur.rowcount > 0
    conn.close()
    return ok


def delete_thread_posts(post_ids: list[int]) -> dict:
    if not post_ids:
        return {"ok": True, "count": 0}
    conn = _connect()
    placeholders = ",".join("?" * len(post_ids))
    cur = conn.execute(
        f"DELETE FROM threads_found_posts WHERE id IN ({placeholders})",
        post_ids,
    )
    conn.commit()
    count = cur.rowcount
    conn.close()
    return {"ok": True, "count": count}


def save_found_post(
    thread_text: str,
    author: str = "",
    account_id: int | None = None,
    source: str = "scroll",
) -> dict:
    """Зберігає побачений Thread-пост в БД (для Thread Feed).

    Дедуплікація: якщо такий же текст вже є в базі (за last 100 постів),
    пропускаємо — щоб не зберігати дублі при довгих scroll-сесіях.
    """
    if not thread_text or len(thread_text) < 20:
        return {"ok": False, "error": "text too short"}

    conn = _connect()
    # Проста дедуплікація: перевіряємо чи є такий же текст за останні 100 постів
    recent = conn.execute(
        "SELECT id FROM threads_found_posts ORDER BY found_at DESC LIMIT 100"
    ).fetchall()
    recent_texts = set()
    for r in recent:
        row = conn.execute(
            "SELECT thread_text FROM threads_found_posts WHERE id = ?", (r["id"],)
        ).fetchone()
        if row:
            recent_texts.add(row["thread_text"][:200])

    if thread_text[:200] in recent_texts:
        conn.close()
        return {"ok": True, "duplicate": True}

    from datetime import datetime
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    cur = conn.execute(
        """INSERT INTO threads_found_posts (thread_text, author, account_id, source, found_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)""",
        (thread_text, author, account_id, source, now, now),
    )
    post_id = cur.lastrowid
    conn.commit()
    row = conn.execute("SELECT * FROM threads_found_posts WHERE id = ?", (post_id,)).fetchone()
    conn.close()
    return {"ok": True, "post": _row_to_dict(row)}


def get_thread_drafts(post_id: int) -> list[dict]:
    conn = _connect()
    rows = conn.execute(
        "SELECT * FROM threads_drafts WHERE post_id = ? ORDER BY created_at DESC",
        (post_id,),
    ).fetchall()
    conn.close()
    return [_row_to_dict(r) for r in rows]


# ─── Draft generation (відповіді на пости зі стрічки) ──────────────────────


def _build_thread_reply_prompt(persona_description: str, post_text: str, intent: str) -> str:
    """Промпт для генерації відповіді на Thread-пост.

    Специфіка Threads:
    - Без заголовка, лише текст
    - 500 символів ліміт
    - Казуальний, розмовний тон
    - Без хештегів
    - Можна lowercase
    """
    intent_line = (
        "Do NOT mention any app, product, or link. Just be a real person reacting naturally."
        if intent == "reply"
        else "You may mention something you built ONCE, only if it fits naturally — as a person would, never as an ad."
    )
    return f"""You are the person described below. Write a Threads REPLY in THEIR authentic voice only.

YOUR PERSONA (never break character, never mention you are an AI or that this is generated):
{persona_description}

TASK: Write a reply to the Threads post below.
- Threads has NO titles — just text. Your reply is pure text.
- Max 500 characters. Aim for 1-3 sentences. Short and punchy works best on Threads.
- {intent_line}
- Sound like a real person scrolling Threads at midnight: casual, sometimes lowercase, contractions ok.
- NO hashtags. Threads algorithm punishes hashtags.
- NO emoji unless the persona naturally uses them.
- NO @mentions.
- NO "great post", "love this", "so true" — zero generic praise. React to ONE specific thing.
- Line breaks are ok and natural on Threads.
- Do not start with "I think" or "This is". Start mid-thought.

THE THREAD POST YOU ARE REPLYING TO:
{post_text}

Reply ONLY in JSON (no markdown fences):
{{"reply": "..."}}"""


def generate_thread_draft(
    post_id: int,
    persona_id: str,
    persona_description: str,
    intent: str = "reply",
    *,
    provider: str = "claude-cli",
    ollama_endpoint: str = "https://ollama.com",
    ollama_api_key: str = "",
    ollama_model: str = "gpt-oss:120b",
) -> dict:
    """Генерує драфт-відповідь на Thread-пост і зберігає в БД."""

    # Отримуємо текст поста
    conn = _connect()
    row = conn.execute(
        "SELECT * FROM threads_found_posts WHERE id = ?", (post_id,)
    ).fetchone()
    conn.close()
    if not row:
        return {"ok": False, "error": f"Post {post_id} not found"}

    post_text = row["thread_text"]
    prompt = _build_thread_reply_prompt(persona_description, post_text, intent)

    if provider == "ollama":
        result = generate_draft_raw(
            prompt,
            provider="ollama",
            ollama_endpoint=ollama_endpoint,
            ollama_api_key=ollama_api_key,
            ollama_model=ollama_model,
            timeout=120,
        )
    else:
        result = generate_draft_raw(prompt, provider="claude-cli", timeout=180)

    # Зберігаємо драфт в БД
    if result.get("ok"):
        reply_text = result.get("reply", "").strip()
        # Прибираємо зайві лапки якщо модель їх додала
        reply_text = reply_text.strip('"`')
        # Hard cap 500 символів
        if len(reply_text) > 500:
            reply_text = reply_text[:500]

        conn = _connect()
        cur = conn.execute(
            """INSERT INTO threads_drafts (post_id, persona_id, intent, reply_text, model)
               VALUES (?, ?, ?, ?, ?)""",
            (post_id, persona_id, intent, reply_text, result.get("model", "")),
        )
        draft_id = cur.lastrowid
        # Позначаємо пост як drafted
        conn.execute(
            "UPDATE threads_found_posts SET status = 'drafted', updated_at = datetime('now') WHERE id = ?",
            (post_id,),
        )
        conn.commit()
        draft = conn.execute(
            "SELECT * FROM threads_drafts WHERE id = ?", (draft_id,)
        ).fetchone()
        conn.close()
        return {"ok": True, "draft": _row_to_dict(draft)}
    else:
        # Зберігаємо помилку
        error_msg = result.get("error", "Unknown error")
        conn = _connect()
        cur = conn.execute(
            """INSERT INTO threads_drafts (post_id, persona_id, intent, reply_text, model, error)
               VALUES (?, ?, ?, '', '', ?)""",
            (post_id, persona_id, intent, error_msg),
        )
        draft_id = cur.lastrowid
        conn.commit()
        draft = conn.execute(
            "SELECT * FROM threads_drafts WHERE id = ?", (draft_id,)
        ).fetchone()
        conn.close()
        return {"ok": False, "error": error_msg, "draft": _row_to_dict(draft)}


# ─── Original thread generation (нові пости від персони) ───────────────────


def _build_thread_post_prompt(persona_description: str, topic_hint: str = "") -> str:
    """Промпт для генерації оригінального Thread-поста.

    Специфіка Threads:
    - Без заголовка, лише текст
    - 500 символів ліміт
    - Оригінальний пост (не відповідь) — інший тон ніж reply
    - Може бути спостереження, думка, міні-історія
    - Без хештегів
    - Казуальний, ненав'язливий
    """
    topic_section = f"\nTOPIC / DIRECTION (optional — use as inspiration, don't force it):\n{topic_hint}\n" if topic_hint else "\nWrite about whatever feels natural and true to the persona right now.\n"

    return f"""You are the person described below. Write an ORIGINAL Threads post in THEIR authentic voice.

YOUR PERSONA (never break character, never mention you are an AI or that this is generated):
{persona_description}
{topic_section}
TASK: Write a single Threads post — your own thought, observation, or mini-story.
- Threads has NO titles — just text. Your post is pure text.
- Max 500 characters. 1-4 sentences is the sweet spot.
- Sound like a real person posting casually: sometimes lowercase, contractions ok, line breaks ok.
- NO hashtags. Threads algorithm punishes hashtags.
- NO emoji unless the persona naturally uses them.
- NO @mentions.
- NO marketing, NO "check out", NO links, NO call-to-action.
- NO generic inspirational quotes. Be specific, personal, real.
- It can be: a small observation from today, a thought that won't leave you alone, a half-formed idea, a contrarian take, a tiny story.
- Do not start with "I think" or "Just". Start mid-thought, like you're continuing a conversation with yourself.
- Do NOT mention any app, product, or link. This is an organic post, not promotion.

Return ONLY in JSON (no markdown fences):
{{"post": "..."}}"""


def generate_thread_post(
    persona_id: str,
    persona_description: str,
    topic_hint: str = "",
    *,
    provider: str = "claude-cli",
    ollama_endpoint: str = "https://ollama.com",
    ollama_api_key: str = "",
    ollama_model: str = "gpt-oss:120b",
) -> dict:
    """Генерує оригінальний Thread-пост і зберігає в БД."""

    prompt = _build_thread_post_prompt(persona_description, topic_hint)

    if provider == "ollama":
        result = generate_draft_raw(
            prompt,
            provider="ollama",
            ollama_endpoint=ollama_endpoint,
            ollama_api_key=ollama_api_key,
            ollama_model=ollama_model,
            timeout=120,
        )
    else:
        result = generate_draft_raw(prompt, provider="claude-cli", timeout=180)

    if result.get("ok"):
        post_text = result.get("reply", "").strip()
        # Може бути в полі "post" або "reply" — перевіряємо обидва
        if not post_text:
            # Спробуємо розпарсити як JSON
            try:
                cleaned = re.sub(r"```(?:json)?", "", post_text).replace("```", "").strip()
                m = re.search(r"\{.*\}", cleaned, re.DOTALL)
                if m:
                    parsed = json.loads(m.group())
                    post_text = parsed.get("post", "").strip()
            except Exception:
                pass

        # Прибираємо зайві лапки
        post_text = post_text.strip('"`')

        # Hard cap 500 символів
        if len(post_text) > 500:
            post_text = post_text[:500]

        if not post_text:
            return {"ok": False, "error": "Модель повернула пустий текст"}

        conn = _connect()
        cur = conn.execute(
            """INSERT INTO threads_generated (persona_id, post_text, model, status)
               VALUES (?, ?, ?, 'draft')""",
            (persona_id, post_text, result.get("model", "")),
        )
        gen_id = cur.lastrowid
        conn.commit()
        gen = conn.execute(
            "SELECT * FROM threads_generated WHERE id = ?", (gen_id,)
        ).fetchone()
        conn.close()
        return {"ok": True, "generated": _row_to_dict(gen)}
    else:
        return {"ok": False, "error": result.get("error", "Unknown error")}


# ─── Generated posts CRUD ──────────────────────────────────────────────────


def get_generated_threads(status: str | None = None, limit: int = 100) -> list[dict]:
    conn = _connect()
    wheres = []
    args: list[Any] = []
    if status:
        wheres.append("status = ?")
        args.append(status)
    where = ("WHERE " + " AND ".join(wheres)) if wheres else ""
    args.append(limit)
    rows = conn.execute(
        f"SELECT * FROM threads_generated {where} ORDER BY created_at DESC LIMIT ?",
        args,
    ).fetchall()
    conn.close()
    return [_row_to_dict(r) for r in rows]


def update_generated_status(gen_id: int, status: str, error: str = "", account_id: int | None = None) -> dict:
    conn = _connect()
    fields = ["status = ?"]
    values: list[Any] = [status]
    if error:
        fields.append("error = ?")
        values.append(error)
    if account_id is not None:
        fields.append("account_id = ?")
        values.append(account_id)
    if status == "published":
        fields.append("published_at = datetime('now')")
    values.append(gen_id)
    conn.execute(
        f"UPDATE threads_generated SET {', '.join(fields)} WHERE id = ?", values
    )
    conn.commit()
    row = conn.execute("SELECT * FROM threads_generated WHERE id = ?", (gen_id,)).fetchone()
    conn.close()
    return _row_to_dict(row) if row else {"ok": False, "error": "not found"}


def delete_generated(gen_id: int) -> bool:
    conn = _connect()
    cur = conn.execute("DELETE FROM threads_generated WHERE id = ?", (gen_id,))
    conn.commit()
    ok = cur.rowcount > 0
    conn.close()
    return ok