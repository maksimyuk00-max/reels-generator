"""
Instagram API client — direct HTTP requests only (no instagrapi for parsing).
Uses session_id cookie from browser for authentication.
instagrapi is only used for clip_upload (publishing).
"""
import sys
import os
import time
import json
import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# Session state
_session_id: str = ""
_user_id: str = ""
_username: str = ""


def _ig_headers(session_id: str = None) -> dict:
    sid = session_id or _session_id
    return {
        "User-Agent": "Instagram 275.0.0.27.98 Android (33/13; 420dpi; 1080x2400; samsung; SM-G991B; o1s; exynos2100)",
        "Cookie": f"sessionid={sid}",
        "X-IG-App-ID": "936619743392459",
        "X-Requested-With": "XMLHttpRequest",
    }


def _ig_web_headers(session_id: str = None) -> dict:
    """Headers for web GraphQL API."""
    sid = session_id or _session_id
    return {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Cookie": f"sessionid={sid}",
        "X-IG-App-ID": "936619743392459",
        "X-Requested-With": "XMLHttpRequest",
        "Accept": "*/*",
    }


# ===== SESSION =====

def is_logged_in() -> bool:
    return bool(_session_id)


def login_by_session(session_id: str) -> dict:
    """Validate session ID via direct API call — no instagrapi login."""
    global _session_id, _user_id, _username
    sid = session_id.strip()

    try:
        resp = requests.get(
            "https://i.instagram.com/api/v1/accounts/current_user/?edit=true",
            headers=_ig_headers(sid),
            timeout=15,
        )
        if resp.status_code == 200:
            data = resp.json()
            user = data.get("user", {})
            _session_id = sid
            _user_id = str(user.get("pk", ""))
            _username = user.get("username", "unknown")
            return {
                "ok": True,
                "username": _username,
                "full_name": user.get("full_name", ""),
            }
        else:
            return {"ok": False, "error": "Session ID недійсний або протермінований. Оновіть cookie в браузері."}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def check_session(session_id: str) -> dict:
    """Check if session ID is valid."""
    return login_by_session(session_id)


# ===== ACCOUNT INFO =====

def get_account_info(username: str) -> dict:
    """Get account info via direct API."""
    try:
        # Method 1: web_profile_info (most reliable)
        resp = requests.get(
            f"https://i.instagram.com/api/v1/users/web_profile_info/?username={username}",
            headers=_ig_web_headers(),
            timeout=15,
        )
        if resp.status_code == 200:
            data = resp.json()
            user = data.get("data", {}).get("user", {})
            if user:
                return {
                    "ok": True,
                    "username": user.get("username", username),
                    "full_name": user.get("full_name", ""),
                    "bio": user.get("biography", ""),
                    "followers": user.get("edge_followed_by", {}).get("count", 0),
                    "following": user.get("edge_follow", {}).get("count", 0),
                    "reels_count": user.get("edge_owner_to_timeline_media", {}).get("count", 0),
                    "avatar_url": user.get("profile_pic_url_hd", "") or user.get("profile_pic_url", ""),
                }
    except Exception:
        pass

    # Method 2: v1 API
    try:
        resp = requests.get(
            f"https://i.instagram.com/api/v1/users/web_profile_info/?username={username}",
            headers=_ig_headers(),
            timeout=15,
        )
        if resp.status_code == 200:
            data = resp.json()
            user = data.get("data", {}).get("user", {})
            if user:
                return {
                    "ok": True,
                    "username": user.get("username", username),
                    "full_name": user.get("full_name", ""),
                    "bio": user.get("biography", ""),
                    "followers": user.get("edge_followed_by", {}).get("count", 0),
                    "following": user.get("edge_follow", {}).get("count", 0),
                    "reels_count": user.get("edge_owner_to_timeline_media", {}).get("count", 0),
                    "avatar_url": user.get("profile_pic_url_hd", "") or user.get("profile_pic_url", ""),
                }
        if resp.status_code == 404:
            return {"ok": False, "error": f"Акаунт @{username} не знайдено"}
    except Exception:
        pass

    # Method 3: search API
    try:
        resp = requests.get(
            f"https://i.instagram.com/api/v1/users/search/?q={username}",
            headers=_ig_headers(),
            timeout=15,
        )
        if resp.status_code == 200:
            users = resp.json().get("users", [])
            for u in users:
                if u.get("username", "").lower() == username.lower():
                    return {
                        "ok": True,
                        "username": u.get("username", username),
                        "full_name": u.get("full_name", ""),
                        "bio": u.get("biography", ""),
                        "followers": u.get("follower_count", 0),
                        "following": u.get("following_count", 0),
                        "reels_count": u.get("media_count", 0),
                        "avatar_url": u.get("profile_pic_url", ""),
                    }
    except Exception:
        pass

    return {"ok": False, "error": f"Не вдалось отримати інфо про @{username}. Перевірте session ID."}


