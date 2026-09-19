import sys
import os

# Force UTF-8 stdout/stderr на Windows (cp1251 падає на → і іншій unicode).
# Працює навіть коли Python запустили без PYTHONIOENCODING env.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
import instagram
import generate
import android_poster
import threads_poster
import threads_monitor
import reddit_monitor
import tigfusion
import json
import time
import tempfile
import urllib.request
import urllib.error


# ─── Electron settings.json reader ─────────────────────────────────────────
# electron-store зберігає в %APPDATA%/reels-generator/settings.json.
# Читаємо напряму, без IPC, щоб Python мав доступ до api ключів і налаштувань.
def _electron_settings_path() -> str:
    if sys.platform == "win32":
        appdata = os.environ.get("APPDATA") or os.path.expanduser("~\\AppData\\Roaming")
        return os.path.join(appdata, "reels-generator", "settings.json")
    # macOS/Linux fallback (на випадок запуску поза Electron)
    return os.path.expanduser("~/.config/reels-generator/settings.json")


def _read_electron_settings() -> dict:
    """Зчитує settings.json. Повертає dict (може бути порожнім)."""
    path = _electron_settings_path()
    if not os.path.isfile(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        print(f"[main] settings.json read error: {e}", file=sys.stderr)
        return {}


def _draft_provider_settings() -> dict:
    """Витягує provider + ollama-параметри з settings. Дефолти — Claude CLI."""
    s = _read_electron_settings()
    ollama = s.get("ollama") or {}
    return {
        "provider": ollama.get("provider") or "claude-cli",
        "ollama_endpoint": ollama.get("endpoint") or "https://ollama.com",
        "ollama_api_key": ollama.get("apiKey") or "",
        "ollama_model": ollama.get("model") or "gpt-oss:120b",
    }
import subprocess
import threading

app = FastAPI(title="Reels Generator API")

# ─── Reddit scan background state ──────────────────────────────────────────
_scan_state = {
    "running": False,
    "done": False,
    "result": None,
    "error": None,
    "started_at": None,
    "finished_at": None,
}
_scan_lock = threading.Lock()

# Модель для Claude CLI. Аліас "sonnet" мапиться через ANTHROPIC_DEFAULT_SONNET_MODEL
# (на проксі-сетапі це glm-5.2:cloud). Без --model CLI дефолтить на модель типу
# claude-fable-5, якої проксі не знає → генерація падає. Можна перевизначити через ANTHROPIC_MODEL.
CLAUDE_MODEL = os.environ.get("ANTHROPIC_MODEL") or "sonnet"

@app.get("/test-claude-cli")
def test_claude_cli():
    """Debug: test if Claude CLI works from server context."""
    try:
        candidates = [r"C:\claude code\claude.exe", r"C:\claude code\reels-generator\python\claude.exe", os.path.join(os.path.expanduser("~"), "AppData", "Roaming", "Claude", "claude-code", "2.1.87", "claude.exe")]
        cli = ""
        results = {}
        for c in candidates:
            exists = os.path.isfile(c)
            results[c] = exists
            if exists and not cli:
                cli = c
        if not cli:
            return {"cli_exists": False, "checked": results}
        result = subprocess.run(
            [cli, "-p", "Return ONLY this JSON: {\"test\": \"ok\"}", "--output-format", "text"],
            capture_output=True, text=True, timeout=30,
        )
        return {
            "cli_exists": True,
            "returncode": result.returncode,
            "stdout": result.stdout[:300],
            "stderr": result.stderr[:300],
        }
    except Exception as e:
        return {"error": str(e)}

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ===== SCHEMAS =====

class SessionRequest(BaseModel):
    session_id: str

class DownloadRequest(BaseModel):
    video_url: str
    save_path: str

class EnrichRequest(BaseModel):
    reel_ids: list[str]


# ===== ROUTES =====

@app.get("/health")
def health():
    return {"status": "ok", "version": "1.0.0"}


@app.post("/auth/login")
def login(body: SessionRequest):
    # Спочатку перевіряємо сесію прямим запитом
    check = instagram.check_session(body.session_id)
    if check["ok"]:
        # Пробуємо ініціалізувати instagrapi клієнт (для парсингу)
        instagram.login_by_session(body.session_id)
    return check


@app.get("/auth/status")
def auth_status():
    return {"logged_in": instagram.is_logged_in()}


@app.get("/account/{username}")
def account_info(username: str):
    return instagram.get_account_info(username)


@app.get("/reels/{username}")
def get_reels(username: str, amount: int = 50):
    return instagram.get_reels(username, amount)


class EnrichRequestV2(BaseModel):
    reel_ids: list[str]
    session_id: str


@app.post("/reels/enrich")
def enrich_reels(body: EnrichRequestV2):
    """
    Завантажує view_count через прямий HTTP-запит до Instagram API.
    Rate limiting: пауза між запитами, бекофф при 429, зупинка при auth error.
    """
    def generate():
        total = len(body.reel_ids)
        delay = 1.0  # базова пауза між запитами
        rate_limit_count = 0
        auth_failed = False

        for i, reel_id in enumerate(body.reel_ids):
            if auth_failed:
                yield json.dumps({
                    "reel_id": reel_id, "views": 0, "index": i + 1,
                    "total": total, "status": "skipped_auth_error",
                }) + "\n"
                continue

            result_data = instagram.get_media_views(reel_id, body.session_id)
            views = result_data.get("views", 0)
            status = result_data.get("status", "ok")

            result = {
                "reel_id": reel_id,
                "views": views,
                "index": i + 1,
                "total": total,
                "status": status,
            }
            yield json.dumps(result) + "\n"

            # Handle rate limiting with exponential backoff
            if status == "rate_limited":
                rate_limit_count += 1
                backoff = min(delay * (2 ** rate_limit_count), 30)  # max 30s
                time.sleep(backoff)
            elif status == "auth_error":
                auth_failed = True
                yield json.dumps({
                    "error": "Session ID недійсний. Оновіть cookie.",
                    "index": i + 1, "total": total, "status": "auth_error",
                }) + "\n"
            else:
                rate_limit_count = max(0, rate_limit_count - 1)
                time.sleep(delay)

    return StreamingResponse(generate(), media_type="application/x-ndjson")


@app.post("/download")
def download_reel(body: DownloadRequest):
    return instagram.download_reel(body.video_url, body.save_path)


# ===== REDDIT FEED MONITOR =====

class RedditScanRequest(BaseModel):
    subreddits: list[str] | None = None
    limit_per_sub: int = 50


@app.post("/reddit/scan")
def reddit_scan(body: RedditScanRequest | None = None):
    """Запускає асинхронний scan Reddit RSS у background thread.
    Повертає одразу {ok: true, running: true}. Перевір статус через /reddit/scan/status.
    """
    with _scan_lock:
        if _scan_state["running"]:
            return {"ok": True, "running": True, "message": "Scan вже триває"}
        _scan_state.update(
            running=True, done=False, result=None, error=None,
            started_at=time.time(), finished_at=None,
        )

    subs = body.subreddits if body else None

    def _bg_scan():
        try:
            stats = reddit_monitor.scan_all(subs)
            with _scan_lock:
                _scan_state["result"] = stats
                _scan_state["done"] = True
                _scan_state["running"] = False
                _scan_state["finished_at"] = time.time()
        except Exception as e:
            with _scan_lock:
                _scan_state["error"] = str(e)
                _scan_state["done"] = True
                _scan_state["running"] = False
                _scan_state["finished_at"] = time.time()

    t = threading.Thread(target=_bg_scan, daemon=True)
    t.start()
    return {"ok": True, "running": True, "message": "Scan запущено у фоні"}


@app.get("/reddit/scan/status")
def reddit_scan_status():
    """Повертає поточний статус background scan."""
    with _scan_lock:
        started = _scan_state["started_at"]
        finished = _scan_state["finished_at"]
        now = time.time()
        # elapsed — це скільки секунд минуло з моменту started_at.
        # Якщо scan завершений — elapsed = finished_at - started_at (точний час сканування).
        # Якщо ще триває — elapsed = now - started_at (live counter).
        elapsed = None
        if started and finished:
            elapsed = round(finished - started, 1)
        elif started and _scan_state["running"]:
            elapsed = round(now - started, 1)
        return {
            "running": _scan_state["running"],
            "done": _scan_state["done"],
            "result": _scan_state["result"],
            "error": _scan_state["error"],
            "started_at": started,
            "finished_at": finished,
            "elapsed": elapsed,
        }


@app.get("/reddit/posts")
def reddit_posts(status: str | None = None, subreddit: str | None = None, limit: int = 200):
    """Список знайдених постів. status: 'new' | 'drafted' | 'dismissed' | None(усі)."""
    try:
        posts = reddit_monitor.get_posts(status, subreddit, min(limit, 500))
        return {"ok": True, "count": len(posts), "posts": posts}
    except Exception as e:
        return {"ok": False, "error": str(e)}


class RedditDeletePostsRequest(BaseModel):
    """Запит на масове видалення постів з БД."""
    ids: list[int] = []


@app.post("/reddit/posts/delete")
def reddit_posts_delete(body: RedditDeletePostsRequest):
    """Видаляє пости (та пов'язані драфти) за id.

    Повертає {ok, deleted_posts, deleted_drafts, requested}.
    Невідомі id тихо ігноруються.
    """
    try:
        return reddit_monitor.delete_posts(body.ids)
    except Exception as e:
        return {"ok": False, "error": str(e)}


class RedditDraftRequest(BaseModel):
    post_id: int
    persona_id: str | None = None
    persona_description: str = ""
    intent: str = "value"  # 'value' | 'light-promo'
    # Опціонально — перевизначити провайдера і ollama-параметри для одного запиту.
    # Якщо None — використовуються значення з settings (див. _draft_provider_settings()).
    provider: str | None = None  # 'claude-cli' | 'ollama'
    ollama_endpoint: str | None = None
    ollama_api_key: str | None = None
    ollama_model: str | None = None


@app.post("/reddit/draft")
def reddit_draft(body: RedditDraftRequest):
    """Генерує драфт-відповідь через обраний провайдер (Claude CLI або Ollama)
    і зберігає у reddit_drafts. Позначає пост як 'drafted' (тільки при успіху).
    """
    post = reddit_monitor.get_posts(None, None, 500)
    target = next((p for p in post if p["id"] == body.post_id), None)
    if target is None:
        return {"ok": False, "error": f"Post id={body.post_id} не знайдено"}
    # Якщо selftext ще не завантажений — пробуємо один раз підтягнути з Reddit.
    # Це додає ~1-3с на перший драфт нового поста, але дає Ollama реальний контекст.
    if not (target.get("selftext") or "").strip():
        try:
            fr = reddit_monitor.fetch_and_store_full_text(body.post_id)
            if fr.get("ok") and fr.get("post"):
                target = fr["post"]
        except Exception as _fe:
            print(f"[reddit_draft] selftext fetch failed: {_fe}", file=sys.stderr)
    selftext = (target.get("selftext") or "").strip()
    selftext_block = f"\nBody:\n{selftext}\n" if selftext else ""
    post_text = (
        f"Subreddit: r/{target['subreddit']}\n"
        f"Author: u/{target['author']}\n"
        f"Score: {target['score']}, Comments: {target['num_comments']}\n\n"
        f"Title: {target['title']}\n"
        f"{selftext_block}\n"
        f"Link: {target['permalink']}\n"
    )
    # Параметри провайдера: тіло запиту > settings.json > дефолт.
    s = _draft_provider_settings()
    provider = body.provider or s["provider"]
    res = reddit_monitor.generate_draft(
        persona_description=body.persona_description,
        post_text=post_text,
        subreddit=target["subreddit"],
        intent=body.intent,
        provider=provider,
        ollama_endpoint=body.ollama_endpoint or s["ollama_endpoint"],
        ollama_api_key=body.ollama_api_key or s["ollama_api_key"],
        ollama_model=body.ollama_model or s["ollama_model"],
    )
    if not res.get("ok"):
        # Зберігаємо невдалу спробу у reddit_drafts (для аудиту)
        reddit_monitor.save_draft(
            post_id=body.post_id,
            persona_id=body.persona_id,
            intent=body.intent,
            reply="",
            model=res.get("model", ""),
        )
        return res
    saved = reddit_monitor.save_draft(
        post_id=body.post_id,
        persona_id=body.persona_id,
        intent=body.intent,
        reply=res.get("reply", ""),
        model=res.get("model", ""),
    )
    drafts = reddit_monitor.get_drafts(body.post_id)
    # Нормалізуємо поле reply_text → reply для сумісності з UI (RedditFeed.jsx
    # читає d.reply, а SQLite-колонка називається reply_text).
    drafts_norm = [
        {**d, "reply": d.get("reply_text", "")} for d in drafts
    ]
    saved_norm = {**saved, "reply": saved.get("reply_text", "")} if isinstance(saved, dict) else saved
    return {
        "ok": True,
        "draft": saved_norm,
        "all_drafts": drafts_norm,
        "reply": res.get("reply", ""),
    }


class RedditStatusRequest(BaseModel):
    post_id: int
    status: str  # 'new' | 'drafted' | 'dismissed'


@app.post("/reddit/status")
def reddit_status(body: RedditStatusRequest):
    ok = reddit_monitor.set_status(body.post_id, body.status)
    return {"ok": ok}


@app.get("/reddit/draft/models")
def reddit_draft_models():
    """Список доступних Ollama-моделей для Settings dropdown + поточні налаштування."""
    s = _draft_provider_settings()
    return {
        "ok": True,
        "models": reddit_monitor.OLLAMA_DEFAULT_MODELS,
        "current": {
            "provider": s["provider"],
            "endpoint": s["ollama_endpoint"],
            "model": s["ollama_model"],
            "has_api_key": bool(s["ollama_api_key"]),
        },
    }


@app.post("/reddit/draft/test")
def reddit_draft_test():
    """Швидкий тест: перевіряє чи Ollama endpoint відповідає і API key валідний.
    Не генерує драфт, лише пінгує."""
    s = _draft_provider_settings()
    if s["provider"] != "ollama":
        return {"ok": False, "error": "Провайдер не ollama. Перевірка тільки для Ollama."}
    if not s["ollama_endpoint"]:
        return {"ok": False, "error": "Endpoint не налаштований"}
    if not s["ollama_api_key"] and "ollama.com" in s["ollama_endpoint"]:
        return {"ok": False, "error": "API key потрібен для Ollama Cloud"}
    base = s["ollama_endpoint"].rstrip("/")
    # Використовуємо /api/tags — повертає список моделей, що юзер має доступ.
    url = f"{base}/api/tags"
    headers = {}
    if s["ollama_api_key"]:
        headers["Authorization"] = f"Bearer {s['ollama_api_key']}"
    try:
        req = urllib.request.Request(url, headers=headers, method="GET")
        with urllib.request.urlopen(req, timeout=10) as resp:
            body = resp.read().decode("utf-8", errors="replace")
        data = json.loads(body)
        models = [m.get("name") for m in (data.get("models") or []) if m.get("name")]
        return {"ok": True, "models_available": models[:20], "endpoint": base}
    except urllib.error.HTTPError as e:
        err = ""
        try:
            err = e.read().decode("utf-8", errors="replace")[:200]
        except Exception:
            pass
        return {"ok": False, "error": f"HTTP {e.code}: {err or e.reason}"}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)[:300]}


