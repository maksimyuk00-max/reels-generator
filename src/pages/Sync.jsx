import { useState, useEffect, useCallback } from 'react'
import './Pages.css'

const isElectron = typeof window !== 'undefined' && !!window.api

export default function Sync() {
  const [status, setStatus] = useState(null)
  const [repoPath, setRepoPath] = useState('')
  const [message, setMessage] = useState('')
  const [posts, setPosts] = useState(false)
  const [personas, setPersonas] = useState(false)
  const [busy, setBusy] = useState('')        // '' | 'status' | 'deploy' | 'pull'
  const [result, setResult] = useState(null)  // { kind: 'ok'|'error'|'warn', text, files?, merged? }
  const [savedPath, setSavedPath] = useState(false)

  const refresh = useCallback(async (path) => {
    if (!isElectron) return
    setBusy('status')
    try {
      const st = await window.api.sync.status(path || undefined)
      setStatus(st)
      if (st.ok && !path) setRepoPath(st.repoPath || '')
    } catch (e) {
      setStatus({ ok: false, error: String(e) })
    }
    setBusy('')
  }, [])

  useEffect(() => { refresh('') }, [refresh])

  const applyPath = async () => {
    await window.api.sync.saveRepoPath(repoPath)
    setSavedPath(true); setTimeout(() => setSavedPath(false), 2000)
    refresh(repoPath)
  }

  const doDeploy = async () => {
    setBusy('deploy'); setResult(null)
    try {
      const r = await window.api.sync.deploy({
        repoPath: repoPath || undefined,
        message,
        posts, personas,
      })
      if (r.ok) {
        setResult({
          kind: 'ok',
          text: `Запушено на GitHub. Файлів: ${r.filesCount}${r.dataIncluded ? ' (включно з даними: календар/персони)' : ''}. Комміт: "${r.message}"`,
        })
        setMessage('')
        setPosts(false); setPersonas(false)
      } else {
        setResult({ kind: r.needPull ? 'warn' : 'error', text: r.error })
      }
    } catch (e) { setResult({ kind: 'error', text: String(e) }) }
    setBusy('')
    refresh(repoPath)
  }

  const doPull = async () => {
    setBusy('pull'); setResult(null)
    try {
      const r = await window.api.sync.pull(repoPath || undefined)
      if (!r.ok) {
        setResult({ kind: r.dirty ? 'warn' : 'error', text: r.error, files: r.dirty || r.conflictFiles })
      } else if (!r.updated) {
        setResult({ kind: 'ok', text: 'Вже актуально — нових коммітів на GitHub нема.' })
      } else {
        const parts = [`Оновлено: ${r.behind} комміт(ів) з GitHub`]
        if (r.merged) {
          parts.push(`Дані: +${r.merged.added_posts} постів, +${r.merged.added_personas} персон` +
            (r.merged.skipped_files ? `, ⚠ ${r.merged.skipped_files} постів без відеофайлу на цьому пристрої` : ''))
          if (r.merged.error) parts.push(`⚠ помилка мерджу: ${r.merged.error}`)
        }
        parts.push('⚠ Програма потребує перезапуску для застосування змін коду.')
        setResult({ kind: 'ok', text: parts.join('. ') })
      }
    } catch (e) { setResult({ kind: 'error', text: String(e) }) }
    setBusy('')
    refresh(repoPath)
  }

  const st = status?.ok ? status : null

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">Синхронізація</h1>
      </div>

      {/* Статус репозиторію */}
      <div style={{ marginBottom: 16 }}>
        {busy === 'status' && !status && <span style={{ color: 'var(--text-secondary)' }}>Перевіряю GitHub...</span>}
        {status && !status.ok && (
          <div style={{ color: 'var(--danger, #e05252)', fontSize: 14 }}>⚠ {status.error}</div>
        )}
        {st && (
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.7 }}>
            <div>
              <b>{st.branch}</b> — {st.ahead === 0 && st.behind === 0 && !st.changed.length ? 'синхронізовано з GitHub' : ''}
              {st.ahead > 0 && `на GitHub ще не запушено: ${st.ahead} комміт(ів)`}
              {st.ahead > 0 && st.behind > 0 ? ', ' : ''}
              {st.behind > 0 && `з GitHub можна стягнути: ${st.behind} комміт(ів)`}
              {st.offline && ' (GitHub недоступний — показано локальний стан)'}
            </div>
            {st.changed.length > 0 && (
              <div>Локальні зміни ({st.changed.length} файлів): {st.changed.slice(0, 8).map(f => f.file).join(', ')}{st.changed.length > 8 ? '…' : ''}</div>
            )}
            <div>Останній комміт: {st.lastCommit}</div>
          </div>
        )}
      </div>

      {/* Дії */}
      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        {/* Деплой */}
        <div style={{ flex: '1 1 380px', maxWidth: 520 }}>
          <div className="section-title">⬆ Деплой на GitHub</div>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
            Комміт + push змін коду цієї машини. За бажанням — календар постингу та персони (без відео і картинок).
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14 }}>
              <input type="checkbox" checked={posts} onChange={e => setPosts(e.target.checked)} />
              Календар постингу (заплановані пости, без відеофайлів)
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
            <button className="btn-primary" disabled={!!busy || !status?.ok} onClick={doDeploy}>
              {busy === 'deploy' ? 'Пушу...' : 'Деплоїти на GitHub'}
            </button>
          </div>
        </div>

        {/* Синк */}
        <div style={{ flex: '1 1 380px', maxWidth: 520 }}>
          <div className="section-title">⬇ Синк з GitHub</div>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
            Стягує комміти з GitHub, додає нові пости/персони в базу (доповнення, без перезапису).
            Зміни коду набудуть чинності після перезапуску програми.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10 }}>
            <button className="btn-secondary" disabled={!!busy || !status?.ok} onClick={doPull}>
              {busy === 'pull' ? 'Синхронізую...' : 'Синхронізувати з GitHub'}
            </button>
            <p style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
              Якщо є незакомічені зміни — спершу задеплойте. Відеофайли не переносяться:
              пости з відсутнім відео позначаються і не публікуються з цього пристрою.
            </p>
          </div>
        </div>
      </div>

      {/* Результат */}
      {result && (
        <div style={{
          marginTop: 20, padding: '12px 16px', borderRadius: 10, fontSize: 14, whiteSpace: 'pre-wrap',
          background: result.kind === 'error' ? '#e0525220'
            : result.kind === 'warn' ? '#e0a05220' : '#52b06020',
          border: `1px solid ${result.kind === 'error' ? '#e0525255' : result.kind === 'warn' ? '#e0a05255' : '#52b06055'}`,
        }}>
          {result.kind === 'ok' ? '✅ ' : result.kind === 'warn' ? '⚠ ' : '❌ '}{result.text}
          {result.files?.length > 0 && (
            <div style={{ marginTop: 8, fontSize: 12, fontFamily: 'monospace' }}>
              {result.files.slice(0, 15).map(f => typeof f === 'string' ? f : `${f.status} ${f.file}`).join('\n')}
              {result.files.length > 15 ? `\n… і ще ${result.files.length - 15}` : ''}
            </div>
          )}
        </div>
      )}

      {/* Шлях до дев-репо */}
      <div style={{ marginTop: 24 }}>
        <div className="section-title">Шлях до дев-репозиторію</div>
        <div style={{ display: 'flex', gap: 8, maxWidth: 640 }}>
          <input
            className="form-input"
            placeholder="C:\claude code\reels-generator"
            value={repoPath}
            onChange={e => setRepoPath(e.target.value)}
          />
          <button className="btn-secondary" onClick={applyPath} disabled={!!busy}>{savedPath ? 'Збережено ✓' : 'Зберегти'}</button>
        </div>
        <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 6 }}>
          Папка з кодом, звідки працює git (на іншій машині може відрізнятись — тоді вкажіть її тут).
        </p>
      </div>
    </div>
  )
}