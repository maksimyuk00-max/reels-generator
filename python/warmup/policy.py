"""Action policy — вибирає що робити наступним.

Чисто логіка, БЕЗ взаємодії з пристроєм. Бере на вхід:
  - ScreenState (де ми зараз)
  - SessionBudget (залишок часу, ліміти)
  - SessionMemory (історія дій сесії)

Повертає PlannedAction — описує що executor має зробити.

Executor (пишемо у Phase 2) викликає методи humanize.py для реального свайпу/тапу.

Тестується без телефону (див. _test_policy.py).
"""

from __future__ import annotations

import random
import time
from dataclasses import dataclass, field
from typing import Literal

from .state_detector import ScreenState


# ───── Action kinds ────────────────────────────────────────────────

ActionKind = Literal[
    # Global / recovery
    'wait',                # пауза (UNKNOWN, завантаження)
    'wake_and_unlock',     # SCREEN_LOCKED → розблокувати
    'open_instagram',      # INSTAGRAM_NOT_OPEN → app_start
    'close_modal',         # MODAL → натиснути Close
    'recover_back',        # невідоме → back spam
    'skip_ad',             # AD → scroll

    # Navigation (switch bottom tab)
    'goto_home',
    'goto_reels',
    'goto_explore',
    'goto_profile_own',

    # HOME_FEED
    'home_scroll_down',
    'home_scroll_up_slightly',      # re-read gesture
    'home_like_current',
    'home_save_current',
    'home_open_current_post',       # tap на пост → POST_DETAIL
    'home_peek_author',              # тап на автора → PROFILE_OTHER (peek)

    # STORY tray (з HOME_FEED)
    'open_unviewed_story',

    # STORY_VIEWER
    'story_watch',                   # просто дивимось (1-5с)
    'story_tap_next',                # тап справа → наступна
    'story_swipe_down_exit',         # свайп вниз → вихід (як user зазначив)

    # REELS_FEED
    'reel_watch',                    # пасивне дивлення
    'reel_scroll_next',
    'reel_scroll_prev',              # rare re-watch
    'reel_like',
    'reel_save',
    'reel_peek_author',

    # EXPLORE
    'explore_scroll',

    # PROFILE (OWN/OTHER — peek only)
    'profile_scroll',
    'profile_back',                  # повернутись

    # Completion
    'end_session',                   # час вичерпано
]


# ───── Budget & Memory ────────────────────────────────────────────

@dataclass
class SessionBudget:
    """Часові і кількісні ліміти сесії. Оновлюється executor'ом."""

    total_seconds: float = 360.0
    started_at: float = field(default_factory=time.time)

    # Планований розподіл часу (сума ≈ 1.0)
    target_ratio: dict[str, float] = field(default_factory=lambda: {
        'reels':    0.60,
        'home':     0.25,
        'stories':  0.10,
        'explore':  0.05,
    })

    # Factual час у кожному tab (секунди) — executor оновлює
    time_in_tab: dict[str, float] = field(default_factory=lambda: {
        'reels': 0.0, 'home': 0.0, 'stories': 0.0,
        'explore': 0.0, 'profile': 0.0,
    })

    # Ліміти (підраховані від очікуваної кількості reels/постів)
    max_likes: int = 3            # 5% від ~60 рілсів за 6 хв ≈ 3
    max_saves: int = 1
    max_profile_peeks: int = 3
    max_tab_switches: int = 6

    # Лічильники (executor інкрементує)
    likes_given: int = 0
    saves_given: int = 0
    profile_peeks: int = 0
    tab_switches: int = 0
    reels_watched: int = 0
    home_posts_seen: int = 0
    stories_watched: int = 0

    # ────────────────────────────────────────
    def elapsed(self) -> float:
        return time.time() - self.started_at

    def remaining(self) -> float:
        return max(0.0, self.total_seconds - self.elapsed())

    def is_done(self) -> bool:
        return self.elapsed() >= self.total_seconds

    def fraction_done(self) -> float:
        return min(1.0, self.elapsed() / self.total_seconds)

    def tab_overspent(self, tab: str, tolerance: float = 0.15) -> bool:
        """Чи витратили на tab більше ніж частка + tolerance від загального часу."""
        spent = self.time_in_tab.get(tab, 0) / max(self.elapsed(), 1)
        target = self.target_ratio.get(tab, 0)
        return spent > (target + tolerance)

    def tab_underspent(self, tab: str, tolerance: float = 0.10) -> bool:
        spent = self.time_in_tab.get(tab, 0) / max(self.elapsed(), 1)
        target = self.target_ratio.get(tab, 0)
        return spent < (target - tolerance)