def _get_user_id(username: str) -> str:
    """Get user_id from username."""
    try:
        resp = requests.get(
            f"https://i.instagram.com/api/v1/users/web_profile_info/?username={username}",
            headers=_ig_web_headers(),
            timeout=15,
        )
        if resp.status_code == 200:
            data = resp.json()
            user = data.get("data", {}).get("user", {})
            return user.get("id", "")
    except Exception:
        pass

    # Fallback: search
    try:
        resp = requests.get(
            f"https://i.instagram.com/api/v1/users/search/?q={username}",
            headers=_ig_headers(),
            timeout=15,
        )
        if resp.status_code == 200:
            for u in resp.json().get("users", []):
                if u.get("username", "").lower() == username.lower():
                    return str(u.get("pk", ""))
    except Exception:
        pass

    return ""


# ===== REELS =====

def get_reels(username: str, amount: int = 50) -> dict:
    """Get user's reels via direct API — no instagrapi."""
    user_id = _get_user_id(username)
    if not user_id:
        return {"ok": False, "error": f"Не вдалось отримати user_id для @{username}"}

    errors = []

    # Method 1: clips endpoint (best for reels)
    try:
        reels = []
        max_id = None
        for page in range(10):  # max 10 pages
            params = {"target_user_id": user_id, "page_size": 12}
            if max_id:
                params["max_id"] = max_id

            resp = requests.post(
                "https://i.instagram.com/api/v1/clips/user/",
                headers=_ig_headers(),
                data=params,
                timeout=20,
            )
            if resp.status_code != 200:
                errors.append(f"clips: HTTP {resp.status_code}")
                break

            data = resp.json()
            items = data.get("items", [])
            for item in items:
                media = item.get("media", {})
                reels.append(_format_media(media))

            if len(reels) >= amount:
                break
            if not data.get("paging_info", {}).get("more_available", False):
                break
            max_id = data.get("paging_info", {}).get("max_id")
            time.sleep(0.5)

        if reels:
            return {"ok": True, "reels": reels[:amount], "method": "clips_api"}
    except Exception as e:
        errors.append(f"clips: {type(e).__name__}: {str(e)}")

    # Method 2: user feed (includes reels)
    try:
        resp = requests.get(
            f"https://i.instagram.com/api/v1/feed/user/{user_id}/?count={amount}",
            headers=_ig_headers(),
            timeout=20,
        )
        if resp.status_code == 200:
            data = resp.json()
            items = data.get("items", [])
            reels = []
            for item in items:
                if item.get("media_type") in (2, 8):  # video or carousel
                    reels.append(_format_media(item))
            if reels:
                return {"ok": True, "reels": reels[:amount], "method": "feed_api"}
    except Exception as e:
        errors.append(f"feed: {type(e).__name__}: {str(e)}")

    if errors:
        return {"ok": False, "error": "Всі методи завершились помилкою:\n" + "\n".join(errors)}
    return {"ok": False, "error": "Не вдалось отримати рілси"}


def _pk_to_code(pk) -> str:
    """Convert Instagram numeric pk to shortcode (same algorithm Instagram uses)."""
    try:
        pk = int(pk)
        alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
        code = ''
        while pk > 0:
            code = alphabet[pk % 64] + code
            pk //= 64
        return code
    except (ValueError, TypeError):
        return ""


