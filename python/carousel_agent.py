"""
Carousel Agent — автоматичний генератор IG каруселей "дві крайності" (Modern vs Samurai).

Потік:
  1. ІДЕЯ (Ollama gpt-oss:120b) — бере шаблон ідеї, підлаштовує під дисципліну/самурая.
  2. СЛАЙДИ (Ollama) — 5-8 слайдів, кожен: text (фраза-контраст) + image_prompt (за hokan_master_prompt.md).
  3. ЗОБРАЖЕННЯ (Google Flow) — generate_flow_image(prompt, aspect='1:1') для кожного слайда.
  4. ТЕКСТ (render_text_overlay) — накладає фразу на зображення.
  5. ПУБЛІКАЦІЯ (post_carousel_v2) — збирає слайди в карусель, публікує в Instagram.

Модель: Ollama (gpt-oss:120b) для ідей/промптів. Зображення — Google Flow.
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.request
import urllib.error

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# ─── Settings reader (той самий шлях що main.py) ──────────────────────────
def _electron_settings_path() -> str:
    if sys.platform == "win32":
        appdata = os.environ.get("APPDATA") or os.path.expanduser("~\\AppData\\Roaming")
        return os.path.join(appdata, "reels-generator", "settings.json")
    return os.path.expanduser("~/.config/reels-generator/settings.json")


def _read_settings() -> dict:
    path = _electron_settings_path()
    if not os.path.isfile(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def _ollama_settings() -> dict:
    s = _read_settings()
    ollama = s.get("ollama") or {}
    return {
        "endpoint": ollama.get("endpoint") or "https://ollama.com",
        "api_key": ollama.get("apiKey") or "",
        "model": ollama.get("model") or "gpt-oss:120b",
    }


def _flow_settings() -> dict:
    s = _read_settings()
    gf = s.get("googleFlow") or {}
    return {
        "project_url": gf.get("projectUrl") or "",
        "cookies": gf.get("cookies") or "",
    }


# ─── Ollama call (для ідей і слайдів) ──────────────────────────────────────
def _ollama_generate(prompt: str, *, model: str = "", endpoint: str = "",
                     api_key: str = "", timeout: int = 180) -> dict:
    """Викликає Ollama /api/generate з format=json. Повертає {ok, data, error}."""
    if not model:
        model = _ollama_settings()["model"]
    if not endpoint:
        endpoint = _ollama_settings()["endpoint"]
    if not api_key:
        api_key = _ollama_settings()["api_key"]

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
        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(url, data=data, headers=headers, method="POST")
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8", errors="replace")
        try:
            parsed = json.loads(body)
        except json.JSONDecodeError as e:
            return {"ok": False, "error": f"Ollama невалідний JSON: {e}. Body: {body[:200]}"}
        raw = (parsed.get("response") or "").strip()
        if not raw:
            return {"ok": False, "error": f"Ollama пуста відповідь. Body: {body[:200]}"}
        # Прибираємо ```json fences
        cleaned = re.sub(r"```(?:json)?", "", raw).replace("```", "").strip()
        m = re.search(r"\{.*\}", cleaned, re.DOTALL)
        if not m:
            return {"ok": False, "error": f"Ollama без JSON. Відповідь: {raw[:200]}"}
        try:
            data_obj = json.loads(m.group())
        except json.JSONDecodeError as e:
            return {"ok": False, "error": f"Ollama JSON parse: {e}. Raw: {raw[:200]}"}
        return {"ok": True, "data": data_obj, "model": model}
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


# ─── Master prompt для зображень ───────────────────────────────────────────
def _load_master_prompt(style: str = "hokan") -> str:
    prompts_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "prompts")
    # Map style names to master prompt files
    style_map = {
        "hokan": "hokan_master_prompt.md",
        "hokan-cartoon": "hokan_cartoon_master_prompt.md",
        "hokan-storybook": "hokan_storybook_master_prompt.md",
        "mushin": "mushin_master_prompt.md",
    }
    fname = style_map.get(style.lower(), f"{style.lower()}_master_prompt.md")
    path = os.path.join(prompts_dir, fname)
    if os.path.isfile(path):
        with open(path, "r", encoding="utf-8") as f:
            return f.read()
    return ""


# ─── Ідея (крок 1) ────────────────────────────────────────────────────────
_IDEA_TEMPLATES = [
    "The average millionaire is 57. You are not behind.",
    "Your parents' plan wasn't wrong. It just expired.",
    "Working hard is the entry fee. It is not the strategy.",
    "Most people think they need to earn more. Usually they just need to wait better.",
    "The scariest part of sales is not the rejection. It is the first few months where the number goes down.",
    "Most people lose the sale long before anyone says no.",
    "Your financial future doesn't change overnight. It changes through the choices you make every day.",
    "Most people sell products. Entrepreneurs create value.",
    "Motivation is a feeling. Discipline is a decision.",
    "Your streak isn't discipline. It's a scoreboard.",
    "The samurai trained 18 hours a day. You can't do 20 minutes.",
    "A broken word is worse than a broken sword.",
    "The calmest water reflects the enemy's truth most clearly.",
    "Nobody invents a new excuse. There are eight of them and you have been using one for years.",
    "You do not wait for the excuse to stop being true. You work next to it.",
]

_IDEA_PROMPT = """You are a copywriter for a men's discipline brand (Hokan, a 90-day samurai discipline app).

