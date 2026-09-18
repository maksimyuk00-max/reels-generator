const Database = require('better-sqlite3')
const path = require('path')
const { app } = require('electron')

let db

function getDb() {
  if (!db) {
    const dbPath = path.join(app.getPath('userData'), 'reels-generator.db')
    db = new Database(dbPath)
    db.pragma('journal_mode = WAL')
    initSchema()
  }
  return db
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      username    TEXT NOT NULL UNIQUE,
      full_name   TEXT,
      bio         TEXT,
      followers   INTEGER DEFAULT 0,
      following   INTEGER DEFAULT 0,
      reels_count INTEGER DEFAULT 0,
      avatar_url  TEXT,
      added_at    TEXT DEFAULT (datetime('now')),
      last_parsed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS reels (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id     INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      reel_id        TEXT NOT NULL UNIQUE,
      code           TEXT DEFAULT '',
      instagram_url  TEXT DEFAULT '',
      title          TEXT,
      views          INTEGER DEFAULT 0,
      likes          INTEGER DEFAULT 0,
      comments       INTEGER DEFAULT 0,
      duration       INTEGER DEFAULT 0,
      published_at   TEXT,
      video_url      TEXT,
      thumbnail_url  TEXT,
      downloaded     INTEGER DEFAULT 0,
      download_path  TEXT,
      parsed_at      TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_reels_account ON reels(account_id);
    CREATE INDEX IF NOT EXISTS idx_reels_views   ON reels(views DESC);
    CREATE INDEX IF NOT EXISTS idx_reels_date    ON reels(published_at DESC);

    CREATE TABLE IF NOT EXISTS scheduled_posts (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      video_path    TEXT NOT NULL,
      caption       TEXT DEFAULT '',
      scheduled_at  TEXT NOT NULL,
      status        TEXT DEFAULT 'pending',
      published_at  TEXT,
      instagram_url TEXT,
      error         TEXT,
      created_at    TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_sched_status ON scheduled_posts(status, scheduled_at);

    CREATE TABLE IF NOT EXISTS warmup_sessions (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id      INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
      serial          TEXT,
      scheduled_at    TEXT NOT NULL,
      started_at      TEXT,
      finished_at     TEXT,
      duration_min    INTEGER,
      like_prob_pct   INTEGER,
      use_ai          INTEGER DEFAULT 0,
      status          TEXT DEFAULT 'pending',   -- pending | running | done | failed | skipped
      reels_watched   INTEGER DEFAULT 0,
      likes_given     INTEGER DEFAULT 0,
      saves_given     INTEGER DEFAULT 0,
      error           TEXT,
      ai_decisions    TEXT,                     -- JSON [{action, reason, mode}]
      created_at      TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_warmup_sched ON warmup_sessions(status, scheduled_at);
    CREATE INDEX IF NOT EXISTS idx_warmup_date  ON warmup_sessions(scheduled_at);

    CREATE TABLE IF NOT EXISTS devices (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT NOT NULL,
      serial        TEXT NOT NULL UNIQUE,           -- Android: '192.168.0.x:5555' або USB serial; iOS: UDID
      platform      TEXT DEFAULT 'android',         -- 'android' | 'ios'
      transport     TEXT DEFAULT 'wifi',            -- Android: 'usb'|'wifi'; iOS: 'usb' (поки)
      wifi_host     TEXT,                           -- Android: last known IP:port
      wifi_mac      TEXT,                           -- Android: WiFi MAC для auto-rediscover
      udid          TEXT,                           -- iOS: Unique Device Identifier
      ios_version   TEXT,                           -- iOS: '16.7.14' etc.
      wda_installed INTEGER DEFAULT 0,              -- iOS: чи WDA встановлений
      cert_expires_at TEXT,                         -- iOS: дата закінчення Apple Dev cert
      proxy_json    TEXT,                           -- JSON {host,port,user,pass,type}
      status        TEXT DEFAULT 'active',          -- 'active' | 'paused' | 'offline'
      added_at      TEXT DEFAULT (datetime('now')),
      last_seen_at  TEXT
    );

    CREATE TABLE IF NOT EXISTS account_warmup_configs (
      account_id         INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
      enabled            INTEGER DEFAULT 0,
      sessions_per_day   INTEGER DEFAULT 3,
      active_hour_start  INTEGER DEFAULT 9,
      active_hour_end    INTEGER DEFAULT 22,
      duration_min       INTEGER DEFAULT 3,
      duration_max       INTEGER DEFAULT 8,
      like_prob_min      INTEGER DEFAULT 10,
      like_prob_max      INTEGER DEFAULT 25,
      use_ai             INTEGER DEFAULT 1,
      min_gap_minutes    INTEGER DEFAULT 30,       -- тайм-гап між сесіями на одному девайсі
      updated_at         TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS threads_sessions (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id      INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      device_id       INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      scheduled_at    TEXT NOT NULL,
      duration_min    INTEGER NOT NULL,
      like_prob       REAL NOT NULL,
      ai_prompt       TEXT,
      status          TEXT NOT NULL DEFAULT 'planned',   -- planned | running | done | failed | cancelled
      started_at      TEXT,
      completed_at    TEXT,
      viewed          INTEGER,
      commented       INTEGER,
      liked           INTEGER,
      error           TEXT,
      created_at      TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_threads_status_sched ON threads_sessions(status, scheduled_at);
    CREATE INDEX IF NOT EXISTS idx_threads_sched        ON threads_sessions(scheduled_at);

    CREATE TABLE IF NOT EXISTS generations (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      style           TEXT,
      variant_name    TEXT,
      image_prompt    TEXT,
      video_prompt    TEXT,
      quote           TEXT,
      image_provider  TEXT,
      video_provider  TEXT,
      image_path      TEXT,
      video_path      TEXT,
      final_path      TEXT,
      music_path      TEXT,
      logo_path       TEXT,
      caption         TEXT,
      created_at      TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_gen_date ON generations(created_at DESC);

    CREATE TABLE IF NOT EXISTS personas (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      description TEXT NOT NULL,
      platform    TEXT DEFAULT 'reddit',   -- 'reddit' | 'threads'
      subreddit   TEXT DEFAULT '',
      created_at  TEXT DEFAULT (datetime('now')),
      updated_at  TEXT DEFAULT (datetime('now'))
    );

    -- Reddit feed monitor (Phase 1)
    CREATE TABLE IF NOT EXISTS reddit_found_posts (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      reddit_id       TEXT NOT NULL UNIQUE,    -- base36 t3_xxx
      subreddit       TEXT NOT NULL,
      title           TEXT NOT NULL,
      author          TEXT,
      permalink       TEXT NOT NULL,
      url             TEXT,
      score           INTEGER DEFAULT 0,
      num_comments    INTEGER DEFAULT 0,
      created_utc     INTEGER,
      matched_keywords TEXT DEFAULT '',
      selftext        TEXT DEFAULT '',
      selftext_fetched_at TEXT,
      status          TEXT DEFAULT 'new',      -- 'new' | 'drafted' | 'dismissed'
      found_at        TEXT DEFAULT (datetime('now')),
      updated_at      TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_rfp_status   ON reddit_found_posts(status, found_at DESC);
    CREATE INDEX IF NOT EXISTS idx_rfp_sub      ON reddit_found_posts(subreddit);
    CREATE INDEX IF NOT EXISTS idx_rfp_score    ON reddit_found_posts(score DESC);

    CREATE TABLE IF NOT EXISTS reddit_drafts (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id       INTEGER NOT NULL REFERENCES reddit_found_posts(id) ON DELETE CASCADE,
      persona_id    TEXT REFERENCES personas(id) ON DELETE SET NULL,
      intent        TEXT DEFAULT 'value',    -- 'value' | 'light-promo'
      reply_text    TEXT NOT NULL,
      model         TEXT DEFAULT '',
      error         TEXT,
      created_at    TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_rd_post ON reddit_drafts(post_id, created_at DESC);

    -- Threads feed monitor (analogous to reddit_found_posts)
    CREATE TABLE IF NOT EXISTS threads_found_posts (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_text     TEXT NOT NULL,             -- visible text captured from feed
      author          TEXT DEFAULT '',            -- @handle if detectable
      captured_at     TEXT DEFAULT (datetime('now')),
      status          TEXT DEFAULT 'new',         -- 'new' | 'drafted' | 'dismissed'
      account_id      INTEGER,                    -- which account's session captured it
      source          TEXT DEFAULT 'scroll',      -- 'scroll' | 'manual'
      found_at        TEXT DEFAULT (datetime('now')),
      updated_at      TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_tfp_status ON threads_found_posts(status, found_at DESC);

    -- Threads drafts (persona-generated replies to found posts)
    CREATE TABLE IF NOT EXISTS threads_drafts (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id       INTEGER NOT NULL REFERENCES threads_found_posts(id) ON DELETE CASCADE,
      persona_id    TEXT REFERENCES personas(id) ON DELETE SET NULL,
      intent        TEXT DEFAULT 'reply',   -- 'reply' | 'quote'
      reply_text    TEXT NOT NULL,
      model         TEXT DEFAULT '',
      error         TEXT,
      created_at    TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_td_post ON threads_drafts(post_id, created_at DESC);

    -- Threads generated (original posts created by personas)
    CREATE TABLE IF NOT EXISTS threads_generated (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      persona_id    TEXT REFERENCES personas(id) ON DELETE SET NULL,
      post_text     TEXT NOT NULL,
      status        TEXT DEFAULT 'draft',    -- 'draft' | 'published' | 'failed'
      model         TEXT DEFAULT '',
      account_id    INTEGER,                 -- which account published (if any)
      error         TEXT,
      created_at    TEXT DEFAULT (datetime('now')),
      published_at  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tg_status ON threads_generated(status, created_at DESC);
  `)

  // Migrations: add columns if missing
  const cols = db.prepare("PRAGMA table_info(reels)").all().map(c => c.name)
  if (!cols.includes('code')) {
    db.exec("ALTER TABLE reels ADD COLUMN code TEXT DEFAULT ''")
  }
  if (!cols.includes('instagram_url')) {
    db.exec("ALTER TABLE reels ADD COLUMN instagram_url TEXT DEFAULT ''")
  }

  // Migrations: generations — draft support
  const genCols = db.prepare("PRAGMA table_info(generations)").all().map(c => c.name)
  if (!genCols.includes('status')) {
    db.exec("ALTER TABLE generations ADD COLUMN status TEXT DEFAULT 'completed'")
  }
  if (!genCols.includes('compose_params')) {
    db.exec("ALTER TABLE generations ADD COLUMN compose_params TEXT DEFAULT ''")
  }
  if (!genCols.includes('step')) {
    db.exec("ALTER TABLE generations ADD COLUMN step TEXT DEFAULT 'done'")
  }
  // Migrations: generations — post/carousel support (Фаза 1 постів)
  if (!genCols.includes('content_type')) {
    // 'reel' | 'post' | 'carousel' — існуючі записи default 'reel'
    db.exec("ALTER TABLE generations ADD COLUMN content_type TEXT DEFAULT 'reel'")
  }
  if (!genCols.includes('slides_json')) {
    // JSON array для carousel: [{image_path, prompt, text_overlay, order}, ...]
    db.exec("ALTER TABLE generations ADD COLUMN slides_json TEXT DEFAULT ''")
  }

  // Migrations: scheduled_posts — account selection
  const schedCols = db.prepare("PRAGMA table_info(scheduled_posts)").all().map(c => c.name)
  if (!schedCols.includes('account_id')) {
    db.exec("ALTER TABLE scheduled_posts ADD COLUMN account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL")
  }
  if (!schedCols.includes('is_dry_run')) {
    // тестовий режим — пост НЕ публікується реально, пройде flow до caption і зупиниться
    db.exec("ALTER TABLE scheduled_posts ADD COLUMN is_dry_run INTEGER DEFAULT 0")
  }
  if (!schedCols.includes('content_type')) {
    // 'reel' (default) | 'post' | 'carousel' — тип контенту що публікується
    db.exec("ALTER TABLE scheduled_posts ADD COLUMN content_type TEXT DEFAULT 'reel'")
  }
  if (!schedCols.includes('image_paths_json')) {
    // Для post/carousel: JSON array зі шляхами до фото (для carousel — всі слайди)
    db.exec("ALTER TABLE scheduled_posts ADD COLUMN image_paths_json TEXT DEFAULT ''")
  }

  // Migrations: accounts — device_id для multi-device
  const accCols = db.prepare("PRAGMA table_info(accounts)").all().map(c => c.name)
  if (!accCols.includes('device_id')) {
    db.exec("ALTER TABLE accounts ADD COLUMN device_id INTEGER REFERENCES devices(id) ON DELETE SET NULL")
  }
  if (!accCols.includes('ig_user_id')) {
    // для detection який акаунт зараз активний (dumpsys отримує IG user_id)
    db.exec("ALTER TABLE accounts ADD COLUMN ig_user_id TEXT")
  }

  // Migrations: warmup_sessions — device_id для швидкого scheduler query
  const wsCols = db.prepare("PRAGMA table_info(warmup_sessions)").all().map(c => c.name)
  if (!wsCols.includes('device_id')) {
    db.exec("ALTER TABLE warmup_sessions ADD COLUMN device_id INTEGER REFERENCES devices(id) ON DELETE SET NULL")
  }

  // AI token/cost tracking (v2 orchestrator returns ai_stats)
  if (!wsCols.includes('ai_input_tokens')) {
    db.exec("ALTER TABLE warmup_sessions ADD COLUMN ai_input_tokens INTEGER DEFAULT 0")
  }
  if (!wsCols.includes('ai_output_tokens')) {
    db.exec("ALTER TABLE warmup_sessions ADD COLUMN ai_output_tokens INTEGER DEFAULT 0")
  }
  if (!wsCols.includes('ai_cache_read_tokens')) {
    db.exec("ALTER TABLE warmup_sessions ADD COLUMN ai_cache_read_tokens INTEGER DEFAULT 0")
  }
  if (!wsCols.includes('ai_cost_usd')) {
    db.exec("ALTER TABLE warmup_sessions ADD COLUMN ai_cost_usd REAL DEFAULT 0")
  }
  if (!wsCols.includes('ai_calls')) {
    db.exec("ALTER TABLE warmup_sessions ADD COLUMN ai_calls INTEGER DEFAULT 0")
  }
  if (!wsCols.includes('engine')) {
    db.exec("ALTER TABLE warmup_sessions ADD COLUMN engine TEXT DEFAULT 'manual'")
  }

  // Migrations: account_warmup_configs — niche profile (per-account relevance)
  const cfgCols = db.prepare("PRAGMA table_info(account_warmup_configs)").all().map(c => c.name)
  if (!cfgCols.includes('niche_description')) {
    db.exec("ALTER TABLE account_warmup_configs ADD COLUMN niche_description TEXT DEFAULT ''")
  }
  if (!cfgCols.includes('niche_keywords')) {
    // JSON array string: ["keyword1", "keyword2", ...]
    db.exec("ALTER TABLE account_warmup_configs ADD COLUMN niche_keywords TEXT DEFAULT '[]'")
  }
  if (!cfgCols.includes('niche_avoid')) {
    // JSON array string: ["skip_topic1", "skip_topic2", ...]
    db.exec("ALTER TABLE account_warmup_configs ADD COLUMN niche_avoid TEXT DEFAULT '[]'")
  }
  if (!cfgCols.includes('niche_examples')) {
    // JSON array string: ["@account1", "@account2", ...]
    db.exec("ALTER TABLE account_warmup_configs ADD COLUMN niche_examples TEXT DEFAULT '[]'")
  }
  if (!cfgCols.includes('warmup_engine')) {
    // 'v1' (класичний scroll_reels) або 'v2' (mixed-action з AI niche)
    db.exec("ALTER TABLE account_warmup_configs ADD COLUMN warmup_engine TEXT DEFAULT 'v1'")
  }

  // Migration: devices.wifi_mac — для auto-rediscover при DHCP-зміні IP
  const devCols = db.prepare("PRAGMA table_info(devices)").all().map(c => c.name)
  if (!devCols.includes('wifi_mac')) {
    db.exec("ALTER TABLE devices ADD COLUMN wifi_mac TEXT")
  }
  // Migration: iOS support колонки
  if (!devCols.includes('platform')) {
    db.exec("ALTER TABLE devices ADD COLUMN platform TEXT DEFAULT 'android'")
  }
  if (!devCols.includes('udid')) {
    db.exec("ALTER TABLE devices ADD COLUMN udid TEXT")
  }
  if (!devCols.includes('ios_version')) {
    db.exec("ALTER TABLE devices ADD COLUMN ios_version TEXT")
  }
  if (!devCols.includes('wda_installed')) {
    db.exec("ALTER TABLE devices ADD COLUMN wda_installed INTEGER DEFAULT 0")
  }
  if (!devCols.includes('cert_expires_at')) {
    db.exec("ALTER TABLE devices ADD COLUMN cert_expires_at TEXT")
  }

  // Indexes
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_accounts_device ON accounts(device_id);
    CREATE INDEX IF NOT EXISTS idx_warmup_device_sched ON warmup_sessions(device_id, status, scheduled_at);
    CREATE INDEX IF NOT EXISTS idx_warmup_device_finished ON warmup_sessions(device_id, finished_at);
  `)

  // One-time migration: legacy settings.warmupSchedule → devices + account_warmup_configs
  try { migrateLegacyWarmupSchedule() } catch (e) { console.error('[DB migration] failed:', e.message) }
}

// Одноразова міграція старого settings.warmupSchedule → devices/configs
function migrateLegacyWarmupSchedule() {
  const existing = db.prepare('SELECT COUNT(*) AS n FROM devices').get()
  if (existing.n > 0) return  // Вже мігровано

  // Читаємо settings.json напряму (щоб не залежати від electron-store)
  try {
    const fs = require('fs')
    const settingsPath = path.join(app.getPath('userData'), 'settings.json')
    if (!fs.existsSync(settingsPath)) return
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
    const w = settings.warmupSchedule
    if (!w || !w.serial) return

    // Створюємо device з legacy serial
    const devResult = db.prepare(`
      INSERT INTO devices (name, serial, transport, wifi_host, status)
      VALUES (?, ?, ?, ?, 'active')
    `).run('Default device', w.serial, w.serial.includes(':') ? 'wifi' : 'usb', w.serial.includes(':') ? w.serial : null)

    const deviceId = devResult.lastInsertRowid

    // Прив'язуємо конфіг до accountId (якщо був) АБО до першого акаунту в БД
    let accountId = w.accountId
    if (!accountId) {
      const first = db.prepare('SELECT id FROM accounts ORDER BY id ASC LIMIT 1').get()
      if (first) accountId = first.id
    }
    if (!accountId) return  // Нема акаунтів — нічого прив'язувати

    // Прив'язуємо account до device
    db.prepare('UPDATE accounts SET device_id = ? WHERE id = ?').run(deviceId, accountId)

    // Створюємо warmup config
    db.prepare(`
      INSERT INTO account_warmup_configs (
        account_id, enabled, sessions_per_day, active_hour_start, active_hour_end,
        duration_min, duration_max, like_prob_min, like_prob_max, use_ai
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      accountId,
      w.enabled ? 1 : 0,
      w.sessionsPerDay || 3,
      w.activeHourStart ?? 9,
      w.activeHourEnd ?? 22,
      w.durationMin || 3,
      w.durationMax || 8,
      w.likeProbMin || 10,
      w.likeProbMax || 25,
      w.useAi ? 1 : 0,
    )

    // Backfill device_id у старих warmup_sessions
    db.prepare('UPDATE warmup_sessions SET device_id = ? WHERE account_id = ? AND device_id IS NULL').run(deviceId, accountId)

    console.log(`[DB migration] OK: device #${deviceId} (serial=${w.serial}) ← account #${accountId}`)
  } catch (e) {
    console.error('[DB migration] error:', e.message)
  }
}

// ===== ACCOUNTS =====

function getAllAccounts() {
  return getDb().prepare(`
    SELECT a.*, COUNT(r.id) as reels_parsed
    FROM accounts a
    LEFT JOIN reels r ON r.account_id = a.id
    GROUP BY a.id
    ORDER BY a.added_at DESC
  `).all()
}

function addAccount(username) {
  const stmt = getDb().prepare(`
    INSERT OR IGNORE INTO accounts (username) VALUES (?)
  `)
  const result = stmt.run(username)
  return getDb().prepare('SELECT * FROM accounts WHERE username = ?').get(username)
}

function updateAccount(username, data) {
  const { full_name, bio, followers, following, reels_count, avatar_url } = data
  getDb().prepare(`
    UPDATE accounts SET
      full_name   = ?,
      bio         = ?,
      followers   = ?,
      following   = ?,
      reels_count = ?,
      avatar_url  = ?,
      last_parsed_at = datetime('now')
    WHERE username = ?
  `).run(full_name, bio, followers, following, reels_count, avatar_url, username)
}

function deleteAccount(id) {
  getDb().prepare('DELETE FROM accounts WHERE id = ?').run(id)
}

// ===== REELS =====

function getReelsByAccount(accountId, sortBy = 'published_at') {
  const allowed = ['published_at', 'views', 'likes', 'comments']
  const col = allowed.includes(sortBy) ? sortBy : 'published_at'
  return getDb().prepare(`
    SELECT * FROM reels WHERE account_id = ? ORDER BY ${col} DESC
  `).all(accountId)
}

function upsertReel(accountId, reel) {
  getDb().prepare(`
    INSERT INTO reels (account_id, reel_id, code, instagram_url, title, views, likes, comments, duration, published_at, video_url, thumbnail_url)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(reel_id) DO UPDATE SET
      views = CASE WHEN excluded.views > 0 THEN excluded.views ELSE reels.views END,
      likes = CASE WHEN excluded.likes > 0 THEN excluded.likes ELSE reels.likes END,
      comments = CASE WHEN excluded.comments > 0 THEN excluded.comments ELSE reels.comments END,
      code = CASE WHEN excluded.code != '' THEN excluded.code ELSE reels.code END,
      instagram_url = CASE WHEN excluded.instagram_url != '' THEN excluded.instagram_url ELSE reels.instagram_url END,
      video_url = CASE WHEN excluded.video_url IS NOT NULL THEN excluded.video_url ELSE reels.video_url END,
      thumbnail_url = CASE WHEN excluded.thumbnail_url IS NOT NULL THEN excluded.thumbnail_url ELSE reels.thumbnail_url END,
      parsed_at = datetime('now')
  `).run(
    accountId,
    reel.reel_id,
    reel.code || '',
    reel.instagram_url || '',
    reel.title,
    reel.views || 0,
    reel.likes || 0,
    reel.comments || 0,
    reel.duration || 0,
    reel.published_at,
    reel.video_url,
    reel.thumbnail_url
  )
}

function markReelDownloaded(reelId, downloadPath) {
  getDb().prepare(`
    UPDATE reels SET downloaded = 1, download_path = ? WHERE reel_id = ?
  `).run(downloadPath, reelId)
}

function updateReelViews(reelId, views) {
  getDb().prepare(`
    UPDATE reels SET views = ? WHERE reel_id = ?
  `).run(views, reelId)
}

// ===== SCHEDULED POSTS =====

function getScheduledPosts() {
  return getDb().prepare(`
    SELECT sp.*, a.username AS account_username, a.avatar_url AS account_avatar
    FROM scheduled_posts sp
    LEFT JOIN accounts a ON a.id = sp.account_id
    ORDER BY sp.scheduled_at ASC
  `).all()
}

function getScheduledPost(id) {
  return getDb().prepare(`
    SELECT sp.*, a.username AS account_username, a.avatar_url AS account_avatar
    FROM scheduled_posts sp
    LEFT JOIN accounts a ON a.id = sp.account_id
    WHERE sp.id = ?
  `).get(id)
}

function addScheduledPost(videoPath, caption, scheduledAt, accountId = null, isDryRun = false,
                           contentType = 'reel', imagePathsJson = '') {
  const result = getDb().prepare(`
    INSERT INTO scheduled_posts (video_path, caption, scheduled_at, account_id, is_dry_run,
      content_type, image_paths_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(videoPath || '', caption, scheduledAt, accountId, isDryRun ? 1 : 0,
    contentType || 'reel', imagePathsJson || '')
  return getScheduledPost(result.lastInsertRowid)
}

function updateScheduledPost(id, data) {
  const allowed = ['video_path', 'caption', 'scheduled_at', 'account_id', 'status', 'is_dry_run',
                    'content_type', 'image_paths_json']
  const fields = []
  const values = []
  for (const [key, val] of Object.entries(data)) {
    if (allowed.includes(key) && val !== undefined) {
      fields.push(`${key} = ?`)
      values.push(val)
    }
  }
  if (fields.length === 0) return getScheduledPost(id)
  values.push(id)
  getDb().prepare(`UPDATE scheduled_posts SET ${fields.join(', ')} WHERE id = ?`).run(...values)
  return getScheduledPost(id)
}

function updateScheduledPostStatus(id, status, instagramUrl, error) {
  getDb().prepare(`
    UPDATE scheduled_posts SET
      status = ?,
      published_at = CASE WHEN ? = 'published' THEN datetime('now') ELSE NULL END,
      instagram_url = ?,
      error = ?
    WHERE id = ?
  `).run(status, status, instagramUrl || null, error || null, id)
}

function deleteScheduledPost(id) {
  getDb().prepare('DELETE FROM scheduled_posts WHERE id = ?').run(id)
}

function getPendingDuePosts() {
  // scheduled_at зберігається у локальному часі користувача ("YYYY-MM-DDTHH:mm:ss"),
  // тому порівнюємо з локальним 'now', а не UTC.
  return getDb().prepare(`
    SELECT * FROM scheduled_posts
    WHERE status = 'pending' AND datetime(scheduled_at) <= datetime('now', 'localtime')
    ORDER BY scheduled_at ASC
  `).all()
}

function getStats() {
  const db = getDb()
  return {
    accounts:   db.prepare('SELECT COUNT(*) as n FROM accounts').get().n,
    reels:      db.prepare('SELECT COUNT(*) as n FROM reels').get().n,
    downloaded: db.prepare('SELECT COUNT(*) as n FROM reels WHERE downloaded = 1').get().n,
  }
}

// ===== GENERATIONS =====

function getAllGenerations() {
  return getDb().prepare(`
    SELECT * FROM generations ORDER BY created_at DESC
  `).all()
}

function saveGeneration(data) {
  const result = getDb().prepare(`
    INSERT INTO generations (style, variant_name, image_prompt, video_prompt, quote,
      image_provider, video_provider, image_path, video_path, final_path, music_path, logo_path, caption,
      compose_params, content_type, slides_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    data.style, data.variant_name, data.image_prompt, data.video_prompt, data.quote,
    data.image_provider, data.video_provider, data.image_path, data.video_path,
    data.final_path, data.music_path, data.logo_path, data.caption, data.compose_params || '',
    data.content_type || 'reel', data.slides_json || ''
  )
  return getDb().prepare('SELECT * FROM generations WHERE id = ?').get(result.lastInsertRowid)
}

function deleteGeneration(id) {
  getDb().prepare('DELETE FROM generations WHERE id = ?').run(id)
}

// ===== PERSONAS =====

function getAllPersonas() {
  return getDb().prepare(`
    SELECT * FROM personas ORDER BY updated_at DESC
  `).all()
}

function savePersona(data) {
  // Upsert по id (якщо id порожній — генеруємо). INSERT OR REPLACE оновлює updated_at.
  const id = data.id || `p_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  getDb().prepare(`
    INSERT INTO personas (id, name, description, platform, subreddit, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      description = excluded.description,
      platform = excluded.platform,
      subreddit = excluded.subreddit,
      updated_at = datetime('now')
  `).run(id, data.name || '', data.description || '', data.platform || 'reddit', data.subreddit || '')
  return getDb().prepare('SELECT * FROM personas WHERE id = ?').get(id)
}

function deletePersona(id) {
  getDb().prepare('DELETE FROM personas WHERE id = ?').run(id)
}

// ===== Reddit feed monitor =====

function upsertFoundPost(data) {
  // Якщо reddit_id існує — оновлюємо score/num_comments (бо Reddit score росте).
  // found_at лишаємо перший, updated_at оновлюємо.
  const id = data.reddit_id
  const now = new Date().toISOString()
  const existing = getDb().prepare('SELECT id, found_at FROM reddit_found_posts WHERE reddit_id = ?').get(id)
  if (existing) {
    getDb().prepare(`
      UPDATE reddit_found_posts SET
        score = ?, num_comments = ?, updated_at = ?
      WHERE reddit_id = ?
    `).run(data.score ?? 0, data.num_comments ?? 0, now, id)
    return getDb().prepare('SELECT * FROM reddit_found_posts WHERE id = ?').get(existing.id)
  }
  const result = getDb().prepare(`
    INSERT INTO reddit_found_posts (
      reddit_id, subreddit, title, author, permalink, url,
      score, num_comments, created_utc, matched_keywords, status, found_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?)
  `).run(
    data.reddit_id, data.subreddit, data.title, data.author || '',
    data.permalink, data.url || '', data.score ?? 0, data.num_comments ?? 0,
    data.created_utc ?? 0, data.matched_keywords || '', now, now,
  )
  return getDb().prepare('SELECT * FROM reddit_found_posts WHERE id = ?').get(result.lastInsertRowid)
}

function getFoundPosts({ status, subreddit, limit = 200 } = {}) {
  const wheres = []
  const args = []
  if (status) { wheres.push('status = ?'); args.push(status) }
  if (subreddit) { wheres.push('subreddit = ?'); args.push(subreddit) }
  const where = wheres.length ? 'WHERE ' + wheres.join(' AND ') : ''
  args.push(limit)
  return getDb().prepare(`
    SELECT * FROM reddit_found_posts
    ${where}
    ORDER BY
      CASE status WHEN 'new' THEN 0 WHEN 'drafted' THEN 1 ELSE 2 END,
      score DESC,
      found_at DESC
    LIMIT ?
  `).all(...args)
}

function getFoundPostById(id) {
  return getDb().prepare('SELECT * FROM reddit_found_posts WHERE id = ?').get(id)
}

function setFoundPostStatus(id, status) {
  getDb().prepare(`
    UPDATE reddit_found_posts SET status = ?, updated_at = datetime('now') WHERE id = ?
  `).run(status, id)
}

function saveRedditDraft({ post_id, persona_id, intent, reply_text, model, error }) {
  const result = getDb().prepare(`
    INSERT INTO reddit_drafts (post_id, persona_id, intent, reply_text, model, error)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(post_id || null, persona_id || null, intent || 'value', reply_text || '', model || '', error || null)
  // Позначаємо пост як 'drafted' (тільки якщо немає помилки)
  if (!error) setFoundPostStatus(post_id, 'drafted')
  return getDb().prepare('SELECT * FROM reddit_drafts WHERE id = ?').get(result.lastInsertRowid)
}

function getDraftsForPost(post_id) {
  return getDb().prepare(`
    SELECT * FROM reddit_drafts WHERE post_id = ? ORDER BY created_at DESC
  `).all(post_id)
}

function saveDraft(data) {
  const result = getDb().prepare(`
    INSERT INTO generations (style, variant_name, image_prompt, video_prompt, quote,
      image_provider, video_provider, image_path, video_path, final_path, music_path, logo_path, caption,
      status, step, compose_params)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)
  `).run(
    data.style || '', data.variant_name || '', data.image_prompt || '', data.video_prompt || '', data.quote || '',
    data.image_provider || '', data.video_provider || '', data.image_path || '', data.video_path || '',
    data.final_path || '', data.music_path || '', data.logo_path || '', data.caption || '',
    data.step || 'config', data.compose_params || ''
  )
  return getDb().prepare('SELECT * FROM generations WHERE id = ?').get(result.lastInsertRowid)
}

function updateGeneration(id, data) {
  const fields = []
  const values = []
  for (const [key, val] of Object.entries(data)) {
    if (val !== undefined && key !== 'id' && key !== 'created_at') {
      fields.push(`${key} = ?`)
      values.push(val)
    }
  }
  if (fields.length === 0) return
  values.push(id)
  getDb().prepare(`UPDATE generations SET ${fields.join(', ')} WHERE id = ?`).run(...values)
  return getDb().prepare('SELECT * FROM generations WHERE id = ?').get(id)
}

// ===== WARMUP SESSIONS =====

function addWarmupSession(data) {
  const result = getDb().prepare(`
    INSERT INTO warmup_sessions (account_id, device_id, serial, scheduled_at, duration_min, like_prob_pct, use_ai)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    data.account_id || null, data.device_id || null, data.serial || '', data.scheduled_at,
    data.duration_min, data.like_prob_pct, data.use_ai ? 1 : 0
  )
  return getDb().prepare('SELECT * FROM warmup_sessions WHERE id = ?').get(result.lastInsertRowid)
}

function addWarmupSessionsBatch(sessions) {
  const stmt = getDb().prepare(`
    INSERT INTO warmup_sessions (account_id, device_id, serial, scheduled_at, duration_min, like_prob_pct, use_ai)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `)
  const txn = getDb().transaction((items) => {
    for (const s of items) {
      stmt.run(
        s.account_id || null, s.device_id || null, s.serial || '',
        s.scheduled_at, s.duration_min, s.like_prob_pct, s.use_ai ? 1 : 0
      )
    }
  })
  txn(sessions)
  return sessions.length
}

function getWarmupSessions(fromIso, toIso) {
  // Повертає сесії в діапазоні дат (якщо задано), або всі
  let q = 'SELECT * FROM warmup_sessions'
  const params = []
  if (fromIso || toIso) {
    const cond = []
    if (fromIso) { cond.push('scheduled_at >= ?'); params.push(fromIso) }
    if (toIso)   { cond.push('scheduled_at <= ?'); params.push(toIso) }
    q += ' WHERE ' + cond.join(' AND ')
  }
  q += ' ORDER BY scheduled_at ASC'
  return getDb().prepare(q).all(...params)
}

function getWarmupSession(id) {
  return getDb().prepare('SELECT * FROM warmup_sessions WHERE id = ?').get(id)
}

function getPendingDueWarmups() {
  return getDb().prepare(`
    SELECT * FROM warmup_sessions
    WHERE status = 'pending' AND datetime(scheduled_at) <= datetime('now')
    ORDER BY scheduled_at ASC
    LIMIT 1
  `).all()
}

function updateWarmupSession(id, data) {
  const allowed = ['status', 'started_at', 'finished_at', 'reels_watched', 'likes_given',
                   'saves_given', 'error', 'ai_decisions', 'scheduled_at',
                   'duration_min', 'like_prob_pct', 'use_ai',
                   'ai_input_tokens', 'ai_output_tokens', 'ai_cache_read_tokens',
                   'ai_cost_usd', 'ai_calls', 'engine']
  const fields = []
  const values = []
  for (const [k, v] of Object.entries(data)) {
    if (allowed.includes(k) && v !== undefined) {
      fields.push(`${k} = ?`)
      values.push(k === 'use_ai' ? (v ? 1 : 0) : v)
    }
  }
  if (fields.length === 0) return getWarmupSession(id)
  values.push(id)
  getDb().prepare(`UPDATE warmup_sessions SET ${fields.join(', ')} WHERE id = ?`).run(...values)
  return getWarmupSession(id)
}

function deleteWarmupSession(id) {
  getDb().prepare('DELETE FROM warmup_sessions WHERE id = ?').run(id)
}

function deleteWarmupSessionsPending(accountId = null) {
  // Видаляємо всі ще не виконані сесії (для перегенерації плану).
  // Якщо accountId передано — тільки для цього акаунту.
  if (accountId) {
    return getDb().prepare("DELETE FROM warmup_sessions WHERE status = 'pending' AND account_id = ?").run(accountId).changes
  }
  return getDb().prepare("DELETE FROM warmup_sessions WHERE status = 'pending'").run().changes
}

function getWarmupStats(fromIso, toIso) {
  const params = []
  let where = ''
  if (fromIso || toIso) {
    const cond = []
    if (fromIso) { cond.push('scheduled_at >= ?'); params.push(fromIso) }
    if (toIso)   { cond.push('scheduled_at <= ?'); params.push(toIso) }
    where = 'WHERE ' + cond.join(' AND ')
  }
  return getDb().prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done,
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
      COALESCE(SUM(reels_watched), 0) AS reels_watched,
      COALESCE(SUM(likes_given), 0) AS likes_given,
      COALESCE(SUM(saves_given), 0) AS saves_given,
      COALESCE(SUM(ai_calls), 0) AS ai_calls_total,
      COALESCE(SUM(ai_input_tokens), 0) AS ai_input_total,
      COALESCE(SUM(ai_output_tokens), 0) AS ai_output_total,
      COALESCE(SUM(ai_cache_read_tokens), 0) AS ai_cache_total,
      COALESCE(SUM(ai_cost_usd), 0) AS ai_cost_total
    FROM warmup_sessions ${where}
  `).get(...params)
}

// ===== THREADS SESSIONS =====

function addThreadsSession(data) {
  const result = getDb().prepare(`
    INSERT INTO threads_sessions (account_id, device_id, scheduled_at, duration_min, like_prob, ai_prompt)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    data.account_id,
    data.device_id,
    data.scheduled_at,
    data.duration_min,
    data.like_prob,
    data.ai_prompt || null,
  )
  return getDb().prepare('SELECT * FROM threads_sessions WHERE id = ?').get(result.lastInsertRowid)
}

function addThreadsSessionsBatch(sessions) {
  const stmt = getDb().prepare(`
    INSERT INTO threads_sessions (account_id, device_id, scheduled_at, duration_min, like_prob, ai_prompt)
    VALUES (?, ?, ?, ?, ?, ?)
  `)
  const txn = getDb().transaction((items) => {
    for (const s of items) {
      stmt.run(
        s.account_id,
        s.device_id,
        s.scheduled_at,
        s.duration_min,
        s.like_prob,
        s.ai_prompt || null,
      )
    }
  })
  txn(sessions)
  return sessions.length
}

function getThreadsSessions({ accountId, deviceId, dateFrom, dateTo } = {}) {
  let q = `
    SELECT ts.*, a.username AS account_username, d.name AS device_name, d.serial AS device_serial
    FROM threads_sessions ts
    LEFT JOIN accounts a ON a.id = ts.account_id
    LEFT JOIN devices d ON d.id = ts.device_id
  `
  const cond = []
  const params = []
  if (accountId) { cond.push('ts.account_id = ?'); params.push(accountId) }
  if (deviceId)  { cond.push('ts.device_id = ?');  params.push(deviceId)  }
  if (dateFrom)  { cond.push('ts.scheduled_at >= ?'); params.push(dateFrom) }
  if (dateTo)    { cond.push('ts.scheduled_at <= ?'); params.push(dateTo)   }
  if (cond.length) q += ' WHERE ' + cond.join(' AND ')
  q += ' ORDER BY ts.scheduled_at ASC'
  return getDb().prepare(q).all(...params)
}

function getThreadsSession(id) {
  return getDb().prepare('SELECT * FROM threads_sessions WHERE id = ?').get(id)
}

function getPlannedThreadsSessions(nowIso) {
  // nowIso — ISO string поточного часу. Якщо не задано — використовуємо CURRENT datetime.
  const now = nowIso || new Date().toISOString()
  return getDb().prepare(`
    SELECT ts.*, a.username AS account_username, d.name AS device_name, d.serial AS device_serial
    FROM threads_sessions ts
    LEFT JOIN accounts a ON a.id = ts.account_id
    LEFT JOIN devices d ON d.id = ts.device_id
    WHERE ts.status = 'planned' AND ts.scheduled_at <= ?
    ORDER BY ts.scheduled_at ASC
  `).all(now)
}

function updateThreadsSession(id, data) {
  const allowed = ['status', 'started_at', 'completed_at', 'viewed', 'commented', 'liked',
                   'error', 'scheduled_at', 'duration_min', 'like_prob', 'ai_prompt']
  const fields = []
  const values = []
  for (const [k, v] of Object.entries(data)) {
    if (allowed.includes(k) && v !== undefined) {
      fields.push(`${k} = ?`)
      values.push(v)
    }
  }
  if (fields.length === 0) return getThreadsSession(id)
  values.push(id)
  getDb().prepare(`UPDATE threads_sessions SET ${fields.join(', ')} WHERE id = ?`).run(...values)
  return getThreadsSession(id)
}

function cancelThreadsSession(id) {
  getDb().prepare(`UPDATE threads_sessions SET status = 'cancelled' WHERE id = ? AND status = 'planned'`).run(id)
  return getThreadsSession(id)
}

function deleteThreadsSessions({ accountId, dateFrom, dateTo, onlyPlanned = true } = {}) {
  let q = 'DELETE FROM threads_sessions'
  const cond = []
  const params = []
  if (onlyPlanned) cond.push("status = 'planned'")
  if (accountId)   { cond.push('account_id = ?'); params.push(accountId) }
  if (dateFrom)    { cond.push('scheduled_at >= ?'); params.push(dateFrom) }
  if (dateTo)      { cond.push('scheduled_at <= ?'); params.push(dateTo)   }
  if (cond.length) q += ' WHERE ' + cond.join(' AND ')
  return getDb().prepare(q).run(...params).changes
}

// ===== DEVICES =====

function getAllDevices() {
  return getDb().prepare(`
    SELECT d.*, COUNT(a.id) as account_count
    FROM devices d
    LEFT JOIN accounts a ON a.device_id = d.id
    GROUP BY d.id
    ORDER BY d.added_at DESC
  `).all()
}

function getDevice(id) {
  return getDb().prepare('SELECT * FROM devices WHERE id = ?').get(id)
}

function getDeviceBySerial(serial) {
  return getDb().prepare('SELECT * FROM devices WHERE serial = ?').get(serial)
}

function addDevice({ name, serial, platform, transport, wifi_host, wifi_mac, udid, ios_version, wda_installed, cert_expires_at, proxy_json }) {
  const r = getDb().prepare(`
    INSERT INTO devices (name, serial, platform, transport, wifi_host, wifi_mac, udid, ios_version, wda_installed, cert_expires_at, proxy_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    name, serial,
    platform || 'android',
    transport || 'wifi',
    wifi_host || null, wifi_mac || null,
    udid || null, ios_version || null,
    wda_installed ? 1 : 0, cert_expires_at || null,
    proxy_json || null,
  )
  return r.lastInsertRowid
}

function updateDevice(id, data) {
  const allowed = ['name', 'serial', 'platform', 'transport', 'wifi_host', 'wifi_mac', 'udid', 'ios_version', 'wda_installed', 'cert_expires_at', 'proxy_json', 'status', 'last_seen_at']
  const fields = []
  const values = []
  for (const [k, v] of Object.entries(data)) {
    if (allowed.includes(k) && v !== undefined) {
      fields.push(`${k} = ?`); values.push(v)
    }
  }
  if (!fields.length) return
  values.push(id)
  getDb().prepare(`UPDATE devices SET ${fields.join(', ')} WHERE id = ?`).run(...values)
}

function deleteDevice(id) {
  getDb().prepare('DELETE FROM devices WHERE id = ?').run(id)
}

function getAccountsByDevice(deviceId) {
  return getDb().prepare('SELECT * FROM accounts WHERE device_id = ? ORDER BY added_at ASC').all(deviceId)
}

function setAccountDevice(accountId, deviceId) {
  // Перевірка ліміту 2 акаунти на пристрій
  if (deviceId) {
    const count = getDb().prepare('SELECT COUNT(*) AS n FROM accounts WHERE device_id = ? AND id != ?').get(deviceId, accountId).n
    if (count >= 2) {
      throw new Error('На цей пристрій уже прив\'язано 2 акаунти (максимум)')
    }
  }
  getDb().prepare('UPDATE accounts SET device_id = ? WHERE id = ?').run(deviceId, accountId)
}

// ===== ACCOUNT WARMUP CONFIGS =====

function getWarmupConfig(accountId) {
  const cfg = getDb().prepare('SELECT * FROM account_warmup_configs WHERE account_id = ?').get(accountId)
  if (cfg) {
    // Parse JSON fields для фронтенду
    cfg.niche_keywords = _parseJsonArray(cfg.niche_keywords)
    cfg.niche_avoid = _parseJsonArray(cfg.niche_avoid)
    cfg.niche_examples = _parseJsonArray(cfg.niche_examples)
    return cfg
  }
  // Дефолт якщо нема запису
  return {
    account_id: accountId,
    enabled: 0,
    sessions_per_day: 3,
    active_hour_start: 9,
    active_hour_end: 22,
    duration_min: 3,
    duration_max: 8,
    like_prob_min: 10,
    like_prob_max: 25,
    use_ai: 1,
    min_gap_minutes: 30,
    niche_description: '',
    niche_keywords: [],
    niche_avoid: [],
    niche_examples: [],
    warmup_engine: 'v1',
  }
}

function _parseJsonArray(s) {
  if (!s) return []
  if (Array.isArray(s)) return s
  try {
    const parsed = JSON.parse(s)
    return Array.isArray(parsed) ? parsed : []
  } catch { return [] }
}

function upsertWarmupConfig(accountId, config) {
  // Нормалізація niche полів (приймаємо array, серіалізуємо в JSON для БД)
  const normalized = { ...config }
  for (const k of ['niche_keywords', 'niche_avoid', 'niche_examples']) {
    if (normalized[k] !== undefined) {
      normalized[k] = JSON.stringify(Array.isArray(normalized[k])
        ? normalized[k]
        : _parseJsonArray(normalized[k]))
    }
  }

  const existing = getDb().prepare('SELECT account_id FROM account_warmup_configs WHERE account_id = ?').get(accountId)
  if (existing) {
    const allowed = ['enabled', 'sessions_per_day', 'active_hour_start', 'active_hour_end',
                     'duration_min', 'duration_max', 'like_prob_min', 'like_prob_max',
                     'use_ai', 'min_gap_minutes',
                     'niche_description', 'niche_keywords', 'niche_avoid', 'niche_examples',
                     'warmup_engine']
    const fields = []
    const values = []
    for (const [k, v] of Object.entries(normalized)) {
      if (allowed.includes(k) && v !== undefined) {
        fields.push(`${k} = ?`); values.push(v)
      }
    }
    if (!fields.length) return
    fields.push("updated_at = datetime('now')")
    values.push(accountId)
    getDb().prepare(`UPDATE account_warmup_configs SET ${fields.join(', ')} WHERE account_id = ?`).run(...values)
  } else {
    getDb().prepare(`
      INSERT INTO account_warmup_configs (
        account_id, enabled, sessions_per_day, active_hour_start, active_hour_end,
        duration_min, duration_max, like_prob_min, like_prob_max, use_ai, min_gap_minutes,
        niche_description, niche_keywords, niche_avoid, niche_examples, warmup_engine
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      accountId,
      config.enabled ? 1 : 0,
      config.sessions_per_day ?? 3,
      config.active_hour_start ?? 9,
      config.active_hour_end ?? 22,
      config.duration_min ?? 3,
      config.duration_max ?? 8,
      config.like_prob_min ?? 10,
      config.like_prob_max ?? 25,
      config.use_ai ? 1 : 0,
      config.min_gap_minutes ?? 30,
      config.niche_description ?? '',
      JSON.stringify(Array.isArray(config.niche_keywords) ? config.niche_keywords : []),
      JSON.stringify(Array.isArray(config.niche_avoid) ? config.niche_avoid : []),
      JSON.stringify(Array.isArray(config.niche_examples) ? config.niche_examples : []),
      config.warmup_engine === 'v2' ? 'v2' : 'v1',
    )
  }
}

// ===== SCHEDULER (multi-device aware) =====

function getPendingDueWarmupForAvailableDevices(activeDeviceIds = []) {
  /*
   Повертає найближчу pending сесію чий device зараз не працює
   І на якому давно (>min_gap_minutes) не було завершеної сесії.
   activeDeviceIds — масив id девайсів, що зараз виконують warmup.
  */
  const placeholders = activeDeviceIds.length ? activeDeviceIds.map(() => '?').join(',') : 'NULL'
  const notInClause = activeDeviceIds.length ? `AND ws.device_id NOT IN (${placeholders})` : ''
  const query = `
    SELECT ws.*, a.username AS account_username, d.name AS device_name, d.serial AS device_serial
    FROM warmup_sessions ws
    LEFT JOIN accounts a ON a.id = ws.account_id
    LEFT JOIN devices d ON d.id = ws.device_id
    LEFT JOIN account_warmup_configs cfg ON cfg.account_id = ws.account_id
    WHERE ws.status = 'pending'
      AND datetime(ws.scheduled_at) <= datetime('now')
      ${notInClause}
      AND NOT EXISTS (
        SELECT 1 FROM warmup_sessions ws2
        WHERE ws2.device_id = ws.device_id
          AND ws2.finished_at IS NOT NULL
          AND ws2.finished_at >= datetime('now', printf('-%d minutes', COALESCE(cfg.min_gap_minutes, 30)))
      )
    ORDER BY ws.scheduled_at ASC
    LIMIT 1
  `
  return getDb().prepare(query).get(...activeDeviceIds)
}

// ===== Threads feed monitor =====

function insertThreadPost({ thread_text, author, account_id, source }) {
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19)
  const result = getDb().prepare(`
    INSERT INTO threads_found_posts (thread_text, author, account_id, source, found_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(thread_text, author || '', account_id || null, source || 'scroll', now, now)
  return getDb().prepare('SELECT * FROM threads_found_posts WHERE id = ?').get(result.lastInsertRowid)
}

function getThreadPosts({ status, limit = 200 } = {}) {
  const wheres = []
  const args = []
  if (status) { wheres.push('status = ?'); args.push(status) }
  const where = wheres.length ? 'WHERE ' + wheres.join(' AND ') : ''
  args.push(limit)
  return getDb().prepare(`
    SELECT * FROM threads_found_posts
    ${where}
    ORDER BY
      CASE status WHEN 'new' THEN 0 WHEN 'drafted' THEN 1 ELSE 2 END,
      found_at DESC
    LIMIT ?
  `).all(...args)
}

function getThreadPostById(id) {
  return getDb().prepare('SELECT * FROM threads_found_posts WHERE id = ?').get(id)
}

function setThreadPostStatus(id, status) {
  getDb().prepare(`
    UPDATE threads_found_posts SET status = ?, updated_at = datetime('now') WHERE id = ?
  `).run(status, id)
}

function deleteThreadPosts(ids) {
  if (!ids || ids.length === 0) return { count: 0 }
  const placeholders = ids.map(() => '?').join(',')
  const result = getDb().prepare(`DELETE FROM threads_found_posts WHERE id IN (${placeholders})`).run(...ids)
  return { count: result.changes }
}

function saveThreadDraft({ post_id, persona_id, intent, reply_text, model, error }) {
  const result = getDb().prepare(`
    INSERT INTO threads_drafts (post_id, persona_id, intent, reply_text, model, error)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(post_id || null, persona_id || null, intent || 'reply', reply_text || '', model || '', error || null)
  if (!error) setThreadPostStatus(post_id, 'drafted')
  return getDb().prepare('SELECT * FROM threads_drafts WHERE id = ?').get(result.lastInsertRowid)
}

function getThreadDrafts(post_id) {
  return getDb().prepare(`
    SELECT * FROM threads_drafts WHERE post_id = ? ORDER BY created_at DESC
  `).all(post_id)
}

// ===== Threads generated (original posts) =====

function saveThreadGenerated({ persona_id, post_text, model, status }) {
  const result = getDb().prepare(`
    INSERT INTO threads_generated (persona_id, post_text, model, status)
    VALUES (?, ?, ?, ?)
  `).run(persona_id || null, post_text || '', model || '', status || 'draft')
  return getDb().prepare('SELECT * FROM threads_generated WHERE id = ?').get(result.lastInsertRowid)
}

function getThreadGenerated({ status, limit = 100 } = {}) {
  const wheres = []
  const args = []
  if (status) { wheres.push('status = ?'); args.push(status) }
  const where = wheres.length ? 'WHERE ' + wheres.join(' AND ') : ''
  args.push(limit)
  return getDb().prepare(`
    SELECT * FROM threads_generated ${where} ORDER BY created_at DESC LIMIT ?
  `).all(...args)
}

function updateThreadGenerated(id, data) {
  const fields = []
  const values = []
  for (const [key, val] of Object.entries(data)) {
    if (val !== undefined && key !== 'id' && key !== 'created_at') {
      fields.push(`${key} = ?`)
      values.push(val)
    }
  }
  if (fields.length === 0) return null
  values.push(id)
  getDb().prepare(`UPDATE threads_generated SET ${fields.join(', ')} WHERE id = ?`).run(...values)
  return getDb().prepare('SELECT * FROM threads_generated WHERE id = ?').get(id)
}

module.exports = {
  getAllAccounts,
  addAccount,
  updateAccount,
  deleteAccount,
  getReelsByAccount,
  upsertReel,
  markReelDownloaded,
  updateReelViews,
  getStats,
  getScheduledPosts,
  getScheduledPost,
  addScheduledPost,
  updateScheduledPost,
  updateScheduledPostStatus,
  deleteScheduledPost,
  getPendingDuePosts,
  getAllGenerations,
  saveGeneration,
  deleteGeneration,
  saveDraft,
  updateGeneration,
  // Personas
  getAllPersonas,
  savePersona,
  deletePersona,
  // Reddit feed monitor
  upsertFoundPost,
  getFoundPosts,
  getFoundPostById,
  setFoundPostStatus,
  saveRedditDraft,
  getDraftsForPost,
  addWarmupSession,
  addWarmupSessionsBatch,
  getWarmupSessions,
  getWarmupSession,
  getPendingDueWarmups,
  updateWarmupSession,
  deleteWarmupSession,
  deleteWarmupSessionsPending,
  getWarmupStats,
  // Devices
  getAllDevices,
  getDevice,
  getDeviceBySerial,
  addDevice,
  updateDevice,
  deleteDevice,
  getAccountsByDevice,
  setAccountDevice,
  // Warmup configs (per-account)
  getWarmupConfig,
  upsertWarmupConfig,
  // Multi-device scheduler
  getPendingDueWarmupForAvailableDevices,
  // Threads feed monitor
  insertThreadPost,
  getThreadPosts,
  getThreadPostById,
  setThreadPostStatus,
  deleteThreadPosts,
  saveThreadDraft,
  getThreadDrafts,
  // Threads generated (original posts)
  saveThreadGenerated,
  getThreadGenerated,
  updateThreadGenerated,
  // Threads sessions
  addThreadsSession,
  addThreadsSessionsBatch,
  getThreadsSessions,
  getThreadsSession,
  getPlannedThreadsSessions,
  updateThreadsSession,
  cancelThreadsSession,
  deleteThreadsSessions,
}
