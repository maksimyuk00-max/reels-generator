"""
Threads (com.instagram.barcelona) Android automation via uiautomator2.

Mirrors the structure of android_poster.py but targets the Threads app:
- threads_status(serial)             — device + Threads install info
- threads_publish(serial, text, ...) — open Threads, compose a post, share
- threads_scroll_and_comment(...)    — scroll For You / Following, occasionally
                                       like + comment (Claude CLI generated)

Helpers (_connect, _human_delay, _run_adb, _find_claude_cli) are imported from
android_poster / generate to avoid duplication.

All taps use defensive multi-pattern selectors (resourceId / description /
text) because Threads ships UI changes frequently and a single id breaks.
"""
from __future__ import annotations

import os
import re
import sys
import time
import random
import subprocess
import tempfile
from typing import Any, Callable

# Ensure local imports resolve when called from FastAPI / CLI.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from android_poster import (
    _connect,
    _run_adb,
    _get_device_wifi_ip,
)

THREADS_PACKAGE = "com.instagram.barcelona"

# Human delay defaults — matches android_poster._pause style.
_DELAY_SHORT = (0.4, 1.0)
_DELAY_MED = (1.2, 2.8)
_DELAY_LONG = (2.5, 5.0)


# ─────────────────────────────────────────────────────────────────────────────
# Internal helpers
# ─────────────────────────────────────────────────────────────────────────────


def _human_delay(lo: float = 1.2, hi: float = 2.8) -> None:
    """Random sleep — used between actions to mimic real user pacing."""
    time.sleep(random.uniform(lo, hi))


def _first_existing(d, *candidates):
    """Return the first selector with .exists True, or None."""
    for el in candidates:
        try:
            if el.exists:
                return el
        except Exception:
            continue
    return None


def _find_compose_button(d):
    """Locate the Threads compose ('+') button.

    Threads has shipped several different resource ids and descriptions for
    this control. Order from most specific (newest builds) to most generic.
    """
    candidates = [
        d(resourceId=f"{THREADS_PACKAGE}:id/create_button"),
        d(resourceId=f"{THREADS_PACKAGE}:id/feed_compose"),
        d(resourceId=f"{THREADS_PACKAGE}:id/composer_fab"),
        d(resourceId=f"{THREADS_PACKAGE}:id/composer_tab"),
        d(description="Compose"),
        d(description="New thread"),
        d(description="Create"),
        d(descriptionContains="ompose"),
    ]
    return _first_existing(d, *candidates)


def _find_text_input(d):
    """Locate the post text input field on the composer screen."""
    candidates = [
        d(resourceId=f"{THREADS_PACKAGE}:id/composer_text_input"),
        d(resourceId=f"{THREADS_PACKAGE}:id/text_input"),
        d(resourceId=f"{THREADS_PACKAGE}:id/edit_text"),
        d(className="android.widget.EditText"),
        d(descriptionContains="What"),
    ]
    return _first_existing(d, *candidates)


def _find_post_button(d):
    """Locate the Post / Share button on the composer screen."""
    candidates = [
        d(resourceId=f"{THREADS_PACKAGE}:id/post_button"),
        d(resourceId=f"{THREADS_PACKAGE}:id/share_button"),
        d(textMatches="(?i)^post$"),
        d(textMatches="(?i)^share$"),
        d(descriptionMatches="(?i)^post$"),
        d(descriptionMatches="(?i)^share$"),
    ]
    return _first_existing(d, *candidates)


def _find_like_button(d):
    """Locate the Like (heart) button on the currently visible post."""
    candidates = [
        d(resourceId=f"{THREADS_PACKAGE}:id/like_button"),
        d(resourceId=f"{THREADS_PACKAGE}:id/row_feed_button_like"),
        d(description="Like"),
        d(descriptionContains="Like"),
    ]
    return _first_existing(d, *candidates)


def _find_comment_button(d):
    """Locate the Comment / Reply button on the currently visible post."""
    candidates = [
        d(resourceId=f"{THREADS_PACKAGE}:id/comment_button"),
        d(resourceId=f"{THREADS_PACKAGE}:id/reply_button"),
        d(description="Reply"),
        d(description="Comment"),
        d(descriptionContains="eply"),
        d(descriptionContains="omment"),
    ]
    return _first_existing(d, *candidates)


def _type_text_humanlike(d, text: str) -> None:
    """Type text character-by-character with small jitter. send_keys handles
    Unicode correctly via the bundled FastInputIME — this preserves that
    behaviour but inserts micro-delays between chunks so the timing looks
    natural in logs/screen recording."""
    # Split into 1-3 char chunks for a typing rhythm.
    i = 0
    while i < len(text):
        chunk_len = random.randint(1, 3)
        chunk = text[i : i + chunk_len]
        try:
            d.send_keys(chunk, clear=False)
        except Exception:
            # Fallback: shell input — slower but always available
            for ch in chunk:
                # Escape spaces and quotes for adb shell input text
                safe = ch.replace(" ", "%s").replace("'", "")
                d.shell(f"input text {safe}")
        i += chunk_len
        time.sleep(random.uniform(0.05, 0.18))


