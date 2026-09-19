// ===== Синхронізація з GitHub (кнопки в UI, сторінка /sync) =====
// Код: git commit/push (деплой) та fetch/rebase (синк).
// Дані: sync/data.json у репо — календар постингу + персони (мердж = тільки додавання).
const { execFile } = require('child_process')
const path = require('path')
const os = require('os')
const fs = require('fs')

// Шлях до дев-репозиторію. Різні машини — різні розташування, тому:
// 1) явний аргумент зі сторінки Sync, 2) settings.sync.devRepoPath, 3) дефолт.
function resolveRepoPath(explicit, stored) {
  return String(explicit || stored || 'C:\\claude code\\reels-generator').trim()
}

function git(repoPath, args, timeoutMs = 120000) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: repoPath, windowsHide: true, maxBuffer: 10 * 1024 * 1024, timeout: timeoutMs },
      (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || err?.message || '') }))
  })
}

function gitWithEnv(repoPath, args, env, timeoutMs = 120000) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: repoPath, windowsHide: true, maxBuffer: 10 * 1024 * 1024, timeout: timeoutMs, env: { ...process.env, ...env } },
      (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || err?.message || '') }))
  })
}

function repoReady(repoPath) {
  return fs.existsSync(path.join(repoPath, '.git'))
}

function rebaseInProgress(repoPath) {
  const g = path.join(repoPath, '.git')
  return fs.existsSync(path.join(g, 'MERGE_HEAD')) ||
    fs.existsSync(path.join(g, 'rebase-merge')) ||
    fs.existsSync(path.join(g, 'rebase-apply'))
}

function parseStatus(stdout) {
  return stdout.trim() ? stdout.split('\n').filter(Boolean).map((l) => ({
    status: l.slice(0, 2).trim() || '??',
    file: l.slice(3),
  })) : []
}

// ===== Об'єднання кількох експортів даних (union, свіжіший перемагає) =====
// exports — масив JSON-об'єктів (можуть бути null). Порядок не важливий:
// сортуємо за _meta.exported_at, дедуп по (video_path+scheduled_at) для постів
// та id для персон — рядок зі свіжішого експорту виграє.
function unionData(exportsList) {
  const valid = exportsList.filter(Boolean).filter(j => j && (j.scheduled_posts || j.personas))
  if (valid.length === 0) return null
  const sorted = [...valid].sort((a, b) => String(a?._meta?.exported_at || '').localeCompare(String(b?._meta?.exported_at || '')))
  const pSeen = new Set()
  const scheduled_posts = []
  for (const j of sorted) {
    for (const p of (j.scheduled_posts || [])) {
      const k = JSON.stringify([p.video_path, p.scheduled_at])
      if (pSeen.has(k)) continue
      pSeen.add(k)
      scheduled_posts.push(p)
    }
  }
  const idSeen = new Set()
  const personas = []
  for (const j of sorted) {
    for (const p of (j.personas || [])) {
      if (idSeen.has(p.id)) continue
      idSeen.add(p.id)
      personas.push(p)
    }
  }
  return {
    _meta: { exported_at: new Date().toISOString(), app: 'reels-generator', version: 1, note: 'auto-union of two machines' },
    scheduled_posts,
    personas,
  }
}

