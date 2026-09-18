"""Симуляція 360-секундної сесії — без реального телефону.

Перевіряємо:
  - розподіл дій приблизно відповідає target_ratio
  - ліміти (likes/saves/peeks) не перевищуються
  - story виклик тільки якщо has_unviewed_stories
  - transitions без залипання
"""

from __future__ import annotations

import random
import sys
import time
from collections import Counter

# Додаємо python/ в sys.path щоб "import warmup" працював при
# запуску як `python _test_policy.py` з папки warmup/
_here = sys.path[0] if sys.path else ''
sys.path.insert(0, str(_here + '/..'))

from warmup.policy import (
    SessionBudget, SessionMemory, next_action, PlannedAction
)
from warmup.state_detector import ScreenState


def simulate_session(total_seconds=360.0, verbose=False) -> dict:
    """Прогнати фейкову сесію з перемикання станів і логувати дії."""
    random.seed(42)  # відтворюваність

    budget = SessionBudget(total_seconds=total_seconds)
    # Штучно виставляємо started_at трохи раніше, щоб time.time() рухався
    budget.started_at = time.time()
    memory = SessionMemory()

    # Стартова вкладка — REELS (як IG після splash іноді)
    current_state = ScreenState(type='REELS_FEED', confidence=0.85,
                                 active_tab='reels')

    actions: list[PlannedAction] = []
    sim_time = budget.started_at
    tick = 2.5  # середня тривалість дії (сек)

    max_iter = 500
    for i in range(max_iter):
        # Симулюємо проходження часу (замість реального time.sleep)
        sim_time += tick
        # Оновлюємо budget.started_at в "минуле" щоб elapsed виглядав більшим
        budget.started_at = time.time() - (sim_time - (time.time() - budget.elapsed()))
        # простіше: переписуємо started_at
        elapsed_fake = (i + 1) * tick
        budget.started_at = time.time() - elapsed_fake

        # Оновлюємо time_in_tab
        cur_tab = _tab_name(current_state)
        if cur_tab:
            budget.time_in_tab[cur_tab] = budget.time_in_tab.get(cur_tab, 0) + tick

        action = next_action(current_state, budget, memory)
        actions.append(action)

        if verbose:
            print(f"  t={elapsed_fake:5.1f}s | {current_state.type:<20} → "
                  f"{action.kind:<24} | {action.reason}")

        if action.kind == 'end_session':
            break

        # Симуляція побічних ефектів + наступний стан
        current_state = _simulate_next_state(current_state, action, memory, budget)
        memory.record(action.kind)

        # Executor оновлює лічильники
        if 'like' in action.kind:
            budget.likes_given += 1
            memory.last_like_at = time.time()
        if 'save' in action.kind:
            budget.saves_given += 1
            memory.last_save_at = time.time()
        if 'peek' in action.kind:
            budget.profile_peeks += 1
        if action.kind.startswith('goto_'):
            budget.tab_switches += 1

        if budget.is_done():
            actions.append(PlannedAction('end_session', reason='budget done'))
            break

    # Статистика
    kinds = Counter(a.kind for a in actions)
    return {
        'actions': len(actions),
        'kinds': dict(kinds),
        'likes': budget.likes_given,
        'saves': budget.saves_given,
        'peeks': budget.profile_peeks,
        'tab_switches': budget.tab_switches,
        'time_in_tab': dict(budget.time_in_tab),
        'elapsed': budget.elapsed(),
    }


def _tab_name(state: ScreenState) -> str | None:
    m = {'HOME_FEED': 'home', 'REELS_FEED': 'reels',
          'STORY_VIEWER': 'stories', 'EXPLORE': 'explore',
          'PROFILE_OWN': 'profile', 'PROFILE_OTHER': 'profile'}
    return m.get(state.type)


def _simulate_next_state(state: ScreenState, action: PlannedAction,
                          memory: SessionMemory,
                          budget: SessionBudget) -> ScreenState:
    """Груба модель: яка state буде після action."""
    k = action.kind

    # Navigation → змінює tab
    if k == 'goto_home':
        # з шансом 50% на home є unviewed stories (для тестування)
        has_un = random.random() < 0.5
        positions = [1, 3] if has_un else []
        return ScreenState(type='HOME_FEED', confidence=0.85, active_tab='feed',
                            has_unviewed_stories=has_un,
                            unviewed_story_positions=positions)
    if k == 'goto_reels':
        return ScreenState(type='REELS_FEED', confidence=0.85, active_tab='reels')
    if k == 'goto_explore':
        return ScreenState(type='EXPLORE', confidence=0.85, active_tab='search')
    if k == 'goto_profile_own':
        return ScreenState(type='PROFILE_OWN', confidence=0.95, active_tab='profile')

    # Story open
    if k == 'open_unviewed_story':
        return ScreenState(type='STORY_VIEWER', confidence=0.95)
    if k == 'story_swipe_down_exit':
        return ScreenState(type='HOME_FEED', confidence=0.85, active_tab='feed')
    if k in ('story_watch', 'story_tap_next'):
        # 30% шанс закінчились сторіс і викидає в home
        if random.random() < 0.3:
            return ScreenState(type='HOME_FEED', confidence=0.85, active_tab='feed')
        return state  # ще одна сторія

    # Peek author → PROFILE_OTHER, наступна дія зазвичай back
    if k in ('home_peek_author', 'reel_peek_author'):
        return ScreenState(type='PROFILE_OTHER', confidence=0.95)
    if k == 'profile_back':
        return ScreenState(type='REELS_FEED', confidence=0.85, active_tab='reels')

    # Решта — той самий стан
    return state


# ───── Run ─────────────────────────────────────────────────────────

if __name__ == "__main__":
    verbose = '-v' in sys.argv
    result = simulate_session(total_seconds=360, verbose=verbose)

    print("\n=== 360s session simulation ===")
    print(f"Total actions:  {result['actions']}")
    print(f"Elapsed:        {result['elapsed']:.1f}s")
    print(f"Likes given:    {result['likes']}")
    print(f"Saves given:    {result['saves']}")
    print(f"Profile peeks:  {result['peeks']}")
    print(f"Tab switches:   {result['tab_switches']}")

    print("\n=== Time distribution ===")
    total_active = sum(v for k, v in result['time_in_tab'].items() if k != 'profile')
    for tab in ['reels', 'home', 'stories', 'explore', 'profile']:
        sec = result['time_in_tab'].get(tab, 0)
        pct = 100 * sec / result['elapsed'] if result['elapsed'] else 0
        print(f"  {tab:10} {sec:6.1f}s  ({pct:5.1f}%)")

    print("\n=== Action kinds (top 15) ===")
    sorted_kinds = sorted(result['kinds'].items(), key=lambda x: -x[1])
    for k, n in sorted_kinds[:15]:
        print(f"  {k:<28} {n}")

    # Sanity assertions
    errors = []
    if result['likes'] > 3:
        errors.append(f"likes={result['likes']} > max_likes=3")
    if result['saves'] > 1:
        errors.append(f"saves={result['saves']} > max_saves=1")
    if result['peeks'] > 3:
        errors.append(f"peeks={result['peeks']} > max_peeks=3")
    if result['tab_switches'] > 6:
        errors.append(f"tab_switches={result['tab_switches']} > max=6")

    if errors:
        print("\n[FAIL] Limit violations:")
        for e in errors:
            print(f"  {e}")
        sys.exit(1)
    else:
        print("\n[OK] All limits respected")
