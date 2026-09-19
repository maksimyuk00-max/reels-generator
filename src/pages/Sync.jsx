import { useState, useEffect, useCallback } from 'react'
import './Pages.css'

const isElectron = typeof window !== 'undefined' && !!window.api

export default function Sync() {
  const [status, setStatus] = useState(null)      // { repo, hermes }
  const [repoPath, setRepoPath] = useState('')
  const [hermesHome, setHermesHome] = useState('')
  const [message, setMessage] = useState('')
  const [posts, setPosts] = useState(false)
  const [personas, setPersonas] = useState(false)
  const [hermesMemory, setHermesMemory] = useState(true) // пам'ять важлива — включено за замовчуванням
  const [busy, setBusy] = useState('')        // '' | 'status' | 'deploy' | 'pull'
  const [result, setResult] = useState(null)  // { kind, lines: [] }
  const [savedPath, setSavedPath] = useState(false)

  const refresh = useCallback(async (path) => {
    if (!isElectron) return
    setBusy('status')
    try {
      const st = await window.api.sync.status(path || undefined)
      setStatus(st)
      if (st?.repo?.ok && !path) setRepoPath(st.repo.repoPath || '')
      if (st?.hermes?.ok && !path) setHermesHome(st.hermes.path || '')
    } catch (e) {
      setStatus({ repo: { ok: false, error: String(e) }, hermes: null })
    }
    setBusy('')
  }, [])

  useEffect(() => { refresh('') }, [refresh])

  const fmtRepo = (r) => {
    if (!r) return null
    if (!r.ok) return { ok: false, error: r.error }
    return { ok: true, text: `${r.branch} — ${r.ahead === 0 && r.behind === 0 && !r.changed.length ? 'синхронізовано' : ''}` +
      (r.ahead > 0 ? `не запушено: ${r.ahead}, ` : '') +
      (r.behind > 0 ? `можно стягнути: ${r.behind}, ` : '') +
      (r.changed.length ? `локальних змін: ${r.changed.length}` : '') }
  }

  const fmtHermes = (h) => {
    if (!h) return null
    if (!h.ok) return { ok: false, error: h.error || 'не git-синк' }
    return { ok: true, text: `ahead ${h.ahead}, behind ${h.behind}, локальних змін: ${h.changed}` }
  }

  const doDeploy = async () => {
    setBusy('deploy'); setResult(null)
    try {
      const r = await window.api.sync.deploy({
        repoPath: repoPath || undefined,
        message,
        posts, personas,
        hermesMemory,
      })
      const lines = []
      if (r.repo?.ok) {
        lines.push(`✅ Код запушено (файлів: ${r.repo.filesCount}${r.repo.dataIncluded ? ', з даними' : ''})`)
      } else if (r.repo?.error && !/Немає змін/i.test(r.repo.error)) {
        lines.push(`❌ Код: ${r.repo.error}`)
      } else if (r.repo?.error) {
        lines.push(`ℹ Код: ${r.repo.error}`)
      }
      if (r.hermes) {
        if (r.hermes.ok && !r.hermes.noop) lines.push(`✅ Пам'ять Hermes запушено (${r.hermes.changed} файлів: ${r.hermes.byDir})`)
        else if (r.hermes.ok) lines.push(`✅ Пам'ять Hermes: без нових змін`)
        else lines.push(`❌ Пам'ять: ${r.hermes.error}`)
      }
      const hasFail = lines.some(l => l.startsWith('❌'))
      if (lines.length) setResult({ kind: hasFail ? 'error' : 'ok', lines })
      setMessage(''); setPosts(false); setPersonas(false)
    } catch (e) { setResult({ kind: 'error', lines: [String(e)] }) }
    setBusy('')
    refresh(repoPath)
  }

  const doPull = async () => {
    setBusy('pull'); setResult(null)
    try {
      const r = await window.api.sync.pull({ repoPath: repoPath || undefined, hermesMemory })
      const lines = []
      if (r.hermes) {
        if (r.hermes.ok && r.hermes.changed) lines.push(`✅ Пам'ять Hermes оновлена (${(r.hermes.files || []).length}+ файлів)`)
        else if (r.hermes.ok) lines.push(`✅ Пам'ять Hermes: вже актуальна`)
        else lines.push(`❌ Пам'ять: ${r.hermes.error}`)
      }
      const repo = r.repo
      if (!repo?.ok) {
        lines.push(`${repo?.dirty ? '⚠' : '❌'} Код: ${repo?.error || 'невідома помилка'}`)
        if (repo?.dirty?.length) lines.push('Змінені файли:\n' + repo.dirty.slice(0, 10).map(f => `${f.status} ${f.file}`).join('\n'))
      } else if (!repo.updated) {
        lines.push('✅ Код: вже актуально')
      } else {
        lines.push(`✅ Код: стягнуто ${repo.behind} комміт(ів)`)
        if (repo.merged) {
          lines.push(`📊 Дані: +${repo.merged.added_posts} постів, +${repo.merged.added_personas} персон` +
            (repo.merged.skipped_files ? `, ⚠ ${repo.merged.skipped_files} без відеофайлу` : ''))
        }
        if (repo.dataError) lines.push(`⚠ sync/data.json пошкоджений: ${repo.dataError}`)
        lines.push('⚠ Перезапустіть програму, щоб зміни коду набрали чинності')
      }
      const hasFail = lines.some(l => l.startsWith('❌'))
      setResult({ kind: hasFail ? 'error' : 'ok', lines })
    } catch (e) { setResult({ kind: 'error', lines: [String(e)] }) }
    setBusy('')
    refresh(repoPath)
  }

  const stRepo = fmtRepo(status?.repo)
  const stHermes = fmtHermes(status?.hermes)

  return (
    <div className="page">
      <div className="page-header"><h1 className="page-title">Синхронізація</h1></div>

      {/* Статус обох синків */}
      <div style={{ marginBottom: 16, fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.7 }}>
        <div>📦 <b>Код Reels-генератора:</b>{' '}
          {busy === 'status' && !status ? 'перевіряю...' :
           stRepo ? (stRepo.ok ? stRepo.text : `⚠ ${stRepo.error}`) : '—'}
        </div>
        <div>🧠 <b>Пам'ять Hermes:</b>{' '}
          {busy === 'status' && !status ? 'перевіряю...' : (stHermes ? (stHermes.ok ? stHermes.text : `⚠ ${stHermes.error}`) : '—')}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        {/* Деплой */}
        <div style={{ flex: '1 1 380px', maxWidth: 520 }}>
          <div className="section-title">⬆ Деплой на GitHub</div>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
            Комміт + push змін коду цієї машини. Пам'ять Hermes (навички, пам'ять, конфіг) пушиться в окреме приватне репо.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14 }}>
              <input type="checkbox" checked={hermesMemory} onChange={e => setHermesMemory(e.target.checked)} />
              Пам'ять Hermes (навички, пам'ять, конфіг)
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14 }}>
              <input type="checkbox" checked={posts} onChange={e => setPosts(e.target.checked)} />
              Календар постингу (без відеофайлів)
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14 }}>
              <input type="checkbox" checked={personas} onChange={e => setPersonas(e.target.checked)} />
              Персони
            </label>
            <input
              className="form-input"
              placeholder="Коментар до комміту (необов'язково)"
              value={message}
              onChange={e => setMessage(e.target.value)}
            />
            <button className="btn-primary" disabled={!!busy || !status?.repo?.ok} onClick={doDeploy}>
              {busy === 'deploy' ? 'Пушу...' : 'Деплоїти на GitHub'}
            </button>
          </div>
        </div>

        {/* Синк */}
        <div style={{ flex: '1 1 380px', maxWidth: 520 }}>
          <div className="section-title">⬇ Синк з GitHub</div>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
            Стягує комміти, додає нові пости/персони в базу (доповнення), підтягує пам'ять Hermes.
            Зміни коду набудуть чинності після перезапуску програми.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14 }}>
              <input type="checkbox" checked={hermesMemory} onChange={e => setHermesMemory(e.target.checked)} />
              Пам'ять Hermes
            </label>
            <button className="btn-secondary" disabled={!!busy || !status?.repo?.ok} onClick={doPull}>
              {busy === 'pull' ? 'Синхронізую...' : 'Синхронізувати з GitHub'}
            </button>
            <p style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
              Відеофайли не переносяться: пости з відсутнім відео позначаються і не публікуються з цього пристрою.
            </p>
          </div>
        </div>
      </div>

      {/* Результат */}
      {result && (
        <div style={{
          marginTop: 20, padding: '12px 16px', borderRadius: 10, fontSize: 13, whiteSpace: 'pre-wrap',
          background: result.kind === 'error' ? '#e0525220' : '#52b06020',
          border: `1px solid ${result.kind === 'error' ? '#e0525255' : '#52b06055'}`,
        }}>
          {result.lines.join('\n')}
        </div>
      )}

      {/* Шляхи */}
      <div style={{ marginTop: 24, display: 'flex', gap: 24, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 380px', maxWidth: 520 }}>
          <div className="section-title">Шлях до дев-репозиторію</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input className="form-input" placeholder="C:\claude code\reels-generator"
              value={repoPath} onChange={e => setRepoPath(e.target.value)} />
            <button className="btn-secondary" onClick={async () => {
              await window.api.sync.saveRepoPath({ repoPath })
              setSavedPath(true); setTimeout(() => setSavedPath(false), 2000); refresh(repoPath)
            }} disabled={!!busy}>{savedPath ? '✓' : 'Зберегти'}</button>
          </div>
        </div>
        <div style={{ flex: '1 1 380px', maxWidth: 520 }}>
          <div className="section-title">Папка пам'яті Hermes</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input className="form-input" placeholder="%LOCALAPPDATA%\hermes"
              value={hermesHome} onChange={e => setHermesHome(e.target.value)} />
            <button className="btn-secondary" onClick={async () => {
              await window.api.sync.saveRepoPath({ hermesHome })
              setSavedPath(true); setTimeout(() => setSavedPath(false), 2000)
            }} disabled={!!busy}>{savedPath ? '✓' : 'Зберегти'}</button>
          </div>
        </div>
      </div>
    </div>
  )
}