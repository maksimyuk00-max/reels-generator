"""
Reddit feed monitor — щогодинний сканер pain-постів з Reddit.

Використовує тільки публічні RSS-ендпоінти Reddit (без OAuth, без 403).
Повертає пости з pain-keywords, що підходять для HOKAN-аудиторії.

Endpoint:
    GET  /reddit/scan                       — сканувати + зберегти у SQLite
    GET  /reddit/posts?status=new&limit=50  — список знайдених постів
    POST /reddit/draft                      — згенерувати драфт (persona + post)
    POST /reddit/dismiss                    — позначити пост як dismissed
"""

from __future__ import annotations

import html as html_module
import json
import os
import re
import sqlite3
import subprocess
import sys
import time
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Iterable

# ─── Конфіг ────────────────────────────────────────────────────────────────

DB_PATH = Path.home() / "AppData" / "Roaming" / "reels-generator" / "reels-generator.db"


def _resolve_db_path() -> Path:
    """Повертає шлях до SQLite.

    Пріоритет:
      1. env REELS_DB_PATH (передає Electron через process.env)
      2. %APPDATA%/reels-generator/reels-generator.db (стандарт Electron)
      3. Fallback до %LOCALAPPDATA% (старий шлях)
    """
    env = os.environ.get("REELS_DB_PATH")
    if env:
        return Path(env)
    appdata = os.environ.get("APPDATA")
    if appdata:
        return Path(appdata) / "reels-generator" / "reels-generator.db"
    # Fallback
    return DB_PATH

# Сабреддіти, де сидить HOKAN-аудиторія
SUBREDDITS: list[str] = [
    "Samurai",
    "Selfhelpbooks",
    "findapath",
    "DeepThoughts",
    "selfimprovement",
    "AskReddit",
    "Discipline",
    "ADHD",
    "productivity",
    "getdisciplined",
    "mentalhealth",
    "PornAddiction",
    "QuitPorn",
    "digitalminimalism",
    "nosurf",
    "depression",
    "Stoicism",
    "Stoic",
    "Meditation",
    "awakened",
    "Veterans",
    "VeteransBenefits",
    "fightporn",
]

# Pain-keywords (lower-case, OR-логіка). Підсвітка показує збіги.
PAIN_KEYWORDS: list[str] = [
    # Addiction / recovery
    "no fap", "nofap", "porn", "pornfree", "relapse", "streak",
    "urge", "addiction", "addicted", "withdrawal",
    # Discipline / routine
    "discipline", "self-discipline", "self discipline",
    "morning routine", "wake up early", "accountability",
    "habit", "routine", "waking up", "alarm",
    # Mindset / stoic
    "warrior", "stoic", "stoicism", "memento mori",
    "mindfulness", "meditation", "presence", "awareness",
    # Self-image / pain
    "weak", "weakness", "stuck", "lost", "no motivation",
    "unmotivated", "procrastination", "procrastinating",
    "lazy", "failure", "shame", "guilt", "beta", "manchild",
    "masculinity", "man up", "lack of discipline",
    # Self-improvement general
    "self-improvement", "self improvement", "be better",
    "better man", "better version", "transform",
    "transformation", "change my life", "fix my life", "level up",
    # Japanese terms (HOKAN niche)
    "bushido", "bushidō", "samurai", "ronin", "shogun", "shōgun",
    "ninja", "shinobi", "yamabushi", "sensei", "kanji", "katakana",
    "hiragana", "go rin no sho", "mushin", "無心", "fudoshin",
    "fudōshin", "不動心", "zanshin", "残心", "shoshin", "初心",
    "zazen", "satori", "kensho", "koan", "kata", "型",
    "hagakure", "葉隠", "shugyō", "shugyo", "修行",
    "kaihōgyō", "kaihogyo", "回峰行", "takigyō", "takigyo", "滝行",
    "suburi", "素振り", "iaidō", "iaido", "居合道", "kendō", "kendo",
    "budo", "武道", "musha shugyō", "bjj", "jiujitsu", "jiu jitsu",
]

NSFW_FLAVOR_KEYWORDS: list[str] = [
    "nude", "nudes", "sex tape", "hookup",
    "onlyfans leak", "celebrity nudes", "dick pic", "horny",
]

# Ліміти
MIN_UPVOTES = 5
MIN_COMMENTS = 3
WINDOW_HOURS = 24
POSTS_PER_SUBREDDIT = 50

# Reddit rate-limit захист:
# - RSS Reddit не має офіційного ліміту, але на практиці — ~60 req/min/UA, ~120 req/min/IP
# - 27 сабреддітів з 1.5s паузою = 40 секунд на цикл
# - Кулдаун після 429: 60 секунд
# - Захист: jitter, max retries
RATE_LIMIT_COOLDOWN_SEC = 10.0
PER_REQUEST_SLEEP = 1.5
JITTER_RANGE = (0.0, 0.5)  # випадковий джиттер
MAX_RETRIES = 3

# User-Agent
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

ATOM_NS = "{http://www.w3.org/2005/Atom}"

# Claude CLI
CLAUDE_MODEL = "sonnet"  # Аліас через проксі (anthropic)


# ─── RSS fetcher ───────────────────────────────────────────────────────────


