"""Action executors — перекладають PlannedAction на реальні жести IG.

Кожен handler має сигнатуру:
    (d, planned: PlannedAction, state: ScreenState) -> ExecutionResult

Диспетчер execute() маршрутизує за kind у потрібний handler.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field

from ..policy import PlannedAction
from ..state_detector import ScreenState

# handlers імпортуються нижче (на кінці файлу), щоб уникнути циклічних імпортів


@dataclass
class ExecutionResult:
    """Уніфікований вихід action executor'а."""
    ok: bool
    elapsed: float = 0.0
    error: str = ''
    # side_effects: зміни які orchestrator має врахувати:
    #   'liked': bool          — пост/рілс лайкнуто у цій дії
    #   'saved': bool          — saved
    #   'reel_advanced': bool  — перегорнули reel
    #   'story_advanced': bool
    #   'post_seen': bool
    side_effects: dict = field(default_factory=dict)

    def __repr__(self) -> str:
        sfx = ', '.join(f"{k}={v}" for k, v in self.side_effects.items()) \
              if self.side_effects else ''
        sfx = f" [{sfx}]" if sfx else ''
        st = 'OK' if self.ok else f'FAIL({self.error[:40]})'
        return f"<Exec {st} {self.elapsed:.2f}s{sfx}>"


def execute(d, planned: PlannedAction, state: ScreenState) -> ExecutionResult:
    """Dispatch PlannedAction до відповідного handler."""
    handler = _HANDLERS.get(planned.kind)
    if handler is None:
        return ExecutionResult(ok=False, error=f"no handler for {planned.kind}")

    start = time.time()
    try:
        result = handler(d, planned, state)
        if not isinstance(result, ExecutionResult):
            # handler повернув щось не те
            result = ExecutionResult(ok=True, elapsed=time.time() - start,
                                      side_effects={'raw': result})
        # гарантуємо elapsed
        if result.elapsed == 0.0:
            result.elapsed = time.time() - start
        return result
    except Exception as e:
        return ExecutionResult(ok=False,
                                elapsed=time.time() - start,
                                error=f"{type(e).__name__}: {e}")


# ───── Handler registry (заповнюється імпортами нижче) ─────────────

_HANDLERS: dict[str, callable] = {}


def _register(kind: str):
    """Декоратор для реєстрації action handler."""
    def wrap(fn):
        _HANDLERS[kind] = fn
        return fn
    return wrap


# Імпортуємо модулі — вони викликають _register для своїх дій
from . import nav           # noqa: E402, F401
from . import recovery      # noqa: E402, F401
from . import story         # noqa: E402, F401
from . import explore       # noqa: E402, F401
from . import reels         # noqa: E402, F401
from . import home          # noqa: E402, F401
from . import profile       # noqa: E402, F401


def list_handlers() -> list[str]:
    return sorted(_HANDLERS.keys())
