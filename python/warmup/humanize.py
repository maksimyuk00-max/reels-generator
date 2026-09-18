"""Natural human-like interactions for Instagram automation.

Містить:
  - human_sleep(low, high)            Гауссіан-подібна пауза (не uniform)
  - human_tap(d, x, y, jitter=5)      Тап із дрібним random offset
  - human_double_tap(d, x, y)         Подвійний тап з природнім інтервалом
  - human_swipe(d, direction, ...)    Свайп з human easing (не constant speed)
  - micro_actions_during_watch(d, duration)
                                      Випадкові дрібні жести під час перегляду
  - bezier_swipe(d, x1,y1, x2,y2)     Більш реалістичний свайп з кривою
  - jitter_coords(x, y, max_jitter)   Дрібна девіація координат
"""

from __future__ import annotations

import math
import random
import time


# ───── Timing ──────────────────────────────────────────────────────

def human_sleep(low: float, high: float) -> None:
    """Пауза з розподілом, близьким до правдоподібного людського.

    Uniform занадто рівний — реальні паузи групуються біля меншого краю
    з довгим хвостом. Використовуємо обрізану log-normal: швидше за uniform
    переважно, але іноді "залипаємо" довше.
    """
    # Mean біля ~40% від (high-low), з хвостом до high
    mid = low + (high - low) * 0.35
    sigma = (high - low) * 0.25
    val = random.gauss(mid, sigma)
    val = max(low, min(high, val))
    time.sleep(val)


def _pause(low: float, high: float) -> None:
    """Alias для зручності всередині модуля."""
    human_sleep(low, high)


def small_pause() -> None:
    """Коротка мікро-пауза між жестами (0.2-0.8s)."""
    human_sleep(0.2, 0.8)


def medium_pause() -> None:
    """Середня пауза (замислився — 1-3s)."""
    human_sleep(1.0, 3.0)


def long_pause() -> None:
    """Довга пауза (read caption — 2-6s)."""
    human_sleep(2.0, 6.0)


# ───── Coords ──────────────────────────────────────────────────────

def jitter_coords(x: int, y: int, max_jitter: int = 5) -> tuple[int, int]:
    """Дрібна рандомна девіація координат — щоб не тапати в піксель-perfect."""
    dx = random.randint(-max_jitter, max_jitter)
    dy = random.randint(-max_jitter, max_jitter)
    return x + dx, y + dy


# ───── Taps ────────────────────────────────────────────────────────

def human_tap(d, x: int, y: int, jitter: int = 5) -> None:
    """Одиночний тап у точку з дрібним offset."""
    x2, y2 = jitter_coords(x, y, jitter)
    d.click(x2, y2)


def human_double_tap(d, x: int, y: int, jitter: int = 4) -> None:
    """Подвійний тап — natural interval 80-160ms між тапами."""
    x1, y1 = jitter_coords(x, y, jitter)
    x2, y2 = jitter_coords(x, y, jitter)
    d.click(x1, y1)
    time.sleep(random.uniform(0.08, 0.16))
    d.click(x2, y2)


def human_long_press(d, x: int, y: int, duration: float = None) -> None:
    """Long press (context menu / save з long-press на рілс)."""
    dur = duration if duration is not None else random.uniform(0.6, 1.1)
    x2, y2 = jitter_coords(x, y, 3)
    d.long_click(x2, y2, dur)


# ───── Swipes ──────────────────────────────────────────────────────

def human_swipe(d, direction: str = 'up', strength: float = 0.7,
                  speed: str = 'normal') -> None:
    """Свайп з природніми параметрами.

    Args:
        direction: 'up' | 'down' | 'left' | 'right'
        strength: 0.3-1.0 — яку частину екрану охоплює свайп
        speed: 'slow' | 'normal' | 'fast'
    """
    info = d.info
    w = info.get('displayWidth', 1080)
    h = info.get('displayHeight', 1920)

    cx = w // 2
    cy = h // 2

    # Рандомна девіація стартової точки (щоб не посередині точно)
    start_dx = random.randint(-int(w * 0.08), int(w * 0.08))
    start_dy = random.randint(-int(h * 0.05), int(h * 0.05))

    # Дальність свайпу як частина екрану
    stroke = int(h * strength) if direction in ('up', 'down') \
             else int(w * strength)
    # +-15% рандомної девіації дальності
    stroke = int(stroke * random.uniform(0.85, 1.15))

    if direction == 'up':
        x1, y1 = cx + start_dx, int(h * 0.75) + start_dy
        x2, y2 = cx + random.randint(-int(w * 0.05), int(w * 0.05)), y1 - stroke
    elif direction == 'down':
        x1, y1 = cx + start_dx, int(h * 0.25) + start_dy
        x2, y2 = cx + random.randint(-int(w * 0.05), int(w * 0.05)), y1 + stroke
    elif direction == 'left':
        x1, y1 = int(w * 0.8) + start_dx, cy + start_dy
        x2, y2 = x1 - stroke, cy + random.randint(-int(h * 0.04), int(h * 0.04))
    elif direction == 'right':
        x1, y1 = int(w * 0.2) + start_dx, cy + start_dy
        x2, y2 = x1 + stroke, cy + random.randint(-int(h * 0.04), int(h * 0.04))
    else:
        raise ValueError(f"direction={direction}")

    speed_map = {'slow': (0.45, 0.75), 'normal': (0.18, 0.35), 'fast': (0.08, 0.16)}
    duration = random.uniform(*speed_map.get(speed, speed_map['normal']))

    # Обмежуємо в межах екрану
    x1 = max(10, min(w - 10, x1))
    y1 = max(10, min(h - 10, y1))
    x2 = max(10, min(w - 10, x2))
    y2 = max(10, min(h - 10, y2))

    d.swipe(x1, y1, x2, y2, duration=duration)