@app.get("/reddit/drafts/{post_id}")
def reddit_drafts(post_id: int):
    drafts = reddit_monitor.get_drafts(post_id)
    # Нормалізуємо reply_text → reply для UI (див. /reddit/draft).
    drafts_norm = [
        {**d, "reply": d.get("reply_text", "")} for d in drafts
    ]
    return {"ok": True, "count": len(drafts_norm), "drafts": drafts_norm}


@app.post("/reddit/fetch-full/{post_id}")
def reddit_fetch_full(post_id: int):
    """Витягує повний selftext поста через Reddit JSON API і зберігає у SQLite.

    Lazy fetch: викликати тільки коли юзер хоче бачити повний текст.
    При 429 повертає {ok: false, error: ...} — не блокує.
    """
    try:
        result = reddit_monitor.fetch_and_store_full_text(post_id)
        return result
    except Exception as e:
        return {"ok": False, "error": str(e)}


@app.post("/reddit/devvit/sync")
def reddit_devvit_sync():
    """Синхронізує пости з Devvit External Endpoint у локальну SQLite.

    Devvit сканує Reddit на своїх серверах (без IP бану) і зберігає
    пости в KV. Цей endpoint витягує їх і кладе в нашу SQLite.
    Пости приходять з score/numComments (на відміну від RSS).
    """
    try:
        result = reddit_monitor.sync_devvit_posts()
        return result
    except Exception as e:
        return {"ok": False, "error": str(e)}


@app.get("/reddit/devvit/status")
def reddit_devvit_status():
    """Перевіряє чи доступний Devvit RSS фід (r/hrrmmendeses_dev)."""
    return {
        "configured": True,
        "subreddit": reddit_monitor.DEVVIT_SUBREDDIT,
        "method": "rss",
    }


# ===== GENERATION =====

class GenerateImageRequest(BaseModel):
    prompt: str = ""
    style: str = "Воїн"
    provider: str = "stability"
    api_key: str
    variant_index: int = -1
    claude_api_key: str = ""
    gemini_api_key: str = ""

class GenerateVideoRequest(BaseModel):
    image_path: str
    prompt: str = ""
    provider: str = "kling"
    api_key: str

class ComposeRequest(BaseModel):
    video_path: str
    quote: str = ""
    music_path: str | None = None
    logo_path: str | None = None
    slow_motion: bool = False
    slow_motion_mode: str = "blend"  # blend | rife | mci
    slow_motion_factor: float = 0.7  # 0.3-1.0, 0.5 = 2x повільніше
    overlay_opacity: float = 0.0   # 0.0-0.8 чорний оверлей
    trim_start: float = 0.0        # секунди
    trim_end: float = 0.0          # секунди (0 = до кінця)
    video_effect: str = ""         # cinematic, cold_steel, blood_ash, fog_ghost, noir
    effect_strength: float = 1.0   # 0.0-1.0
    music_trim_start: float = 0.0
    music_trim_end: float = 0.0
    text_size: int = 100           # % scale
    text_weight: int = 500         # font-weight
    text_position: int = 50        # % from top
    text_font: str = "YuGothM.ttc" # font filename

class PromptsData(BaseModel):
    styles: dict


@app.get("/prompts")
def get_prompts():
    return generate.load_prompts()


class GeneratePromptRequest(BaseModel):
    style: str = ""


