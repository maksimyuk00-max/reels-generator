"""
TIGFUSION engine — унікалізація відео для перезаливів.

Рецептура (перевірена на батчах the_daily_standard):
  - ghost-оверлей: копія кадру vflip + 1% прозорості поверх оригіналу
  - per-copy рандомний кроп-зсув (left/right/center) + мікроротація
  - pitch аудіо (басистіший голос, швидкість і синхрон не змінюються)
  - trim початку/кінця, fade-in
  - метадані під CapCut-експорт (Hw=1, te_is_reencode=1 і т.д.), сліди ffmpeg затерті
  - Smart Detector: перцептивні хеші (aHash, чистий stdlib) між копіями;
    занадто близькі перерендеруються з ескалацією трансформів
  - БЕЗ шуму/eq: вони ламають темні сцени (макроблоки + видимий ghost)
"""

import os
import re
import math
import random
import shutil
import subprocess
import datetime

# ─── ffmpeg пошук ────────────────────────────────────────────────────────────

_GYAN = "C:/Users/User/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-8.0.1-full_build/bin"


def find_binaries():
    """Повертає (ffmpeg, ffprobe) або кидає RuntimeError з поясненням."""
    ff, fp = None, None
    for base in (_GYAN, ""):
        if base:
            cand_f = os.path.join(base, "ffmpeg.exe")
            cand_p = os.path.join(base, "ffprobe.exe")
        else:
            cand_f = shutil.which("ffmpeg") or "ffmpeg"
            cand_p = shutil.which("ffprobe") or "ffprobe"
        if os.path.isfile(cand_f) or (base == "" and shutil.which("ffmpeg")):
            ff = cand_f
        if os.path.isfile(cand_p) or (base == "" and shutil.which("ffprobe")):
            fp = cand_p
        if ff and fp and (os.path.isfile(ff) and os.path.isfile(fp)):
            return ff, fp
    # останній шанс — що-небудь у PATH
    if shutil.which("ffmpeg") and shutil.which("ffprobe"):
        return shutil.which("ffmpeg"), shutil.which("ffprobe")
    raise RuntimeError(
        "ffmpeg не знайдено. Встанови: winget install Gyan.FFmpeg "
        "або поклади ffmpeg.exe/ffprobe.exe поруч з python/tigfusion.py"
    )


def _probe(fp, path, entries):
    out = subprocess.run(
        [fp, "-v", "error", "-select_streams", "v:0", "-show_entries",
         f"stream={entries}", "-of", "csv=p=0", path],
        capture_output=True, text=True
    ).stdout.strip()
    return out


def probe_video(fp, path):
    """(width, height, duration) джерела."""
    info = _probe(fp, path, "width,height,duration")
    parts = (info.split(",") + ["0", "0", "0"])[:3]
    try:
        w, h, dur = int(float(parts[0])), int(float(parts[1])), float(parts[2])
    except ValueError:
        w, h, dur = 720, 1280, 0.0
    # аудіо sample rate
    sr_out = subprocess.run(
        [fp, "-v", "error", "-select_streams", "a:0", "-show_entries",
         "stream=sample_rate", "-of", "csv=p=0", path],
        capture_output=True, text=True
    ).stdout.strip().splitlines()
    try:
        sr = int(sr_out[0])
    except (ValueError, IndexError):
        sr = 44100
    return w, h, dur, sr


# ─── плани копій ─────────────────────────────────────────────────────────────

def make_plan(rng, escalation=0):
    """Випадковий план однієї копії. escalation посилює трансформи для Smart Detector."""
    axes = ("left", "right", "center")
    zoom = rng.uniform(2.0, 4.0) + escalation * rng.uniform(1.5, 2.5)
    zoom = min(zoom, 9.0)
    plan = {
        "zoom_pct": round(zoom, 2),
        "axis": rng.choice(axes),
        "rot_deg": round(rng.uniform(0.3, 1.2 + escalation * 0.4) * rng.choice([-1, 1]), 2),
        "pitch_pct": round(rng.uniform(-2.5, -1.2) - escalation * 0.3, 2),
        "trim_start": round(rng.uniform(0.1, 0.25), 2),
        "trim_end": round(rng.uniform(0.1, 0.25), 2),
        "fade_in": rng.choice([0.0, 0.3, 0.4, 0.5]),
    }
    return plan