@dataclass
class SessionMemory:
    """Короткострокова пам'ять: щоб не повторюватись і не заходити в loop."""

    recent_actions: list[ActionKind] = field(default_factory=list)      # last N
    consecutive_scrolls: int = 0                                        # без інших дій
    last_peek_profile_idx: int = -1                                     # скільки дій тому
    actions_since_tab_switch: int = 0
    current_tab_name: str = 'unknown'      # логічна назва таба
    last_like_at: float = 0.0
    last_save_at: float = 0.0
    watched_stories_users: set[str] = field(default_factory=set)
    unknown_streak: int = 0                # скільки UNKNOWN поспіль
    action_counter: int = 0

    # AI relevance integration (orchestrator виставляє)
    last_ai_decision: str | None = None    # 'like' | 'save' | 'skip' | None
    already_liked_this_reel: bool = False
    already_saved_this_reel: bool = False

    def record(self, action: ActionKind) -> None:
        self.action_counter += 1
        self.recent_actions.append(action)
        if len(self.recent_actions) > 30:
            self.recent_actions.pop(0)
        self.actions_since_tab_switch += 1

        if 'scroll' in action:
            self.consecutive_scrolls += 1
        else:
            self.consecutive_scrolls = 0

        if action.startswith('goto_') or action == 'open_instagram':
            self.actions_since_tab_switch = 0

    def reset_unknown(self) -> None:
        self.unknown_streak = 0


# ───── PlannedAction ──────────────────────────────────────────────

@dataclass
class PlannedAction:
    kind: ActionKind
    reason: str = ''                       # для логів
    params: dict = field(default_factory=dict)   # e.g. {'story_index': 2}

    def __repr__(self) -> str:
        p = f" {self.params}" if self.params else ""
        return f"<PlannedAction {self.kind}{p} — {self.reason}>"


# ───── Main policy ─────────────────────────────────────────────────

def next_action(state: ScreenState, budget: SessionBudget,
                memory: SessionMemory) -> PlannedAction:
    """Вирішує що робити наступним на основі поточного стану.

    Порядок: completion check → recovery → tab switch → per-state action.
    """

    # 0. Сесія завершена?
    if budget.is_done():
        return PlannedAction('end_session', reason='budget exhausted')

    # 1. Recovery states — пріоритет найвищий
    if state.type == 'SCREEN_LOCKED':
        return PlannedAction('wake_and_unlock', reason='screen off')

    if state.type == 'INSTAGRAM_NOT_OPEN':
        return PlannedAction('open_instagram', reason='IG not foreground')

    if state.type == 'LOGIN':
        return PlannedAction('wait',
                              reason='login screen — manual action needed')

    if state.type == 'MODAL':
        memory.reset_unknown()
        return PlannedAction('close_modal', reason='modal detected')

    if state.type == 'AD':
        memory.reset_unknown()
        return PlannedAction('skip_ad', reason='sponsored content')

    if state.type == 'UNKNOWN':
        memory.unknown_streak += 1
        if memory.unknown_streak >= 3:
            return PlannedAction('recover_back',
                                 reason=f'unknown streak={memory.unknown_streak}')
        return PlannedAction('wait',
                             reason=f'unknown #{memory.unknown_streak} — transient')

    memory.reset_unknown()

    # 2. Peek-повернення з профілю (чужого або POST_DETAIL/COMMENTS)
    if state.type == 'PROFILE_OTHER' and memory.actions_since_tab_switch > 1:
        # Дивимось ~2-4 сек, потім назад
        if _dice(0.7):
            return PlannedAction('profile_back',
                                 reason='peek_done, returning')
        return PlannedAction('profile_scroll',
                             reason='peek: scroll a bit')

    if state.type == 'POST_DETAIL':
        return PlannedAction('recover_back', reason='exiting post detail')

    if state.type == 'COMMENTS_SHEET':
        return PlannedAction('recover_back', reason='close comments')

    if state.type == 'DIRECT_INBOX':
        return PlannedAction('recover_back', reason='leave direct inbox')

    # 3. Switch tab? (overspent current, underspent another, or random)
    tab_decision = _maybe_switch_tab(state, budget, memory)
    if tab_decision is not None:
        return tab_decision

    # 4. Per-screen action
    if state.type == 'HOME_FEED':
        return _action_home(state, budget, memory)
    if state.type == 'REELS_FEED':
        return _action_reels(state, budget, memory)
    if state.type == 'STORY_VIEWER':
        return _action_story(state, budget, memory)
    if state.type == 'EXPLORE':
        return _action_explore(state, budget, memory)
    if state.type == 'PROFILE_OWN':
        return _action_profile_own(state, budget, memory)

    # Fallback
    return PlannedAction('wait', reason=f'no rule for {state.type}')