Here is a proven viral idea template from a successful competitor:
"{template}"

Your job: adapt this idea to the discipline/samurai niche. Keep the SAME structure and punch, but make it about discipline, duty, and the samurai code instead of money/business.

Return ONLY JSON:
{{
  "idea": "the adapted one-line idea, max 15 words, sharp and cold",
  "hook": "the first-slide hook that makes people stop scrolling, max 8 words",
  "cta": "the final call-to-action line, max 10 words"
}}"""


def generate_idea(template: str = "", model: str = "", endpoint: str = "",
                  api_key: str = "") -> dict:
    """Крок 1: генерує ідею каруселі через Ollama."""
    if not template:
        import random
        template = random.choice(_IDEA_TEMPLATES)
    prompt = _IDEA_PROMPT.format(template=template)
    r = _ollama_generate(prompt, model=model, endpoint=endpoint, api_key=api_key)
    if not r.get("ok"):
        return r
    data = r.get("data") or {}
    return {
        "ok": True,
        "idea": data.get("idea", ""),
        "hook": data.get("hook", ""),
        "cta": data.get("cta", ""),
        "template": template,
        "model": r.get("model", ""),
    }


# ─── Слайди (крок 2) ─────────────────────────────────────────────────────
_SLIDES_PROMPT = """You are a soft-illustration artist + copywriter for Hokan, a samurai discipline brand.

You have ONE idea for an Instagram carousel:
"{idea}"

Create a cohesive carousel of {n} square (1:1) images. Every slide shows THE SAME SPLIT-SCREEN concept: a strong samurai animal character on one side, a weak modern man on the other. Only the camera angle and the specific contrast change per slide. Each slide carries a short text line that builds the idea across the carousel (like a story: hook → escalation → payoff).

The visual style follows the Hokan STORYBOOK master prompt (soft, warm, atmospheric digital illustration, thin soft lines, NO thick black outlines, warm muted palette, premium illustrated-book feel).

Return ONLY JSON:
{{
  "scene_anchor": "short shared description of the split-screen scene (one sentence)",
  "slides": [
    {{
      "angle": "camera angle for this slide, e.g. wide split-screen",
      "text": "short text line for this slide, max 8 words, cold and sharp",
      "image_prompt": "full detailed image prompt for this slide following the Hokan STORYBOOK master prompt JSON schema (fields: label, tags, Style, Subject, MadeOutOf, Arrangement, Background, ColorRestriction, Lighting, Camera, Composition, Weather, OutputStyle, Mood, Negative)"
    }}
  ]
}}

