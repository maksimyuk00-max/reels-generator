"""iOS Instagram automation via WebDriverAgent + go-ios.

Аналог `android_poster.py` для iPhone. Все робиться з Windows через USB:
  - go-ios.exe керує lifecycle WDA (install IPA, run XCTest, port forward)
  - Appium (через appium-python-client) шле tap/swipe/type команди
  - pymobiledevice3 завантажує медіа в Photos library (як adb push для Android)

Vstand:
  1. Mac (одноразово): build WebDriverAgent.ipa з Xcode, sign Apple Dev cert
  2. Windows: ios install WDA.ipa --udid=<UDID>
  3. Runtime: ios runxctest --bundle-id=com.facebook.WebDriverAgentRunner.xctrunner
     (запускає WDA HTTP server на iPhone, port 8100)
  4. Appium client підключається через USB tunnel (port forwarding 8100→8100)
  5. Python викликає driver.tap(), driver.find_element() etc.

API drop-in compatible з android_poster.py:
  - list_devices()
  - device_status(udid)
  - post_reel(video_path, caption, udid=...)
  - post_reel_v2(...)  — human-like
  - post_carousel(image_paths, caption, udid=...)
  - scroll_reels(udid, duration_seconds, ...)
"""
import os
import subprocess
import json
import time
from pathlib import Path

# ───────────────────────── Constants ─────────────────────────

IG_BUNDLE_ID = "com.burbn.instagram"
WDA_BUNDLE_ID = "com.facebook.WebDriverAgentRunner.xctrunner"
WDA_PORT = 8100  # WDA HTTP server port
APPIUM_PORT = 4723  # Appium server port

GO_IOS_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "..", "tools", "ios", "ios.exe"
)


# ───────────────────────── Helpers ─────────────────────────

def _find_go_ios() -> str:
    """Знаходить шлях до ios.exe (go-ios CLI)."""
    if os.path.isfile(GO_IOS_PATH):
        return GO_IOS_PATH
    # fallback: PATH
    import shutil
    found = shutil.which("ios") or shutil.which("ios.exe")
    return found or GO_IOS_PATH  # повертаємо очікуваний навіть якщо нема — щоб error message був зрозумілий


def _run_ios(*args: str, timeout: int = 15) -> dict:
    """Запускає go-ios команду. Повертає {ok, output, raw_stdout, raw_stderr}."""
    ios_bin = _find_go_ios()
    if not os.path.isfile(ios_bin):
        return {"ok": False, "error": f"go-ios not found at {ios_bin}. Run `tools/ios/install.bat` first."}
    cmd = [ios_bin] + list(args)
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, encoding="utf-8", errors="replace")
        return {
            "ok": r.returncode == 0,
            "output": (r.stdout or "").strip(),
            "raw_stdout": r.stdout or "",
            "raw_stderr": r.stderr or "",
            "rc": r.returncode,
        }
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": f"go-ios timeout after {timeout}s"}
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}


# ───────────────────────── Device Management ─────────────────────────

def list_devices() -> dict:
    """List all USB-connected iPhones via go-ios.

    Returns: {"ok": True, "devices": [udid1, udid2, ...]}
    """
    r = _run_ios("list", timeout=10)
    if not r["ok"]:
        return {"ok": False, "error": r.get("error") or r.get("raw_stderr") or "go-ios list failed"}
    # go-ios list повертає JSON: {"deviceList":["udid1","udid2"]}
    try:
        data = json.loads(r["output"])
        return {"ok": True, "devices": data.get("deviceList", [])}
    except Exception:
        # fallback: parse plain text
        lines = [l.strip() for l in r["output"].splitlines() if l.strip()]
        return {"ok": True, "devices": lines}