# ───── Tab switching ──────────────────────────────────────────────

def _maybe_switch_tab(state: ScreenState, budget: SessionBudget,
                       memory: SessionMemory) -> PlannedAction | None:
    """Вирішити чи пора змінити tab."""

    current = _tab_from_state(state)
    if current is None:
        return None   # не в основному табі — не пере-switch'имо

    # Ліміт перемикань
    if budget.tab_switches >= budget.max_tab_switches:
        return None

    # Не перемикаємось занадто часто (мінімум 5 дій у табі)
    if memory.actions_since_tab_switch < 5:
        return None

    # Hard switch: tab перевитрачено >15%
    if budget.tab_overspent(current):
        target = _pick_underspent_tab(budget, avoid=current, memory=memory)
        if target:
            return _goto_action(target,
                                 reason=f'{current} overspent, switch to {target}')

    # Soft switch: випадковий (шанс росте з кількістю дій в табі)
    actions_here = memory.actions_since_tab_switch
    switch_chance = min(0.20, 0.02 * (actions_here - 5))  # 0% перші 5, 20% після 15
    if _dice(switch_chance):
        target = _pick_underspent_tab(budget, avoid=current, memory=memory)
        if target:
            return _goto_action(target,
                                 reason=f'random switch from {current} to {target}')

    return None


def _tab_from_state(state: ScreenState) -> str | None:
    """Логічна назва tab для budget.time_in_tab."""
    if state.type == 'HOME_FEED': return 'home'
    if state.type == 'REELS_FEED': return 'reels'
    if state.type == 'STORY_VIEWER': return 'stories'
    if state.type == 'EXPLORE': return 'explore'
    if state.type in ('PROFILE_OWN', 'PROFILE_OTHER'): return 'profile'
    return None


def _pick_underspent_tab(budget: SessionBudget, avoid: str,
                          memory: SessionMemory) -> str | None:
    """Вибрати tab де ми "недобули", вагою за нестачу."""
    weights: dict[str, float] = {}
    for tab, target in budget.target_ratio.items():
        if tab == avoid:
            continue
        if tab == 'stories':
            # stories особливі — тільки якщо є unviewed
            # (цей check робиться executor'ом, тут just skip якщо не в home)
            continue
        spent = budget.time_in_tab.get(tab, 0) / max(budget.elapsed(), 1)
        gap = target - spent
        if gap > 0:
            weights[tab] = gap * 100.0
    if not weights:
        return None
    # weighted random
    tabs = list(weights.keys())
    ws = list(weights.values())
    total = sum(ws)
    r = random.uniform(0, total)
    cum = 0
    for t, w in zip(tabs, ws):
        cum += w
        if r <= cum:
            return t
    return tabs[-1]


def _goto_action(tab: str, reason: str) -> PlannedAction:
    m = {
        'home': 'goto_home',
        'reels': 'goto_reels',
        'explore': 'goto_explore',
        'profile': 'goto_profile_own',
    }
    return PlannedAction(m[tab], reason=reason)


# ───── Per-screen action selection ───────────────────────────────

def _action_home(state: ScreenState, budget: SessionBudget,
                  memory: SessionMemory) -> PlannedAction:
    """Дії на головній ленті."""

    # Якщо є unviewed stories — іноді заходимо (тільки якщо нашарувалось достатньо бюджету)
    if state.has_unviewed_stories and state.unviewed_story_positions:
        # Story tray проглядаємо переважно на початку сесії (більше природньо)
        # Базова ймовірність 0.20, падає після 50% сесії
        base_p = 0.20 if budget.fraction_done() < 0.5 else 0.08
        if _dice(base_p):
            # Беремо РАНДОМНУ позицію з unviewed (не завжди першу)
            idx = random.choice(state.unviewed_story_positions)
            return PlannedAction('open_unviewed_story',
                                 reason=f'unviewed story idx={idx}',
                                 params={'story_index': idx})

    # Якщо consecutive_scrolls > 3, 20% шанс лайкнути (не механічно)
    too_many_scrolls = memory.consecutive_scrolls >= 3

    weights = {
        'home_scroll_down':        60,
        'home_scroll_up_slightly':  3,
        'home_like_current':       _like_weight(budget, memory, base=6,
                                                  bumped=too_many_scrolls),
        'home_save_current':       _save_weight(budget, memory, base=2),
        'home_peek_author':        _peek_weight(budget, memory, base=4),
        'home_open_current_post':  3,
    }
    return PlannedAction(_weighted(weights), reason='home action')