def _ensure_threads_installed(d) -> dict:
    """Return version info dict if installed, else {'installed': False}."""
    try:
        info = d.app_info(THREADS_PACKAGE) or {}
        version = info.get("versionName")
        if not version:
            return {"installed": False}
        return {"installed": True, "version": version}
    except Exception:
        return {"installed": False}


def _wake_and_unlock(d) -> None:
    """Turn screen on and dismiss the lockscreen swipe-up.

    Two WAKEUP presses (some phones need two). Then if a lockscreen
    marker is detected, swipe up from the lower 80% to upper 20%.
    Mirrors `android_poster.py` step 0 of `scroll_reels`.
    """
    try:
        d.shell("input keyevent KEYCODE_WAKEUP")
        time.sleep(1)
        screen_on = True
        try:
            screen_on = bool(d.info.get("screenOn", True))
        except Exception:
            pass
        is_locked = False
        try:
            is_locked = (
                d(resourceId="com.android.systemui:id/lockscreen_status_view").exists
                or d(descriptionContains="unlock").exists
                or d(textContains="Swipe").exists
            )
        except Exception:
            pass
        if not screen_on or is_locked:
            try:
                info = d.info
                w = info.get("displayWidth", 1080)
                h = info.get("displayHeight", 1920)
                d.swipe(w // 2, int(h * 0.8), w // 2, int(h * 0.2), duration=0.4)
                time.sleep(1.2)
            except Exception:
                pass
        try:
            d.shell("input keyevent KEYCODE_MENU")
            time.sleep(0.5)
        except Exception:
            pass
    except Exception:
        # Wake-up best-effort; downstream selector probes will still surface
        # any real failure ("Compose button not found").
        pass


def _open_threads(d) -> bool:
    """Cold-start Threads and wait for the bottom tab bar to render."""
    _wake_and_unlock(d)
    try:
        d.app_stop(THREADS_PACKAGE)
    except Exception:
        pass
    _human_delay(0.6, 1.2)
    try:
        d.app_start(THREADS_PACKAGE, use_monkey=True)
    except Exception:
        return False

    # Wait up to 15s for any feed/UI marker to appear.
    deadline = time.time() + 15
    markers: list[Callable[[Any], bool]] = [
        lambda dev: dev(resourceId=f"{THREADS_PACKAGE}:id/tab_bar").exists,
        lambda dev: dev(resourceId=f"{THREADS_PACKAGE}:id/feed_recycler_view").exists,
        lambda dev: _find_compose_button(dev) is not None,
    ]
    while time.time() < deadline:
        try:
            for m in markers:
                if m(d):
                    return True
        except Exception:
            pass
        time.sleep(0.6)
    return False


def _claude_cli_path() -> str | None:
    """Resolve Claude CLI path via the existing helper in generate.py."""
    try:
        from generate import _find_claude_cli  # type: ignore[import-not-found]

        return _find_claude_cli()
    except Exception:
        return None


def _read_visible_post_text(d, min_len: int = 20) -> str:
    """Pull readable post text from the currently-visible Thread.

    Heuristic: collect TextView contents, drop UI labels/timestamps/numbers,
    return the longest dedup'd block. Bounded at 1200 chars to keep prompts
    small.
    """
    skip_exact = {
        "Like", "Reply", "Comment", "Repost", "Share", "Follow", "Following",
        "More", "now", "h", "m", "s", "ago",
    }

    def _is_junk(t: str) -> bool:
        t = t.strip()
        if not t or len(t) < 3:
            return True
        if t in skip_exact:
            return True
        if t.startswith("@") and " " not in t:
            return True
        if t.replace(",", "").replace(".", "").replace("K", "").replace(
            "M", ""
        ).replace(" ", "").isdigit():
            return True
        return False

    try:
        texts: list[str] = []
        for el in d(className="android.widget.TextView"):
            try:
                t = (el.info.get("text") or "").strip()
                if t and not _is_junk(t):
                    texts.append(t)
            except Exception:
                continue
        seen = set()
        uniq = []
        for t in texts:
            if t not in seen:
                seen.add(t)
                uniq.append(t)
        merged = " | ".join(uniq)
        if len(merged) < min_len:
            return ""
        return merged[:1200]
    except Exception:
        return ""


def _generate_comment(caption: str, ai_prompt: str) -> str:
    """Use Claude CLI to draft a comment that fits the post.

    Returns empty string on any failure — caller treats that as 'skip
    commenting on this post'.
    """
    claude_cli = _claude_cli_path()
    if not claude_cli or not caption:
        return ""

    style = (ai_prompt or "").strip() or (
        "Casual, like a real person scrolling Threads. "
        "Short, conversational, sometimes lowercase, no formal tone."
    )

    prompt = (
        "You are commenting on a Threads post AS A REAL HUMAN USER.\n"
        "Your goal: blend in. Sound like an actual person, not a bot.\n\n"
        f"POST: {caption}\n\n"
        f"YOUR PERSONA / STYLE: {style}\n\n"
        "STRICT RULES (do not break):\n"
        "- ENGLISH ONLY. Never use Ukrainian, Russian, or any other language.\n"
        "- Max 1-2 sentences, max 140 chars.\n"
        "- Sound natural: contractions ok (it's, don't, can't), occasional lowercase,\n"
        "  one typo is fine but not required, no perfect grammar.\n"
        "- NO emoji. NO hashtags. NO @mentions.\n"
        "- NO corporate / marketing tone. NO 'great post', 'love this', generic praise.\n"
        "- React to ONE specific thing in the post. Add a thought, a question,\n"
        "  a small disagreement, a personal angle. Make it feel like a real reply.\n"
        "- Do not start with 'I think' or 'This is'. Start mid-thought.\n"
        "- Return ONLY the comment text. No quotes, no preamble, no labels."
    )

    try:
        result = subprocess.run(
            [claude_cli, "-p", prompt, "--output-format", "text"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=25,
        )
        if result.returncode != 0:
            return ""
        out = (result.stdout or "").strip()
        # Strip wrapping quotes if any
        out = out.strip("\"'`")
        # Hard cap at 150 chars per the RULES
        if len(out) > 150:
            out = out[:150].rsplit(" ", 1)[0]
        return out
    except subprocess.TimeoutExpired:
        return ""
    except Exception:
        return ""


# ─────────────────────────────────────────────────────────────────────────────
# Public API
# ─────────────────────────────────────────────────────────────────────────────


def threads_status(serial: str | None = None) -> dict:
    """Return install + version info for Threads on the target device."""
    try:
        d = _connect(serial)
    except Exception as e:
        return {
            "ok": False,
            "installed": False,
            "version": None,
            "error": f"Device connect failed: {e}",
        }
    info = _ensure_threads_installed(d)
    return {
        "ok": True,
        "installed": bool(info.get("installed")),
        "version": info.get("version"),
    }


def threads_publish(
    serial: str | None,
    text: str,
    account_id: int | None = None,
) -> dict:
    """Publish a single text post on Threads.

    Steps: open Threads → tap compose (+) → type text → tap Post → verify by
    waiting for the composer to disappear.
    """
    if not text or not text.strip():
        return {"ok": False, "error": "Текст порожній"}

    try:
        d = _connect(serial)
    except Exception as e:
        return {"ok": False, "error": f"Device connect failed: {e}"}

    install = _ensure_threads_installed(d)
    if not install.get("installed"):
        return {"ok": False, "error": "Threads (com.instagram.barcelona) не встановлено"}

    if not _open_threads(d):
        return {"ok": False, "error": "Threads не завантажується (UI marker not found)"}
    _human_delay(*_DELAY_MED)

    # 1. Tap compose
    compose = _find_compose_button(d)
    if compose is None:
        return {
            "ok": False,
            "error": "Compose button not found — оновіть Threads app",
        }
    try:
        compose.click()
    except Exception as e:
        return {"ok": False, "error": f"Compose click failed: {e}"}
    _human_delay(*_DELAY_MED)

    # 2. Find text input and type
    text_input = _find_text_input(d)
    if text_input is None:
        return {"ok": False, "error": "Composer text input not found"}
    try:
        text_input.click()
        _human_delay(*_DELAY_SHORT)
        _type_text_humanlike(d, text)
    except Exception as e:
        return {"ok": False, "error": f"Typing failed: {e}"}
    _human_delay(*_DELAY_MED)

    # Close the soft keyboard so the Post button is reachable on small screens.
    try:
        d.press("back")
    except Exception:
        pass
    _human_delay(0.4, 0.9)

    # 3. Tap Post
    post_btn = _find_post_button(d)
    if post_btn is None:
        return {"ok": False, "error": "Post button not found"}
    try:
        post_btn.click()
    except Exception as e:
        return {"ok": False, "error": f"Post click failed: {e}"}

    # 4. Verify: composer should disappear within ~10s
    deadline = time.time() + 10
    while time.time() < deadline:
        try:
            if _find_text_input(d) is None:
                # Composer gone → assume published
                return {"ok": True, "account_id": account_id}
        except Exception:
            pass
        time.sleep(0.5)

    # Composer still visible — couldn't confirm. Treat as failure but return
    # neutral message; UI may still have succeeded but verification timed out.
    return {
        "ok": False,
        "error": "Не вдалось підтвердити публікацію (composer не закрився за 10s)",
    }


def threads_scroll_and_comment(
    serial: str | None,
    duration_sec: int,
    like_prob: float,
    ai_prompt: str = "",
    account_id: int | None = None,
) -> dict:
    """Scroll Threads For You / Following with occasional likes + comments.

    Returns counts of viewed/liked/commented posts. Comments use Claude CLI
    to draft contextually-relevant text; if CLI is unavailable we silently
    skip commenting (but still like + scroll).
    """
    try:
        d = _connect(serial)
    except Exception as e:
        return {
            "ok": False,
            "viewed": 0,
            "commented": 0,
            "liked": 0,
            "error": f"Device connect failed: {e}",
        }

    install = _ensure_threads_installed(d)
    if not install.get("installed"):
        return {
            "ok": False,
            "viewed": 0,
            "commented": 0,
            "liked": 0,
            "error": "Threads (com.instagram.barcelona) не встановлено",
        }

    if not _open_threads(d):
        return {
            "ok": False,
            "viewed": 0,
            "commented": 0,
            "liked": 0,
            "error": "Threads не завантажується",
        }
    _human_delay(*_DELAY_MED)

    # Comment probability is half of like probability — keep account safe
    comment_prob = max(0.0, min(1.0, like_prob)) * 0.5

    info = d.info
    w = info.get("displayWidth", 1080)
    h = info.get("displayHeight", 1920)
    cx = w // 2

    viewed = 0
    liked = 0
    commented = 0
    start = time.time()

    try:
        while (time.time() - start) < duration_sec:
            remaining = duration_sec - (time.time() - start)
            if remaining <= 0:
                break

            # Read visible post — bounds the work for AI prompts
            visible_text = _read_visible_post_text(d, min_len=20)
            viewed += 1

            # Save visible post to DB for Thread Feed
            if visible_text and len(visible_text) >= 20:
                try:
                    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
                    import threads_monitor
                    threads_monitor.save_found_post(
                        thread_text=visible_text,
                        author="",
                        account_id=account_id,
                        source="scroll",
                    )
                except Exception:
                    pass  # Don't let DB issues break the scroll session

            # Watch / read time
            watch = min(random.uniform(2.5, 8.0), remaining)
            time.sleep(watch)

            roll = random.random()

            # Like
            if roll < like_prob:
                like_btn = _find_like_button(d)
                if like_btn is not None:
                    try:
                        like_btn.click()
                        liked += 1
                        _human_delay(*_DELAY_SHORT)
                    except Exception:
                        pass

            # Comment (independent probability roll)
            if random.random() < comment_prob and visible_text:
                comment_text = _generate_comment(visible_text, ai_prompt)
                if comment_text:
                    comment_btn = _find_comment_button(d)
                    if comment_btn is not None:
                        try:
                            comment_btn.click()
                            _human_delay(*_DELAY_MED)
                            reply_input = _find_text_input(d)
                            if reply_input is not None:
                                reply_input.click()
                                _human_delay(*_DELAY_SHORT)
                                _type_text_humanlike(d, comment_text)
                                _human_delay(*_DELAY_SHORT)
                                # Hide keyboard, then tap Post
                                try:
                                    d.press("back")
                                except Exception:
                                    pass
                                _human_delay(0.4, 0.9)
                                send_btn = _find_post_button(d)
                                if send_btn is not None:
                                    send_btn.click()
                                    commented += 1
                                    _human_delay(*_DELAY_MED)
                            # Return to feed
                            try:
                                d.press("back")
                            except Exception:
                                pass
                            _human_delay(*_DELAY_SHORT)
                        except Exception:
                            # Make sure we drop back to the feed on any error
                            try:
                                d.press("back")
                            except Exception:
                                pass

            # Scroll to next thread — human-like swipe with jitter
            if (time.time() - start) >= duration_sec:
                break
            swipe_start_y = int(h * random.uniform(0.72, 0.82))
            swipe_end_y = int(h * random.uniform(0.18, 0.28))
            swipe_dur = random.uniform(0.20, 0.45)
            try:
                d.swipe(
                    cx + random.randint(-20, 20),
                    swipe_start_y,
                    cx + random.randint(-20, 20),
                    swipe_end_y,
                    duration=swipe_dur,
                )
            except Exception:
                pass
            _human_delay(0.6, 1.6)

        # Exit gracefully — return to home like a real user
        try:
            d.press("home")
        except Exception:
            pass

        return {
            "ok": True,
            "viewed": viewed,
            "commented": commented,
            "liked": liked,
            "duration": round(time.time() - start, 1),
            "account_id": account_id,
        }

    except Exception as e:
        return {
            "ok": False,
            "viewed": viewed,
            "commented": commented,
            "liked": liked,
            "error": f"{type(e).__name__}: {e}",
        }
