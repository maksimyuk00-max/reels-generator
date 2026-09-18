"""Instagram screen state detector.

Визначає де саме зараз у додатку, через один `dump_hierarchy()` виклик
і parsing XML на всі маркери разом — набагато швидше ніж 10 окремих
`d(resourceId=...).exists` перевірок (кожен з яких робить новий dump).

API:
    state = detect_screen(d)
    if state.type == 'HOME_FEED' and state.has_unviewed_stories:
        ...
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Literal
from xml.etree import ElementTree as ET

IG_PKG = "com.instagram.android"

ScreenType = Literal[
    'HOME_FEED',          # головна лента (feed tab активний)
    'REELS_FEED',         # Reels tab активний, переглядаємо відео
    'STORY_VIEWER',       # fullscreen story (не тап-бар)
    'EXPLORE',            # Search/Explore tab
    'PROFILE_OWN',        # свій профіль
    'PROFILE_OTHER',      # чужий профіль (кнопка Follow)
    'POST_DETAIL',        # окремий пост відкритий
    'COMMENTS_SHEET',     # bottom sheet з коментарями
    'DIRECT_INBOX',       # DMs
    'MODAL',              # невідомий overlay (update prompt, permission, etc.)
    'AD',                 # реклама в фіді (sponsored)
    'LOGIN',              # екран логіну
    'INSTAGRAM_NOT_OPEN', # IG не foreground
    'SCREEN_LOCKED',      # екран заблокований (user натиснув power button)
    'UNKNOWN',            # нічого не збіглося → AI fallback
]


@dataclass
class ScreenState:
    type: ScreenType
    confidence: float = 0.0                    # 0.0-1.0
    active_tab: str | None = None              # 'feed' | 'search' | 'reels' | 'shop' | 'profile' | None
    has_unviewed_stories: bool = False
    unviewed_story_positions: list[int] = field(default_factory=list)
    total_stories_in_tray: int = 0
    can_like: bool = False                     # є кнопка лайку на видимому пості/рілсі
    can_save: bool = False
    current_liked: bool = False                # вже лайкнуто (selected state)
    current_saved: bool = False
    modal_close_hint: tuple[int, int] | None = None   # координати кнопки Close якщо MODAL
    method: str = 'resourceId'                 # 'resourceId' | 'ai' | 'heuristic'
    markers_found: list[str] = field(default_factory=list)
    raw: dict = field(default_factory=dict)    # додаткова діагностика

    def __repr__(self) -> str:
        bits = [f"type={self.type}", f"conf={self.confidence:.2f}"]
        if self.active_tab: bits.append(f"tab={self.active_tab}")
        if self.has_unviewed_stories:
            bits.append(f"unviewed={len(self.unviewed_story_positions)}/{self.total_stories_in_tray}")
        if self.current_liked: bits.append("liked")
        if self.current_saved: bits.append("saved")
        return f"<ScreenState {' '.join(bits)} via {self.method}>"


# ───── Маркери (resourceId suffixes після IG_PKG:id/) ────────────
# Тільки суфікс після "com.instagram.android:id/" — щоб порівнювати короткими рядками.
M = {
    # Bottom tabs
    'feed_tab':     'feed_tab',
    'search_tab':   'search_tab',
    'clips_tab':    'clips_tab',      # Reels tab
    'shop_tab':     'shop_tab',
    'profile_tab':  'profile_tab',

    # Home feed
    'row_feed_like':      'row_feed_button_like',
    'row_feed_save':      'row_feed_button_save',
    'reel_tray':          'reels_tray_container',     # story tray (актуальний id)
    'reel_tray_legacy':   'reel_tray_recycler_view',  # старший варіант (fallback)

    # Reels (clips)
    'clips_pager':        'clips_viewer_pager',
    'clips_like':         'like_button',  # в reel overlay
    'clips_save':         'save_button',

    # Story viewer
    'story_header':       'reel_header_view',
    'story_progress':     'reel_viewer_progress_bar',
    'story_image':        'reel_viewer_image_view',

    # Explore
    'search_edit':        'action_bar_search_edit_text',

    # Profile
    'user_detail_fragment': 'user_detail_fragment',    # свій профіль (tab-based)
    'profile_header_container': 'profile_header_container',
    'profile_tabs_container': 'profile_tabs_container',
    # Follow button — точний маркер PROFILE_OTHER (немає у OWN дампі)
    'profile_header_follow_button': 'profile_header_follow_button',
    'profile_header_user_action_follow_button': 'profile_header_user_action_follow_button',
    # Кнопки OWN впізнаємо через текст 'Edit profile' (resourceId відсутній)

    # Post detail / comments
    'comments_count':     'row_feed_comment_count',
    'comments_sheet':     'comments_bottom_sheet',

    # DMs
    'direct_inbox':       'thread_list_recycler_view',

    # Login
    'login_username':     'login_username',
    'login_password':     'password',

    # Ads
    'sponsored_label':    'sponsored_label',
}


_TAB_TO_SCREEN: dict[str, ScreenType] = {
    'feed':    'HOME_FEED',
    'search':  'EXPLORE',
    'reels':   'REELS_FEED',
    'shop':    'HOME_FEED',   # трактуємо як схожий на фід (рідко треба туди лізти)
    'profile': 'PROFILE_OWN', # уточнимо через text-based: 'Edit profile' vs 'Follow'
}

# Тексти кнопки Edit на своєму профілі (en/uk/ru/de/es — best-effort)
_EDIT_PROFILE_TEXTS = re.compile(
    r"(?i)^(edit profile|редагувати профіль|редактировать профиль|"
    r"profil bearbeiten|editar perfil)$"
)
# Тексти кнопки Follow/Following на чужому профілі
_FOLLOW_BUTTON_TEXTS = re.compile(
    r"(?i)^(follow|following|requested|"
    r"підписатися|стежити|підписано|"
    r"подписаться|подписан|запрошено)$"
)
# "Message" — присутня ТІЛЬКИ на чужому профілі (direct msg button)
_MESSAGE_BUTTON_TEXTS = re.compile(
    r"(?i)^(message|повідомлення|сообщение)$"
)


def detect_screen(d, *, include_stories: bool = True) -> ScreenState:
    """Швидкий детектор поточного стану IG. Один dump_hierarchy на все.

    Args:
        d: uiautomator2 Device
        include_stories: чи сканувати story tray на unviewed (доп. час ~100мс)

    Returns:
        ScreenState (type='UNKNOWN' якщо confidence низька — тоді варто AI fallback)
    """
    # 0. Екран увімкнений? (перевірка ДО app_current — заблокований пристрій
    # може повертати stale app info)
    try:
        info = d.info or {}
        if info.get('screenOn') is False:
            return ScreenState(type='SCREEN_LOCKED', confidence=1.0,
                               method='heuristic', raw={'screenOn': False})
    except Exception:
        pass

    # 1. IG взагалі foreground?
    try:
        app = d.app_current()
        if app.get('package') != IG_PKG:
            return ScreenState(type='INSTAGRAM_NOT_OPEN', confidence=1.0,
                               method='heuristic', raw={'app': app})
    except Exception as e:
        return ScreenState(type='UNKNOWN', confidence=0.0,
                           method='heuristic', raw={'app_error': str(e)})

    # 2. Один dump — парсимо resourceId з усього дерева
    try:
        xml = d.dump_hierarchy()
    except Exception as e:
        return ScreenState(type='UNKNOWN', confidence=0.0,
                           method='heuristic', raw={'dump_error': str(e)})

    found_rids = _extract_resource_ids(xml, IG_PKG)
    texts = _extract_texts(xml)
    content_descs = _extract_content_descs(xml)

    state = ScreenState(type='UNKNOWN', method='resourceId', raw={
        'rids_count': len(found_rids),
    })

    # 3. Login/модалки перевіряємо ДО tab-based detection
    if M['login_username'] in found_rids or M['login_password'] in found_rids:
        state.type = 'LOGIN'
        state.confidence = 1.0
        state.markers_found = ['login']
        return state

    # 4. Active tab detection
    state.active_tab = _detect_active_tab(xml, found_rids)

    # 5. Унікальні екрани (story/post detail/comments) мають пріоритет над tab
    if M['story_header'] in found_rids or M['story_progress'] in found_rids \
            or M['story_image'] in found_rids:
        state.type = 'STORY_VIEWER'
        state.confidence = 0.95
        state.markers_found = ['story']
        return state

    if M['comments_sheet'] in found_rids:
        state.type = 'COMMENTS_SHEET'
        state.confidence = 0.9
        state.markers_found = ['comments_sheet']
        return state

    if M['direct_inbox'] in found_rids:
        state.type = 'DIRECT_INBOX'
        state.confidence = 0.9
        state.markers_found = ['direct_inbox']
        return state

    # 5b. PROFILE detection — має пріоритет над tabs, бо чужий профіль
    # відкривається через ModalActivity без bottom tabs.
    has_follow_btn = (M['profile_header_follow_button'] in found_rids
                      or M['profile_header_user_action_follow_button'] in found_rids)
    has_profile_header = M['profile_header_container'] in found_rids

    if has_follow_btn:
        # точний маркер чужого профілю
        state.type = 'PROFILE_OTHER'
        state.confidence = 0.95
        state.markers_found = ['profile_header_follow_button']
        return state

    if has_profile_header and M['user_detail_fragment'] in found_rids:
        # свій профіль (Modal без tabs теж можливий — безпечно детектимо тут)
        has_edit = _has_any_match(texts, _EDIT_PROFILE_TEXTS) \
                   or _has_any_match(content_descs, _EDIT_PROFILE_TEXTS)
        if has_edit:
            state.type = 'PROFILE_OWN'
            state.confidence = 0.95
            state.markers_found = ['user_detail_fragment', 'text:Edit profile']
            return state

    # 6. Tab-based mapping
    if state.active_tab:
        state.type = _TAB_TO_SCREEN.get(state.active_tab, 'UNKNOWN')
        state.confidence = 0.85
        state.markers_found.append(f'tab:{state.active_tab}')

        # Уточнення профілю: OWN vs OTHER через text (resourceId не стабільні)
        if state.type == 'PROFILE_OWN':
            # Якщо маркери профілю взагалі є — підвищуємо конфіденс
            profile_marker = (M['user_detail_fragment'] in found_rids
                              or M['profile_header_container'] in found_rids)
            has_edit = _has_any_match(texts, _EDIT_PROFILE_TEXTS) \
                       or _has_any_match(content_descs, _EDIT_PROFILE_TEXTS)
            has_follow = _has_any_match(texts, _FOLLOW_BUTTON_TEXTS)
            has_message = _has_any_match(texts, _MESSAGE_BUTTON_TEXTS) \
                          or _has_any_match(content_descs, _MESSAGE_BUTTON_TEXTS)

            # Edit profile = точний маркер OWN (suggested accounts внизу теж мають
            # текст "Follow", тому не використовуємо його для виключення OWN).
            if has_edit:
                state.type = 'PROFILE_OWN'
                state.confidence = 0.95
                state.markers_found.append('text:Edit profile')
            elif has_follow and has_message:
                # чужий профіль: кнопки Follow + Message одночасно у header
                state.type = 'PROFILE_OTHER'
                state.confidence = 0.95
                state.markers_found.append('text:Follow+Message')
            elif profile_marker:
                # маркер profile є, але не впевнено own/other — середній conf
                state.confidence = 0.70

        # AD detection: якщо у фіді є sponsored label
        if state.type == 'HOME_FEED' or state.type == 'REELS_FEED':
            if M['sponsored_label'] in found_rids \
                    or any(t.lower() in ('sponsored', 'promoted') for t in texts):
                state.type = 'AD'
                state.markers_found.append('sponsored')
                state.confidence = 0.95

        # Лайк/save доступні?
        if state.type == 'HOME_FEED':
            state.can_like = M['row_feed_like'] in found_rids
            state.can_save = M['row_feed_save'] in found_rids
            state.current_liked = _is_liked(xml, 'row_feed_button_like')
            state.current_saved = _is_selected(xml, 'row_feed_button_save')
        elif state.type == 'REELS_FEED':
            state.can_like = M['clips_like'] in found_rids or 'like_button' in found_rids
            state.can_save = M['clips_save'] in found_rids or 'save_button' in found_rids
            state.current_liked = _is_liked(xml, 'like_button')
            state.current_saved = _is_selected(xml, 'save_button')

        # Story tray scan (тільки у HOME_FEED)
        if include_stories and state.type == 'HOME_FEED':
            tray = _scan_story_tray(xml)
            state.total_stories_in_tray = tray['total']
            state.unviewed_story_positions = tray['unviewed']
            state.has_unviewed_stories = len(tray['unviewed']) > 0

        return state

    # 7. Нічого не збіглося — можливо MODAL або щось нове
    # Шукаємо ознаки modal: текст "Close"/"Dismiss"/"×", невелика кількість елементів
    has_close_hint = any(re.fullmatch(r'(?i)close|dismiss|not now|×|✕|cancel', t)
                         for t in texts)
    has_close_desc = any(re.search(r'(?i)close|dismiss', desc) for desc in content_descs)
    if has_close_hint or has_close_desc:
        state.type = 'MODAL'
        state.confidence = 0.5
        state.markers_found = ['close_text']
        return state

    # 8. Справжній UNKNOWN — кандидат на AI fallback
    state.type = 'UNKNOWN'
    state.confidence = 0.0
    return state


# ───── XML parsing helpers ────────────────────────────────────────

_RID_RE = re.compile(r'resource-id="([^"]+)"')
_TEXT_RE = re.compile(r'text="([^"]+)"')
_DESC_RE = re.compile(r'content-desc="([^"]+)"')


def _extract_resource_ids(xml: str, pkg: str) -> set[str]:
    """Повертає set суфіксів resourceId після `com.instagram.android:id/`."""
    prefix = f"{pkg}:id/"
    out: set[str] = set()
    for m in _RID_RE.finditer(xml):
        rid = m.group(1)
        if rid.startswith(prefix):
            out.add(rid[len(prefix):])
    return out


def _extract_texts(xml: str) -> list[str]:
    return [m.group(1) for m in _TEXT_RE.finditer(xml) if m.group(1)]


def _extract_content_descs(xml: str) -> list[str]:
    return [m.group(1) for m in _DESC_RE.finditer(xml) if m.group(1)]


def _has_any_match(values: list[str], pattern: re.Pattern) -> bool:
    """True якщо хоча б одне значення у списку матчиться pattern."""
    return any(pattern.search(v) for v in values if v)


def _detect_active_tab(xml: str, found_rids: set[str]) -> str | None:
    """Визначити який bottom tab активний через selected="true" біля tab resourceId.

    uiautomator XML для активної вкладки зазвичай має selected="true" на node з
    resource-id="<pkg>:id/<tab_name>".
    """
    try:
        root = ET.fromstring(xml)
    except ET.ParseError:
        return None

    tab_map = {
        M['feed_tab']: 'feed',
        M['search_tab']: 'search',
        M['clips_tab']: 'reels',
        M['shop_tab']: 'shop',
        M['profile_tab']: 'profile',
    }

    prefix = f"{IG_PKG}:id/"
    # Шукаємо selected=true tab
    for node in root.iter():
        rid = node.attrib.get('resource-id', '')
        if not rid.startswith(prefix):
            continue
        suffix = rid[len(prefix):]
        if suffix not in tab_map:
            continue
        if node.attrib.get('selected') == 'true':
            return tab_map[suffix]

    # Fallback: жоден не selected — беремо перший присутній (IG іноді не виставляє selected)
    for suffix, name in tab_map.items():
        if suffix in found_rids:
            return name
    return None


def _is_liked(xml: str, like_rid_suffix: str) -> bool:
    """Кнопка лайку selected=true → пост лайкнуто."""
    try:
        root = ET.fromstring(xml)
    except ET.ParseError:
        return False
    target_rid = f"{IG_PKG}:id/{like_rid_suffix}"
    for node in root.iter():
        if node.attrib.get('resource-id') == target_rid:
            if node.attrib.get('selected') == 'true':
                return True
            desc = node.attrib.get('content-desc', '').lower()
            # IG також міняє desc: "Liked" vs "Like"
            if 'liked' in desc or 'unlike' in desc:
                return True
    return False


def _is_selected(xml: str, rid_suffix: str) -> bool:
    try:
        root = ET.fromstring(xml)
    except ET.ParseError:
        return False
    target_rid = f"{IG_PKG}:id/{rid_suffix}"
    for node in root.iter():
        if node.attrib.get('resource-id') == target_rid:
            if node.attrib.get('selected') == 'true':
                return True
            desc = node.attrib.get('content-desc', '').lower()
            if 'saved' in desc or 'remove' in desc:
                return True
    return False


def _scan_story_tray(xml: str, own_username: str | None = None) -> dict:
    """Знайти story tray у HOME_FEED, порахувати unviewed через content-desc.

    Формат content-desc для story item (сучасний IG):
       "<username>'s story, <N> of <M>, Unseen."   ← непереглянута
       "<username>'s story, <N> of <M>, Seen."    ← переглянута

    Власну сторіс виключаємо через:
      - текст "Your story" поруч
      - "0 of M" — placeholder кнопки "Add to story"
      - якщо передано own_username — match по username
    """
    result = {'total': 0, 'unviewed': []}
    try:
        root = ET.fromstring(xml)
    except ET.ParseError:
        return result

    # Шукаємо tray у двох варіантах resourceId (сучасний + legacy)
    candidates = [f"{IG_PKG}:id/{M['reel_tray']}",
                  f"{IG_PKG}:id/{M['reel_tray_legacy']}"]
    tray_node = None
    for node in root.iter():
        if node.attrib.get('resource-id') in candidates:
            tray_node = node
            break
    if tray_node is None:
        return result

    # Regex: захоплюємо username, position, total, Seen|Unseen
    # Приклад: "bookspie._'s story, 1 of 3, Unseen."
    story_desc_re = re.compile(
        r"^(.*?)'s story,\s*(\d+)\s*of\s*(\d+),\s*(Seen|Unseen)\.?$",
        re.IGNORECASE,
    )
    # Альтернативні/старі формати
    legacy_unseen = re.compile(r"(?i)\bnot seen\b|\bunseen\b|не переглянут|новая история")
    legacy_seen = re.compile(r"(?i)\bseen\b|переглянут")
    your_re = re.compile(r"(?i)your story|ваша истор|ваша історі")
    # Виключення placeholder'ів, які містять слово "story" але не є сторіс
    exclude_re = re.compile(
        r"(?i)^(add to (your )?story|create|create story|create new)$"
    )

    children = [c for c in tray_node.iter()
                if c.attrib.get('content-desc')
                and c is not tray_node]

    # Дедуп по content-desc — один item у tray може мати кілька nested
    # вузлів (контейнер + avatar + frame), усі з однаковим desc.
    seen_usernames: set[str] = set()
    seen_descs: set[str] = set()

    idx = 0
    for child in children:
        desc = child.attrib.get('content-desc', '').strip()
        if not desc or desc in seen_descs:
            continue
        seen_descs.add(desc)

        # Явний "Your story" / "Add to story" placeholder → скіп
        if your_re.search(desc) or exclude_re.match(desc):
            continue

        # Сучасний формат "<name>'s story, N of M, Seen/Unseen."
        m = story_desc_re.match(desc)
        if m:
            username = m.group(1).strip()
            n_watched = int(m.group(2))
            total = int(m.group(3))
            state_word = m.group(4).lower()
            is_viewed = (state_word == 'seen')

            # Дедуп по username (нормалізованому)
            uname_key = username.lower()
            if uname_key in seen_usernames:
                continue
            seen_usernames.add(uname_key)

            # Виключаємо власну сторіс: placeholder "0 of N" або match own_username
            if n_watched == 0 and total > 0:
                continue
            if own_username and username.lower() == own_username.lower():
                continue

            result['total'] += 1
            if not is_viewed:
                result['unviewed'].append(idx)
            idx += 1
            continue

        # Legacy/fallback format — тільки якщо НЕ жоден modern вже не зафіксовано
        if not seen_usernames and (
                'story' in desc.lower() or 'історі' in desc.lower()
                or 'истори' in desc.lower()):
            is_unseen = bool(legacy_unseen.search(desc))
            is_seen = bool(legacy_seen.search(desc))
            result['total'] += 1
            if is_unseen or not is_seen:
                result['unviewed'].append(idx)
            idx += 1

    return result