def fetch_subreddit_new(subreddit: str, limit: int = 50) -> bytes | None:
    """Завантажує RSS для сабреддіту з rate-limit захистом.
    
    Повертає XML-тіло або None після вичерпання retry.
    Sleep + jitter між запитами — робить запит схожим на людину.
    При 429 — кулдаун 60 секунд і повтор.
    """
    import random
    url = f"https://www.reddit.com/r/{subreddit}/new/.rss?limit={limit}"
    # backoffs скорочені, щоб не зависати на сабреддітах де Reddit не віддає RSS.
    # 10s timeout × 4 спроби max = ~40s на 1 проблемний subreddit,
    # а не 60s+ як раніше.
    backoffs = (2, 4, 8, 12)
    last_err = ""
    for backoff in backoffs:
        try:
            req = urllib.request.Request(
                url,
                headers={
                    "User-Agent": USER_AGENT,
                    "Accept": "application/atom+xml, application/xml;q=0.9, */*;q=0.8",
                },
            )
            with urllib.request.urlopen(req, timeout=10) as resp:
                if resp.status == 200:
                    return resp.read()
                if resp.status == 429:
                    last_err = "HTTP 429 (rate limit)"
                    # 60-секундний кулдаун, потім retry
                    time.sleep(RATE_LIMIT_COOLDOWN_SEC)
                    continue
                last_err = f"HTTP {resp.status}"
                time.sleep(backoff + random.uniform(*JITTER_RANGE))
        except urllib.error.HTTPError as e:  # type: ignore[attr-defined]
            last_err = f"HTTPError {e.code}: {e.reason}"
            if e.code in (429, 503):
                time.sleep(RATE_LIMIT_COOLDOWN_SEC)
                continue
            time.sleep(backoff + random.uniform(*JITTER_RANGE))
        except Exception as e:  # noqa: BLE001
            last_err = str(e)
            time.sleep(backoff + random.uniform(*JITTER_RANGE))
            continue
        break
    print(f"  ! {subreddit}: {last_err}", file=sys.stderr)
    return None


def _sleep_jittered(base: float = PER_REQUEST_SLEEP) -> None:
    """Пауза з випадковим джиттером — щоб не виглядати як бот."""
    import random
    time.sleep(base + random.uniform(*JITTER_RANGE))


# ─── Парсинг ──────────────────────────────────────────────────────────────


_PERMALINK_RE = re.compile(r"/comments/([a-z0-9]+)/", re.IGNORECASE)


def parse_atom(xml_bytes: bytes, subreddit: str) -> list[dict]:
    """Парсить Reddit Atom feed → список сирих постів."""
    try:
        root = ET.fromstring(xml_bytes)
    except ET.ParseError as e:
        print(f"  ! {subreddit}: parse error {e}", file=sys.stderr)
        return []

    posts: list[dict] = []
    for entry in root.findall(f"{ATOM_NS}entry"):
        title = (entry.findtext(f"{ATOM_NS}title") or "").strip()
        if not title:
            continue

        # permalink: <link rel="alternate"> (старий формат) АБО <link href=.../comments/> (новий)
        permalink = ""
        for link in entry.findall(f"{ATOM_NS}link"):
            rel = link.get("rel")
            href = link.get("href", "")
            # Старий формат: rel="alternate" + href містить /comments/
            if rel == "alternate" and "/comments/" in href:
                permalink = href
                break
            # Новий формат: <link href=".../comments/..."> без rel
            if not rel and "/comments/" in href:
                permalink = href
                break
        # Fallback: шукаємо /comments/.../ в <content type="html">
        if not permalink:
            content_elem = entry.find(f"{ATOM_NS}content")
            if content_elem is not None and content_elem.text:
                m = _PERMALINK_RE.search(content_elem.text)
                if m:
                    raw_id_from_content = m.group(1)
                    permalink = f"https://www.reddit.com/r/{subreddit}/comments/{raw_id_from_content}/"

        if not permalink or "/comments/" not in permalink:
            continue

        # reddit id з permalink
        m = _PERMALINK_RE.search(permalink)
        if not m:
            continue
        reddit_id = m.group(1)

        # author
        author = (entry.findtext(f"{ATOM_NS}author/{ATOM_NS}name") or "").lstrip("/")

        # created
        updated_str = entry.findtext(f"{ATOM_NS}updated") or entry.findtext(f"{ATOM_NS}published")
        created_utc = 0
        if updated_str:
            try:
                dt = parsedate_to_datetime(updated_str)
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                created_utc = int(dt.timestamp())
            except (TypeError, ValueError):
                pass
        if not created_utc:
            created_utc = int(time.time())

        # url: перший href з content, що не reddit
        url = permalink
        # selftext preview з <content type="html"> (RSS дає повний текст для self-posts).
        # Для link posts content часто = "[link]", тоді selftext лишається "".
        selftext = ""
        content_elem = entry.find(f"{ATOM_NS}content")
        if content_elem is not None and content_elem.text:
            raw_html = content_elem.text
            # Шукаємо href для url (зовнішнє посилання)
            for href_m in re.finditer(r'href="(https?://[^"]+)"', raw_html):
                href = href_m.group(1)
                if "reddit.com" not in href and "redditstatic.com" not in href:
                    url = href
                    break
            # Витягуємо selftext — все що НЕ <a> tag (для self-posts) або весь текст (для link posts)
            # Якщо в content є div.md (markdown body) — беремо його plain text
            md_div = re.search(r'<div class="md">([\s\S]*?)</div>', raw_html)
            if md_div:
                # Зрізаємо HTML теги простою регуляркою
                text = re.sub(r"<[^>]+>", " ", md_div.group(1))
                text = re.sub(r"\s+", " ", text).strip()
                # Декодуємо HTML entities (мінімум)
                text = (
                    text.replace("&amp;", "&")
                        .replace("&lt;", "<")
                        .replace("&gt;", ">")
                        .replace("&quot;", '"')
                        .replace("&#39;", "'")
                        .replace("&nbsp;", " ")
                )
                selftext = text

        posts.append({
            "reddit_id": reddit_id,
            "subreddit": subreddit,
            "title": title,
            "author": author or "[unknown]",
            "permalink": permalink,
            "url": url,
            "created_utc": created_utc,
            "selftext": selftext,
        })
    return posts