@app.post("/generate/prompt")
def generate_prompt_endpoint(body: GeneratePromptRequest):
    if not body.style:
        return {"ok": False, "error": "Стиль не вибрано"}

    raw = generate.generate_prompt_for_style(body.style)
    if not raw:
        return {"ok": False, "error": f"Не вдалось згенерувати промт для стилю '{body.style}'. Перевір master prompt файл або Claude CLI."}

    def to_json_str(val):
        if isinstance(val, dict):
            return json.dumps(val, ensure_ascii=False, indent=2)
        try:
            return json.dumps(json.loads(val), ensure_ascii=False, indent=2)
        except Exception:
            return str(val)

    img = raw.get("image_prompt", {})
    vid = raw.get("video_prompt", {})

    # Nano Banana Pro: JSON string для UI і для генератора — однакові
    img_json = to_json_str(img)

    return {
        "ok": True,
        "prompt": img_json,           # JSON для UI (відображення)
        "prompt_text": img_json,      # той самий JSON для генератора (Nano Banana Pro format)
        "video_prompt": to_json_str(vid),
        "video_prompt_text": generate._assemble_video_prompt(vid) if isinstance(vid, dict) else str(vid),
        "quote": raw.get("quote", ""),
    }


@app.post("/prompts")
def save_prompts(body: PromptsData):
    ok = generate.save_prompts(body.model_dump())
    return {"ok": ok}


class GenerateFullRequest(BaseModel):
    style: str = "Воїн"
    prompt: str = ""
    quote: str = ""
    music_path: str | None = None
    logo_path: str | None = None
    image_provider: str = "stability"
    image_api_key: str
    video_provider: str = "kling"
    video_api_key: str


@app.post("/generate/image")
def gen_image(body: GenerateImageRequest):
    return generate.generate_image(body.prompt, body.style, body.provider, body.api_key, body.variant_index, body.claude_api_key, body.gemini_api_key)


# ───── Post / Carousel image generation (ізольовано від Reels) ─────

class PostImageRequest(BaseModel):
    prompt: str = ""
    style: str = ""
    project_url: str = ""
    aspect: str = "1:1"


@app.post("/generate/post-image")
def gen_post_image(body: PostImageRequest):
    """Generate 1:1 image via Google Flow (той же pipeline що Reels).
    Не чіпає Reels — новий aspect='1:1' через параметр, Reels default '9:16'."""
    import post_generate
    return post_generate.generate_post_image(
        body.prompt, body.style, body.project_url, aspect=body.aspect,
    )


class CarouselPromptsRequest(BaseModel):
    style: str = ""
    topic: str = ""
    n_slides: int = 5
    claude_api_key: str = ""


@app.post("/generate/carousel-prompts")
def gen_carousel_prompts(body: CarouselPromptsRequest):
    """Claude CLI генерує scene_anchor + N angle prompts для carousel."""
    import post_generate
    return post_generate.generate_carousel_prompts(
        body.style, body.topic, body.n_slides, body.claude_api_key
    )


# ─── Carousel Agent (Ollama ідеї + Google Flow зображення) ────────────────
class CarouselAgentRequest(BaseModel):
    template: str = ""          # шаблон ідеї (порожньо = випадковий)
    n_slides: int = 5           # 2-10
    style: str = "hokan"        # hokan | mushin
    generate_images: bool = True
    apply_text: bool = True
    model: str = ""             # override Ollama model
    endpoint: str = ""
    api_key: str = ""


@app.post("/carousel-agent/run")
def carousel_agent_run(body: CarouselAgentRequest):
    """Запускає Carousel Agent: ідея → слайди → зображення → текст."""
    import carousel_agent
    return carousel_agent.run_agent(
        template=body.template,
        n_slides=body.n_slides,
        style=body.style,
        generate_images=body.generate_images,
        apply_text=body.apply_text,
        model=body.model,
        endpoint=body.endpoint,
        api_key=body.api_key,
    )


@app.post("/carousel-agent/idea")
def carousel_agent_idea(body: CarouselAgentRequest):
    """Тільки крок 1: згенерувати ідею (без зображень)."""
    import carousel_agent
    return carousel_agent.generate_idea(
        body.template, body.model, body.endpoint, body.api_key
    )


@app.post("/carousel-agent/slides")
def carousel_agent_slides(body: CarouselAgentRequest):
    """Тільки крок 2: згенерувати слайди з ідеї (без зображень)."""
    import carousel_agent
    return carousel_agent.generate_slides(
        body.template, body.n_slides, body.style, body.model, body.endpoint, body.api_key
    )


class PostOverlayRequest(BaseModel):
    image_path: str
    text: str = ""
    font_size: int = 120
    position: int = 50            # % від висоти (0 = top, 100 = bottom, 50 = center)
    color: str = "white"
    stroke_color: str = "black"
    stroke_width: int = 6


@app.post("/render/post-overlay")
def render_post_overlay(body: PostOverlayRequest):
    """Burn text overlay на зображення (PIL)."""
    import post_generate
    return post_generate.render_text_overlay(
        body.image_path, body.text, body.font_size,
        body.position, body.color, body.stroke_color, body.stroke_width,
    )


@app.post("/generate/video")
def gen_video(body: GenerateVideoRequest):
    return generate.generate_video(body.image_path, body.prompt, body.provider, body.api_key)


@app.post("/generate/compose")
def gen_compose(body: ComposeRequest):
    return generate.compose_final(body.video_path, body.quote, body.music_path, body.logo_path,
                                   slow_motion=body.slow_motion,
                                   slow_motion_mode=body.slow_motion_mode,
                                   slow_motion_factor=body.slow_motion_factor,
                                   overlay_opacity=body.overlay_opacity,
                                   trim_start=body.trim_start, trim_end=body.trim_end,
                                   video_effect=body.video_effect,
                                   effect_strength=body.effect_strength,
                                   music_trim_start=body.music_trim_start,
                                   music_trim_end=body.music_trim_end,
                                   text_size=body.text_size,
                                   text_weight=body.text_weight,
                                   text_position=body.text_position,
                                   text_font=body.text_font)


@app.post("/generate/full")
def gen_full(body: GenerateFullRequest):
    """Full pipeline: image → video → compose. Streams NDJSON progress."""
    def stream():
        for update in generate.run_pipeline(body.model_dump()):
            yield json.dumps(update) + "\n"
    return StreamingResponse(stream(), media_type="application/x-ndjson")


class FlowGenerateRequest(BaseModel):
    prompt: str
    cookies: str
    project_url: str = ""
    headless: bool = True


@app.get("/flow/setup")
def flow_setup():
    import google_flow
    return google_flow.setup_profile()


@app.post("/generate/flow")
def generate_flow(body: FlowGenerateRequest):
    import google_flow
    return google_flow.generate_flow_image(
        body.prompt,
        body.cookies,
        body.project_url or None,
        headless=False,  # показуємо браузер щоб можна було бачити процес
    )


class FlowDownloadLatestRequest(BaseModel):
    project_url: str = ""


@app.post("/generate/flow-latest")
def download_flow_latest(body: FlowDownloadLatestRequest):
    import google_flow
    return google_flow.download_latest_flow(body.project_url)


class GenerateCaptionRequest(BaseModel):
    style: str = ""
    custom_text: str = ""
    claude_api_key: str = ""
    # Контекст з обраного відео (з історії генерацій)
    quote: str = ""
    image_prompt: str = ""
    video_prompt: str = ""


@app.post("/generate/caption")
def generate_caption_endpoint(body: GenerateCaptionRequest):
    """Генерує підпис + хештеги для Instagram Reels через Claude CLI.

    Якщо передано контекст з відео (quote/style/image_prompt/video_prompt) —
    Claude робить підпис, який резонує саме з цим відео.
    """
    import subprocess
    import re
    from generate import _find_claude_cli

    claude_cli = _find_claude_cli()
    if not claude_cli:
        return {"ok": False, "error": "Claude CLI не знайдено (claude.exe)"}

    # Збираємо контекст з обраного відео
    context_lines = []
    if body.style:
        context_lines.append(f"- Стиль/жанр відео: {body.style}")
    if body.quote:
        context_lines.append(f"- Цитата у відео (видна глядачу): «{body.quote}»")
    if body.image_prompt:
        # Скорочуємо великі промти (Nano Banana JSON може бути 2KB+)
        ip = body.image_prompt[:1200]
        context_lines.append(f"- Візуальний опис кадру: {ip}")
    if body.video_prompt:
        vp = body.video_prompt[:600]
        context_lines.append(f"- Опис руху/сцени: {vp}")
    if body.custom_text:
        context_lines.append(f"- Додаткова інформація від користувача: {body.custom_text}")

    if context_lines:
        context_block = "CONTEXT OF THIS VIDEO:\n" + "\n".join(context_lines)
        instruction = (
            "Write a caption that DIRECTLY reveals or amplifies the meaning of THESE specific frames and the quote. "
            "Don't write generically — reference imagery from the description, continue the thought of the quote."
        )
    else:
        context_block = ""
        instruction = "Write a generic motivational caption in a neutral tone."

    prompt = f"""You are a content manager of an Instagram account with motivational and philosophical content.

{context_block}

TASK: {instruction}

Response format:
1. Caption — 2-4 sentences, inspiring, no hype. Emoji allowed (1-3 max). ENGLISH ONLY.
2. Hashtags — EXACTLY 4 most relevant hashtags, space-separated, in English.
   Match the theme/mood of THIS specific video — no generic junk tags.

Reply ONLY in JSON format (no markdown, no comments):
{{"caption": "...", "hashtags": "#tag1 #tag2 #tag3 #tag4"}}"""

    try:
        result = subprocess.run(
            [claude_cli, "-p", prompt, "--model", CLAUDE_MODEL, "--output-format", "text"],
            capture_output=True, text=True, encoding="utf-8", timeout=120,
        )
        if result.returncode != 0:
            return {"ok": False, "error": f"Claude CLI rc={result.returncode}: {(result.stderr or '')[:300]}"}
        text = (result.stdout or "").strip()
        if not text:
            return {"ok": False, "error": "Claude CLI повернув пусту відповідь"}
        m = re.search(r"\{.*\}", text, re.DOTALL)
        if not m:
            return {"ok": False, "error": f"Не вдалось розпарсити JSON. Відповідь: {text[:200]}"}
        try:
            data = json.loads(m.group())
        except json.JSONDecodeError as e:
            return {"ok": False, "error": f"JSON parse error: {e}"}
        return {
            "ok": True,
            "caption": data.get("caption", ""),
            "hashtags": data.get("hashtags", ""),
        }
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "Claude CLI timeout (120s)"}
    except Exception as e:
        return {"ok": False, "error": str(e)}


