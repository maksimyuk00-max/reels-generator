"""Post/Carousel generator — переваги той самий pipeline що Reels:
  - Prompts: Claude Sonnet через generate_prompt_for_style() (той самий код)
  - Images: Google Flow з aspect='1:1' (замість 9:16 як у Reels)

Reels pipeline 100% не змінюється (generate_prompt_for_style працює однаково).
google_flow.generate_flow_image() має новий default aspect='9:16' (для Reels) —
Posts викликає з aspect='1:1'.
"""

from __future__ import annotations

import json
import os
import re
import subprocess

from generate import (
    generate_prompt_for_style, _find_claude_cli, _pick_diverse, _load_history, _save_history,
)
from google_flow import generate_flow_image


def _prompt_to_string(val) -> str:
    """Claude повертає image_prompt як dict (Nano Banana Pro format). Flow приймає JSON string."""
    if isinstance(val, dict):
        return json.dumps(val, ensure_ascii=False, indent=2)
    try:
        return json.dumps(json.loads(val), ensure_ascii=False, indent=2)
    except Exception:
        return str(val) if val else ""


# _VARIETY дубльовано з generate.py щоб не чіпати Reels code
_VARIETY = {
    "hokan": {
        "warriors":    ["samurai with oni mask", "ronin with scarred face no mask",
                         "ashigaru foot soldier with banner", "sohei warrior monk with naginata",
                         "shogun warlord mounted on horse", "shinobi assassin crouching at night"],
        "backgrounds": ["dark misty forest", "devastated battlefield", "snowy mountain blizzard",
                         "destroyed temple in rain", "stone torii gate in fog",
                         "wooden bridge over gorge", "dark Japanese garden", "bamboo grove in rain",
                         "burning castle ruins"],
        "angles":      ["close-up chest-up side profile", "extreme close-up of mask only",
                         "full body dramatic low angle", "medium shot from behind",
                         "low angle looking up", "over-the-shoulder wide", "detail of hands",
                         "wide establishing shot", "high angle top-down"],
    },
    "mushin": {
        "warriors":    ["armored samurai matte black armor oni mask",
                         "armored samurai deep crimson armor kuwagata horns",
                         "unarmored ronin dark robes scarred face",
                         "unarmored ronin wet hair stoic expression",
                         "silhouette warrior kasa hat against sky"],
        "backgrounds": ["dark misty plains bokeh campfire lights",
                         "golden amber wheat field explosive sunset backlight",
                         "heavy rain storm dark storm clouds puddle reflections",
                         "field of deep crimson poppies grey sky",
                         "snowfall white mountain peaks cold palette",
                         "burning battlefield orange fire embers smoke",
                         "explosive gold orange sunset silhouette sky"],
        "angles":      ["extreme close-up mask fills entire frame",
                         "medium portrait chest to head low angle",
                         "full body low angle dramatic sky behind",
                         "from behind facing vast landscape",
                         "profile side view strong rim light",
                         "over-the-shoulder detail",
                         "wide establishing shot with character small",
                         "detail shot of armor and weapon"],
    },
}


def _load_style_master(style: str) -> str:
    """Читає master prompt файл стилю."""
    prompts_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "prompts")
    path = os.path.join(prompts_dir, f"{style.lower()}_master_prompt.md")
    if os.path.isfile(path):
        with open(path, "r", encoding="utf-8") as f:
            return f.read()
    return ""