# ─── Фільтрація ───────────────────────────────────────────────────────────


def matches_keywords(title: str) -> list[str]:
    haystack = title.lower()
    return [kw for kw in PAIN_KEYWORDS if kw in haystack]


def is_nsfw_title(title: str) -> bool:
    t = title.lower()
    return any(kw in t for kw in NSFW_FLAVOR_KEYWORDS)


def is_fresh(created_utc: int, window_hours: int) -> bool:
    return (time.time() - created_utc) / 3600 <= window_hours


def should_include(raw: dict) -> dict | None:
    title = raw.get("title", "")
    matched = matches_keywords(title)
    if not matched:
        return None
    if is_nsfw_title(title):
        return None
    if not is_fresh(raw.get("created_utc", 0), WINDOW_HOURS):
        return None
    # RSS не дає score/comments — пропускаємо фільтр по них
    raw["matched_keywords"] = matched
    return raw


# ─── DB ───────────────────────────────────────────────────────────────────


def _connect() -> sqlite3.Connection:
    # SQLite WAL режим — дозволяє читати з Electron під час запису.
    # busy_timeout=5s: SQLite сам чекатиме звільнення lock замість миттєвої
    # помилки "database is locked". У комбінації з retry у save_draft це
    # повністю прибирає race-conditions між Electron reader і Python writer.
    conn = sqlite3.connect(str(DB_PATH), timeout=10)
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA busy_timeout = 5000")
    return conn


def upsert_post(conn: sqlite3.Connection, data: dict) -> tuple[int, bool]:
    """Повертає (local_id, inserted)."""
    cur = conn.execute(
        "SELECT id FROM reddit_found_posts WHERE reddit_id = ?",
        (data["reddit_id"],),
    )
    row = cur.fetchone()
    if row is not None:
        return (row[0], False)
    cur = conn.execute(
        """INSERT INTO reddit_found_posts (
              reddit_id, subreddit, title, author, permalink, url,
              score, num_comments, created_utc, matched_keywords,
              status, found_at, updated_at, selftext
            ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, 'new', datetime('now'), datetime('now'), ?)""",
        (
            data["reddit_id"],
            data["subreddit"],
            data["title"],
            data.get("author", ""),
            data["permalink"],
            data.get("url", ""),
            data.get("created_utc", 0),
            " ".join(data.get("matched_keywords", [])),
            data.get("selftext", "") or "",
        ),
    )
    return (cur.lastrowid, True)


# ─── Скан ─────────────────────────────────────────────────────────────────


def scan_all(subreddits: list[str] | None = None) -> dict:
    """Один прохід сканування. Повертає статистику.

    Сканує subreddits з jittered sleep (1.5s ± 0.5s) між запитами.
    При 429 від Reddit — 60s кулдаун, потім retry.
    """
    subs = subreddits or SUBREDDITS
    conn = _connect()
    total_seen = 0
    total_inserted = 0
    total_dup = 0
    per_sub: dict[str, int] = {}
    for sub in subs:
        body = fetch_subreddit_new(sub, limit=POSTS_PER_SUBREDDIT)
        if not body:
            _sleep_jittered()
            continue
        raws = parse_atom(body, sub)
        sub_inserted = 0
        for raw in raws:
            total_seen += 1
            filtered = should_include(raw)
            if filtered is None:
                continue
            try:
                _, inserted = upsert_post(conn, filtered)
                if inserted:
                    sub_inserted += 1
                    total_inserted += 1
                else:
                    total_dup += 1
            except sqlite3.Error as e:
                print(f"  ! {sub}: db error {e}", file=sys.stderr)
        per_sub[sub] = sub_inserted
        _sleep_jittered()
    conn.commit()
    conn.close()
    return {
        "seen": total_seen,
        "inserted": total_inserted,
        "duplicates": total_dup,
        "per_subreddit": per_sub,
    }


# ─── Claude CLI для драфту ────────────────────────────────────────────────


def find_claude_cli() -> str | None:
    candidates = [
        r"C:\claude code\claude.exe",
        r"C:\claude code\reels-generator\python\claude.exe",
        str(Path.home() / "AppData" / "Roaming" / "Claude" / "claude-code" / "2.1.87" / "claude.exe"),
    ]
    for c in candidates:
        if Path(c).is_file():
            return c
    return None


# ─── Ollama (Cloud або локальний) ──────────────────────────────────────────

# Дефолтний список моделей для Settings dropdown.
# Синхронізовано з Settings.jsx (OLLAMA_DEFAULT_MODELS).
# Джерело реального списку: https://ollama.com/cloud (oLlama Cloud catalog).
OLLAMA_DEFAULT_MODELS = [
    "gpt-oss:120b",              # flagship англійською
    "gpt-oss:20b",               # дешевший варіант
    "minimax-m3",             # поточна модель Hermes Agent
    "minimax-m2.7",           # попередня
    "glm-5.2",                   # ZhipuAI
    "glm-5.1",
    "deepseek-v3.1:671b",        # найкращий reasoning
    "deepseek-v4-pro:preview",
    "llama-3.3-70b",             # стабільний tone-of-voice
    "qwen3-coder:480b",          # короткі відповіді
    "qwen3.5:397b",
    "mistral-large-3:675b",
    "kimi-k3",
]


