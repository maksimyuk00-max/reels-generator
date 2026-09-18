"""
Dolphin Anty cookie warmler — нагулює кукі для профілів Dolphin.
Запускає кожен профіль, відкриває американські сайти, клікає по сторінці,
зберігає кукі через Dolphin API.

Використання: python dolphin_warmup.py
"""
import json
import time
import urllib.request
import urllib.error
import sys

DOLPHIN_TOKEN = "eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.eyJhdWQiOiIxIiwianRpIjoiYzE4YjhiODQ1OTg4MmY3OGIxNjQwNzY5M2QyYTAyZGE4MWViNTQxZjBiMTI4NjBkYWMwYTMxMjYxYjVjMDY4ZTYxNDJlMGJkNjJlNjA5MTYiLCJpYXQiOjE3ODY2MzU4NDkuMDQ3NjQzLCJuYmYiOjE3ODY2MzU4NDkuMDQ3NjQ2LCJleHAiOjE3ODkyMjc4NDkuMDM3OTUyLCJzdWIiOiI1MDAxODg0Iiwic2NvcGVzIjpbXSwidGVhbV9pZCI6NDkwMDQ2OSwidGVhbV9wbGFuIjoiZnJlZSIsInRlYW1fcGxhbl9leHBpcmF0aW9uIjoxNzczMjI4NDU0fQ.IEw4--VtCQTS5Z0bQvS6JVLO0E7dVGZVEv-9G0-piTss4cyWaXGpVX-KU1G_CWlHYyWejQRtsa0KYKujhAEtaw6gycN-yb57Y7yIIuJw76HqqK7iJ7qw5Le7wxUrrBy2SqGMyM4am4ShPYoxweaAniA0uFjKfJ4YGLzge-xrdLV7zPU3UY1YwOrr5iV4x-acaaJIi516IB31SQVFNHuv3EBBrZgJhN3M1WreFZKCHQQMoFsnIXWqWIOOMuDe5K9b2PcF228D2UugDYGc9cVMmgZaNY6cIj5rvbjHJhwBrFXMs55tz3P0KImyfnaxyYJPlkSs6YKTIn1SMeC-zrJpt5Az8_aSYc1FvWsTLGygPEiG3mA5QJZPjC1KiukmX_bLj1cbd-lfiqyrx8hyHGDUWBOymOTsTvCB4E4Xa-W61wFXuf-mRlAmWZ9IrZ2yD-aakGGYKYouvqsOLagDtortroPQsPJkFXtPKBxOQOi1DkfYYQxY6nbdqP92bALdEL0uSM1TP9OUJKmsTNmM0IAyX67bwWWMp4AOkbKysAUwzbgDgkmzoi_bR2Z-BLZxhisIetnn0RXCdNvLczx9Dele5dBxaY_K8umKOf_e60bqaRRCZ7Aj_8_z_1eeXfNQTQDbYBm26uzZY1zgksJdniuHEKdxqOmR8PSIOGAWIW1Y_5w"

# Американські сайти для нагуляння кукі (не Reddit)
WARMUP_SITES = [
    "https://www.yahoo.com",
    "https://www.google.com",
    "https://www.youtube.com",
    "https://www.amazon.com",
    "https://www.facebook.com",
    "https://www.wikipedia.org",
    "https://www.cnn.com",
    "https://www.nytimes.com",
    "https://www.espn.com",
    "https://www.weather.com",
    "https://www.buzzfeed.com",
    "https://www.reddit.com",  # SKIP — не заходити на Reddit
]

# Фільтруємо Reddit
WARMUP_SITES = [s for s in WARMUP_SITES if "reddit" not in s]

LOCAL_API = "http://localhost:3001/v1.0"
REMOTE_API = "https://dolphin-anty-api.com"


def api_get(url):
    """GET request to Dolphin API."""
    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {DOLPHIN_TOKEN}",
        "Content-Type": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        return json.loads(e.read().decode())
    except Exception as e:
        return {"error": str(e)}


def api_post(url, data=None):
    """POST request to Dolphin API."""
    body = json.dumps(data).encode() if data else b""
    req = urllib.request.Request(url, data=body, headers={
        "Authorization": f"Bearer {DOLPHIN_TOKEN}",
        "Content-Type": "application/json",
    }, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        return json.loads(e.read().decode())
    except Exception as e:
        return {"error": str(e)}


def get_profiles():
    """Отримати список профілів."""
    result = api_get(f"{REMOTE_API}/browser_profiles?limit=50&page=1")
    return result.get("data", [])


def start_profile(profile_id):
    """Запустити профіль (без automation — free plan)."""
    result = api_get(f"{LOCAL_API}/browser_profiles/{profile_id}/start")
    return result


def stop_profile(profile_id):
    """Зупинити профіль."""
    result = api_get(f"{LOCAL_API}/browser_profiles/{profile_id}/stop")
    return result


def update_profile_cookies(profile_id):
    """Зберегти кукі профілю через API."""
    result = api_post(f"{REMOTE_API}/browser_profiles/{profile_id}/cookies")
    return result


def main():
    print("=== Dolphin Anty Cookie Warmler ===")
    print(f"Sites: {len(WARMUP_SITES)} (Reddit excluded)")
    print()

    profiles = get_profiles()
    print(f"Found {len(profiles)} profiles")

    for p in profiles:
        pid = p["id"]
        name = p.get("name", "")
        print(f"\n--- Profile: {name} (id={pid}) ---")

        # Запустити профіль
        print(f"  Starting profile...")
        result = start_profile(pid)
        if not result.get("success"):
            if "already running" in str(result.get("error", "")):
                print(f"  Already running, continuing...")
            else:
                print(f"  Start failed: {result}")
                continue
        time.sleep(5)

        print(f"  Profile started. Visit these sites manually in the browser:")
        for i, site in enumerate(WARMUP_SITES):
            print(f"    [{i+1}/{len(WARMUP_SITES)}] {site}")

        print(f"\n  >>> Open each site in the Dolphin browser, scroll, click around <<<")
        print(f"  >>> Then press Enter to stop this profile and save cookies <<<")
        input()

        # Зупинити профіль (Dolphin автоматично зберігає кукі)
        print(f"  Stopping profile...")
        stop_profile(pid)
        time.sleep(3)
        print(f"  Done.")

    print("\n=== All profiles warmed up ===")


if __name__ == "__main__":
    main()