def generate_carousel_prompts(style: str, topic: str = "", n_slides: int = 5,
                               claude_api_key: str = "") -> dict:
    """Генерує carousel = ОДИН персонаж + ОДИН background, N різних angles.

    Один виклик Claude Sonnet отримує весь carousel одразу.
    Для post (n=1) — той самий pipeline що Reels (через generate_prompt_for_style).
    """
    n = max(1, min(10, int(n_slides)))

    # Для single post — Reels-style diverse pipeline (через _VARIETY rotation)
    if n == 1:
        r = generate_prompt_for_style(style)
        if not r or not isinstance(r, dict):
            return {"ok": False, "error": "Claude не повернув prompt"}
        return {
            "ok": True,
            "scene_anchor": "",
            "slides": [{
                "angle": "single",
                "prompt": _prompt_to_string(r.get("image_prompt", "")),
                "quote": r.get("quote", ""),
            }],
        }

    # Carousel — один warrior + один background, N angles
    style_key = style.lower()
    variety = _VARIETY.get(style_key, _VARIETY["hokan"])
    history = _load_history()
    warrior = _pick_diverse(variety["warriors"], "warrior", history)
    background = _pick_diverse(variety["backgrounds"], "background", history)
    # History: зберігаємо лише перший angle (щоб наступна carousel брала інший bg/warrior)
    history.append({"warrior": warrior, "background": background,
                     "angle": variety["angles"][0]})
    _save_history(history)

    master = _load_style_master(style)

    claude_cli = _find_claude_cli()
    if not claude_cli:
        return {"ok": False, "error": "Claude CLI not found"}

    topic_block = f"\nTheme/concept (optional): {topic}\n" if topic else ""

    user_msg = f"""Generate a cohesive IG CAROUSEL of {n} square (1:1) images.

CRITICAL: Every slide must show THE SAME character in THE SAME environment — identical warrior, identical armor/clothing, identical background. Only the camera angle/framing changes.

FIXED:
- Character: {warrior}
- Environment: {background}
{topic_block}
Generate {n} slides with different angles (e.g. wide establishing → medium → close-up of face → detail of hands/weapon → reverse angle). Each slide must explicitly include the fixed character and environment descriptions so the AI image model generates consistent look.

Each slide's image_prompt should follow the master prompt's JSON schema structure.

Return ONLY JSON (no markdown, no preamble):
{{
  "scene_anchor": "short shared description of warrior + environment",
  "slides": [
    {{"angle": "wide establishing shot", "image_prompt": <full JSON prompt following master schema for slide 1>}},
    {{"angle": "medium from behind", "image_prompt": <full JSON prompt for slide 2>}},
    ...total {n} slides
  ]
}}"""

    full_prompt = f"{master}\n\n{user_msg}"

    try:
        result = subprocess.run(
            [claude_cli, "-p", full_prompt, "--output-format", "text"],
            capture_output=True, text=True, encoding="utf-8", timeout=180,
        )
        if result.returncode != 0:
            return {"ok": False, "error": f"Claude rc={result.returncode}: {(result.stderr or '')[:300]}"}

        text = (result.stdout or "").strip()
        # Strip markdown fences
        cleaned = re.sub(r'^```(?:json)?\s*', '', text, flags=re.MULTILINE)
        cleaned = re.sub(r'\s*```\s*$', '', cleaned, flags=re.MULTILINE).strip()
        start = cleaned.find('{')
        end = cleaned.rfind('}')
        if start < 0 or end <= start:
            return {"ok": False, "error": "Claude повернув не JSON", "raw": text[:500]}

        try:
            data = json.loads(cleaned[start:end + 1])
        except json.JSONDecodeError as je:
            return {"ok": False, "error": f"Invalid JSON: {je}", "raw": cleaned[start:end + 1][:500]}

        if not isinstance(data.get("slides"), list):
            return {"ok": False, "error": "JSON без slides[]", "raw": cleaned[start:end + 1][:300]}

        slides_out = []
        for sl in data["slides"][:n]:
            slides_out.append({
                "angle": sl.get("angle", ""),
                "prompt": _prompt_to_string(sl.get("image_prompt", "")),
                "quote": "",
            })

        return {
            "ok": True,
            "scene_anchor": data.get("scene_anchor", f"{warrior} | {background}"),
            "slides": slides_out,
            "character": warrior,
            "environment": background,
        }
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}


def render_text_overlay(image_path: str, text: str, font_size: int = 120,
                         position: int = 50, color: str = "white",
                         stroke_color: str = "black", stroke_width: int = 6) -> dict:
    """Burn text overlay на зображення через PIL.

    position: 0-100 (% від висоти, 50 = центр)
    Returns: {"ok": bool, "path": str, "error": str}
    """
    if not image_path or not os.path.isfile(image_path):
        return {"ok": False, "error": "Image not found"}
    if not text:
        return {"ok": True, "path": image_path}  # nothing to do

    try:
        from PIL import Image, ImageDraw, ImageFont
    except ImportError:
        return {"ok": False, "error": "PIL not installed"}

    try:
        img = Image.open(image_path).convert("RGBA")
        overlay = Image.new("RGBA", img.size, (0, 0, 0, 0))
        draw = ImageDraw.Draw(overlay)

        # Find font
        from generate import _find_font
        font_path = _find_font()
        font = None
        if font_path and os.path.isfile(font_path):
            try:
                font = ImageFont.truetype(font_path, font_size)
            except Exception:
                font = None
        if font is None:
            font = ImageFont.load_default()

        # Measure text і центруємо
        bbox = draw.textbbox((0, 0), text, font=font, stroke_width=stroke_width)
        tw = bbox[2] - bbox[0]
        th = bbox[3] - bbox[1]
        x = (img.width - tw) // 2 - bbox[0]
        y = int(img.height * (position / 100.0)) - th // 2 - bbox[1]

        draw.text(
            (x, y), text, font=font, fill=color,
            stroke_width=stroke_width, stroke_fill=stroke_color,
        )

        result = Image.alpha_composite(img, overlay).convert("RGB")
        out_path = image_path.replace(".png", "_overlay.png")
        if out_path == image_path:
            out_path = image_path + "_overlay.png"
        result.save(out_path, "PNG", quality=95)
        return {"ok": True, "path": out_path}
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}


def generate_post_image(prompt: str, style: str = "", project_url: str = "",
                        aspect: str = "1:1") -> dict:
    """Генерує 1:1 image через Google Flow (той же механізм що Reels)."""
    if not prompt:
        return {"ok": False, "error": "empty prompt"}
    try:
        return generate_flow_image(
            prompt,
            cookies_raw="",
            project_url=project_url or None,
            headless=False,
            aspect=aspect,
        )
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}