def _build_draft_prompt(persona_description: str, post_text: str, subreddit: str, intent: str) -> str:
    """Спільний промпт для всіх провайдерів. Винесений, щоб Claude CLI і Ollama
    використовували однакову логіку intent."""
    intent_line = (
        "Do NOT mention any app, product, or link. Pure value/comment only — be a real member of the community."
        if intent == "value"
        else "You may mention the app you are building ONCE, near the end, only if it fits naturally — as a person would, never as an ad. Disclose that you built it."
    )
    return f"""You are the person described below. Reply in THEIR authentic voice only.

YOUR PERSONA (never break character, never mention you are an AI or that this is generated):
{persona_description}

TASK: Write a Reddit REPLY to the post below, in r/{subreddit or 'unknown'}.
- Use the persona's vocabulary, spelling quirks, and tone precisely.
- {intent_line}
- Substantive, 2-6 sentences. Match the sub's culture. No filler.

THE POST YOU ARE REPLYING TO:
{post_text}

Reply ONLY in JSON (no markdown fences):
{{"reply": "..."}}"""


def generate_draft_ollama(
    persona_description: str,
    post_text: str,
    subreddit: str,
    intent: str = "value",
    *,
    endpoint: str = "https://ollama.com",
    api_key: str = "",
    model: str = "gpt-oss:120b",
    timeout: int = 120,
) -> dict:
    """Викликає Ollama API (Cloud або локальний) і повертає {ok, reply, error}.

    endpoint: база URL. Для Ollama Cloud — https://ollama.com.
              Для локального — http://localhost:11434.
    api_key: потрібен тільки для Cloud. None/"" для локального.
    model: назва моделі (напр. gpt-oss:120b, llama-3.3-70b).
    """
    if not endpoint:
        return {"ok": False, "error": "Ollama endpoint не налаштований (Settings → Ollama)"}
    if not model:
        return {"ok": False, "error": "Ollama модель не обрана (Settings → Ollama)"}

    base = endpoint.rstrip("/")
    url = f"{base}/api/generate"
    prompt = _build_draft_prompt(persona_description, post_text, subreddit, intent)

    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    payload = {
        "model": model,
        "prompt": prompt,
        "stream": False,
        # JSON-режим: Ollama просить модель відповідати валідним JSON.
        # Підтримується не всіма моделями — fallback на regex парсер нижче.
        "format": "json",
    }

    try:
        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(url, data=data, headers=headers, method="POST")
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8", errors="replace")
        try:
            data = json.loads(body)
        except json.JSONDecodeError as e:
            return {"ok": False, "error": f"Ollama повернув невалідний JSON: {e}. Body: {body[:200]}"}

        raw = (data.get("response") or "").strip()
        if not raw:
            return {"ok": False, "error": f"Ollama повернув пусту відповідь. Body: {body[:200]}"}

        # Ollama в режимі format=json зазвичай повертає чистий JSON,
        # але деякі моделі все одно додають ```json fences — прибираємо.
        cleaned = re.sub(r"```(?:json)?", "", raw).replace("```", "").strip()
        # Шукаємо JSON-обʼєкт
        m = re.search(r"\{.*\}", cleaned, re.DOTALL)
        if not m:
            return {"ok": False, "error": f"Ollama відповідь без JSON. Відповідь: {raw[:200]}"}
        try:
            parsed = json.loads(m.group())
        except json.JSONDecodeError as e:
            return {"ok": False, "error": f"Ollama JSON parse error: {e}. Сирий текст: {raw[:200]}"}
        reply = parsed.get("reply", "").strip() if isinstance(parsed, dict) else ""
        if not reply:
            return {"ok": False, "error": f"Ollama JSON без поля 'reply'. JSON: {raw[:200]}"}
        return {"ok": True, "reply": reply, "model": model, "provider": "ollama"}
    except urllib.error.HTTPError as e:
        # 401/403/404 — часті помилки авторизації або невідома модель
        err_body = ""
        try:
            err_body = e.read().decode("utf-8", errors="replace")[:300]
        except Exception:
            pass
        return {"ok": False, "error": f"Ollama HTTP {e.code}: {err_body or e.reason}"}
    except urllib.error.URLError as e:
        return {"ok": False, "error": f"Ollama недоступний ({endpoint}): {e.reason}"}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"Ollama error: {e}"}


def generate_draft(
    persona_description: str,
    post_text: str,
    subreddit: str,
    intent: str = "value",
    *,
    provider: str = "claude-cli",  # 'claude-cli' | 'ollama'
    ollama_endpoint: str = "https://ollama.com",
    ollama_api_key: str = "",
    ollama_model: str = "gpt-oss:120b",
) -> dict:
    """Диспетчер: обирає провайдера і делегує.

    provider='claude-cli' → subprocess до claude.exe (потребує логін)
    provider='ollama'     → HTTP до Ollama API (Cloud або local)
    """
    if provider == "ollama":
        return generate_draft_ollama(
            persona_description=persona_description,
            post_text=post_text,
            subreddit=subreddit,
            intent=intent,
            endpoint=ollama_endpoint,
            api_key=ollama_api_key,
            model=ollama_model,
        )

    # --- legacy: Claude CLI ---
    cli = find_claude_cli()
    if not cli:
        return {"ok": False, "error": "Claude CLI не знайдено (claude.exe)"}

    prompt = _build_draft_prompt(persona_description, post_text, subreddit, intent)

    try:
        result = subprocess.run(
            [cli, "-p", prompt, "--model", CLAUDE_MODEL, "--output-format", "text"],
            stdin=subprocess.DEVNULL,  # уникаємо "no stdin data received" warning
            capture_output=True, text=True, encoding="utf-8", timeout=180,
        )
        if result.returncode != 0:
            stderr = (result.stderr or "").strip()
            stdout = (result.stdout or "").strip()
            # Claude CLI пише деякі повідомлення (напр. "Not logged in") у stdout.
            # Якщо stderr пустий — fallback на stdout, щоб користувач бачив причину.
            tail = stderr if stderr else stdout
            return {"ok": False, "error": f"Claude CLI rc={result.returncode}: {tail[:300]}"}
        text = (result.stdout or "").strip()
        if not text:
            return {"ok": False, "error": "Claude CLI повернув пусту відповідь"}
        cleaned = re.sub(r"```(?:json)?", "", text).replace("```", "")
        m = re.search(r"\{.*\}", cleaned, re.DOTALL)
        if not m:
            return {"ok": False, "error": f"Не вдалось розпарсити JSON. Відповідь: {text[:200]}"}
        try:
            data = json.loads(m.group())
        except json.JSONDecodeError as e:
            return {"ok": False, "error": f"JSON parse error: {e}"}
        return {"ok": True, "reply": data.get("reply", ""), "model": CLAUDE_MODEL}
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "Claude CLI timeout (180s)"}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)}