class PersonaReplyRequest(BaseModel):
    persona_description: str
    reddit_post: str
    subreddit: str = ""
    intent: str = "value"  # 'value' | 'light-promo'
    user_notes: str = ""  # опційні вказівки/досвід користувача


class PersonaPostRequest(BaseModel):
    persona_description: str
    topic: str
    subreddit: str = ""
    intent: str = "value"  # 'value' | 'light-promo'
    user_notes: str = ""  # опційні вказівки/досвід користувача


def _run_persona_prompt(prompt: str, timeout: int = 180):
    """Викликає обраний LLM (Claude CLI або Ollama) для генерації драфту.

    Вибір провайдера читається з settings.json через _draft_provider_settings()
    — той самий ключ, що й /reddit/draft. Це тримає вкладку «Контент»
    консистентною з Reddit Feed: якщо юзер перемкнув Ollama там,
    вкладка «Контент» теж використовує Ollama.

    Використовує generate_draft_raw — тобто НЕ обгортає prompt ще раз у
    _build_draft_prompt template (адже prompt тут уже повний).
    """
    import re
    s = _draft_provider_settings()
    res = reddit_monitor.generate_draft_raw(
        prompt=prompt,
        provider=s["provider"],
        ollama_endpoint=s["ollama_endpoint"],
        ollama_api_key=s["ollama_api_key"],
        ollama_model=s["ollama_model"],
        timeout=timeout,
    )
    if not res.get("ok"):
        return res

    text = (res.get("reply") or "").strip()
    if not text:
        return {"ok": False, "error": "LLM повернув пусту відповідь"}

    cleaned = re.sub(r"```(?:json)?", "", text).replace("```", "")
    m = re.search(r"\{.*\}", cleaned, re.DOTALL)
    if not m:
        return {"ok": False, "error": f"Не вдалось розпарсити JSON. Відповідь: {text[:200]}"}
    try:
        data = json.loads(m.group())
    except json.JSONDecodeError as e:
        return {"ok": False, "error": f"JSON parse error: {e}"}
    return {"ok": True, "data": data}


@app.post("/generate/persona-reply")
def generate_persona_reply_endpoint(body: PersonaReplyRequest):
    """Генерує Reddit-відповідь у voice персони на чужий пост."""
    intent_line = (
        "Do NOT mention any app, product, or link. Pure value/comment only — be a real member of the community."
        if body.intent == "value"
        else "You may mention the app you are building ONCE, near the end, only if it fits naturally — as a person would, never as an ad. Disclose that you built it."
    )
    prompt = f"""You are the person described below. Reply in THEIR authentic voice only.

YOUR PERSONA (never break character, never mention you are an AI or that this is generated):
{body.persona_description}

TASK: Write a Reddit REPLY to the post below, in r/{body.subreddit or 'unknown'}.
- Use the persona's vocabulary, spelling quirks, and tone precisely.
- {intent_line}
- Substantive, 2-6 sentences. Match the sub's culture. No filler.
{f"""
ADDITIONAL INSTRUCTIONS FROM THE USER (incorporate these naturally — the user is sharing their real experience/thoughts to guide your reply):
{body.user_notes}
""" if body.user_notes.strip() else ""}
THE POST YOU ARE REPLYING TO:
{body.reddit_post}

Reply ONLY in JSON (no markdown fences):
{{"reply": "..."}}"""
    res = _run_persona_prompt(prompt)
    if not res["ok"]:
        return res
    return {"ok": True, "reply": res["data"].get("reply", "")}


@app.post("/generate/persona-post")
def generate_persona_post_endpoint(body: PersonaPostRequest):
    """Генерує оригінальний Reddit-пост у voice персони по темі."""
    intent_line = (
        "No product link in the body. The post must be valuable even with no link."
        if body.intent == "value"
        else "May include a waitlist link once at the very bottom, founder-disclosed. The post must stand on its own without it."
    )
    prompt = f"""You are the person described below. Write in THEIR authentic voice only.

YOUR PERSONA (never break character, never mention you are an AI or that this is generated):
{body.persona_description}

TASK: Write an original Reddit POST for r/{body.subreddit or 'unknown'} on the topic/angle below.
- Title + body. Title bimodal: 1-5 words OR 18+ words (avoid the 6-12 word sweet spot).
- {intent_line}
- Match the sub's culture and the persona's voice/quirks exactly.
{f"""
ADDITIONAL INSTRUCTIONS FROM THE USER (incorporate these naturally — the user is sharing their real experience/thoughts to guide your post):
{body.user_notes}
""" if body.user_notes.strip() else ""}
TOPIC/ANGLE:
{body.topic}

Reply ONLY in JSON (no markdown fences):
{{"title": "...", "body": "..."}}"""
    res = _run_persona_prompt(prompt)
    if not res["ok"]:
        return res
    return {"ok": True, "title": res["data"].get("title", ""), "body": res["data"].get("body", "")}


# ═══════════════════════════════════════════════════════════════
# Threads persona pipeline (copy of Reddit /generate/persona-*,
# but adapted to Threads: single text (no title/body), 500-char cap,
# terse Threads-native voice)
# ═══════════════════════════════════════════════════════════════

class ThreadPersonaReplyRequest(BaseModel):
    persona_description: str
    thread_post: str = ""        # текст поста, на який відповідаємо (може бути порожнім)
    intent: str = "value"        # 'value' | 'light-promo'
    user_notes: str = ""         # опційні вказівки/досвід користувача


class ThreadPersonaPostRequest(BaseModel):
    persona_description: str
    topic: str
    intent: str = "value"        # 'value' | 'light-promo'
    user_notes: str = ""         # опційні вказівки/досвід користувача


@app.post("/threads/persona-reply")
def threads_persona_reply_endpoint(body: ThreadPersonaReplyRequest):
    """Генерує Threads-відповідь у voice персони на чужий пост (як /generate/persona-reply, але для Threads)."""
    intent_line = (
        "Do NOT mention any app, product, link, or waitlist. Pure value/comment only — be a real member of the feed."
        if body.intent == "value"
        else "You may mention the app/brand ONCE, near the end, only if it fits naturally — never as an ad, never a hard sell. Keep it terse."
    )
    post_context = (
        f"\nTHE THREAD POST YOU ARE REPLYING TO:\n{body.thread_post}"
        if body.thread_post.strip() else ""
    )
    prompt = f"""You are the person/brand voice described below. Reply in THEIR authentic voice only.

YOUR PERSONA (never break character, never mention you are an AI or that this is generated):
{body.persona_description}

TASK: Write a Threads REPLY to the post below.
- Threads-native: short, one idea, no hashtags. Target 1-4 short lines. Hard cap ~500 characters.
- Use the persona's vocabulary, spelling quirks, and tone precisely.
- {intent_line}
- The default is a period, not an exclamation. No emoji unless the persona uses them.
{post_context}
{f"""ADDITIONAL INSTRUCTIONS FROM THE USER (incorporate naturally):
{body.user_notes}""" if body.user_notes.strip() else ""}
Reply ONLY in JSON (no markdown fences):
{{"reply": "..."}}"""
    res = _run_persona_prompt(prompt)
    if not res["ok"]:
        return res
    return {"ok": True, "reply": res["data"].get("reply", "")}


@app.post("/threads/persona-post")
def threads_persona_post_endpoint(body: ThreadPersonaPostRequest):
    """Генерує оригінальний Threads-пост у voice персони по темі (як /generate/persona-post, але для Threads)."""
    intent_line = (
        "No product/link/waitlist in the post. The post must be valuable and complete on its own."
        if body.intent == "value"
        else "You may mention the app/brand once at the very end, terse, never a hard sell. The post must stand on its own without it."
    )
    prompt = f"""You are the person/brand voice described below. Write in THEIR authentic voice only.

YOUR PERSONA (never break character, never mention you are an AI or that this is generated):
{body.persona_description}

TASK: Write an original Threads POST on the topic/angle below.
- Threads-native: short lines, pauses, one idea. 3-6 short lines. Hard cap ~500 characters.
- No hashtag stuffing — at most one topic tag.
- Use the persona's vocabulary, spelling quirks, and tone precisely.
- {intent_line}
{f"""ADDITIONAL INSTRUCTIONS FROM THE USER (incorporate naturally):
{body.user_notes}""" if body.user_notes.strip() else ""}
TOPIC/ANGLE:
{body.topic}

Reply ONLY in JSON (no markdown fences):
{{"text": "..."}}"""
    res = _run_persona_prompt(prompt)
    if not res["ok"]:
        return res
    return {"ok": True, "text": res["data"].get("text", "")}


class PublishReelRequest(BaseModel):
    video_path: str
    caption: str = ""


@app.post("/publish/reel")
def publish_reel(body: PublishReelRequest):
    return instagram.post_reel(body.video_path, body.caption)


# ===== ANDROID POSTING (uiautomator2) =====

class AndroidPostRequest(BaseModel):
    video_path: str
    caption: str = ""
    serial: str | None = None
    dry_run: bool = False
    proxy: str | None = None  # формат: "host:port" або "host:port:user:pass"


@app.get("/android/devices")
def android_devices():
    return android_poster.list_devices()