def _format_media(media: dict) -> dict:
    """Format media dict from Instagram API response."""
    video_versions = media.get("video_versions", [])
    image_versions = media.get("image_versions2", {}).get("candidates", [])
    caption = media.get("caption")

    # Get shortcode for proper Instagram URL
    pk = str(media.get("pk", ""))
    code = media.get("code", "") or _pk_to_code(pk)

    return {
        "reel_id": pk,
        "code": code,
        "instagram_url": f"https://www.instagram.com/reel/{code}/" if code else "",
        "title": caption.get("text", "") if isinstance(caption, dict) else (caption or ""),
        "views": media.get("view_count", 0) or media.get("play_count", 0) or 0,
        "likes": media.get("like_count", 0) or 0,
        "comments": media.get("comment_count", 0) or 0,
        "duration": int(media.get("video_duration", 0) or 0),
        "published_at": _timestamp_to_iso(media.get("taken_at")),
        "video_url": video_versions[0]["url"] if video_versions else None,
        "thumbnail_url": image_versions[0]["url"] if image_versions else None,
    }


def _timestamp_to_iso(ts) -> str:
    if not ts:
        return None
    try:
        from datetime import datetime, timezone
        return datetime.fromtimestamp(int(ts), tz=timezone.utc).isoformat()
    except Exception:
        return None


# ===== VIEWS =====

def get_media_views(reel_id: str, session_id: str) -> dict:
    """Get view count for a specific media."""
    url = f"https://i.instagram.com/api/v1/media/{reel_id}/info/"
    try:
        resp = requests.get(url, headers=_ig_headers(session_id), timeout=15)
        if resp.status_code == 200:
            data = resp.json()
            items = data.get("items", [])
            if items:
                views = items[0].get("view_count", 0) or items[0].get("play_count", 0) or 0
                return {"views": views, "status": "ok"}
            return {"views": 0, "status": "ok"}
        elif resp.status_code == 429:
            return {"views": 0, "status": "rate_limited"}
        elif resp.status_code in (401, 403):
            return {"views": 0, "status": "auth_error"}
        else:
            return {"views": 0, "status": f"http_{resp.status_code}"}
    except requests.exceptions.Timeout:
        return {"views": 0, "status": "timeout"}
    except Exception as e:
        return {"views": 0, "status": f"error: {str(e)[:100]}"}


# ===== DOWNLOAD =====

def download_reel(video_url: str, save_path: str) -> dict:
    try:
        os.makedirs(os.path.dirname(save_path), exist_ok=True)
        resp = requests.get(video_url, stream=True, timeout=60)
        resp.raise_for_status()
        with open(save_path, "wb") as f:
            for chunk in resp.iter_content(chunk_size=8192):
                f.write(chunk)
        return {"ok": True, "path": save_path}
    except Exception as e:
        return {"ok": False, "error": str(e)}


# ===== PUBLISH (still uses instagrapi — only function that needs it) =====

_insta_client = None

def _get_insta_client():
    global _insta_client
    if _insta_client is None:
        from instagrapi import Client
        _insta_client = Client()
        _insta_client.delay_range = [1, 3]
    return _insta_client


def post_reel(video_path: str, caption: str = "") -> dict:
    """Publish reel via instagrapi clip_upload (requires login)."""
    from pathlib import Path
    cl = _get_insta_client()
    if not _session_id:
        return {"ok": False, "error": "Не авторизовано. Перевірте Session ID в Налаштуваннях."}

    # Login instagrapi only when publishing
    try:
        cl.login_by_sessionid(_session_id)
    except Exception:
        pass  # May fail but cookie might be set

    try:
        path_obj = Path(video_path)
        if not path_obj.exists():
            return {"ok": False, "error": f"Файл не знайдено: {video_path}"}
        media = cl.clip_upload(path=path_obj, caption=caption)
        code = getattr(media, 'code', None) or str(media.pk)
        return {
            "ok": True,
            "media_id": str(media.pk),
            "url": f"https://www.instagram.com/reel/{code}/",
        }
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {str(e)}"}