# ─── DB read helpers (для endpoint /reddit/posts) ──────────────────────────


def generate_draft_raw(
    prompt: str,
    *,
    provider: str = "claude-cli",
    ollama_endpoint: str = "https://ollama.com",
    ollama_api_key: str = "",
    ollama_model: str = "gpt-oss:120b",
    timeout: int = 180,
) -> dict:
    """Генерує відповідь по вже готовому prompt (без шаблону _build_draft_prompt).

    Використовується для /generate/persona-reply та /generate/persona-post —
    там prompt вже зібрано у main.py з повним контекстом (persona + post + intent),
    і нам не треба дублювати обгортку.

    Повертає {ok, reply, model} — той самий формат, що generate_draft.
    """
    if provider == "ollama":
        # Для Ollama викликаємо generate_draft_ollama напряму, але обходимо
        # _build_draft_prompt. Найпростіше: підставляємо prompt як persona_description
        # і використовуємо спеціальний post_text маркер.
        return _ollama_raw(
            prompt=prompt,
            endpoint=ollama_endpoint,
            api_key=ollama_api_key,
            model=ollama_model,
            timeout=timeout,
        )

    # --- Claude CLI ---
    cli = find_claude_cli()
    if not cli:
        return {"ok": False, "error": "Claude CLI не знайдено (claude.exe)"}

    try:
        result = subprocess.run(
            [cli, "-p", prompt, "--model", CLAUDE_MODEL, "--output-format", "text"],
            stdin=subprocess.DEVNULL,
            capture_output=True, text=True, encoding="utf-8", timeout=timeout,
        )
        if result.returncode != 0:
            tail = (result.stderr or result.stdout or "").strip()
            return {"ok": False, "error": f"Claude CLI rc={result.returncode}: {tail[:300]}"}
        text = (result.stdout or "").strip()
        if not text:
            return {"ok": False, "error": "Claude CLI повернув пусту відповідь"}
        return {"ok": True, "reply": text, "model": CLAUDE_MODEL, "provider": "claude-cli"}
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": f"Claude CLI timeout ({timeout}s)"}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def _ollama_raw(
    *,
    prompt: str,
    endpoint: str,
    api_key: str,
    model: str,
    timeout: int,
) -> dict:
    """Ollama-запит з raw prompt (без _build_draft_prompt обгортки)."""
    import json as _json
    import urllib.request
    import re as _re

    if not endpoint:
        return {"ok": False, "error": "Ollama endpoint не налаштований (Settings → Ollama)"}
    if not model:
        return {"ok": False, "error": "Ollama модель не обрана (Settings → Ollama)"}

    base = endpoint.rstrip("/")
    url = f"{base}/api/generate"
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    payload = {
        "model": model,
        "prompt": prompt,
        "stream": False,
        "format": "json",
    }

    try:
        data = _json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(url, data=data, headers=headers, method="POST")
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8", errors="replace")
        try:
            data = _json.loads(body)
        except _json.JSONDecodeError as e:
            return {"ok": False, "error": f"Ollama повернув невалідний JSON: {e}. Body: {body[:200]}"}
        raw = (data.get("response") or "").strip()
        if not raw:
            return {"ok": False, "error": f"Ollama повернув пусту відповідь. Body: {body[:200]}"}
        return {"ok": True, "reply": raw, "model": model, "provider": "ollama"}
    except urllib.error.HTTPError as e:
        err_body = ""
        try:
            err_body = e.read().decode("utf-8", errors="replace")[:300]
        except Exception:
            pass
        return {"ok": False, "error": f"Ollama HTTP {e.code}: {err_body or e.reason}"}
    except urllib.error.URLError as e:
        return {"ok": False, "error": f"Ollama недоступний ({endpoint}): {e.reason}"}
    except Exception as e:
        return {"ok": False, "error": f"Ollama error: {e}"}


def get_posts(status: str | None, subreddit: str | None, limit: int) -> list[dict]:
    conn = _connect()
    wheres = []
    args = []
    if status:
        wheres.append("status = ?")
        args.append(status)
    if subreddit:
        wheres.append("subreddit = ?")
        args.append(subreddit)
    where = ("WHERE " + " AND ".join(wheres)) if wheres else ""
    args.append(limit)
    rows = conn.execute(
        f"""SELECT * FROM reddit_found_posts {where}
            ORDER BY
              CASE status WHEN 'new' THEN 0 WHEN 'drafted' THEN 1 ELSE 2 END,
              score DESC,
              found_at DESC
            LIMIT ?""",
        args,
    ).fetchall()
    cols = [d[0] for d in conn.execute("SELECT * FROM reddit_found_posts LIMIT 0").description]
    conn.close()
    return [dict(zip(cols, r)) for r in rows]


