"""AI relevance evaluator — чи контент відповідає ніші акаунту.

Використовує локальну Claude Code CLI (`claude.exe`) з прапорцем `--model haiku`
для швидкого і безкоштовного (підписка) оцінювання.

API:
    niche = NicheProfile(description="...", keywords=[...], avoid=[...], examples=[...])
    decision = ai_decide_reel_text(reel_text, niche)     # text-only, ~1-2с
    decision = ai_decide_reel_vision(png_bytes, niche)    # vision, ~3-4с

    decision: {"action": "like"|"save"|"skip", "reason": "..."}
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field


@dataclass
class NicheProfile:
    """Конфігурація ніші для одного акаунту (per-account)."""
    description: str = ''
    keywords: list[str] = field(default_factory=list)
    avoid: list[str] = field(default_factory=list)
    examples: list[str] = field(default_factory=list)

    def is_configured(self) -> bool:
        """Чи нішу взагалі налаштовано (щоб не викликати AI на порожні дані)."""
        return bool(self.description.strip()
                    or self.keywords or self.avoid or self.examples)

    def to_prompt_block(self) -> str:
        """Сформувати блок тексту про нішу для AI prompt."""
        lines = []
        if self.description.strip():
            lines.append(f"Опис ніші: {self.description.strip()}")
        if self.keywords:
            lines.append(f"Теми які ЛАЙКАЄМО: {', '.join(self.keywords)}")
        if self.avoid:
            lines.append(f"Теми які УНИКАЄМО: {', '.join(self.avoid)}")
        if self.examples:
            lines.append(f"Приклади релевантних акаунтів: {', '.join(self.examples)}")
        return "\n".join(lines) if lines else "Ніша не сконфігурована"


# ───── Ollama-клієнт (спільний з Reddit/Caption, 2026-09-21) ─────
# Claude CLI в ai_relevance падав/tаймаутить (нема активної підписки),
# і все рішення ставало "skip". Юзер: перевести на Ollama — ту саму, що
# працює для Reddit/капшенів. Джерело правди — settings.ollama.*
# (спільна конфігурація провайдера; не розгалужувати).

def _read_electron_settings() -> dict:
    """Прочитати %APPDATA%/reels-generator/settings.json (той самий, що main.py)."""
    import json
    try:
        p = os.path.join(os.environ.get("APPDATA", ""), "reels-generator", "settings.json")
        if os.path.exists(p):
            with open(p, encoding="utf-8") as fh:
                return json.load(fh)
    except Exception:
        pass
    return {}


def _draft_provider_settings() -> dict:
    """Витягнути provider + ollama-параметри (дефолти — Claude CLI)."""
    s = _read_electron_settings()
    ollama = s.get("ollama") or {}
    return {
        "provider": ollama.get("provider") or "claude-cli",
        "ollama_endpoint": ollama.get("endpoint") or "https://ollama.com",
        "ollama_api_key": ollama.get("apiKey") or "",
        "ollama_model": ollama.get("model") or "gpt-oss:120b",
        "ollama_vision_model": ollama.get("visionModel") or "",
    }


def _ollama_prompt(prompt: str, timeout: int) -> dict:
    """Один запит до Ollama (як reddit_monitor._ollama_raw). Повертає
    {"ok": True, "reply": "..."} або {"ok": False, "error": "..."}."""
    import json as _json
    import urllib.request
    ps = _draft_provider_settings()
    if ps["provider"] != "ollama" or not ps["ollama_endpoint"] or not ps["ollama_model"]:
        return {"ok": False, "error": "provider не ollama або не налаштовано"}
    base = ps["ollama_endpoint"].rstrip("/")
    url = f"{base}/api/generate"
    headers = {"Content-Type": "application/json"}
    if ps["ollama_api_key"]:
        headers["Authorization"] = f"Bearer {ps['ollama_api_key']}"
    payload = {
        "model": ps["ollama_model"],
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
            j = _json.loads(body)
        except _json.JSONDecodeError as e:
            return {"ok": False, "error": f"невалідний JSON: {e}"}
        raw = (j.get("response") or "").strip()
        if not raw:
            return {"ok": False, "error": "порожня відповідь"}
        return {"ok": True, "reply": raw}
    except urllib.error.HTTPError as e:
        return {"ok": False, "error": f"Ollama HTTP {e.code}"}
    except urllib.error.URLError as e:
        return {"ok": False, "error": f"Ollama недоступний: {e.reason}"}
    except Exception as e:
        return {"ok": False, "error": str(e)}


# ───── text-only decision ─────────────────────────────────────────

def ai_decide_reel_text(reel_text: str, niche: NicheProfile,
                         timeout: int = 30) -> dict:
    """Швидке рішення на основі текста з reel (caption + overlay).
    Через Ollama (не Claude CLI) — див. _ollama_prompt.

    Returns: {"action": "like"|"save"|"skip", "reason": "...", "mode": "text",
              "tokens_in": int, "tokens_out": int, "cost_usd": float,
              "cache_read": int, "duration_ms": int}
    """
    base_result = {"action": "skip", "mode": "text",
                    "tokens_in": 0, "tokens_out": 0, "cost_usd": 0.0,
                    "cache_read": 0, "duration_ms": 0}

    if not niche.is_configured():
        return {**base_result, "reason": "niche not configured"}

    prompt = _build_text_prompt(reel_text, niche)
    res = _ollama_prompt(prompt, timeout)
    if not res.get("ok"):
        return {**base_result, "reason": res.get("error", "ollama fail")}

    # Ollama повертає JSON в "response" (формат json -> має бути чистий об'єкт)
    parsed = _parse_action_json(res["reply"])
    return {**base_result, "reason": parsed.get("reason", res["reply"][:120]),
            "action": parsed.get("action", "skip")}


def _parse_action_json(reply: str) -> dict:
    """Витягти {action, reason} з відповіді Ollama (якщо обгорнено або є шум)."""
    m = re.search(r"\{[^{}]*\"action\"[^{}]*\}", (reply or ""), re.DOTALL)
    if not m:
        return {"action": "skip", "reason": reply[:100]}
    try:
        d = json.loads(m.group())
    except json.JSONDecodeError:
        return {"action": "skip", "reason": reply[:100]}
    action = d.get("action", "skip")
    if action not in ("like", "save", "skip"):
        action = "skip"
    return {"action": action, "reason": d.get("reason", "")}



# ───── vision decision ───────────────────────────────────────────

def ai_decide_reel_vision(screenshot_png: bytes, niche: NicheProfile,
                            timeout: int = 30) -> dict:
    """Рішення на основі скриншоту reel (fallback, коли text недоступний).

    Ollama Cloud gpt-oss:120b — ТЕКСТОВА модель, зображення не приймає.
    Тому vision тут працює тільки якщо юзер поставить локальну vision-модель;
    для гіпотетичного vision через Ollama скриншот конвертується в base64 і
    передається в поле images (локальні мультимодальні моделі його зрозуміють).
    Поки vision-моделі нема — відверто повертає skip з причиною замість
    зламаного Claude CLI (rc=1). (Фікс 2026-09-21: раніше CLI падав і всі
    рішення ставали безпідставним skip.)
    """
    base_result = {"action": "skip", "mode": "vision",
                    "tokens_in": 0, "tokens_out": 0, "cost_usd": 0.0,
                    "cache_read": 0, "duration_ms": 0}

    if not screenshot_png:
        return {**base_result, "reason": "no screenshot"}
    if not niche.is_configured():
        return {**base_result, "reason": "niche not configured"}

    # Відправляємо screenshot base64 у Ollama (для локальної vision-моделі).
    import base64
    import urllib.request
    import json as _json
    ps = _draft_provider_settings()
    if ps["provider"] != "ollama":
        return {**base_result, "reason": "provider не ollama"}
    # Vision-модель (окрема від текстової): DeepSeek-V4.1-Flash приймає картинки.
    vmodel = ps.get("ollama_vision_model") or ps.get("ollama_model") or ""
    if not vmodel:
        return {**base_result, "reason": "vision model не налаштовано"}
    b64 = base64.b64encode(screenshot_png).decode("ascii")
    prompt = _build_vision_prompt_text(niche)  # текст без шляху до файлу
    try:
        url = ps["ollama_endpoint"].rstrip("/") + "/api/generate"
        headers = {"Content-Type": "application/json"}
        if ps["ollama_api_key"]:
            headers["Authorization"] = f"Bearer {ps['ollama_api_key']}"
        payload = {"model": vmodel, "prompt": prompt,
                   "images": [b64], "stream": False, "format": "json"}
        req = urllib.request.Request(
            url, data=_json.dumps(payload).encode("utf-8"),
            headers=headers, method="POST")
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8", errors="replace")
        j = _json.loads(body)
        raw = (j.get("response") or "").strip()
        if not raw:
            return {**base_result, "reason": "vision: порожня відповідь"}
        parsed = _parse_action_json(raw)
        return {**base_result, "action": parsed.get("action", "skip"),
                "reason": parsed.get("reason", raw[:100])}
    except urllib.error.HTTPError as e:
        if e.code == 400:
            # Модель не підтримує images — чесно кажемо про обмеження
            return {**base_result, "reason": "модель без vision (тільки текст)"}
        return {**base_result, "reason": f"vision HTTP {e.code}"}
    except Exception as e:
        return {**base_result, "reason": f"vision err: {e}"}

def _build_vision_prompt_text(niche: NicheProfile) -> str:
    """Текстовий промпт для vision-рішення (картинка йде в base64 images)."""
    return (
        f"Оцінюєш Instagram Reel (зображення) для прогріву акаунту.\n\n"
        f"{niche.to_prompt_block()}\n\n"
        f"Поверни ТІЛЬКИ JSON (без markdown):\n"
        f'{{"action": "like", "reason": "..."}}   — релевантний ніші\n'
        f'{{"action": "save", "reason": "..."}}   — дуже цінний/глибокий (рідко)\n'
        f'{{"action": "skip", "reason": "..."}}   — НЕ наша ніша або в avoid\n\n'
        f"Reason одним коротким реченням українською."
    )



# ───── prompts ─────────────────────────────────────────────────────

def _build_text_prompt(reel_text: str, niche: NicheProfile) -> str:
    return (
        f"Оцінюєш Instagram Reel для прогріву акаунту.\n\n"
        f"{niche.to_prompt_block()}\n\n"
        f"Текст з рілса (caption + overlay): «{reel_text}»\n\n"
        f"Поверни ТІЛЬКИ JSON (без markdown):\n"
        f'{{"action": "like", "reason": "..."}}   — релевантний нашій ніші\n'
        f'{{"action": "save", "reason": "..."}}   — дуже цінний/глибокий (рідко)\n'
        f'{{"action": "skip", "reason": "..."}}   — НЕ наша ніша або в avoid\n\n'
        f"Reason одним коротким реченням українською."
    )


def _build_vision_prompt(screenshot_path: str, niche: NicheProfile) -> str:
    return (
        f"Проаналізуй Instagram Reel screenshot для прогріву акаунту.\n\n"
        f"{niche.to_prompt_block()}\n\n"
        f"Зображення: @{screenshot_path}\n\n"
        f"Поверни ТІЛЬКИ JSON (без markdown):\n"
        f'{{"action": "like", "reason": "..."}}   — релевантний ніші\n'
        f'{{"action": "save", "reason": "..."}}   — дуже цінний (глибокий/унікальний)\n'
        f'{{"action": "skip", "reason": "..."}}   — поза нішею або в avoid\n\n'
        f"Reason — одним реченням українською."
    )


# ───── response parsing ───────────────────────────────────────────

def _parse_ai_response(text: str, mode: str) -> dict:
    """Legacy parser для --output-format text (не використовується з моменту переходу на json)."""
    text = (text or "").strip()
    if not text:
        return {"action": "skip", "reason": "empty response", "mode": mode}
    m = re.search(r"\{.*\}", text, re.DOTALL)
    if not m:
        return {"action": "skip", "reason": f"no JSON: {text[:80]}", "mode": mode}
    try:
        decision = json.loads(m.group())
    except json.JSONDecodeError as e:
        return {"action": "skip", "reason": f"bad JSON: {e}", "mode": mode}
    action = decision.get("action", "skip")
    if action not in ("like", "save", "skip"):
        action = "skip"
    return {
        "action": action,
        "reason": decision.get("reason", ""),
        "mode": mode,
    }


def _parse_ai_json_response(stdout: str, mode: str) -> dict:
    """Parser для --output-format json.

    Claude CLI JSON response:
      {
        "result": "{\"action\":\"like\",\"reason\":\"...\"}",
        "usage": {
          "input_tokens": N,
          "output_tokens": N,
          "cache_read_input_tokens": N,
          "cache_creation_input_tokens": N
        },
        "total_cost_usd": X,
        "duration_ms": N
      }
    """
    out = {"action": "skip", "reason": "", "mode": mode,
            "tokens_in": 0, "tokens_out": 0, "cost_usd": 0.0,
            "cache_read": 0, "duration_ms": 0}

    try:
        response = json.loads((stdout or "").strip())
    except json.JSONDecodeError as e:
        out["reason"] = f"bad CLI JSON: {str(e)[:60]}"
        return out

    # Usage info (tokens + cost)
    usage = response.get("usage") or {}
    out["tokens_in"] = int(usage.get("input_tokens", 0))
    out["tokens_out"] = int(usage.get("output_tokens", 0))
    out["cache_read"] = int(usage.get("cache_read_input_tokens", 0))
    out["cost_usd"] = float(response.get("total_cost_usd", 0.0))
    out["duration_ms"] = int(response.get("duration_ms", 0))

    # Власне результат (JSON всередині результату, може бути в ```json``` блоці)
    result_text = response.get("result", "").strip()
    m = re.search(r"\{[^{}]*\"action\"[^{}]*\}", result_text, re.DOTALL)
    if not m:
        out["reason"] = f"no action JSON: {result_text[:80]}"
        return out

    try:
        decision = json.loads(m.group())
    except json.JSONDecodeError:
        out["reason"] = f"bad action JSON: {result_text[:80]}"
        return out

    action = decision.get("action", "skip")
    if action not in ("like", "save", "skip"):
        action = "skip"
    out["action"] = action
    out["reason"] = decision.get("reason", "")
    return out


# ───── helpers for orchestrator ───────────────────────────────────

def niche_from_config(cfg: dict) -> NicheProfile:
    """Створити NicheProfile з warmup_config (dict з БД)."""
    def _as_list(v) -> list[str]:
        if isinstance(v, list): return [str(x) for x in v]
        if isinstance(v, str):
            if not v: return []
            try:
                parsed = json.loads(v)
                return [str(x) for x in parsed] if isinstance(parsed, list) else []
            except json.JSONDecodeError:
                # fallback: comma-separated
                return [s.strip() for s in v.split(',') if s.strip()]
        return []

    return NicheProfile(
        description=str(cfg.get('niche_description') or ''),
        keywords=_as_list(cfg.get('niche_keywords')),
        avoid=_as_list(cfg.get('niche_avoid')),
        examples=_as_list(cfg.get('niche_examples')),
    )