def scan_usb_devices() -> dict:
    """Scan USB iPhones, повертає інфо для кожного: {udid, model, ios_version, name}.

    Симетрично з android_poster.scan_usb_devices().
    """
    listing = list_devices()
    if not listing.get("ok"):
        return listing

    devices = []
    for udid in listing["devices"]:
        info = {"udid": udid, "serial": udid}  # serial = udid для уніфікації з Android API
        try:
            r = _run_ios("info", "--udid", udid, timeout=10)
            if r["ok"]:
                d = json.loads(r["output"]) if r["output"].startswith("{") else {}
                info["model"] = d.get("ProductType") or d.get("DeviceName")
                info["name"] = d.get("DeviceName")
                info["ios_version"] = d.get("ProductVersion")
        except Exception:
            pass
        devices.append(info)
    return {"ok": True, "devices": devices}


def device_status(udid: str | None = None) -> dict:
    """Перевіряє чи iPhone доступний і чи Instagram встановлений.

    Симетрично з android_poster.device_status().
    """
    if not udid:
        # auto-pick first device
        listing = list_devices()
        if not listing.get("ok") or not listing.get("devices"):
            return {"ok": False, "error": "No iPhone connected via USB"}
        udid = listing["devices"][0]

    # Get device info
    info_r = _run_ios("info", "--udid", udid, timeout=8)
    if not info_r["ok"]:
        return {"ok": False, "error": f"info fail: {info_r.get('raw_stderr') or info_r.get('error')}"}

    try:
        info = json.loads(info_r["output"]) if info_r["output"].startswith("{") else {}
    except Exception:
        info = {}

    # Check if Instagram installed
    apps_r = _run_ios("apps", "--udid", udid, timeout=15)
    ig_installed = False
    if apps_r["ok"]:
        ig_installed = IG_BUNDLE_ID in (apps_r.get("output") or "")

    # Check if WDA installed
    wda_installed = False
    if apps_r["ok"]:
        wda_installed = WDA_BUNDLE_ID in (apps_r.get("output") or "") or "WebDriverAgent" in (apps_r.get("output") or "")

    return {
        "ok": True,
        "device": {
            "udid": udid,
            "name": info.get("DeviceName"),
            "model": info.get("ProductType"),
            "ios_version": info.get("ProductVersion"),
            "battery_level": info.get("BatteryCurrentCapacity"),
        },
        "instagram_installed": ig_installed,
        "wda_installed": wda_installed,
    }


# ───────────────────────── WDA Lifecycle ─────────────────────────

def install_wda(ipa_path: str, udid: str) -> dict:
    """Installs WebDriverAgent.ipa на iPhone через go-ios.

    Передумова: IPA вже підписаний Apple Developer cert на Mac.
    """
    if not os.path.isfile(ipa_path):
        return {"ok": False, "error": f"IPA file not found: {ipa_path}"}

    r = _run_ios("install", "--path", ipa_path, "--udid", udid, timeout=120)
    if not r["ok"]:
        return {"ok": False, "error": r.get("raw_stderr") or r.get("error") or "install failed"}
    return {"ok": True, "message": f"WDA installed on {udid}"}


def launch_wda(udid: str) -> dict:
    """Запускає WebDriverAgent через XCTest на iPhone.

    WDA HTTP server слухає на порту 8100 на iPhone. go-ios робить port forward
    через USB: localhost:8100 (Windows) → 8100 (iPhone).

    Це блокуючий процес — тримаємо в окремому subprocess (не чекаємо на нього).
    Returns process handle або error.
    """
    # TODO: В runtime треба тримати handle процесу, щоб мати змогу killти.
    # Поки заглушка для скаффолдингу.
    return {"ok": False, "error": "launch_wda not implemented yet (потрібен підписаний WDA після Mac-сесії)"}


def wda_status(udid: str) -> dict:
    """Перевіряє чи WDA HTTP server відповідає на iPhone."""
    return {"ok": False, "error": "wda_status not implemented yet"}


# ───────────────────────── Media Upload ─────────────────────────