def set_status(post_id: int, status: str) -> bool:
    conn = _connect()
    cur = conn.execute(
        "UPDATE reddit_found_posts SET status = ?, updated_at = datetime('now') WHERE id = ?",
        (status, post_id),
    )
    conn.commit()
    ok = cur.rowcount > 0
    conn.close()
    return ok


def delete_posts(post_ids: list[int]) -> dict:
    """Видаляє пости за id (та їх драфти каскадно). Повертає статистику.

    Не помиляється якщо id не існує — просто рахує скільки реально видалено.
    Використовує той самий retry-pattern що save_draft (Electron тримає SQLite).
    """
    if not post_ids:
        return {"ok": True, "deleted_posts": 0, "deleted_drafts": 0, "requested": 0}

    import time as _t
    # Нормалізуємо id до int, відкидаємо дурні значення
    valid_ids: list[int] = []
    for x in post_ids:
        try:
            valid_ids.append(int(x))
        except (TypeError, ValueError):
            pass
    valid_ids = [x for x in valid_ids if x > 0]
    if not valid_ids:
        return {"ok": True, "deleted_posts": 0, "deleted_drafts": 0, "requested": 0}

    last_err: Exception | None = None
    for attempt in range(5):
        try:
            conn = _connect()
            cur = conn.cursor()
            # Каскад: спочатку видаляємо драфти цих постів (бо reddit_drafts має
            # FK REFERENCES reddit_found_posts через post_id, але без ON DELETE
            # CASCADE — тому мусимо видаляти вручну).
            drafts_sql = "DELETE FROM reddit_drafts WHERE post_id IN ({})".format(
                ",".join("?" * len(valid_ids))
            )
            cur.execute(drafts_sql, valid_ids)
            deleted_drafts = cur.rowcount

            # Тепер видаляємо самі пости
            placeholders = ",".join("?" * len(valid_ids))
            posts_sql = f"DELETE FROM reddit_found_posts WHERE id IN ({placeholders})"
            cur.execute(posts_sql, valid_ids)
            deleted_posts = cur.rowcount

            conn.commit()
            conn.close()
            return {
                "ok": True,
                "deleted_posts": deleted_posts,
                "deleted_drafts": deleted_drafts,
                "requested": len(valid_ids),
            }
        except sqlite3.OperationalError as e:
            last_err = e
            if "locked" in str(e).lower() and attempt < 4:
                _t.sleep(0.4 * (2 ** attempt))
                continue
            return {"ok": False, "error": str(e)}
        except Exception as e:
            last_err = e
            return {"ok": False, "error": str(e)}
    return {"ok": False, "error": f"delete_posts timeout: {last_err}"}


def save_draft(post_id: int, persona_id: str | None, intent: str, reply: str, model: str = "") -> dict:
    # SQLite lock retries: Electron тримає базу для своїх readів у /reddit/posts,
    # і може тримати короткий write lock. OperationalError "database is locked"
    # означає що інший процес уже в транзакції. WAL + busy_timeout вирішують
    # це у 95% випадків, але для певності додаємо retry з backoff.
    import time as _t
    last_err = None
    for attempt in range(6):  # до 6 спроб: 0.1s, 0.2s, 0.4s, 0.8s, 1.6s, 3.2s
        conn = _connect()
        try:
            cur = conn.execute(
                """INSERT INTO reddit_drafts (post_id, persona_id, intent, reply_text, model)
                   VALUES (?, ?, ?, ?, ?)""",
                (post_id, persona_id, intent, reply, model),
            )
            draft_id = cur.lastrowid
            conn.execute(
                "UPDATE reddit_found_posts SET status = 'drafted', updated_at = datetime('now') WHERE id = ?",
                (post_id,),
            )
            conn.commit()
            row = conn.execute("SELECT * FROM reddit_drafts WHERE id = ?", (draft_id,)).fetchone()
            cols = [d[0] for d in conn.execute("SELECT * FROM reddit_drafts LIMIT 0").description]
            return dict(zip(cols, row)) if row else {}
        except sqlite3.OperationalError as e:
            last_err = e
            if "locked" not in str(e).lower():
                raise  # не lock-еррор — одразу пробрасываем
            try:
                conn.rollback()
            except Exception:
                pass
            _t.sleep(0.1 * (2 ** attempt))
        finally:
            try:
                conn.close()
            except Exception:
                pass
    raise last_err  # type: ignore[misc]


def get_drafts(post_id: int) -> list[dict]:
    conn = _connect()
    rows = conn.execute(
        "SELECT * FROM reddit_drafts WHERE post_id = ? ORDER BY created_at DESC", (post_id,)
    ).fetchall()
    cols = [d[0] for d in conn.execute("SELECT * FROM reddit_drafts LIMIT 0").description]
    conn.close()
    return [dict(zip(cols, r)) for r in rows]


# ─── Full text fetch через Reddit JSON API ─────────────────────────────────