@app.get("/android/status")
def android_status(serial: str | None = None):
    return android_poster.device_status(serial)


@app.post("/android/post")
def android_post(body: AndroidPostRequest):
    return android_poster.post_reel(
        body.video_path,
        body.caption,
        serial=body.serial,
        dry_run=body.dry_run,
        proxy=body.proxy,
    )


# ───── Posting v2 (human-like, через state verification) ──────────

class AndroidPostV2Request(BaseModel):
    video_path: str
    caption: str = ""
    serial: str | None = None
    proxy: str | None = None
    post_id: int | None = None    # для унікального remote filename + DB update
    dry_run: bool = False         # пройти все окрім Share (для тестів)
    db_path: str | None = None    # SQLite для direct write результату (Варіант Б)
    expected_username: str | None = None  # verify active IG account matches


@app.post("/android/post-v2")
def android_post_v2(body: AndroidPostV2Request):
    """Post IG Reel через Android з human-like behavior + cleanup remote file.

    Якщо передано post_id + db_path — Python пише фінальний статус у БД напряму
    після завершення (не залежить від Electron).
    Якщо передано expected_username — перевіряється що активний IG акаунт співпадає.
    """
    import posting_v2
    return posting_v2.post_reel_v2(
        video_path=body.video_path,
        caption=body.caption,
        serial=body.serial,
        proxy=body.proxy,
        post_id=body.post_id,
        dry_run=body.dry_run,
        db_path=body.db_path,
        expected_username=body.expected_username,
    )


class AndroidCarouselRequest(BaseModel):
    image_paths: list[str]
    caption: str = ""
    serial: str | None = None
    proxy: str | None = None
    post_id: int | None = None
    dry_run: bool = False
    db_path: str | None = None
    expected_username: str | None = None


@app.post("/android/post-carousel")
def android_post_carousel(body: AndroidCarouselRequest):
    """Post IG carousel (1-10 photos) через Android UI automation."""
    import posting_v2
    return posting_v2.post_carousel_v2(
        image_paths=body.image_paths,
        caption=body.caption,
        serial=body.serial,
        proxy=body.proxy,
        post_id=body.post_id,
        dry_run=body.dry_run,
        db_path=body.db_path,
        expected_username=body.expected_username,
    )


class AndroidScrollRequest(BaseModel):
    serial: str | None = None
    duration_seconds: int = 120
    like_probability: float = 0.15
    proxy: str | None = None
    use_ai: bool = False
    claude_api_key: str = ""
    # Niche profile — якщо заповнено, v1 використовує замість хардкоду
    niche_description: str = ''
    niche_keywords: list[str] = []
    niche_avoid: list[str] = []
    niche_examples: list[str] = []
    # Direct DB write (Варіант Б) — Python пише результат сам, не залежить від Electron
    session_id: int | None = None
    db_path: str | None = None
    engine: str = 'manual'  # manual | v1


@app.post("/android/scroll-reels")
def android_scroll_reels(body: AndroidScrollRequest):
    """Scroll Instagram Reels to simulate human activity (warm-up).

    Якщо use_ai=True — Claude vision вирішує like/save/skip для кожного рілсу.
    Якщо передано niche поля — використовуються для AI prompt. Інакше — хардкод.
    Якщо передано session_id + db_path — Python пише результат у БД напряму.
    """
    from datetime import datetime, timezone
    import db_helper

    niche = {
        'description': body.niche_description,
        'keywords': body.niche_keywords,
        'avoid': body.niche_avoid,
        'examples': body.niche_examples,
    }
    # Якщо всі niche поля пусті — передаємо None щоб спрацював fallback на хардкод
    if not (body.niche_description or body.niche_keywords or body.niche_avoid):
        niche = None

    result = android_poster.scroll_reels(
        serial=body.serial,
        duration_seconds=body.duration_seconds,
        like_probability=body.like_probability,
        proxy=body.proxy,
        use_ai=body.use_ai,
        claude_api_key=body.claude_api_key,
        niche=niche,
    )

    # Direct write у БД (Варіант Б) — на випадок якщо Electron timeout'нув pyFetch.
    # Без цього результат губиться коли Electron не отримав response.
    if body.session_id and body.db_path:
        try:
            now_iso = datetime.now(timezone.utc).isoformat()
            update_data = {
                'status': 'done' if result.get('ok') else 'failed',
                'finished_at': now_iso,
                'reels_watched': result.get('reels_watched', 0) or 0,
                'likes_given': result.get('likes_given', 0) or 0,
                'saves_given': result.get('saves_given', 0) or 0,
                'engine': body.engine,
            }
            if result.get('error'):
                update_data['error'] = str(result['error'])[:500]
            write_res = db_helper.update_warmup_session(body.db_path, body.session_id, update_data)
            if not write_res.get('ok'):
                print(f"[scroll-reels] DB write fail: {write_res.get('error')}", flush=True)
            else:
                print(f"[scroll-reels] DB write OK: session #{body.session_id} → {update_data['status']}", flush=True)
        except Exception as e:
            print(f"[scroll-reels] DB write exception: {e}", flush=True)

    return result


# ───── Warmup v2 (mixed-action orchestrator) ──────────────────────

class WarmupV2Request(BaseModel):
    serial: str | None = None
    duration_seconds: int = 360
    proxy: str | None = None
    use_ai: bool = True
    # Niche profile (per-account, from DB)
    niche_description: str = ''
    niche_keywords: list[str] = []
    niche_avoid: list[str] = []
    niche_examples: list[str] = []
    # Ліміти (optional — якщо None, рахуємо автоматично)
    max_likes: int | None = None
    max_saves: int | None = None
    # Direct DB write (Варіант Б): Python пише результат напряму у SQLite
    session_id: int | None = None
    db_path: str | None = None
    engine: str = 'v2'


@app.post("/android/warmup-v2")
def android_warmup_v2(body: WarmupV2Request):
    """Новий mixed-action warmup orchestrator (Phase 2).

    Виконує розумний прогрів з перемиканнями між Home/Reels/Stories/Explore,
    з AI relevance-check для лайків і сейвів (через Claude Haiku subscription).

    Якщо передано session_id + db_path — Python пише результат напряму у БД
    після завершення (щоб не залежати від Electron).
    """
    from warmup.orchestrator import run_warmup_session
    from warmup.ai_relevance import NicheProfile

    niche = NicheProfile(
        description=body.niche_description,
        keywords=body.niche_keywords,
        avoid=body.niche_avoid,
        examples=body.niche_examples,
    )

    return run_warmup_session(
        serial=body.serial,
        duration_seconds=body.duration_seconds,
        niche=niche,
        proxy=body.proxy,
        use_ai=body.use_ai,
        max_likes=body.max_likes,
        max_saves=body.max_saves,
        session_id=body.session_id,
        db_path=body.db_path,
        engine=body.engine,
    )


@app.get("/android/screenshot")
def android_screenshot(serial: str | None = None):
    """Returns PNG bytes of the device screen — для дзеркала в UI."""
    from fastapi.responses import Response
    png = android_poster.take_screenshot(serial)
    if not png:
        return Response(status_code=503, content=b"screenshot failed")
    return Response(content=png, media_type="image/png", headers={"Cache-Control": "no-store"})


class AndroidAdbConnectRequest(BaseModel):
    host: str          # IP або IP:port (напр. "192.168.1.50" або "192.168.1.50:5555")


class AndroidAdbPairRequest(BaseModel):
    host: str          # IP:port з розділу "Pair with pairing code" (напр. "192.168.1.50:41234")
    code: str          # 6-значний код із телефону


class AndroidTcpipRequest(BaseModel):
    serial: str | None = None  # USB серійник (якщо кілька підключено)
    port: int = 5555


@app.post("/android/adb-pair")
def android_adb_pair(body: AndroidAdbPairRequest):
    """
    Android 11+ бездротове сполучення: adb pair <host> <code>.
    Потрібно для першого WiFi з'єднання без USB.
    """
    return android_poster.adb_pair(body.host, body.code)


@app.post("/android/adb-connect")
def android_adb_connect(body: AndroidAdbConnectRequest):
    """
    З'єднати з пристроєм по WiFi: adb connect <host[:port]>.
    Після pair-у використовує дефолтний порт 5555.
    """
    return android_poster.adb_connect(body.host)


@app.post("/android/adb-tcpip")
def android_adb_tcpip(body: AndroidTcpipRequest):
    """
    Legacy підхід (Android <11): переключити підключений USB-пристрій на TCP.
    Після цього можна відключити кабель і adb connect по IP.
    """
    return android_poster.adb_tcpip(body.serial, body.port)


@app.post("/android/adb-disconnect")
def android_adb_disconnect(body: AndroidAdbConnectRequest):
    """Відключити WiFi-пристрій."""
    return android_poster.adb_disconnect(body.host)


@app.get("/android/mdns-discover")
def android_mdns_discover():
    """mDNS discovery для Android 11+ Wireless Debugging. Знаходить телефон по мережі."""
    return android_poster.adb_mdns_discover()


class ActiveAccountRequest(BaseModel):
    serial: str | None = None

@app.post("/android/active-account")
def android_active_account(body: ActiveAccountRequest):
    """Визначає який Instagram акаунт активний зараз на пристрої."""
    return android_poster.get_active_ig_account(body.serial)


@app.post("/android/all-accounts")
def android_all_accounts(body: ActiveAccountRequest):
    """Знаходить ВСІ залогінені IG акаунти на пристрої (account switcher)."""
    return android_poster.get_all_ig_accounts(body.serial)


@app.get("/android/scan-usb")
def android_scan_usb():
    """Сканує USB-підключені пристрої. Повертає {serial, model, wifi_ip, android_version}."""
    return android_poster.scan_usb_devices()