def push_video_to_photos(video_path: str, udid: str) -> dict:
    """Завантажує відео у Photos library iPhone.

    На Android — `adb push` у /sdcard/DCIM/. На iOS — через AFC2 сервіс
    (Apple File Conduit), доступний через pymobiledevice3.

    TODO: реалізувати після того як pymobiledevice3 встановиться.
    """
    return {"ok": False, "error": "push_video_to_photos not implemented yet"}


def push_image_to_photos(image_path: str, udid: str) -> dict:
    """Аналог для фото."""
    return {"ok": False, "error": "push_image_to_photos not implemented yet"}


# ───────────────────────── Posting (заглушки для майбутнього) ─────────────────────────

def post_reel(
    video_path: str,
    caption: str = "",
    udid: str | None = None,
    serial: str | None = None,  # alias для сумісності з Android API
    proxy: str | None = None,
    dry_run: bool = False,
    expected_username: str | None = None,
) -> dict:
    """Постить Instagram Reel на iPhone через WDA.

    Drop-in compatible з android_poster.post_reel(). Рівнозначна логіка:
      1. Push video → Photos library
      2. Open Instagram
      3. Tap (+) → Reel → select video → next → caption → share

    Поки заглушка. Реальна реалізація після Mac-сесії і встановлення WDA.
    """
    udid = udid or serial
    return {
        "ok": False,
        "error": "iOS post_reel not implemented yet — потрібно завершити Mac-сесію (build & install WDA)",
        "step": "wda_pending",
    }


def post_reel_v2(
    video_path: str,
    caption: str = "",
    udid: str | None = None,
    serial: str | None = None,
    proxy: str | None = None,
    post_id: int | None = None,
    db_path: str | None = None,
    expected_username: str | None = None,
    dry_run: bool = False,
) -> dict:
    """Human-like Reel posting для iOS. Drop-in compat з posting_v2.post_reel_v2()."""
    udid = udid or serial
    return {
        "ok": False,
        "error": "iOS post_reel_v2 not implemented yet — потрібно завершити Mac-сесію",
        "step": "wda_pending",
    }


def post_carousel(
    image_paths: list,
    caption: str = "",
    udid: str | None = None,
    serial: str | None = None,
    proxy: str | None = None,
    post_id: int | None = None,
    db_path: str | None = None,
    expected_username: str | None = None,
    dry_run: bool = False,
) -> dict:
    """Carousel post (1-10 фото) для iOS."""
    udid = udid or serial
    return {
        "ok": False,
        "error": "iOS post_carousel not implemented yet",
        "step": "wda_pending",
    }


def scroll_reels(
    udid: str | None = None,
    serial: str | None = None,
    duration_seconds: int = 120,
    like_probability: float = 0.15,
    proxy: str | None = None,
    use_ai: bool = False,
    claude_api_key: str = "",
    niche_description: str = "",
    niche_keywords: list = None,
    niche_avoid: list = None,
    niche_examples: list = None,
    session_id: int | None = None,
    db_path: str | None = None,
    engine: str = "manual",
) -> dict:
    """Warmup scroll Reels на iOS. Drop-in compat з android scroll_reels."""
    udid = udid or serial
    return {
        "ok": False,
        "error": "iOS scroll_reels not implemented yet",
        "step": "wda_pending",
    }


def warmup_v2(
    udid: str | None = None,
    serial: str | None = None,
    duration_seconds: int = 180,
    proxy: str | None = None,
    use_ai: bool = True,
    niche_description: str = "",
    niche_keywords: list = None,
    niche_avoid: list = None,
    niche_examples: list = None,
    session_id: int | None = None,
    db_path: str | None = None,
    engine: str = "v2",
) -> dict:
    """Warmup v2 (mixed-action) для iOS."""
    udid = udid or serial
    return {
        "ok": False,
        "error": "iOS warmup_v2 not implemented yet",
        "step": "wda_pending",
    }