def _strip_html(html: str) -> str:
    """Мінімальний HTML → text: викидаємо теги, декодуємо entities."""
    if not html:
        return ""
    import html as html_lib
    import re
    text = re.sub(r"<[^>]+>", " ", html)
    text = html_lib.unescape(text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def fetch_full_text(reddit_id: str) -> dict:
    """Витягує повний selftext поста через Reddit JSON API.

    reddit_id: 't3_abc123' або просто 'abc123'
    Використовує публічний endpoint /r/all/comments/{id}.json (не OAuth Info).
    Повертає {ok, selftext, score, num_comments, permalink, ...}
    При помилці — {ok: False, error: str}
    """
    import time as _time
    rid = reddit_id
    if rid.startswith("t3_"):
        rid = rid[3:]
    backoffs = (0, 3, 10, 30)
    for wait in backoffs:
        if wait:
            _time.sleep(wait)
        # Публічний endpoint (без OAuth). Спробуємо r/all, потім r/<sub>.
        # subreddit у нас є у SQLite, але для простоти — r/all завжди працює.
        url = f"https://www.reddit.com/r/all/comments/{rid}.json"
        try:
            req = urllib.request.Request(
                url,
                headers={
                    "User-Agent": USER_AGENT,
                    "Accept": "application/json",
                },
            )
            with urllib.request.urlopen(req, timeout=20) as resp:
                if resp.status == 200:
                    data = json.loads(resp.read())
                    if isinstance(data, list) and len(data) > 0:
                        children = data[0].get("data", {}).get("children", [])
                        if children:
                            post = children[0]["data"]
                            return _extract_selftext(post)
                        return {"ok": False, "error": "no children in response"}
                    return {"ok": False, "error": "unexpected response shape"}
                if resp.status == 429:
                    print(f"  ! fetch_full_text: 429, waiting 60s", file=sys.stderr)
                    _time.sleep(60)
                    continue
                return {"ok": False, "error": f"HTTP {resp.status}"}
        except urllib.error.HTTPError as e:  # type: ignore[attr-defined]
            if e.code in (429, 503):
                _time.sleep(60)
                continue
            return {"ok": False, "error": f"HTTPError {e.code}: {e.reason}"}
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": str(e)}
    return {"ok": False, "error": "rate-limited after retries"}


def _extract_selftext(post: dict) -> dict:
    """Витягує поля поста з Reddit JSON."""
    selftext_html = post.get("selftext", "") or ""
    selftext = _strip_html(selftext_html)
    return {
        "ok": True,
        "selftext": selftext,
        "selftext_html": selftext_html,
        "score": post.get("score", 0),
        "num_comments": post.get("num_comments", 0),
        "permalink": "https://reddit.com" + post.get("permalink", ""),
        "author": post.get("author", ""),
        "created_utc": int(post.get("created_utc", 0)),
    }


def fetch_and_store_full_text(post_id: int) -> dict:
    """Fetch full selftext + update SQLite row. Повертає результат + пост."""
    post = get_posts(None, None, 500)
    target = next((p for p in post if p["id"] == post_id), None)
    if target is None:
        return {"ok": False, "error": f"Post id={post_id} not found"}
    reddit_id = target.get("reddit_id", "")
    if not reddit_id:
        return {"ok": False, "error": "no reddit_id"}
    res = fetch_full_text(reddit_id)
    if not res.get("ok"):
        return res
    # Update DB
    conn = _connect()
    now_iso = datetime.now(timezone.utc).isoformat()
    conn.execute(
        """UPDATE reddit_found_posts
           SET selftext = ?,
               selftext_fetched_at = ?,
               score = ?,
               num_comments = ?,
               updated_at = ?
           WHERE id = ?""",
        (
            res.get("selftext", ""),
            now_iso,
            res.get("score", target.get("score", 0)),
            res.get("num_comments", target.get("num_comments", 0)),
            now_iso,
            post_id,
        ),
    )
    conn.commit()
    # Read back updated row
    cols = [d[0] for d in conn.execute("SELECT * FROM reddit_found_posts LIMIT 0").description]
    row = conn.execute(
        "SELECT * FROM reddit_found_posts WHERE id = ?", (post_id,)
    ).fetchone()
    conn.close()
    return {
        "ok": True,
        "post": dict(zip(cols, row)) if row else None,
        "fetched": res,
    }


# ─── Devvit RSS sync (варіант B — через r/hrrmmendeses_dev RSS) ─────────────


DEVVIT_SUBREDDIT = "hrrmmendeses_dev"
DEVVIT_JSON_RE = re.compile(r"<devvit-digest>(.*?)</devvit-digest>", re.DOTALL)


def _fetch_devvit_rss(subreddit: str = DEVVIT_SUBREDDIT, limit: int = 5) -> bytes | None:
    """Завантажує RSS для Devvit subreddit (тільки кілька останніх постів)."""
    url = f"https://www.reddit.com/r/{subreddit}/new/.rss?limit={limit}"
    try:
        req = urllib.request.Request(
            url,
            headers={
                "User-Agent": USER_AGENT,
                "Accept": "application/atom+xml, application/xml;q=0.9, */*;q=0.8",
            },
        )
        with urllib.request.urlopen(req, timeout=20) as resp:
            if resp.status == 200:
                return resp.read()
            print(f"  ! devvit RSS: HTTP {resp.status}", file=sys.stderr)
            return None
    except Exception as e:
        print(f"  ! devvit RSS: {e}", file=sys.stderr)
        return None


def _parse_devvit_posts_from_rss(xml_bytes: bytes) -> list[dict]:
    """Парсить RSS r/hrrmmendeses_dev, витягує JSON-блок з <devvit-digest> тегу.

    Повертає список DigestPost-об'єктів з усіх знайдених дайджест-постів.
    Дедуплікує по id поста.
    """
    try:
        root = ET.fromstring(xml_bytes)
    except ET.ParseError as e:
        print(f"  ! devvit RSS parse error: {e}", file=sys.stderr)
        return []

    seen_ids: set[str] = set()
    all_posts: list[dict] = []

    for entry in root.findall(f"{ATOM_NS}entry"):
        # Шукаємо JSON-блок у content
        content_elem = entry.find(f"{ATOM_NS}content")
        if content_elem is None or not content_elem.text:
            continue

        content_text = html_module.unescape(content_elem.text or "")
        m = DEVVIT_JSON_RE.search(content_text)
        if not m:
            continue

        raw_block = m.group(1)
        # Devvit v0.0.5+ кодує JSON в base64 щоб Reddit не ламав його
        # markdown-рендером. Старі пости мають чистий JSON.
        try:
            import base64
            json_str = base64.b64decode(raw_block).decode("utf-8")
        except Exception:
            # Старий формат: чистий JSON, ламаний Reddit markdown-рендером.
            # Reddit обгортає URL-и в <a> теги та URL-кодує решту рядка.
            import urllib.parse
            json_str = re.sub(r'<a\s+href="([^"]*)"[^>]*>(.*?)</a>', r'\1', raw_block)
            json_str = urllib.parse.unquote(json_str)
            json_str = re.sub(r'</?[a-zA-Z][^>]*>', '', json_str)

        try:
            digest = json.loads(json_str)
        except json.JSONDecodeError as e:
            print(f"  ! devvit JSON parse: {e}", file=sys.stderr)
            continue

        posts = digest.get("posts", [])
        for p in posts:
            pid = p.get("id", "")
            if pid and pid not in seen_ids:
                seen_ids.add(pid)
                all_posts.append(p)

    return all_posts


def sync_devvit_posts() -> dict:
    """Синхронізує пости з Devvit (через RSS r/hrrmmendeses_dev) у локальну SQLite.

    Devvit публікує text post з JSON-блоком <devvit-digest>...</devvit-digest>.
    Ця функція:
      1. Читає RSS r/hrrmmendeses_dev (1 запит — мінімальний ризик IP бану)
      2. Парсить JSON з постів
      3. Upsert в SQLite з score/numComments

    Повертає статистику: {ok, fetched, inserted, updated, unchanged, error}.
    """
    xml = _fetch_devvit_rss()
    if not xml:
        return {
            "ok": False,
            "error": "Не вдалось завантажити RSS r/hrrmmendeses_dev",
            "fetched": 0,
            "inserted": 0,
            "updated": 0,
            "unchanged": 0,
        }

    posts = _parse_devvit_posts_from_rss(xml)
    if not posts:
        return {
            "ok": True,
            "fetched": 0,
            "inserted": 0,
            "updated": 0,
            "unchanged": 0,
            "message": "Дайджест-постів не знайдено або JSON порожній",
        }

    conn = _connect()
    inserted = 0
    updated = 0
    unchanged = 0
    for p in posts:
        _, is_new, is_updated = _upsert_devvit_post(conn, p)
        if is_new:
            inserted += 1
        elif is_updated:
            updated += 1
        else:
            unchanged += 1
    conn.commit()
    conn.close()
    return {
        "ok": True,
        "fetched": len(posts),
        "inserted": inserted,
        "updated": updated,
        "unchanged": unchanged,
    }


def _upsert_devvit_post(conn: sqlite3.Connection, post: dict) -> tuple[int, bool, bool]:
    """Upsert поста з Devvit в reddit_found_posts.

    На відміну від RSS-постів, Devvit дає score і numComments.
    Якщо пост вже є — оновлюємо score/num_comments.

    Повертає (local_id, inserted_new, updated_score).
    """
    reddit_id = post.get("id", "")
    if not reddit_id:
        return (0, False, False)

    cur = conn.execute(
        "SELECT id, score, num_comments FROM reddit_found_posts WHERE reddit_id = ?",
        (reddit_id,),
    )
    row = cur.fetchone()

    matched_kw = post.get("matchedKeywords", [])
    if isinstance(matched_kw, list):
        matched_kw_str = " ".join(matched_kw)
    else:
        matched_kw_str = str(matched_kw)

    score = post.get("score", 0)
    num_comments = post.get("numComments", 0)
    created_utc = post.get("createdUtc", 0)

    if row is not None:
        local_id = row[0]
        old_score = row[1] or 0
        old_comments = row[2] or 0
        if score != old_score or num_comments != old_comments:
            conn.execute(
                """UPDATE reddit_found_posts
                   SET score = ?, num_comments = ?, updated_at = datetime('now')
                   WHERE id = ?""",
                (score, num_comments, local_id),
            )
            return (local_id, False, True)
        return (local_id, False, False)

    # Devvit дає relative permalink (/r/.../comments/...) — додаємо домен
    permalink = post.get("permalink", "")
    if permalink and not permalink.startswith("http"):
        permalink = "https://www.reddit.com" + permalink

    cur = conn.execute(
        """INSERT INTO reddit_found_posts (
              reddit_id, subreddit, title, author, permalink, url,
              score, num_comments, created_utc, matched_keywords,
              status, found_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', datetime('now'), datetime('now'))""",
        (
            reddit_id,
            post.get("subreddit", ""),
            post.get("title", ""),
            post.get("author", ""),
            permalink,
            post.get("url", ""),
            score,
            num_comments,
            created_utc,
            matched_kw_str,
        ),
    )
    return (cur.lastrowid, True, False)


# ─── CLI для cron / debug ─────────────────────────────────────────────────


def main_cli() -> int:
    if len(sys.argv) > 1 and sys.argv[1] == "--scan":
        stats = scan_all()
        print(json.dumps(stats, indent=2))
        return 0
    if len(sys.argv) > 1 and sys.argv[1] == "--list":
        status = sys.argv[2] if len(sys.argv) > 2 else "new"
        posts = get_posts(status, None, 20)
        for p in posts:
            print(f"  [{p['status']}] r/{p['subreddit']} | {p['title'][:80]}")
        return 0
    if len(sys.argv) > 1 and sys.argv[1] == "--devvit-sync":
        stats = sync_devvit_posts()
        print(json.dumps(stats, indent=2))
        return 0
    print("Usage: python reddit_monitor.py --scan | --list [status] | --devvit-sync")
    return 1


if __name__ == "__main__":
    sys.exit(main_cli())