class RegisterUsbRequest(BaseModel):
    serial: str

@app.post("/android/register-usb")
def android_register_usb(body: RegisterUsbRequest):
    """USB → Wi-Fi ADB bootstrap. Робить tcpip 5555 і connect по WiFi."""
    return android_poster.register_usb_device(body.serial)


class EnsureWifiRequest(BaseModel):
    saved_host: str | None = None  # IP:port останнього успішного з'єднання

@app.post("/android/ensure-wifi")
def android_ensure_wifi(body: EnsureWifiRequest):
    """
    Гарантує активне WiFi ADB з'єднання. Спочатку пробує saved_host,
    на фейл — mDNS discovery. Повертає {ok, host, method}.
    """
    return android_poster.ensure_wifi_connection(body.saved_host)


class PingDeviceRequest(BaseModel):
    host: str

@app.post("/android/ping-device")
def android_ping_device(body: PingDeviceRequest):
    """Справжня перевірка живого ADB з'єднання через adb shell echo."""
    return android_poster.adb_ping_device(body.host, timeout=4)


class RediscoverByMacRequest(BaseModel):
    wifi_mac: str
    port: int = 5555

@app.post("/android/rediscover-by-mac")
def android_rediscover_by_mac(body: RediscoverByMacRequest):
    """Знайти пристрій у локальній мережі за збереженою MAC адресою.

    Використовується коли DHCP видав новий IP — ping sweep + arp lookup.
    Повертає {ok, wifi_host, wifi_ip} на успіх.
    """
    return android_poster.rediscover_by_mac(body.wifi_mac, body.port)


# ═══════════════════════════════════════════════════════════════
# Threads (com.instagram.barcelona) — Android automation
# ═══════════════════════════════════════════════════════════════

class ThreadsPublishRequest(BaseModel):
    serial: str
    text: str
    account_id: int | None = None


class ThreadsScrollCommentRequest(BaseModel):
    serial: str
    duration_sec: int = 180
    like_prob: float = 0.15
    ai_prompt: str | None = None
    account_id: int | None = None


@app.get("/threads/status")
def threads_status(serial: str):
    """Перевіряє чи Threads (com.instagram.barcelona) встановлено на пристрої."""
    return threads_poster.threads_status(serial)


@app.post("/threads/publish")
def threads_publish(body: ThreadsPublishRequest):
    """Публікує один text post у Threads через Android UI automation."""
    return threads_poster.threads_publish(
        body.serial, body.text, account_id=body.account_id,
    )


@app.post("/threads/scroll-comment")
def threads_scroll_comment(body: ThreadsScrollCommentRequest):
    """Scroll For You / Following у Threads з лайками і коментарями від AI."""
    return threads_poster.threads_scroll_and_comment(
        serial=body.serial,
        duration_sec=body.duration_sec,
        like_prob=body.like_prob,
        ai_prompt=body.ai_prompt or "",
        account_id=body.account_id,
    )


# ===== THREADS FEED MONITOR =====

class ThreadDraftRequest(BaseModel):
    post_id: int
    persona_id: str | None = None
    persona_description: str = ""
    intent: str = "reply"  # 'reply' | 'quote'
    provider: str | None = None
    ollama_endpoint: str | None = None
    ollama_api_key: str | None = None
    ollama_model: str | None = None


class ThreadStatusRequest(BaseModel):
    post_id: int
    status: str  # 'new' | 'drafted' | 'dismissed'


class ThreadDeletePostsRequest(BaseModel):
    ids: list[int] = []


class ThreadGeneratePostRequest(BaseModel):
    persona_id: str | None = None
    persona_description: str = ""
    topic_hint: str = ""
    provider: str | None = None
    ollama_endpoint: str | None = None
    ollama_api_key: str | None = None
    ollama_model: str | None = None


class ThreadUpdateGeneratedRequest(BaseModel):
    id: int
    status: str = "draft"  # 'draft' | 'published' | 'failed'
    error: str = ""
    account_id: int | None = None


@app.get("/threads/feed/posts")
def threads_feed_posts(status: str | None = None, limit: int = 200):
    """Список збережених Threads-постів зі стрічки."""
    try:
        posts = threads_monitor.get_thread_posts(status, min(limit, 500))
        return {"ok": True, "count": len(posts), "posts": posts}
    except Exception as e:
        return {"ok": False, "error": str(e)}


@app.post("/threads/feed/status")
def threads_feed_status(body: ThreadStatusRequest):
    ok = threads_monitor.set_thread_post_status(body.post_id, body.status)
    return {"ok": ok}


@app.post("/threads/feed/delete")
def threads_feed_delete(body: ThreadDeletePostsRequest):
    try:
        return threads_monitor.delete_thread_posts(body.ids)
    except Exception as e:
        return {"ok": False, "error": str(e)}


@app.post("/threads/feed/draft")
def threads_feed_draft(body: ThreadDraftRequest):
    """Генерує драфт-відповідь на Thread-пост через персону."""
    s = _draft_provider_settings()
    provider = body.provider or s["provider"]
    result = threads_monitor.generate_thread_draft(
        post_id=body.post_id,
        persona_id=body.persona_id or "",
        persona_description=body.persona_description,
        intent=body.intent,
        provider=provider,
        ollama_endpoint=body.ollama_endpoint or s["ollama_endpoint"],
        ollama_api_key=body.ollama_api_key or s["ollama_api_key"],
        ollama_model=body.ollama_model or s["ollama_model"],
    )
    if result.get("ok") and result.get("draft"):
        drafts = threads_monitor.get_thread_drafts(body.post_id)
        drafts_norm = [{**d, "reply": d.get("reply_text", "")} for d in drafts]
        return {"ok": True, "draft": result["draft"], "all_drafts": drafts_norm}
    return result


@app.get("/threads/feed/drafts/{post_id}")
def threads_feed_drafts(post_id: int):
    drafts = threads_monitor.get_thread_drafts(post_id)
    drafts_norm = [{**d, "reply": d.get("reply_text", "")} for d in drafts]
    return {"ok": True, "drafts": drafts_norm}


# ===== THREADS GENERATOR (original posts) =====

@app.post("/threads/generate")
def threads_generate(body: ThreadGeneratePostRequest):
    """Генерує оригінальний Thread-пост через персону."""
    s = _draft_provider_settings()
    provider = body.provider or s["provider"]
    result = threads_monitor.generate_thread_post(
        persona_id=body.persona_id or "",
        persona_description=body.persona_description,
        topic_hint=body.topic_hint,
        provider=provider,
        ollama_endpoint=body.ollama_endpoint or s["ollama_endpoint"],
        ollama_api_key=body.ollama_api_key or s["ollama_api_key"],
        ollama_model=body.ollama_model or s["ollama_model"],
    )
    return result


@app.get("/threads/generated")
def threads_generated(status: str | None = None, limit: int = 100):
    """Список згенерованих Threads-постів."""
    try:
        items = threads_monitor.get_generated_threads(status, min(limit, 500))
        return {"ok": True, "count": len(items), "items": items}
    except Exception as e:
        return {"ok": False, "error": str(e)}


@app.post("/threads/generated/update")
def threads_generated_update(body: ThreadUpdateGeneratedRequest):
    """Оновлює статус згенерованого поста (напр. після публікації)."""
    try:
        row = threads_monitor.update_generated_status(
            body.id, body.status, body.error, body.account_id
        )
        return {"ok": True, "item": row}
    except Exception as e:
        return {"ok": False, "error": str(e)}


@app.delete("/threads/generated/{gen_id}")
def threads_generated_delete(gen_id: int):
    """Видаляє згенерований пост з БД."""
    try:
        ok = threads_monitor.delete_generated(gen_id)
        return {"ok": ok}
    except Exception as e:
        return {"ok": False, "error": str(e)}


# ═══════════════════════════════════════════════════════════════
# iOS / iPhone automation (WebDriverAgent + go-ios)
# ═══════════════════════════════════════════════════════════════

import ios_poster


@app.get("/ios/devices")
def ios_devices():
    """Список USB-підключених iPhone'ів (UDID)."""
    return ios_poster.list_devices()


@app.get("/ios/scan-usb")
def ios_scan_usb():
    """Сканує USB iPhone'и з повним інфо: udid, model, ios_version, name."""
    return ios_poster.scan_usb_devices()


@app.get("/ios/status")
def ios_status(udid: str | None = None):
    """Перевіряє чи iPhone живий + чи Instagram/WDA встановлені."""
    return ios_poster.device_status(udid)


class IOSInstallWdaRequest(BaseModel):
    ipa_path: str
    udid: str

@app.post("/ios/install-wda")
def ios_install_wda(body: IOSInstallWdaRequest):
    """Встановлює підписаний WDA.ipa на iPhone."""
    return ios_poster.install_wda(body.ipa_path, body.udid)


class IOSLaunchWdaRequest(BaseModel):
    udid: str

@app.post("/ios/launch-wda")
def ios_launch_wda(body: IOSLaunchWdaRequest):
    """Запускає WDA через XCTest (HTTP server на iPhone:8100)."""
    return ios_poster.launch_wda(body.udid)


@app.get("/ios/wda-status")
def ios_wda_status(udid: str):
    """Перевіряє чи WDA HTTP server відповідає."""
    return ios_poster.wda_status(udid)


class IOSPostRequest(BaseModel):
    video_path: str
    caption: str = ""
    udid: str | None = None
    proxy: str | None = None
    dry_run: bool = False
    expected_username: str | None = None

@app.post("/ios/post")
def ios_post(body: IOSPostRequest):
    """Postит Reel на iPhone (basic)."""
    return ios_poster.post_reel(
        body.video_path, body.caption, udid=body.udid,
        proxy=body.proxy, dry_run=body.dry_run,
        expected_username=body.expected_username,
    )