// ===== Статус репо =====
async function getStatus(repoPath, stored) {
  const rp = resolveRepoPath(repoPath, stored)
  if (!repoReady(rp)) return { ok: false, repoPath: rp, error: 'Git-репозиторій не знайдено: ' + rp }
  if (rebaseInProgress(rp)) return { ok: false, repoPath: rp, error: 'Триває незавершений rebase/merge — розберіть його у терміналі (git status у ' + rp + ')' }

  const fetch = await git(rp, ['fetch', 'origin'], 60000)
  const offline = !fetch.ok
  const branch = (await git(rp, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()
  const ahead = parseInt((await git(rp, ['rev-list', '--count', `origin/${branch}..HEAD`])).stdout.trim()) || 0
  const behind = parseInt((await git(rp, ['rev-list', '--count', `HEAD..origin/${branch}`])).stdout.trim()) || 0
  const changed = parseStatus((await git(rp, ['status', '--porcelain=v1'])).stdout)
  const log = await git(rp, ['log', '-1', '--format=%h %s (%ar)'])
  return {
    ok: true, repoPath: rp, branch, ahead, behind, changed, offline,
    lastCommit: log.stdout.trim() || '—',
  }
}

// ===== Деплой: commit + push (код + опційно sync/data.json) =====
async function deploy(repoPath, message, dataJson, stored) {
  const rp = resolveRepoPath(repoPath, stored)
  if (!repoReady(rp)) return { ok: false, error: 'Git-репозиторій не знайдено: ' + rp }
  if (rebaseInProgress(rp)) return { ok: false, error: 'Триває незавершений rebase/merge — спершу розберіть його у терміналі' }

  const st = await git(rp, ['status', '--porcelain=v1'])
  const files = parseStatus(st.stdout)
  if (files.length === 0 && !dataJson) return { ok: false, error: 'Немає змін для деплою' }

  if (dataJson) {
    try {
      // Якщо на GitHub уже є data.json з другої машини — об'єднуємо (union),
      // щоб деплої з різних машин не конфліктували (вчорашній баг).
      const fetch = await git(rp, ['fetch', 'origin'], 60000)
      if (fetch.ok) {
        const branch = (await git(rp, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()
        const remoteData = await git(rp, ['show', `origin/${branch}:sync/data.json`])
        const remoteJson = remoteData.ok ? (() => { try { return JSON.parse(remoteData.stdout) } catch (_) { return null } })() : null
        const mergedData = unionData([dataJson, remoteJson])
        if (mergedData && mergedData.scheduled_posts.length + mergedData.personas.length > 0) dataJson = mergedData
      }
      fs.mkdirSync(path.join(rp, 'sync'), { recursive: true })
      fs.writeFileSync(path.join(rp, 'sync', 'data.json'), JSON.stringify(dataJson, null, 2))
    } catch (e) {
      return { ok: false, error: 'Не вдалось записати sync/data.json: ' + e.message }
    }
  }

  // Стейджимо ТОЛЬКО те, що показали в UI: sync/ + конкретні файли зі статусу.
  if (fs.existsSync(path.join(rp, 'sync'))) await git(rp, ['add', '--', 'sync/'])
  for (const f of files) {
    if (f.file.startsWith('"')) continue // екзотичні імена з лапками — вручну
    await git(rp, ['add', '--', f.file])
  }

  const msg = (message && message.trim()) ||
    `sync from ${os.hostname()}, ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`
  const commit = await git(rp, ['commit', '-m', msg])
  if (!commit.ok) {
    const nothing = /nothing to commit/i.test(commit.stderr + commit.stdout)
    if (nothing) {
      return { ok: false, error: dataJson
        ? 'Немає нових змін: код без змін, дані ідентичні останньому деплою'
        : 'Немає змін для комміту' }
    }
    return { ok: false, error: 'commit: ' + (commit.stderr || commit.stdout) }
  }

  const push = await git(rp, ['push', 'origin', 'HEAD'])
  if (!push.ok) {
    return {
      ok: false,
      needPull: true,
      error: 'push відхилено. Ймовірно, на GitHub є новіші зміни — спершу натисніть «Синк з GitHub». Деталі: ' + (push.stderr || push.stdout),
    }
  }
  return {
    ok: true,
    message: msg,
    filesCount: files.length + (dataJson ? 1 : 0),
    dataIncluded: !!dataJson,
  }
}

// ===== Синк: fetch + rebase + читання sync/data.json =====
async function pull(repoPath, stored) {
  const rp = resolveRepoPath(repoPath, stored)
  if (!repoReady(rp)) return { ok: false, error: 'Git-репозиторій не знайдено: ' + rp }
  if (rebaseInProgress(rp)) return { ok: false, error: 'Триває незавершений rebase/merge — спершу розберіть його у терміналі' }
  const dataPath = path.join(rp, 'sync', 'data.json')

  const st = await git(rp, ['status', '--porcelain=v1'])
  const dirty = parseStatus(st.stdout)
  if (dirty.length > 0) {
    return {
      ok: false,
      dirty,
      error: 'Є незакомічені локальні зміни — спочатку натисніть «Деплой на GitHub» (або відкиньте зміни у терміналі)',
    }
  }

  const fetch = await git(rp, ['fetch', 'origin'], 60000)
  if (!fetch.ok) return { ok: false, error: 'Немає зв\'язку з GitHub: ' + (fetch.stderr || '') }

  const branch = (await git(rp, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()
  const behind = parseInt((await git(rp, ['rev-list', '--count', `HEAD..origin/${branch}`])).stdout.trim()) || 0
  if (behind === 0) return { ok: true, updated: false, behind: 0, branch }

  const commits = (await git(rp, ['log', `HEAD..origin/${branch}`, '--format=%h %s'])).stdout.trim().split('\n').filter(Boolean)

  let dataMerged = false
  const rebase = await git(rp, ['rebase', `origin/${branch}`])
  if (!rebase.ok) {
    const conflicts = (await git(rp, ['diff', '--name-only', '--diff-filter=U'])).stdout.trim().split('\n').filter(Boolean)
    const onlyData = conflicts.length === 1 && conflicts[0].replace(/\\/g, '/') === 'sync/data.json'
    if (onlyData) {
      // Автозлиття: union пости (ключ video_path+scheduled_at+caption) і персони (по id).
      // "Наша" версія — ORIG_HEAD (стейт гілки ДО rebase; під час зупиненого rebase
      // HEAD вказує на чужі комміти, а не на наші дані).
      const showOurs = await git(rp, ['show', 'ORIG_HEAD:sync/data.json'])
      const showTheirs = await git(rp, ['show', `origin/${branch}:sync/data.json`])
      let oursJson = {}, theirsJson = {}
      try { oursJson = JSON.parse(showOurs.stdout || '{}') } catch (_) {}
      try { theirsJson = JSON.parse(showTheirs.stdout || '{}') } catch (_) {}
      const seen = new Set()
      const key = (p) => JSON.stringify([p.video_path, p.scheduled_at, p.caption])
      const union = []
      for (const p of [...(theirsJson.scheduled_posts || []), ...(oursJson.scheduled_posts || [])]) {
        const k = key(p); if (seen.has(k)) continue; seen.add(k); union.push(p)
      }
      const pidSeen = new Set()
      const personas = []
      for (const p of [...(theirsJson.personas || []), ...(oursJson.personas || [])]) {
        if (pidSeen.has(p.id)) continue; pidSeen.add(p.id); personas.push(p)
      }
      fs.writeFileSync(dataPath, JSON.stringify({
        _meta: { exported_at: new Date().toISOString(), app: 'reels-generator', version: 1, note: 'auto-union of two machines' },
        scheduled_posts: union, personas,
      }, null, 2))
      const add = await git(rp, ['add', 'sync/data.json'])
      if (!add.ok) return { ok: false, error: 'Не вдалось застейджити злитий data.json: ' + add.stderr }
      // GIT_EDITOR=true — no-op редактор, щоб rebase --continue не відкрив vim
      const cont = await gitWithEnv(rp, ['rebase', '--continue'], { GIT_EDITOR: 'true' }, 60000)
      if (!cont.ok && !/nothing to (commit|apply)/i.test(cont.stderr + cont.stdout)) {
        return { ok: false, error: 'rebase --continue після автозлиття: ' + (cont.stderr || cont.stdout) }
      }
      dataMerged = true
    } else {
      await git(rp, ['rebase', '--abort'])
      return {
        ok: false,
        conflict: true,
        conflictFiles: conflicts,
        error: 'Конфлікт (обидві машини правили один файл): ' + conflicts.join(', ') + '. Rebase відкачено — розберіть вручну.',
      }
    }
  }

  let dataJson = null
  let dataError = null
  if (fs.existsSync(dataPath)) {
    try { dataJson = JSON.parse(fs.readFileSync(dataPath, 'utf8')) }
    catch (e) { dataError = 'sync/data.json пошкоджений: ' + e.message }
  }

  return { ok: true, updated: true, behind, commits, branch, dataJson, dataError, needRebuild: true, dataMerged }
}

module.exports = { resolveRepoPath, getStatus, deploy, pull }