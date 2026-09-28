import { useState, useEffect, useRef } from 'react'
import './Pages.css'

const isElectron = typeof window !== 'undefined' && !!window.api

export default function BulkDownload() {
  const [username, setUsername] = useState('')
  const [amount, setAmount] = useState(50)
  const [saveDir, setSaveDir] = useState('')
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState({ index: 0, total: 0, code: '', ok: null })
  const [result, setResult] = useState(null)  // { ok, total, failed }
  const [msg, setMsg] = useState(null)
  const logRef = useRef(null)
  const [logLines, setLogLines] = useState([])

  useEffect(() => {
    if (!isElectron || !window.api.on) return
    const unsub = window.api.on('bulkdownload:progress', (data) => {
      setProgress({ index: data.index, total: data.total, code: data.code, ok: data.ok })
      setLogLines(prev => [
        ...prev.slice(-199),
        `${data.ok ? '✓' : '✗'} [${data.index}/${data.total}] ${data.code}${data.ok ? '' : ' — ' + (data.error || '')}`,
      ])
    })
    return unsub
  }, [])

  const pickDir = async () => {
    if (!isElectron) { setMsg({ type: 'err', text: 'Вибір папки працює тільки в Electron' }); return }
    const p = await window.api.dialog.openFile({
      title: 'Оберіть папку, куди скачати рілси',
      properties: ['openDirectory', 'createDirectory'],
    })
    if (p) setSaveDir(p)
  }

  const cleanHandle = (s) => s.trim()
    .replace(/^@/, '')
    .replace(/.*instagram\.com\//, '')
    .replace(/\/$/, '')

  const start = async () => {
    const handle = cleanHandle(username)
    if (!handle) { setMsg({ type: 'err', text: 'Введи username акаунта' }); return }
    if (!saveDir) { setMsg({ type: 'err', text: 'Обери папку для скачування' }); return }
    setMsg(null); setResult(null); setLogLines([])
    setRunning(true)
    setProgress({ index: 0, total: 0, code: '', ok: null })
    try {
      const r = await window.api.python.bulkDownload(handle, saveDir, Math.max(1, parseInt(amount) || 50))
      setRunning(false)
      if (!r.ok) {
        setMsg({ type: 'err', text: r.error || 'Не вдалось скачати' })
      } else {
        setResult(r)
      }
    } catch (e) {
      setRunning(false)
      setMsg({ type: 'err', text: String(e) })
    }
  }

  const pct = progress.total > 0 ? Math.round((progress.index / progress.total) * 100) : 0

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">⬇️ Скачування Reels</h1>
      </div>

      <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 16, lineHeight: 1.6 }}>
        Вводь <b>@username</b> — застосунок читає рілси акаунта з DOM твого залогіненого
        Edge (не API, без 400/429) і качає відеофайли АНОНІМНО в обрану папку.
        Пауза 12с між файлами — безпечний темп без бану.
      </div>

      {/* Крок 1: акаунт */}
      <div style={{ marginBottom: 16 }}>
        <div className="section-title">1. Акаунт</div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div>
            <label style={{ display: 'block', fontSize: 12, color: '#888', marginBottom: 4 }}>Username (без @)</label>
            <input
              className="form-input"
              placeholder="напр. ventormen або посилання на профіль"
              value={username}
              onChange={e => setUsername(e.target.value)}
              disabled={running}
              style={{ width: 320, padding: '8px 10px', background: '#1a1a2e', border: '1px solid #333', borderRadius: 6, color: '#eee' }}
            />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 12, color: '#888', marginBottom: 4 }}>Скільки рілсів</label>
            <input
              className="form-input" type="number" min="1" max="200"
              value={amount} onChange={e => setAmount(e.target.value)}
              disabled={running}
              style={{ width: 110, padding: '8px 10px', background: '#1a1a2e', border: '1px solid #333', borderRadius: 6, color: '#eee' }}
            />
          </div>
        </div>
      </div>

      {/* Крок 2: папка */}
      <div style={{ marginBottom: 16 }}>
        <div className="section-title">2. Куди скачувати</div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="btn-secondary" onClick={pickDir} disabled={running}>
            📁 Обрати папку
          </button>
          {saveDir && <code style={{ fontSize: 12, color: '#aaa' }}>{saveDir}</code>}
        </div>
      </div>

      {/* Запуск */}
      <div style={{ marginBottom: 16 }}>
        <button
          className="btn-primary"
          onClick={start}
          disabled={running || !username.trim() || !saveDir}
          style={{ padding: '12px 32px', fontSize: 15 }}
        >
          {running ? '⏳ Скачую...' : '⬇️ Скачати рілси'}
        </button>

        {running && progress.total > 0 && (
          <div style={{ marginTop: 14 }}>
            <div style={{ background: '#222', borderRadius: 6, height: 10, overflow: 'hidden' }}>
              <div style={{ background: 'linear-gradient(90deg,#4caf50,#8bc34a)', width: `${pct}%`, height: '100%', transition: 'width .4s' }} />
            </div>
            <div style={{ fontSize: 12, color: '#999', marginTop: 6 }}>
              {progress.index}/{progress.total} ({pct}%) — {progress.code}
            </div>
          </div>
        )}
        {running && progress.total === 0 && (
          <div style={{ fontSize: 12, color: '#999', marginTop: 8 }}>⏳ Паршу список рілсів акаунта...</div>
        )}
      </div>

      {/* Лог */}
      {logLines.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div className="section-title">Хід скачування</div>
          <div ref={logRef} style={{
            maxHeight: 220, overflowY: 'auto', fontSize: 12, fontFamily: 'monospace',
            border: '1px solid #26263a', borderRadius: 6, padding: 8, color: '#bbb',
          }}>
            {logLines.map((l, i) => <div key={i}>{l}</div>)}
          </div>
        </div>
      )}

      {/* Результат */}
      {result && (
        <div style={{ padding: 12, background: '#102a12', borderRadius: 6, fontSize: 14, color: '#8bc34a', marginBottom: 12 }}>
          ✅ Скачано {result.total - result.failed} з {result.total} рілсів{result.failed > 0 ? `, помилок: ${result.failed}` : ''}
          {saveDir && <> → <code style={{ color: '#7ec8e3' }}>{saveDir}</code></>}
        </div>
      )}

      {/* Повідомлення */}
      {msg && (
        <div style={{
          padding: '10px 14px', borderRadius: 6, fontSize: 13,
          background: msg.type === 'ok' ? '#1b3a1b' : '#3a1b1b',
          color: msg.type === 'ok' ? '#8bc34a' : '#ef5350',
        }}>
          {msg.text}
        </div>
      )}

      {/* Інфо */}
      <div style={{ marginTop: 24, padding: 14, background: '#14141f', borderRadius: 8, fontSize: 12, color: '#777', lineHeight: 1.6 }}>
        <b style={{ color: '#999' }}>Як працює:</b> список рілсів береться з DOM твого залогіненого
        Edge (порт 9223) — жодного запиту до Instagram API, тому жодних 400/429. Файли качаються
        АНОНІМНО через yt-dlp, по одному, з паузою 12 секунд. Твій акаунт при качанні не задіяний
        — ban-safe. Імена файлів: &lt;code&gt;.mp4.
      </div>
    </div>
  )
}