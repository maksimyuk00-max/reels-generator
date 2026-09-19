// ===== Синхронізація пам'яті Hermes (skills/memories/config) через hermes-sync repo =====
// Репо: maksimyuk00-max/hermes-sync (приватне). Клон = сама папка $LOCALAPPDATA/hermes.
// .gitignore там — whitelist, тому git add -A БЕЗПЕЧНИЙ (env/БД/сесії не комітяться).
const { execFile } = require('child_process')
const path = require('path')
const os = require('os')
const fs = require('fs')

function resolveHermesHome(explicit, stored) {
  return String(explicit || stored || path.join(os.homedir(), 'AppData', 'Local', 'hermes')).trim()
}

function git(repoPath, args, timeoutMs = 120000) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: repoPath, windowsHide: true, maxBuffer: 10 * 1024 * 1024, timeout: timeoutMs },
      (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || err?.message || '') }))
  })
}

function repoReady(p) { return fs.existsSync(path.join(p, '.git')) }

// Файли, які НІКОЛИ не мають комітитись (подвійний захист поверх whitelist .gitignore)
const FORBIDDEN = [
  /^\.env$/, /^auth\.json$/, /^state\.db/, /^\.usage\.json/,
  /^sessions\//, /^logs\//, /^cron\//, /^gateway/, /\.lock$/, /\.db-shm$/, /\.db-wal$/,
]

async function deploy(hermesHome, message, stored) {
  const hp = resolveHermesHome(hermesHome, stored)
  if (!repoReady(hp)) return { ok: false, error: 'Hermes-репозиторій не знайдено: ' + hp + ' (пам\'ять цієї машини не в git-синці)' }

  // 1) pull --rebase спершу (щоб не конфліктувати з другою машиною)
  const pull = await git(hp, ['pull', '--rebase'])
  if (!pull.ok) {
    if (/conflict/i.test(pull.stderr + pull.stdout)) {
      const cf = (await git(hp, ['diff', '--name-only', '--diff-filter=U'])).stdout.trim().split('\n').filter(Boolean)
      await git(hp, ['rebase', '--abort'])
      return { ok: false, conflict: true, conflictFiles: cf, error: 'Конфлікт у пам\'яті Hermes: ' + cf.join(', ') + ' (rebase відкачено)' }
    }
    // offline — коммітимо локально, push може не вдатись
  }

  // 2) add -A (безпечно: whitelist gitignore)
  await git(hp, ['add', '-A'])
  const staged = (await git(hp, ['diff', '--cached', '--name-only'])).stdout.trim().split('\n').filter(Boolean)
  const bad = staged.filter(f => FORBIDDEN.some(re => re.test(f)))
  if (bad.length > 0) {
    for (const f of bad) await git(hp, ['reset', '--', f])
    await git(hp, ['reset']) // на всяк випадок повністю зняти стейдж при знахідці forbidden
    return { ok: false, error: 'Знайдено заборонені файли (не комічу): ' + bad.join(', ') }
  }
  if (staged.length === 0) return { ok: true, noop: true, changed: 0 }

  const msg = (message && message.trim()) || `hermes memory sync from ${os.hostname()}, ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`
  const commit = await git(hp, ['commit', '-m', msg])
  if (!commit.ok && !/nothing to commit/i.test(commit.stderr + commit.stdout)) {
    return { ok: false, error: 'commit: ' + (commit.stderr || commit.stdout) }
  }
  const push = await git(hp, ['push', 'origin', 'HEAD'])
  if (!push.ok) return { ok: false, error: 'push: ' + (push.stderr || push.stdout) }

  // Підсумок по верхніх папках
  const byDir = {}
  for (const f of staged) {
    const d = f.includes('/') ? f.split('/')[0] : '(корінь)'
    byDir[d] = (byDir[d] || 0) + 1
  }
  return { ok: true, changed: staged.length, byDir: Object.entries(byDir).map(([d, n]) => `${d}: ${n}`).join(', ') }
}

async function pull(hermesHome, stored) {
  const hp = resolveHermesHome(hermesHome, stored)
  if (!repoReady(hp)) return { ok: false, error: 'Hermes-репозиторій не знайдено: ' + hp }

  const dirty = (await git(hp, ['status', '--porcelain'])).stdout.trim()
  if (dirty) {
    // Є локальні зміни → спершу деплой (пам'ять має злитись обидвома напрямами)
    const dep = await deploy(hp, null, stored)
    if (!dep.ok) return dep
  }

  const pull = await git(hp, ['pull', '--rebase'])
  if (!pull.ok) {
    const cf = (await git(hp, ['diff', '--name-only', '--diff-filter=U'])).stdout.trim().split('\n').filter(Boolean)
    if (cf.length) {
      await git(hp, ['rebase', '--abort'])
      return { ok: false, conflict: true, conflictFiles: cf, error: 'Конфлікт у пам\'яті Hermes: ' + cf.join(', ') + ' (rebase відкачено)' }
    }
    return { ok: false, error: 'pull: ' + (pull.stderr || pull.stdout) }
  }
  const changed = !/up to date|already up to date/i.test(pull.stdout)
  let files = []
  if (changed) {
    const out = (await git(hp, ['log', '-1', '--name-only', '--format='])).stdout.trim().split('\n').filter(Boolean)
    files = out.slice(0, 12)
  }
  return { ok: true, changed, files, note: 'Нові навички/пам\'ять підхопляться з наступної сесії Hermes (або після перезапуску)' }
}

async function status(hermesHome, stored) {
  const hp = resolveHermesHome(hermesHome, stored)
  if (!repoReady(hp)) return { ok: false, error: 'Не git-синк: ' + hp }
  await git(hp, ['fetch', 'origin'], 60000)
  const branch = (await git(hp, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim() || 'main'
  const ahead = parseInt((await git(hp, ['rev-list', '--count', `origin/${branch}..HEAD`])).stdout.trim()) || 0
  const behind = parseInt((await git(hp, ['rev-list', '--count', `HEAD..origin/${branch}`])).stdout.trim()) || 0
  const changed = (await git(hp, ['status', '--porcelain'])).stdout.trim().split('\n').filter(Boolean).length
  return { ok: true, path: hp, branch, ahead, behind, changed }
}

module.exports = { deploy, pull, status }