def bezier_swipe(d, x1: int, y1: int, x2: int, y2: int,
                 duration: float = None, curve: float = 0.15) -> None:
    """Свайп по квадратичній Bezier-кривій замість прямої лінії.

    Реальні свайпи людей ніколи не лінійні — рука робить дугу.
    uiautomator2 підтримує only straight swipes, але ми можемо емулювати
    кривизну через `d.swipe_points([...])`.

    Args:
        curve: кривизна 0.0-0.5 (0 = пряма, 0.3 = помітна дуга)
    """
    if duration is None:
        duration = random.uniform(0.2, 0.45)

    # Генеруємо 8-14 проміжних точок по квадратичній Bezier
    n_points = random.randint(8, 14)

    # Control point: перпендикуляр до AB, на відстані curve * |AB|
    mid_x = (x1 + x2) / 2
    mid_y = (y1 + y2) / 2
    dx = x2 - x1
    dy = y2 - y1
    length = math.hypot(dx, dy) or 1
    # нормаль
    nx = -dy / length
    ny = dx / length
    # зміщення випадково в один з боків
    side = random.choice([-1, 1])
    offset = length * curve * random.uniform(0.7, 1.0) * side
    ctrl_x = mid_x + nx * offset
    ctrl_y = mid_y + ny * offset

    points = []
    for i in range(n_points + 1):
        t = i / n_points
        # B(t) = (1-t)^2 P0 + 2(1-t)t P1 + t^2 P2
        bx = (1 - t) ** 2 * x1 + 2 * (1 - t) * t * ctrl_x + t ** 2 * x2
        by = (1 - t) ** 2 * y1 + 2 * (1 - t) * t * ctrl_y + t ** 2 * y2
        points.append((int(bx), int(by)))

    try:
        # uiautomator2 >= 2.x має swipe_points
        d.swipe_points(points, duration=duration)
    except AttributeError:
        # fallback: straight swipe
        d.swipe(x1, y1, x2, y2, duration=duration)


# ───── Micro-actions during reel/post watching ─────────────────────

def micro_actions_during_watch(d, total_duration: float,
                                  reel_mode: bool = True) -> None:
    """Симулювати те що люди роблять поки дивляться: мікро-паузи, re-scroll,
    tap щоб поставити на паузу, тощо.

    Блокує на total_duration секунд, але в цей час може робити дрібні жести.

    Args:
        total_duration: скільки секунд дивимось
        reel_mode: якщо True — дозволяє re-scroll (повернутись трохи назад).
                   Для фіду теж можна, але поведінка трохи інша.
    """
    info = d.info
    w = info.get('displayWidth', 1080)
    h = info.get('displayHeight', 1920)
    cx = w // 2

    elapsed = 0.0
    while elapsed < total_duration:
        chunk = random.uniform(1.5, 4.0)
        chunk = min(chunk, total_duration - elapsed)
        time.sleep(chunk)
        elapsed += chunk

        remaining = total_duration - elapsed
        if remaining < 0.5:
            break

        r = random.random()
        # Re-watch gesture (8%): swipe up чуть і повертаємось
        if reel_mode and r < 0.08 and remaining > 2:
            try:
                up_px = random.randint(80, 200)
                d.swipe(cx, h // 2, cx, h // 2 + up_px,
                        duration=random.uniform(0.22, 0.45))
                time.sleep(random.uniform(0.3, 0.9))
                d.swipe(cx, h // 2 + up_px, cx, h // 2 - 30,
                        duration=random.uniform(0.2, 0.4))
                time.sleep(random.uniform(0.2, 0.6))
            except Exception:
                pass
        # Pause tap (5%, тільки reels — тап = pause/play)
        elif reel_mode and r < 0.13 and remaining > 1.5:
            try:
                x, y = jitter_coords(cx, h // 2, 80)
                d.click(x, y)
                time.sleep(random.uniform(0.4, 1.2))
                d.click(x, y)  # знову play
            except Exception:
                pass
        # Рідкісний зум/два пальці (2%) — скіпаємо як складний жест
        # Основний час просто чекаємо


# ───── Utilities ───────────────────────────────────────────────────

def weighted_choice(choices: dict[str, float]) -> str:
    """Вибрати ключ з dict {option: weight} пропорційно вагам.

    Вага 0 = виключити. Сума ваг > 0.
    """
    items = [(k, v) for k, v in choices.items() if v > 0]
    total = sum(v for _, v in items)
    if total <= 0:
        raise ValueError("weighted_choice: all weights are 0")
    r = random.uniform(0, total)
    cumulative = 0.0
    for k, v in items:
        cumulative += v
        if r <= cumulative:
            return k
    return items[-1][0]