class IOSPostV2Request(BaseModel):
    video_path: str
    caption: str = ""
    udid: str | None = None
    proxy: str | None = None
    post_id: int | None = None
    db_path: str | None = None
    expected_username: str | None = None
    dry_run: bool = False

@app.post("/ios/post-v2")
def ios_post_v2(body: IOSPostV2Request):
    """Human-like Reel posting (з verification і retry)."""
    return ios_poster.post_reel_v2(
        body.video_path, body.caption, udid=body.udid,
        proxy=body.proxy, post_id=body.post_id, db_path=body.db_path,
        expected_username=body.expected_username, dry_run=body.dry_run,
    )


class IOSPostCarouselRequest(BaseModel):
    image_paths: list[str]
    caption: str = ""
    udid: str | None = None
    proxy: str | None = None
    post_id: int | None = None
    db_path: str | None = None
    expected_username: str | None = None
    dry_run: bool = False

@app.post("/ios/post-carousel")
def ios_post_carousel(body: IOSPostCarouselRequest):
    """Carousel post (1-10 фото)."""
    return ios_poster.post_carousel(
        body.image_paths, body.caption, udid=body.udid,
        proxy=body.proxy, post_id=body.post_id, db_path=body.db_path,
        expected_username=body.expected_username, dry_run=body.dry_run,
    )


class IOSScrollReelsRequest(BaseModel):
    udid: str | None = None
    duration_seconds: int = 120
    like_probability: float = 0.15
    proxy: str | None = None
    use_ai: bool = False
    claude_api_key: str = ""
    niche_description: str = ""
    niche_keywords: list[str] = []
    niche_avoid: list[str] = []
    niche_examples: list[str] = []
    session_id: int | None = None
    db_path: str | None = None
    engine: str = "manual"

@app.post("/ios/scroll-reels")
def ios_scroll_reels(body: IOSScrollReelsRequest):
    """Warmup scroll Reels на iOS."""
    return ios_poster.scroll_reels(
        udid=body.udid, duration_seconds=body.duration_seconds,
        like_probability=body.like_probability, proxy=body.proxy,
        use_ai=body.use_ai, claude_api_key=body.claude_api_key,
        niche_description=body.niche_description,
        niche_keywords=body.niche_keywords, niche_avoid=body.niche_avoid,
        niche_examples=body.niche_examples, session_id=body.session_id,
        db_path=body.db_path, engine=body.engine,
    )


class IOSWarmupV2Request(BaseModel):
    udid: str | None = None
    duration_seconds: int = 180
    proxy: str | None = None
    use_ai: bool = True
    niche_description: str = ""
    niche_keywords: list[str] = []
    niche_avoid: list[str] = []
    niche_examples: list[str] = []
    session_id: int | None = None
    db_path: str | None = None
    engine: str = "v2"

@app.post("/ios/warmup-v2")
def ios_warmup_v2(body: IOSWarmupV2Request):
    """Warmup v2 (mixed-action) на iOS."""
    return ios_poster.warmup_v2(
        udid=body.udid, duration_seconds=body.duration_seconds,
        proxy=body.proxy, use_ai=body.use_ai,
        niche_description=body.niche_description,
        niche_keywords=body.niche_keywords, niche_avoid=body.niche_avoid,
        niche_examples=body.niche_examples, session_id=body.session_id,
        db_path=body.db_path, engine=body.engine,
    )


# ═══════════════════════════════════════════════════════════════
# Audio extraction
# ═══════════════════════════════════════════════════════════════

class ExtractAudioRequest(BaseModel):
    reel_id: str
    video_url: str
    session_id: str = ""

@app.post("/extract-audio")
def extract_audio(body: ExtractAudioRequest):
    """Download reel video and extract audio to mp3."""
    import tempfile, subprocess, requests
    out_dir = os.path.join(tempfile.gettempdir(), "reels-generator", "audio")
    os.makedirs(out_dir, exist_ok=True)

    audio_path = os.path.join(out_dir, f"{body.reel_id}.mp3")
    if os.path.exists(audio_path):
        return {"ok": True, "path": audio_path, "message": "Вже завантажено"}

    # Download video
    headers = {
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15",
        "Cookie": f"sessionid={body.session_id}" if body.session_id else "",
        "Referer": "https://www.instagram.com/",
    }
    try:
        resp = requests.get(body.video_url, headers=headers, timeout=30)
        if resp.status_code != 200:
            return {"ok": False, "error": f"Не вдалось завантажити відео: {resp.status_code}. URL можливо протермінувався — перепарсіть акаунт."}
    except Exception as e:
        return {"ok": False, "error": f"Помилка завантаження: {e}"}

    video_tmp = os.path.join(out_dir, f"{body.reel_id}_tmp.mp4")
    with open(video_tmp, "wb") as f:
        f.write(resp.content)

    # Extract audio with FFmpeg
    ffmpeg = generate._find_ffmpeg()
    try:
        result = subprocess.run(
            [ffmpeg, "-y", "-i", video_tmp, "-vn", "-acodec", "libmp3lame", "-b:a", "192k", audio_path],
            capture_output=True, text=True, timeout=30
        )
        os.remove(video_tmp)
        if result.returncode != 0:
            return {"ok": False, "error": f"FFmpeg: {result.stderr[-300:]}"}
        return {"ok": True, "path": audio_path}
    except Exception as e:
        return {"ok": False, "error": f"FFmpeg помилка: {e}"}


from fastapi.responses import FileResponse

@app.get("/files/{filepath:path}")
def serve_file(filepath: str):
    """Serve generated files for preview (temp + generations folders). Supports subfolders like audio/."""
    import tempfile
    search_dirs = [
        os.path.join(tempfile.gettempdir(), "reels-generator"),
        os.path.join(os.path.expanduser("~"), "AppData", "Roaming", "reels-generator", "generations"),
    ]
    for d in search_dirs:
        file_path = os.path.join(d, filepath)
        if os.path.isfile(file_path):
            ext = filepath.rsplit(".", 1)[-1].lower()
            media_types = {"mp4": "video/mp4", "png": "image/png", "jpg": "image/jpeg",
                           "jpeg": "image/jpeg", "webp": "image/webp",
                           "mp3": "audio/mpeg", "wav": "audio/wav", "aac": "audio/aac", "m4a": "audio/mp4"}
            media_type = media_types.get(ext, "application/octet-stream")
            return FileResponse(file_path, media_type=media_type)
    return {"ok": False, "error": "File not found"}


@app.get("/local-audio")
def serve_local_audio(path: str):
    """Serve audio file from any local path (for compose UI preview — bypasses file:// CORS restrictions)."""
    from fastapi import HTTPException
    import urllib.parse
    decoded = urllib.parse.unquote(path)
    ext = decoded.rsplit(".", 1)[-1].lower() if "." in decoded else ""
    if ext not in ("mp3", "wav", "aac", "m4a", "ogg", "flac"):
        raise HTTPException(status_code=403, detail="Only audio files allowed")
    if not os.path.isfile(decoded):
        raise HTTPException(status_code=404, detail="File not found")
    media_types = {"mp3": "audio/mpeg", "wav": "audio/wav", "aac": "audio/aac",
                   "m4a": "audio/mp4", "ogg": "audio/ogg", "flac": "audio/flac"}
    return FileResponse(decoded, media_type=media_types.get(ext, "audio/mpeg"))


class ImportFileRequest(BaseModel):
    file_path: str

@app.post("/import/image")
def import_image(body: ImportFileRequest):
    """Копіює зовнішній файл у temp директорію і повертає filename для /files/."""
    import tempfile, shutil
    src = body.file_path
    if not os.path.isfile(src):
        return {"ok": False, "error": f"Файл не знайдено: {src}"}
    ext = src.rsplit(".", 1)[-1].lower()
    dest_name = f"import_{int(time.time())}.{ext}"
    dest = os.path.join(tempfile.gettempdir(), "reels-generator", dest_name)
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    shutil.copy2(src, dest)
    return {"ok": True, "filename": dest_name, "path": dest}


# ===== TIGFUSION (унікалізація відео батчем) =====

class TigfusionRequest(BaseModel):
    files: list[str]            # абсолютні шляхи до відео
    output_dir: str             # куди зберігати копії
    prefix: str = ""            # префікс імені файлу
    start_num: int = 1          # перший порядковий номер
    copies: int = 1             # копій на кожне відео
    threshold: float = 8.0      # поріг Smart Detector (нижче → перерендер)


_tig_state: dict = {"running": False, "done": True, "result": None,
                    "error": None, "progress": 0, "total": 0, "current": ""}
_tig_lock = threading.Lock()
_tig_cancel = threading.Event()  # сигнал зупинки для активного батчу


def _tig_run(req: TigfusionRequest):
    def cb(done, total, current):
        with _tig_lock:
            _tig_state["progress"] = done
            _tig_state["total"] = total
            _tig_state["current"] = current
        if _tig_cancel.is_set():
            raise InterruptedError("Зупинено користувачем")
    try:
        results = tigfusion.process_batch(
            files=req.files, output_dir=req.output_dir, prefix=req.prefix,
            start_num=req.start_num, copies=max(1, req.copies),
            progress_cb=cb, threshold=req.threshold,
            cancel_check=_tig_cancel.is_set,
        )
        with _tig_lock:
            _tig_state["result"] = results
            _tig_state["error"] = None if all(r["ok"] for r in results) else \
                "; ".join(str(r["error"]) for r in results if not r["ok"])
            _tig_state["done"] = True
            _tig_state["running"] = False
    except InterruptedError:
        with _tig_lock:
            _tig_state["error"] = "Зупинено користувачем"
            _tig_state["done"] = True
            _tig_state["running"] = False
    except Exception as e:
        with _tig_lock:
            _tig_state["error"] = str(e)
            _tig_state["done"] = True
            _tig_state["running"] = False
    finally:
        _tig_cancel.clear()


