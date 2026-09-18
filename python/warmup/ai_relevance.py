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


# ───── Claude CLI discovery (копія з generate.py) ─────────────────

def _find_claude_cli() -> str | None:
    """Знайти claude.exe — спочатку локально в python/, потім у PATH."""
    here = os.path.dirname(os.path.abspath(__file__))
    # warmup/ → python/
    local = os.path.normpath(os.path.join(here, '..', 'claude.exe'))
    if os.path.exists(local):
        return local
    # у PATH
    from shutil import which
    return which('claude') or which('claude.exe')


# ───── text-only decision ─────────────────────────────────────────

def ai_decide_reel_text(reel_text: str, niche: NicheProfile,
                         timeout: int = 20) -> dict:
    """Швидке рішення на основі текста з reel (caption + overlay).

    Returns: {"action": "like"|"save"|"skip", "reason": "...", "mode": "text",
              "tokens_in": int, "tokens_out": int, "cost_usd": float,
              "cache_read": int, "duration_ms": int}
    """
    base_result = {"action": "skip", "mode": "text",
                    "tokens_in": 0, "tokens_out": 0, "cost_usd": 0.0,
                    "cache_read": 0, "duration_ms": 0}

    if not niche.is_configured():
        return {**base_result, "reason": "niche not configured"}

    claude = _find_claude_cli()
    if not claude:
        return {**base_result, "reason": "Claude CLI не знайдено"}

    prompt = _build_text_prompt(reel_text, niche)

    try:
        result = subprocess.run(
            [claude, "-p", prompt,
             "--model", "haiku",
             "--output-format", "json"],
            capture_output=True, text=True, encoding="utf-8", timeout=timeout,
        )
        if result.returncode != 0:
            return {**base_result, "reason": f"CLI rc={result.returncode}"}
        return _parse_ai_json_response(result.stdout, mode="text")
    except subprocess.TimeoutExpired:
        return {**base_result, "reason": "timeout"}
    except Exception as e:
        return {**base_result, "reason": f"err: {e}"}


# ───── vision decision ───────────────────────────────────────────

def ai_decide_reel_vision(screenshot_png: bytes, niche: NicheProfile,
                            timeout: int = 30) -> dict:
    """Рішення на основі скриншоту reel. Дорожче за text-only, використовуй
    як fallback коли text недостатній."""
    base_result = {"action": "skip", "mode": "vision",
                    "tokens_in": 0, "tokens_out": 0, "cost_usd": 0.0,
                    "cache_read": 0, "duration_ms": 0}

    if not screenshot_png:
        return {**base_result, "reason": "no screenshot"}
    if not niche.is_configured():
        return {**base_result, "reason": "niche not configured"}

    claude = _find_claude_cli()
    if not claude:
        return {**base_result, "reason": "Claude CLI не знайдено"}

    tmp = tempfile.NamedTemporaryFile(suffix=".png", delete=False)
    screenshot_path = None
    try:
        tmp.write(screenshot_png)
        tmp.close()
        screenshot_path = tmp.name

        prompt = _build_vision_prompt(screenshot_path, niche)

        result = subprocess.run(
            [claude, "-p", prompt,
             "--model", "haiku",
             "--output-format", "json",
             "--allowedTools", "Read"],
            capture_output=True, text=True, encoding="utf-8", timeout=timeout,
        )
        if result.returncode != 0:
            return {**base_result, "reason": f"CLI rc={result.returncode}"}
        return _parse_ai_json_response(result.stdout, mode="vision")
    except subprocess.TimeoutExpired:
        return {**base_result, "reason": "timeout"}
    except Exception as e:
        return {**base_result, "reason": f"err: {e}"}
    finally:
        if screenshot_path and os.path.exists(screenshot_path):
            try: os.unlink(screenshot_path)
            except Exception: pass


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
