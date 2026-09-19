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
  const rebase = await git(rp, ['rebase', `origin/${branch}`])
  if (!rebase.ok) {
    const conflicts = (await git(rp, ['diff', '--name-only', '--diff-filter=U'])).stdout.trim().split('\n').filter(Boolean)
    await git(rp, ['rebase', '--abort'])
    return {
      ok: false,
      conflict: true,
      conflictFiles: conflicts,
      error: 'Конфлікт (обидві машини правили один файл): ' + conflicts.join(', ') + '. Rebase відкачено — розберіть вручну.',
    }
  }

  let dataJson = null
  let dataError = null
  const dataPath = path.join(rp, 'sync', 'data.json')
  if (fs.existsSync(dataPath)) {
    try { dataJson = JSON.parse(fs.readFileSync(dataPath, 'utf8')) }
    catch (e) { dataError = 'sync/data.json пошкоджений: ' + e.message }
  }

  return { ok: true, updated: true, behind, commits, branch, dataJson, dataError, needRebuild: true }
}

module.exports = { resolveRepoPath, getStatus, deploy, pull }