@app.post("/tigfusion/run")
def tigfusion_run(body: TigfusionRequest):
    """Запускає батч-унікалізацію у фоновому потоці."""
    if not body.files:
        return {"ok": False, "error": "Порожній список файлів"}
    with _tig_lock:
        if _tig_state["running"]:
            return {"ok": False, "error": "TIGFUSION вже працює, дочекайся завершення або натисни СТОП"}
        _tig_state.update(running=True, done=False, result=None, error=None,
                          progress=0, total=len(body.files) * max(1, body.copies),
                          current="")
    _tig_cancel.clear()
    t = threading.Thread(target=_tig_run, args=(body,), daemon=True)
    t.start()
    return {"ok": True, "started": True, "total": _tig_state["total"]}


@app.post("/tigfusion/stop")
def tigfusion_stop():
    """М'яка зупинка активного батчу: після поточного файлу рендер припиняється."""
    with _tig_lock:
        if not _tig_state["running"]:
            return {"ok": True, "stopped": False, "message": "Нічого зупиняти — процес не активний"}
        _tig_cancel.set()
    return {"ok": True, "stopped": True}


@app.get("/tigfusion/status")
def tigfusion_status():
    with _tig_lock:
        return {"ok": True, **_tig_state}


@app.get("/tigfusion/check-ffmpeg")
def tigfusion_check():
    try:
        ff, fp = tigfusion.find_binaries()
        return {"ok": True, "ffmpeg": ff, "ffprobe": fp}
    except RuntimeError as e:
        return {"ok": False, "error": str(e)}


@app.get("/tigfusion/list-dir")
def tigfusion_list_dir(path: str = ""):
    """Список mp4 у папці (для вибору 'звідки завантажити')."""
    import glob
    if not os.path.isdir(path):
        return {"ok": False, "error": f"Папка не знайдено: {path}", "files": []}
    files = sorted(glob.glob(os.path.join(path, "*.mp4")) +
                   glob.glob(os.path.join(path, "*.mov")) +
                   glob.glob(os.path.join(path, "*.avi")) +
                   glob.glob(os.path.join(path, "*.mkv")))
    return {"ok": True, "files": files, "count": len(files)}


# ===== LAN SHARE: роздача папки по мережі для телефонів =====

_share_state: dict = {"running": False, "port": 0, "dir": "", "error": None, "server": None}
_share_lock = threading.Lock()


def _get_local_ip():
    """Локальна IP-адреса ПК у LAN."""
    import socket
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
    except OSError:
        ip = "127.0.0.1"
    finally:
        s.close()
    return ip


class ShareStartRequest(BaseModel):
    folder: str
    port: int = 8000


@app.post("/share/start")
def share_start(body: ShareStartRequest):
    """Запускає HTTP-сервер на 0.0.0.0:port, що роздає folder усій LAN."""
    import uvicorn
    from fastapi import FastAPI as _App
    if not os.path.isdir(body.folder):
        return {"ok": False, "error": f"Папка не знайдено: {body.folder}"}
    with _share_lock:
        if _share_state["running"]:
            return {"ok": False, "error": f"Сервер вже працює на порту {_share_state['port']} — спершу зупини"}
        try:
            app_share = FastAPI(title="LAN Share")

            @app_share.get("/health")
            def _health():
                return {"status": "ok"}

            # /files/<шлях> — файл напряму; /browse — HTML-список для телефону
            from fastapi.responses import HTMLResponse, FileResponse
            from urllib.parse import quote

            @app_share.get("/browse")
            def _browse():
                import glob as _g
                rows = []
                for ext in ("*.mp4", "*.mov", "*.avi", "*.mkv"):
                    for f in sorted(_g.glob(os.path.join(body.folder, ext))):
                        name = os.path.basename(f)
                        size_mb = os.path.getsize(f) / 1024 / 1024
                        rows.append(
                            f'<li><a href="/files/{name}">{name}</a> '
                            f'<small style="color:#888">{size_mb:.1f} MB</small></li>')
                zip_link = (
                    '<div style="margin:14px 0;padding:12px;background:#1b3a1b;border-radius:8px">'
                    '<b style="color:#8bc34a">📦 Завантажити все одним архівом:</b><br>'
                    '<a href="/download-zip" style="color:#7ec8e3;font-size:16px">'
                    f'{_ZIP_PROGRESS.get("zip_label", "спершу створи архів на ПК")}</a>'
                    '</div>'
                ) if os.path.isfile(_ZIP_PROGRESS.get("ready", "")) else (
                    '<div style="margin:14px 0;color:#888;font-size:14px">'
                    '💡 Хочеш завантажити все одним файлом? Створи архів кнопкою на ПК.</div>'
                )
                html = ("<!doctype html><meta charset='utf-8'>"
                        "<meta name='viewport' content='width=device-width,initial-scale=1'>"
                        "<title>Reels Generator — файлосервер</title>"
                        f"{zip_link}"
                        f"<h2 style='font-family:sans-serif'>Відео ({len(rows)})</h2><ul>{''.join(rows)}</ul>")
                return HTMLResponse(html)

            @app_share.get("/files/{name}")
            def _file(name: str):
                safe = os.path.basename(name)  # без traversal
                p = os.path.join(body.folder, safe)
                if not os.path.isfile(p):
                    return {"error": "not found"}
                return FileResponse(p, filename=safe)

            @app_share.get("/download-zip")
            def _dl_zip():
                p = _ZIP_PROGRESS.get("ready")
                if not p or not os.path.isfile(p):
                    return {"error": "zip ще не готовий"}
                return FileResponse(p, filename=os.path.basename(p), media_type="application/zip")

            config = uvicorn.Config(app_share, host="0.0.0.0", port=body.port, log_level="error")
            server = uvicorn.Server(config)
            th = threading.Thread(target=server.run, daemon=True)
            th.start()
            _share_state.update(running=True, port=body.port, folder=body.folder, error=None, server=server)
            return {"ok": True, "port": body.port, "folder": body.folder}
        except Exception as e:
            _share_state.update(running=False, error=str(e))
            return {"ok": False, "error": str(e)}


@app.post("/share/stop")
def share_stop():
    with _share_lock:
        server = _share_state.get("server")
        if not _share_state["running"] or not server:
            return {"ok": True, "stopped": False, "message": "Сервер не працює"}
        try:
            server.should_exit = True
        except Exception as e:
            _share_state["error"] = str(e)
        _share_state.update(running=False, port=0, server=None)
    return {"ok": True, "stopped": True}


def _zip_folder(folder: str, zip_path: str, progress: dict):
    """Стрімінгова архівація папки в zip (без завантаження всього в пам'ять)."""
    import zipfile, glob as _g
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_STORED) as zf:  # STORED: відео не стискається, швидко
        files = []
        for ext in ("*.mp4", "*.mov", "*.avi", "*.mkv"):
            files.extend(_g.glob(os.path.join(folder, ext)))
        total = len(files)
        for i, f in enumerate(sorted(files), 1):
            zf.write(f, os.path.basename(f))
            progress["done"] = i
            progress["total"] = total


@app.post("/share/zip")
def share_zip():
    """Створює zip-архів усієї роздаваної папки (у temp). Прогрес через /share/zip-status."""
    with _share_lock:
        folder = _share_state.get("folder")
        if not _share_state["running"] or not folder:
            return {"ok": False, "error": "Сервер не працює — спершу запусти роздачу"}
        port = _share_state["port"]
    try:
        os.makedirs("C:/Users/User/AppData/Local/Temp/reels_share", exist_ok=True)
        zip_name = "reels_" + os.path.basename(folder.rstrip("/\\")).replace(" ", "_") + ".zip"
        zip_path = os.path.join("C:/Users/User/AppData/Local/Temp/reels_share", zip_name)
        _ZIP_PROGRESS.clear()
        _ZIP_PROGRESS.update({"done": 0, "total": 0})
        _zip_folder(folder, zip_path, _ZIP_PROGRESS)
        size_mb = os.path.getsize(zip_path) / 1024 / 1024
        _ZIP_PROGRESS["ready"] = zip_path
        _ZIP_PROGRESS["size_mb"] = round(size_mb, 1)
        _ZIP_PROGRESS["zip_label"] = f"⬇ {zip_name} ({round(size_mb, 1)} MB)"
        return {"ok": True, "zip_name": zip_path, "size_mb": round(size_mb, 1)}
    except Exception as e:
        return {"ok": False, "error": str(e)}


_ZIP_PROGRESS: dict = {}


@app.get("/share/zip-status")
def share_zip_status():
    return {"ok": True, **_ZIP_PROGRESS}


@app.get("/share/download-zip")
def share_download_zip():
    """Віддає готовий zip на скачування."""
    from fastapi.responses import FileResponse
    p = _ZIP_PROGRESS.get("ready")
    if not p or not os.path.isfile(p):
        return {"error": "zip ще не готовий"}
    return FileResponse(p, filename=os.path.basename(p), media_type="application/zip")


@app.get("/share/status")
def share_status():
    with _share_lock:
        return {"ok": True, **{k: v for k, v in _share_state.items() if k != "server"}}


@app.get("/share/local-ip")
def share_local_ip():
    import socket
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
    except OSError:
        ip = "127.0.0.1"
    finally:
        s.close()
    return {"ok": True, "ip": ip}


# ===== ENTRY POINT =====

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8765))
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
