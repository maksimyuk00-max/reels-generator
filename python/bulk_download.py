import os
import re
import shutil
import subprocess
import sys
import tempfile
import time


def _sanitize(code: str) -> str:
    """Безпечне ім'я файлу: тільки [A-Za-z0-9_-], без пробілів (media scanner)."""
    code = re.sub(r'[^A-Za-z0-9_-]', '_', code or 'reel')
    return code[:60]


def _find_yt_dlp() -> str | None:
    """yt-dlp: вбудований модуль того самого python, або окремий exe у PATH."""
    try:
        import yt_dlp  # noqa: F401
        return sys.executable  # запуск: python -m yt_dlp
    except ImportError:
        return shutil.which('yt-dlp')


def download_anonymous(reel_code: str, save_dir: str) -> dict:
    """Скачує один рілс АНОНІМНО через yt-dlp (--impersonate chrome).

    Без sessionid, без кукі, не залогінений — перевірений шлях
    (references: instagram-scraping/ban-safe). Session ID потрібен лише
    для ПАРСИНГУ списку кодів, не для скачування файлів.
    """
    code = _sanitize(reel_code)
    url = f'https://www.instagram.com/reel/{reel_code}/'
    os.makedirs(save_dir, exist_ok=True)
    out_tpl = os.path.join(save_dir, f'{code}_%(id)s.%(ext)s')

    ytdlp = _find_yt_dlp()
    if not ytdlp:
        return {'ok': False, 'error': 'yt-dlp не знайдено (ні модуль, ні exe)'}

    # ВАЖЛИВО: python.exe теж закінчується на .exe — розрізняємо по basename:
    # окремий бінарник називається yt-dlp.exe, інтерпретатор — python.exe
    base = os.path.basename(ytdlp).lower()
    if base.startswith('yt-dlp'):
        cmd = [ytdlp]
    else:
        # Це python-інтерпретатор з імпортованим модулем → запуск як python -m yt_dlp
        cmd = [ytdlp, '-m', 'yt_dlp']

    try:
        r = subprocess.run(
            cmd + ['--impersonate', 'chrome', '--no-playlist',
                   '--no-warnings', '-o', out_tpl, url],
            capture_output=True, text=True, timeout=300, encoding='utf-8', errors='replace',
        )
        # Знайти скачаний файл (найсвіжіший mp4 у папці з нашим префіксом)
        files = [f for f in os.listdir(save_dir) if f.startswith(code) and f.endswith('.mp4')]
        if r.returncode == 0 and files:
            path = os.path.join(save_dir, max(files, key=lambda f: os.path.getmtime(os.path.join(save_dir, f))))
            size = os.path.getsize(path)
            if size < 100 * 1024:
                return {'ok': False, 'error': f'файл підозріло малий ({size // 1024}KB) — можливо обрізок'}
            return {'ok': True, 'path': path, 'size': size, 'method': 'yt_dlp_anonymous'}
        return {'ok': False, 'error': (r.stderr or r.stdout or 'unknown')[-300:]}
    except subprocess.TimeoutExpired:
        return {'ok': False, 'error': 'yt-dlp timeout (300s)'}
    except Exception as e:
        return {'ok': False, 'error': f'{type(e).__name__}: {str(e)[:200]}'}


def download_reel_anonymous(reel_code: str, save_dir: str) -> dict:
    """Публічний API-метод: анонімне скачування одного рілса за кодом/URL."""
    # Приймаємо і повний URL, і голий код
    if '/' in reel_code:
        m = re.search(r'/reel/([A-Za-z0-9_-]+)', reel_code)
        if not m:
            return {'ok': False, 'error': 'Не вдалось витягти код рілса з URL'}
        reel_code = m.group(1)
    return download_anonymous(reel_code, save_dir)


if __name__ == '__main__':
    # CLI-тест: python bulk_download.py <code> <dir>
    code = sys.argv[1] if len(sys.argv) > 1 else 'DVhcNcXjaCe'
    sdir = sys.argv[2] if len(sys.argv) > 2 else os.path.join(tempfile.gettempdir(), 'anon_reel_test')
    print(json := download_reel_anonymous(code, sdir))