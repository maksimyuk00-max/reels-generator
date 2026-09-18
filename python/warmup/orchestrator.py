"""Warmup v2 orchestrator — головний цикл mixed-action IG warmup.

Зшиває разом:
  - state_detector (де ми в IG)
  - ai_relevance   (чи релевантний контент)
  - policy         (яку дію обирати)
  - actions        (виконання реальних жестів)

Головна функція: run_warmup_session() — drop-in заміна для scroll_reels().
API сумісний: приймає серіал/тривалість/налаштування, повертає dict зі статистикою.
"""

from __future__ import annotations

import os
import random
import sys
import time

# Додаємо python/ у sys.path для імпортів з android_poster
_HERE = os.path.dirname(os.path.abspath(__file__))
_PY_DIR = os.path.dirname(_HERE)
if _PY_DIR not in sys.path:
    sys.path.insert(0, _PY_DIR)

from .state_detector import detect_screen, ScreenState
from .policy import (
    SessionBudget, SessionMemory, PlannedAction, next_action,
)
from .actions import execute, ExecutionResult
from .ai_relevance import (
    NicheProfile, niche_from_config,
    ai_decide_reel_text, ai_decide_reel_vision,
)


def run_warmup_session(
    serial: str | None = None,
    duration_seconds: int = 360,
    niche: NicheProfile | None = None,
    proxy: str | None = None,
    use_ai: bool = True,
    max_likes: int | None = None,      # якщо None — 5% від очікуваних reels
    max_saves: int | None = None,
    log_fn=None,                        # optional: callback для логів
    session_id: int | None = None,     # id у БД для прямого запису результату
    db_path: str | None = None,        # шлях до SQLite (з Electron)
    engine: str = 'v2',                 # для db.engine field
) -> dict:
    """Запустити повну warmup сесію з mixed actions.

    Args:
        serial:            ADB host (None = default)
        duration_seconds:  тривалість
        niche:             налаштована ніша (NicheProfile або None щоб не використовувати AI)
        proxy:             "host:port:user:pass" або None
        use_ai:            вмикає AI relevance (якщо niche заповнено)
        max_likes/saves:   жорсткі ліміти (None → розраховуємо: 5%/2% від reels)
        log_fn:            callable(str) для логів

    Returns:
        {
            "ok": True,
            "reels_watched": int,
            "likes_given": int,
            "saves_given": int,
            "stories_watched": int,
            "ai_decisions": list[dict],
            "duration": float,
            "time_in_tab": {...},
            "tab_switches": int,
            "actions": list[str],   # послідовність дій для debug
            "error": str | None,
        }
    """
    import uiautomator2 as u2
    from android_poster import _set_proxy, _set_uk_disguise, read_reel_text

    def log(msg: str) -> None:
        if log_fn:
            try: log_fn(msg)
            except Exception: pass
        print(f"[v2] {msg}", flush=True)

    # ── 0. Connect ──────────────────────────────────────────────
    try:
        d = u2.connect(serial) if serial else u2.connect()
    except Exception as e:
        return {"ok": False, "error": f"Device connect failed: {e}"}

    log(f"Session start: {duration_seconds}s, AI={use_ai}, "
        f"niche={'configured' if (niche and niche.is_configured()) else 'NONE'}")

    # ── 1. Proxy & disguise ─────────────────────────────────────
    proxy_set = False
    orig_disguise = None

    # Estimate очікуваних reels для лімітів (для 6 хв = ~50 reels)
    # Cred 20-25 reels/хв з природніми паузами
    expected_reels = max(1, int(duration_seconds / 12))
    if max_likes is None:
        max_likes = max(1, int(expected_reels * 0.05))   # 5%
    if max_saves is None:
        max_saves = max(1, int(expected_reels * 0.02))   # 2%

    budget = SessionBudget(
        total_seconds=float(duration_seconds),
        max_likes=max_likes,
        max_saves=max_saves,
    )
    memory = SessionMemory()

    # Трекер: коли востаннє викликали AI для reel (за action counter'ом)
    last_ai_reel_at_action = -999
    # Прапорці для поточного reel
    current_reel_liked = False
    current_reel_saved = False
    # Ліміт vision викликів (дорогий fallback) — max ~30% від reels
    max_vision_calls = max(3, int(duration_seconds / 60 * 3))  # ~3 на 60с
    vision_calls_used = 0

    actions_log: list[str] = []
    ai_decisions: list[dict] = []
    error: str | None = None
    last_tab_time = time.time()

    try:
        if proxy:
            parts = proxy.strip().split(":")
            if len(parts) >= 2:
                try:
                    _set_proxy(d, parts[0], int(parts[1]),
                               parts[2] if len(parts) > 2 else "",
                               parts[3] if len(parts) > 3 else "")
                    proxy_set = True
                    log("proxy set OK")
                except Exception as e:
                    return {"ok": False, "error": f"Proxy setup failed: {e}"}

        try:
            orig_disguise = _set_uk_disguise(d)
        except Exception as e:
            log(f"disguise warn: {e}")

        # ── 2. Open IG ──────────────────────────────────────────
        # Wake + unlock (повний цикл: KEYCODE_WAKEUP + перевірка Display Power +
        # swipe up для dismissing lockscreen + dismiss-keyguard).
        # Простий KEYCODE_WAKEUP не дає dismiss lockscreen → IG не стартує.
        try:
            from android_poster import _wake_and_unlock
            d.shell("svc power stayon true")
            _wake_and_unlock(d)
            # Підтверджуємо що екран увімкнувся; до 3 спроб
            for _ in range(3):
                power_state = d.shell("dumpsys power | grep 'Display Power'").output
                if "state=ON" in power_state:
                    break
                d.shell("input keyevent KEYCODE_WAKEUP")
                time.sleep(1.0)
                d.shell("wm dismiss-keyguard")
                time.sleep(0.5)
        except Exception as e:
            log(f"wake_and_unlock warn: {e}")

        # Закриваємо і знову відкриваємо IG — чистий старт
        try:
            from android_poster import IG_PKG
            d.app_stop(IG_PKG)
            time.sleep(0.8)
            d.app_start(IG_PKG, use_monkey=True)
        except Exception as e:
            log(f"app_start warn: {e}")

        time.sleep(3.5)  # splash + feed load

        # ── 3. Main loop ────────────────────────────────────────
        last_tab_time = time.time()
        recovery_attempts = 0       # лічильник recover_back/open_instagram
        last_productive_action_at = time.time()  # час останнього product-у action

        while not budget.is_done():
            now = time.time()

            # 3.1 Detect state
            state = detect_screen(d)

            # 3.0 DEAD LOOP DETECTION — якщо >60s без жодної продуктивної дії
            # (тільки recovery/wait) — виходимо з error
            if now - last_productive_action_at > 60:
                log(f"DEAD LOOP detected: {recovery_attempts} recovery attempts, "
                    f"no productive action for {now - last_productive_action_at:.0f}s")
                error = f"dead loop (recovery {recovery_attempts}x)"
                break

            # 3.2 Track time in current tab
            cur_tab = _tab_name(state)
            if cur_tab:
                budget.time_in_tab[cur_tab] = budget.time_in_tab.get(cur_tab, 0) + (now - last_tab_time)
            last_tab_time = now

            # 3.3 AI evaluation на новому reel
            if (use_ai and state.type == 'REELS_FEED'
                    and niche and niche.is_configured()
                    and memory.action_counter - last_ai_reel_at_action >= 1
                    and memory.last_ai_decision is None):
                # Новий reel — оцінюємо (text first, vision як fallback)
                try:
                    # Даємо UI час завантажити TextView після scroll
                    time.sleep(0.7)
                    reel_text = read_reel_text(d, min_len=0) or ""
                    decision = None

                    if len(reel_text.strip()) >= 10:
                        # Text-only — швидко
                        decision = ai_decide_reel_text(reel_text, niche, timeout=15)
                        log(f"AI [text] → {decision['action']}: {decision.get('reason','')[:80]}")
                    elif vision_calls_used < max_vision_calls:
                        # Vision fallback — робимо screenshot через PIL
                        try:
                            png = _grab_screenshot_bytes(d)
                            if png and len(png) > 1000:
                                decision = ai_decide_reel_vision(png, niche, timeout=25)
                                vision_calls_used += 1
                                log(f"AI [vision #{vision_calls_used}] → {decision['action']}: {decision.get('reason','')[:80]}")
                            else:
                                log(f"AI vision skip: screenshot empty ({len(png) if png else 0}b)")
                        except Exception as ve:
                            log(f"AI vision error: {ve}")

                    if decision:
                        # Downgrade якщо бюджет вичерпано — щоб у логах відображалось
                        # реальне поведінка, не "phantom" save decisions.
                        if decision['action'] == 'save' and budget.saves_given >= budget.max_saves:
                            if budget.likes_given < budget.max_likes:
                                decision['downgraded_from'] = 'save'
                                decision['downgrade_reason'] = f'save limit reached ({budget.max_saves})'
                                decision['action'] = 'like'
                            else:
                                decision['downgraded_from'] = 'save'
                                decision['downgrade_reason'] = f'save limit reached, likes also at limit'
                                decision['action'] = 'skip'
                            log(f"  [downgrade] save → {decision['action']}: {decision['downgrade_reason']}")
                        elif decision['action'] == 'like' and budget.likes_given >= budget.max_likes:
                            decision['downgraded_from'] = 'like'
                            decision['downgrade_reason'] = f'likes limit reached ({budget.max_likes})'
                            decision['action'] = 'skip'
                            log(f"  [downgrade] like → skip: {decision['downgrade_reason']}")
                        memory.last_ai_decision = decision['action']
                        ai_decisions.append(decision)
                    else:
                        memory.last_ai_decision = 'skip'
                        log(f"AI skip: no signal (text={len(reel_text)}, vision_used={vision_calls_used}/{max_vision_calls})")

                    last_ai_reel_at_action = memory.action_counter
                except Exception as e:
                    log(f"AI error: {e} — skip")
                    memory.last_ai_decision = 'skip'

            # 3.4 Policy → обираємо наступну дію
            action = next_action(state, budget, memory)

            if action.kind == 'end_session':
                log(f"end_session: {action.reason}")
                break

            # 3.5 Execute
            log(f"{state.type:<18} → {action.kind:<24} | {action.reason[:50]}")
            result = execute(d, action, state)
            actions_log.append(action.kind)

            if not result.ok:
                log(f"  FAIL: {result.error[:80]}")

            # 3.6 Update budget/memory з side_effects
            fx = result.side_effects or {}
            if fx.get('liked') is True:
                budget.likes_given += 1
                memory.last_like_at = time.time()
                current_reel_liked = True
            if fx.get('saved') is True:
                budget.saves_given += 1
                memory.last_save_at = time.time()
                current_reel_saved = True
            if 'reel' in action.kind and 'scroll' in action.kind:
                budget.reels_watched += 1
            if fx.get('peeked') is True:
                budget.profile_peeks += 1
            if action.kind.startswith('goto_') or action.kind == 'open_instagram':
                budget.tab_switches += 1
            if fx.get('watched') is True and state.type == 'STORY_VIEWER':
                budget.stories_watched += 1

            # 3.7 Reset AI state коли переходимо на НАСТУПНИЙ reel
            if action.kind == 'reel_scroll_next':
                memory.last_ai_decision = None
                current_reel_liked = False
                current_reel_saved = False

            # 3.75 Трекер recovery/productive actions (для dead loop detection)
            recovery_kinds = {'wait', 'wake_and_unlock', 'recover_back',
                               'close_modal', 'open_instagram', 'skip_ad'}
            if action.kind in recovery_kinds:
                recovery_attempts += 1
                # Якщо > 6 recovery спроб підряд — уже явно щось не так
                if recovery_attempts > 6:
                    log(f"EARLY EXIT: {recovery_attempts} recovery attempts in a row")
                    error = f"too many recovery attempts ({recovery_attempts})"
                    break
                # Добавляємо довшу паузу після кожного recovery щоб не дати циклу "пальнути"
                time.sleep(2.0)
            else:
                recovery_attempts = 0
                last_productive_action_at = time.time()

            # 3.8 Записуємо в memory (впливає на consecutive_scrolls, тощо)
            memory.record(action.kind)

            # 3.9 Оновлюємо memory прапорці
            memory.already_liked_this_reel = current_reel_liked
            memory.already_saved_this_reel = current_reel_saved

        # ── 4. Cleanup ─────────────────────────────────────────
        log(f"cleanup: reels={budget.reels_watched}, likes={budget.likes_given}, "
            f"saves={budget.saves_given}, ai_calls={len(ai_decisions)}")

        # Home → закриваємо IG у фон (як реальні юзери)
        try:
            d.press("home")
        except Exception: pass

    except KeyboardInterrupt:
        error = "interrupted"
    except Exception as e:
        error = f"{type(e).__name__}: {e}"
        log(f"SESSION FAIL: {error}")
    finally:
        # Revert disguise/proxy
        if orig_disguise is not None:
            try:
                d.shell(f"settings put global device_name '{orig_disguise}'")
            except Exception: pass
        if proxy_set:
            try:
                d.shell("settings put global http_proxy :0")
            except Exception: pass

    # Aggregate AI costs
    total_in = sum(d.get('tokens_in', 0) for d in ai_decisions)
    total_out = sum(d.get('tokens_out', 0) for d in ai_decisions)
    total_cache_read = sum(d.get('cache_read', 0) for d in ai_decisions)
    total_cost = sum(d.get('cost_usd', 0.0) for d in ai_decisions)

    result = {
        "ok": error is None,
        "error": error,
        "reels_watched": budget.reels_watched,
        "likes_given": budget.likes_given,
        "saves_given": budget.saves_given,
        "stories_watched": budget.stories_watched,
        "profile_peeks": budget.profile_peeks,
        "tab_switches": budget.tab_switches,
        "time_in_tab": dict(budget.time_in_tab),
        "ai_decisions": ai_decisions,
        "actions": actions_log,
        "duration": budget.elapsed(),
        "ai_stats": {
            "calls": len(ai_decisions),
            "input_tokens": total_in,
            "output_tokens": total_out,
            "cache_read_tokens": total_cache_read,
            "total_tokens": total_in + total_out + total_cache_read,
            "cost_usd_if_api": round(total_cost, 6),
        },
    }

    # ── Direct DB write (Варіант Б): Python сам пише результат у SQLite ──
    # Це гарантує збереження даних навіть якщо Electron crashed/restarted.
    if session_id and db_path:
        try:
            from datetime import datetime, timezone
            from db_helper import update_warmup_session

            db_data = {
                'status': 'done' if result['ok'] else 'failed',
                'finished_at': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
                'reels_watched': result['reels_watched'],
                'likes_given': result['likes_given'],
                'saves_given': result['saves_given'],
                'error': None if result['ok'] else result.get('error', 'unknown'),
                'ai_decisions': result['ai_decisions'] if result['ai_decisions'] else None,
                'ai_input_tokens': total_in,
                'ai_output_tokens': total_out,
                'ai_cache_read_tokens': total_cache_read,
                'ai_cost_usd': round(total_cost, 6),
                'ai_calls': len(ai_decisions),
                'engine': engine,
            }
            db_r = update_warmup_session(db_path, session_id, db_data)
            if db_r.get('ok'):
                log(f"DB write OK: session #{session_id} → {db_data['status']}")
                result['db_written'] = True
            else:
                log(f"DB write FAIL: {db_r.get('error')}")
                result['db_written'] = False
                result['db_error'] = db_r.get('error')
        except Exception as e:
            log(f"DB write exception: {e}")
            result['db_written'] = False
            result['db_error'] = str(e)

    return result