def _action_reels(state: ScreenState, budget: SessionBudget,
                   memory: SessionMemory) -> PlannedAction:
    """Дії на Reels з урахуванням AI relevance decision."""

    # Після переключення на рілс — спочатку ВСЕ ж watch (не скролимо одразу)
    if memory.actions_since_tab_switch == 0:
        return PlannedAction('reel_watch', reason='first watch after switch')

    # AI декретував like — робимо негайно (ігноруємо ваги, якщо ліміт є)
    if memory.last_ai_decision == 'like' and not memory.already_liked_this_reel:
        if _like_weight(budget, memory, base=10) > 0:
            return PlannedAction('reel_like', reason='AI: relevant content')

    if memory.last_ai_decision == 'save' and not memory.already_saved_this_reel:
        if _save_weight(budget, memory, base=10) > 0:
            return PlannedAction('reel_save', reason='AI: high-value content')

    # AI сказав skip (або не викликаний) — НЕ пропонуємо like/save.
    # Переважно скролимо далі, часом watch/peek.
    ai_skipped = memory.last_ai_decision == 'skip'

    weights = {
        'reel_watch':       20,   # коротша пауза
        'reel_scroll_next': 65 if ai_skipped else 55,
        'reel_scroll_prev':  1,
        'reel_peek_author': _peek_weight(budget, memory, base=5),
        # like/save ТІЛЬКИ якщо AI не викликано взагалі (niche не сконфігурована)
        'reel_like':        0 if memory.last_ai_decision is not None
                                else _like_weight(budget, memory, base=4),
        'reel_save':        0 if memory.last_ai_decision is not None
                                else _save_weight(budget, memory, base=2),
    }
    return PlannedAction(_weighted(weights), reason='reel action')


def _action_story(state: ScreenState, budget: SessionBudget,
                   memory: SessionMemory) -> PlannedAction:
    """Дії у story viewer."""

    weights = {
        'story_watch':              30,   # дивитись 2-4с
        'story_tap_next':           55,   # швидше до наступної
        'story_swipe_down_exit':    15,   # вийти
    }
    return PlannedAction(_weighted(weights), reason='story action')


def _action_explore(state: ScreenState, budget: SessionBudget,
                     memory: SessionMemory) -> PlannedAction:
    """Explore — тільки скролимо (як ти просив)."""
    return PlannedAction('explore_scroll', reason='browse explore')


def _action_profile_own(state: ScreenState, budget: SessionBudget,
                          memory: SessionMemory) -> PlannedAction:
    """На своєму профілі — одразу йдемо назад."""
    # Own profile trip має бути коротким (не зависаємо)
    if memory.actions_since_tab_switch < 2:
        return PlannedAction('profile_scroll', reason='quick own profile check')
    return _goto_action(_pick_underspent_tab(budget, avoid='profile',
                                              memory=memory) or 'reels',
                         reason='leaving own profile')


# ───── Weight helpers ─────────────────────────────────────────────

def _like_weight(budget: SessionBudget, memory: SessionMemory,
                  base: float, bumped: bool = False) -> float:
    """Вага дії лайку, з урахуванням лімітів і часу з останнього лайку."""
    if budget.likes_given >= budget.max_likes:
        return 0.0
    # Після лайку — не лайкаємо наступні 8+ дій (природно)
    since_last = time.time() - memory.last_like_at if memory.last_like_at else 999
    if since_last < 15:
        return 0.0
    w = base * (2.0 if bumped else 1.0)
    # Ближче до кінця сесії — менше нових дій
    w *= (1.0 - 0.5 * budget.fraction_done())
    return max(0.0, w)


def _save_weight(budget: SessionBudget, memory: SessionMemory,
                  base: float) -> float:
    if budget.saves_given >= budget.max_saves:
        return 0.0
    since_last = time.time() - memory.last_save_at if memory.last_save_at else 999
    if since_last < 30:
        return 0.0
    return base * (1.0 - 0.3 * budget.fraction_done())


def _peek_weight(budget: SessionBudget, memory: SessionMemory,
                  base: float) -> float:
    if budget.profile_peeks >= budget.max_profile_peeks:
        return 0.0
    # не peek'аємо підряд
    if 'peek' in (memory.recent_actions[-2:] if len(memory.recent_actions) >= 2
                   else []):
        return 0.0
    return base


# ───── Primitives ──────────────────────────────────────────────────

def _dice(p: float) -> bool:
    return random.random() < p


def _weighted(weights: dict[str, float]) -> str:
    items = [(k, w) for k, w in weights.items() if w > 0]
    if not items:
        return 'wait'
    total = sum(w for _, w in items)
    r = random.uniform(0, total)
    cum = 0
    for k, w in items:
        cum += w
        if r <= cum:
            return k
    return items[-1][0]