Total {n} slides. The text lines must build the idea: slide 1 = hook, middle = escalation, last = payoff/CTA.
"""


def generate_slides(idea: str, n_slides: int = 5, style: str = "hokan",
                    model: str = "", endpoint: str = "", api_key: str = "") -> dict:
    """Крок 2: генерує N слайдів (текст + image_prompt) через Ollama."""
    n = max(2, min(10, int(n_slides)))
    master = _load_master_prompt(style)
    prompt = f"{master}\n\n{_SLIDES_PROMPT.format(idea=idea, n=n)}"
    r = _ollama_generate(prompt, model=model, endpoint=endpoint, api_key=api_key)
    if not r.get("ok"):
        return r
    data = r.get("data") or {}
    slides = data.get("slides") or []
    if not isinstance(slides, list) or not slides:
        return {"ok": False, "error": "Ollama не повернув slides[]"}
    out = []
    for sl in slides[:n]:
        ip = sl.get("image_prompt", "")
        # Ollama format=json повертає image_prompt як dict — конвертуємо в JSON string
        if isinstance(ip, dict):
            ip = json.dumps(ip, ensure_ascii=False)
        out.append({
            "angle": sl.get("angle", ""),
            "text": sl.get("text", ""),
            "image_prompt": ip,
        })
    return {
        "ok": True,
        "scene_anchor": data.get("scene_anchor", ""),
        "slides": out,
        "model": r.get("model", ""),
    }


# ─── Повний пайплайн (кроки 1-4, без публікації) ─────────────────────────
def run_agent(template: str = "", n_slides: int = 5, style: str = "hokan",
              generate_images: bool = True, apply_text: bool = True,
              model: str = "", endpoint: str = "", api_key: str = "") -> dict:
    """Запускає агента: ідея → слайди → зображення (Google Flow) → текст.

    Повертає {ok, idea, hook, cta, slides: [{angle, text, image_prompt, image_path, final_path}]}
    """
    # Крок 1: ідея
    idea_r = generate_idea(template, model=model, endpoint=endpoint, api_key=api_key)
    if not idea_r.get("ok"):
        return idea_r
    idea = idea_r.get("idea", "")
    hook = idea_r.get("hook", "")
    cta = idea_r.get("cta", "")

    # Крок 2: слайди
    slides_r = generate_slides(idea, n_slides, style, model=model, endpoint=endpoint, api_key=api_key)
    if not slides_r.get("ok"):
        return slides_r
    slides = slides_r.get("slides", [])
    scene_anchor = slides_r.get("scene_anchor", "")

    # Крок 3: зображення через Google Flow
    flow = _flow_settings()
    from google_flow import generate_flow_image
    for i, sl in enumerate(slides):
        if not sl.get("image_prompt"):
            continue
        if not generate_images:
            sl["image_path"] = ""
            sl["final_path"] = ""
            continue
        try:
            img = generate_flow_image(
                sl["image_prompt"],
                cookies_raw=flow.get("cookies", ""),
                project_url=flow.get("project_url", "") or None,
                headless=False,
                aspect="1:1",
            )
            if img.get("ok"):
                sl["image_path"] = img.get("path", "")
                sl["final_path"] = img.get("path", "")
            else:
                sl["image_path"] = ""
                sl["final_path"] = ""
                sl["error"] = img.get("error", "")
        except Exception as e:
            sl["image_path"] = ""
            sl["final_path"] = ""
            sl["error"] = f"{type(e).__name__}: {e}"

    # Крок 4: накласти текст
    if apply_text:
        from post_generate import render_text_overlay
        for i, sl in enumerate(slides):
            if not sl.get("image_path") or not sl.get("text"):
                continue
            try:
                ov = render_text_overlay(sl["image_path"], sl["text"], font_size=90, position=50)
                if ov.get("ok"):
                    sl["final_path"] = ov.get("path", sl["image_path"])
            except Exception as e:
                sl["error"] = f"overlay: {e}"

    return {
        "ok": True,
        "idea": idea,
        "hook": hook,
        "cta": cta,
        "scene_anchor": scene_anchor,
        "slides": slides,
        "model": idea_r.get("model", ""),
    }