def _grab_screenshot_bytes(d) -> bytes | None:
    """Взяти скріншот пристрою як PNG bytes.

    uiautomator2 за замовчуванням повертає PIL Image. Конвертуємо у bytes.
    Різні версії u2 мають різні сигнатури — намагаємось кілька варіантів.
    """
    import io

    # Спроба 1: default (повертає PIL Image)
    try:
        img = d.screenshot()
        if img is None:
            return None
        # PIL Image → PNG bytes
        if hasattr(img, 'save'):
            buf = io.BytesIO()
            img.save(buf, format='PNG')
            return buf.getvalue()
        # Уже bytes?
        if isinstance(img, (bytes, bytearray)):
            return bytes(img)
    except Exception:
        pass

    # Спроба 2: через adb shell screencap
    try:
        import tempfile, os
        tmp = tempfile.NamedTemporaryFile(suffix='.png', delete=False)
        tmp.close()
        try:
            d.screenshot(tmp.name)
            with open(tmp.name, 'rb') as f:
                return f.read()
        finally:
            try: os.unlink(tmp.name)
            except Exception: pass
    except Exception:
        return None


def _tab_name(state: ScreenState) -> str | None:
    m = {
        'HOME_FEED': 'home', 'REELS_FEED': 'reels',
        'STORY_VIEWER': 'stories', 'EXPLORE': 'explore',
        'PROFILE_OWN': 'profile', 'PROFILE_OTHER': 'profile',
    }
    return m.get(state.type)