def _filter_chain(w, h, p):
    zoom = p["zoom_pct"]
    cw, ch = int(w * (1 - zoom / 100)), int(h * (1 - zoom / 100))
    cw -= cw % 2
    ch -= ch % 2
    axis = p["axis"]
    if axis == "left":
        x, y = 0, (h - ch) // 2
    elif axis == "right":
        x, y = w - cw, (h - ch) // 2
    else:
        x, y = (w - cw) // 2, (h - ch) // 2
    rad = math.radians(p["rot_deg"])
    # другий кроп ховає прозорі кути після ротації
    extra = max(0.02, abs(p["rot_deg"]) * 0.02)
    ew, eh = int(cw * (1 - extra / 100)), int(ch * (1 - extra / 100))
    ew -= ew % 2
    eh -= eh % 2
    ex, ey = (cw - ew) // 2, (ch - eh) // 2
    chain = (
        f"split=2[base][top];"
        f"[top]vflip,format=rgba,colorchannelmixer=aa=0.01[ghost];"
        f"[base][ghost]overlay=0:0,"
        f"crop={cw}:{ch}:{x}:{y},"
        f"rotate={rad:.6f}:c=black@0,"
        f"crop={ew}:{eh}:{ex}:{ey},"
        f"scale=1080:1920:flags=lanczos,"
        f"setsar=1,"
        f"settb=1/30,"
        f"setpts=PTS-STARTPTS"
    )
    if p["fade_in"] > 0:
        chain += f",fade=t=in:st=0:d={p['fade_in']}"
    chain += ",fps=30"
    return chain


def render_copy(ff, fp, src, dst, plan, creation_time):
    w, h, dur, sr = probe_video(fp, src)
    if dur <= 0.5:
        raise RuntimeError(f"Не вдалось прочитати тривалість: {src}")
    t_start = min(plan["trim_start"], dur * 0.2)
    t_end = max(dur - plan["trim_start"] - plan["trim_end"], dur * 0.5)
    pitch_ratio = 1 + plan["pitch_pct"] / 100.0
    atempo = 1.0 / pitch_ratio
    vf = _filter_chain(w, h, plan)
    af = f"asetrate={sr}*{pitch_ratio:.5f},aresample={sr},atempo={atempo:.5f}"
    cmd = [
        ff, "-y", "-nostdin", "-v", "error",
        "-ss", f"{t_start:.3f}", "-t", f"{t_end:.3f}",
        "-i", src,
        "-filter_complex", f"[0:v]{vf}[out];[0:a]{af}[aout]",
        "-map", "[out]", "-map", "[aout]",
        # GPU-енкодер: не пише x264-SEI (слід "x264 - core..." усередині H.264-потоку),
        # у 10+ разів швидший за libx264. Fallback на libx264 нижче при помилці.
        "-c:v", "h264_nvenc", "-b:v", "8000k", "-preset", "p4", "-tune", "ll",
        "-bf", "1",
        "-profile:v", "main",
        "-colorspace", "bt709", "-color_primaries", "bt709",
        "-color_trc", "bt709", "-color_range", "tv",
        "-pix_fmt", "yuv420p",
        "-video_track_timescale", "30",
        "-c:a", "aac", "-b:a", "192k", "-ar", str(sr), "-ac", "2",
        # БЕЗ -fflags +bitexact на рівні формату: інакше mov-muxer не пише тег encoder,
        # а файл без "encoder=Lavf61.1.100" виглядає підозріливо (CapCut завжди підписаний).
        # Слід стрімів гасимо -flags:v/a +bitexact, справжній Lavf-тег підмінюємо пост-обробкою.
        "-map_metadata", "-1", "-flags:v", "+bitexact", "-flags:a", "+bitexact",
        "-movflags", "+use_metadata_tags",  # БЕЗ faststart: CapCut пише mdat спереду (offset 48)
        "-metadata", f"creation_time={creation_time}",
        "-metadata", "Hw=1", "-metadata", "bitrate=8000000",
        "-metadata", "maxrate=0", "-metadata", "te_is_reencode=1",
        "-metadata:s:v:0", "encoder=", "-metadata:s:a:0", "encoder=",
        dst,
    ]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        # Fallback на CPU (якщо нема NVIDIA GPU) — зі слідом x264-SEI всередині потоку
        cmd[cmd.index("h264_nvenc")] = "libx264"
        cmd[cmd.index("-preset")] = "-preset"
        cmd[cmd.index("p5")] = "medium"
        r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"ffmpeg rc={r.returncode}: {r.stderr[-400:]}")
    # Пост-обробка: підмінюємо справжній підпис нашого muxer'а (Lavf62.x.x) на
    # фірмовий CapCut-овий (Lavf61.1.100). Рядки однакової довжини — байти in-place.
    try:
        data = open(dst, "rb").read()
        patched = re.sub(rb"Lavf\d+\.\d+\.\d+", b"Lavf61.1.100", data, count=1)
        if patched != data:
            open(dst, "wb").write(patched)
    except OSError:
        pass  # не критично: файл залишиться з чесним Lavf-тегом


# ─── Smart Detector (aHash, чистий stdlib) ──────────────────────────────────
# Порівнюються ТІЛЬКИ копії одного джерела (між собою і з оригіналом):
# унікалізація різних відео не потребує взаємних перевірок.

def _ahash(ff, path, t):
    out = subprocess.run(
        [ff, "-nostdin", "-v", "error", "-ss", str(t), "-i", path,
         "-frames:v", "1", "-vf", "scale=16:16,format=gray", "-f", "rawvideo", "-"],
        capture_output=True
    ).stdout
    if len(out) < 16:
        return 0
    mean = sum(out) / len(out)
    bits = 0
    for b in out:
        bits = (bits << 1) | (1 if b > mean else 0)
    return bits


def pair_distance(ff, a, b, frames=6):
    """Середня хеммінгова відстань aHash між двома відео (0=ідентичні, 256=макс)."""
    ha, hb = _video_hashes(ff, a), _video_hashes(ff, b)
    return _hash_distance(ha, hb)


def _video_hashes(ff, path, frames=6):
    """Хеші 6 кадрів відео (1 раз на файл, далі з кеша)."""
    times = [1.0, 3.3, 5.6, 7.9, 10.2, 12.5][:max(1, frames)]
    return [_ahash(ff, path, t) for t in times]


def _hash_distance(ha, hb):
    """Середня хеммінгова відстань між двома наборами хешів."""
    total = sum(bin(x ^ y).count("1") for x, y in zip(ha, hb))
    return total / max(1, len(ha))


def smart_check(ff, paths, threshold=8.0):
    """Повертає список пар (i, j, dist) занадто близьких копій."""
    close = []
    for i in range(len(paths)):
        for j in range(i + 1, len(paths)):
            d = pair_distance(ff, paths[i], paths[j])
            if d < threshold:
                close.append((i, j, d))
    return close


# ─── батч-обробка ────────────────────────────────────────────────────────────

def process_batch(files, output_dir, prefix="", start_num=1, copies=1,
                  progress_cb=None, threshold=8.0, cancel_check=None):
    """Головна функція: пачка відео → унікалізовані копії з нумерацією.

    files: список шляхів до mp4
    output_dir: куди зберігати
    prefix: префікс імені (наприклад 'hokan_')
    start_num: перший порядковий номер
    copies: скільки унікальних копій робити з кожного відео
    cancel_check: callable → True означає "зупинити батч" (кинується InterruptedError)
    Імена: {prefix}{номер, паддінг до кількості цифр останнього}.mp4
    """
    ff, fp = find_binaries()
    os.makedirs(output_dir, exist_ok=True)
    total_outputs = len(files) * max(1, copies)
    pad = max(1, len(str(start_num + total_outputs - 1)))
    rng = random.Random()
    results = []
    num = start_num
    created = []  # (шлях, номер) для звіту
    base_time = datetime.datetime.now()

    done_count = 0
    for idx, src in enumerate(sorted(files)):
        if cancel_check and cancel_check():
            raise InterruptedError("Зупинено користувачем")
        if not os.path.isfile(src):
            results.append({"src": src, "ok": False, "outputs": [], "error": "файл не знайдено"})
            done_count += max(1, copies)
            if progress_cb:
                progress_cb(done_count, total_outputs, os.path.basename(src))
            continue

        outs = []
        # Smart Detector діє ЛИШЕ всередині групи копій одного відео (+ оригінал):
        # різні відео один одному не загрожують — їх хеші ніколи не порівнюються.
        sib_hashes_for_src = [_video_hashes(ff, src)]  # хеш оригіналу цього відео
        for c in range(max(1, copies)):
            if cancel_check and cancel_check():
                raise InterruptedError("Зупинено користувачем")
            plan = make_plan(rng)
            name = f"{prefix}{num:0{pad}d}.mp4"
            dst = os.path.join(output_dir, name)
            ct = (base_time + datetime.timedelta(seconds=40 * len(created))).strftime(
                "%Y-%m-%dT%H:%M:%S.000000Z")
            attempts = 0
            while True:
                render_copy(ff, fp, src, dst, plan, ct)
                # Smart Detector: нова копія vs ІНШІ КОПІЇ ЦЬОГО Ж відео + ЙОГО ОРИГІНАЛ.
                # Хеші копій беремо з кеша (рахуються 1 раз), оригінал рахуємо 1 раз на відео.
                new_hashes = _video_hashes(ff, dst)
                close = []
                for prev_hashes in sib_hashes_for_src:
                    d = _hash_distance(new_hashes, prev_hashes)
                    if d < threshold:
                        close.append(d)
                if not close or attempts >= 2:
                    break
                attempts += 1
                plan = make_plan(rng, escalation=attempts)
            sib_hashes_for_src.append(new_hashes)  # копія приєдналась до групи свого відео
            created.append((dst, num))
            outs.append(name)
            num += 1
            done_count += 1
            if progress_cb:
                progress_cb(done_count, total_outputs, f"{os.path.basename(src)} → {name}")
        results.append({"src": src, "ok": True, "outputs": outs, "error": None})

    return results