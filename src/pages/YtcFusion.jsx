import { useState, useEffect, useRef } from 'react'
import './Pages.css'

const isElectron = typeof window !== 'undefined' && !!window.api

// Патерн виклику Python API як в інших сторінках: через Electron IPC,
// а в dev-режимі (без Electron) — напряму на FastAPI.
const PY = 'http://127.0.0.1:8765'
async function pyFetch(path, options = {}) {
  if (isElectron) {
    if (path.startsWith('/tigfusion/run')) return window.api.tigfusion.run(options.body)
    if (path.startsWith('/tigfusion/status')) return window.api.tigfusion.status()
    if (path.startsWith('/tigfusion/check-ffmpeg')) return window.api.tigfusion.checkFfmpeg()
    if (path.startsWith('/tigfusion/list-dir')) return window.api.tigfusion.listDir(options.__path || '')
    if (path.startsWith('/tigfusion/stop')) return window.api.tigfusion.stop()
  }
  const res = await fetch(`${PY}${path}`, {
    method: options.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: options.body ? JSON.stringify(options.body) : undefined,
  })
  return res.json()
}

export default function YtcFusion() {
  const [ffmpeg, setFfmpeg] = useState(null)       // null=перевіряється, true/false
  const [ffmpegPath, setFfmpegPath] = useState('')
  const [sourceDir, setSourceDir] = useState('')
  const [sourceFiles, setSourceFiles] = useState([]) // [] = не завантажено
  const [selected, setSelected] = useState(new Set()) // індекси вибраних файлів
  const [outputDir, setOutputDir] = useState('')
  const [prefix, setPrefix] = useState('')
  const [startNum, setStartNum] = useState(1)
  const [copies, setCopies] = useState(1)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState({ done: 0, total: 0, current: '' })
  const [result, setResult] = useState(null)        // {ok, results, error}
  const [msg, setMsg] = useState(null)
  const pollRef = useRef(null)

  useEffect(() => {
    checkFfmpeg()
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [])

  const checkFfmpeg = async () => {
    setFfmpeg(null)
    try {
      const r = await pyFetch('/tigfusion/check-ffmpeg')
      setFfmpeg(!!r.ok)
      if (r.ok) setFfmpegPath(r.ffmpeg || '')
      else setMsg({ type: 'err', text: r.error || 'ffmpeg не знайдено' })
    } catch {
      setFfmpeg(false)
      setMsg({ type: 'err', text: 'Python backend не відповідає' })
    }
  }

  const pickSourceDir = async () => {
    if (!isElectron) { setMsg({ type: 'err', text: 'Вибір папки працює тільки в Electron' }); return }
    const p = await window.api.dialog.openFile({
      title: 'Оберіть папку З ВІДЕО (звідки завантажити)',
      properties: ['openDirectory'],
    })
    if (!p) return
    setSourceDir(p)
    await loadDir(p)
  }

  // Вибір окремих файлів (мульти-селект) — додається до списку
  const pickSourceFiles = async () => {
    if (!isElectron) { setMsg({ type: 'err', text: 'Вибір файлів працює тільки в Electron' }); return }
    const paths = await window.api.dialog.openFiles({
      title: 'Оберіть окремі відео (Ctrl+клік для кількох)',
      filters: [{ name: 'Video', extensions: ['mp4', 'mov', 'avi', 'mkv'] }],
      properties: ['openFile', 'multiSelections'],
    })
    if (!paths || !paths.length) return
    setSourceFiles(prev => {
      const merged = [...prev]
      for (const p of paths) if (!merged.includes(p)) merged.push(p)
      return merged
    })
    setSelected(new Set())  // скидаємо вибір — нові файли поза папкою
    setSourceDir('')
    setMsg({ type: 'ok', text: `Додано ${paths.length} файл(ів)` })
  }

  const loadDir = async (dir) => {
    const r = await pyFetch(`/tigfusion/list-dir?path=${encodeURIComponent(dir)}`, { __path: dir })
    if (r.ok) {
      setSourceFiles(r.files)
      // за замовчуванням вибрані всі
      setSelected(new Set(r.files.map((_, i) => i)))
      setMsg({ type: 'ok', text: `Знайдено ${r.count} відео` })
    } else {
      setSourceFiles([])
      setSelected(new Set())
      setMsg({ type: 'err', text: r.error || 'Не вдалось прочитати папку' })
    }
  }

  const toggleFile = (idx) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(idx)) next.delete(idx)
      else next.add(idx)
      return next
    })
  }

  const toggleAll = () => {
    setSelected(prev => {
      if (prev.size === sourceFiles.length) return new Set()
      return new Set(sourceFiles.map((_, i) => i))
    })
  }

  const pickOutputDir = async () => {
    if (!isElectron) { setMsg({ type: 'err', text: 'Вибір папки працює тільки в Electron' }); return }
    const p = await window.api.dialog.openFile({
      title: 'Оберіть папку КУДИ ЗБЕРЕГТИ копії',
      properties: ['openDirectory', 'createDirectory'],
    })
    if (p) setOutputDir(p)
  }

  const previewNames = () => {
    const total = selected.size * Math.max(1, copies)
    if (total === 0) return []
    const pad = Math.max(1, String(startNum + total - 1).length)
    const names = []
    let n = startNum
    for (let i = 0; i < Math.min(4, total); i++) names.push(`${prefix}${String(n).padStart(pad, '0')}.mp4`)
    if (total > 4) names.push('...')
    return names
  }

  const start = async () => {
    const chosen = sourceFiles.filter((_, i) => selected.has(i))
    if (!chosen.length) { setMsg({ type: 'err', text: 'Нічого не вибрано — познач файли чекбоксами' }); return }
    if (!outputDir) { setMsg({ type: 'err', text: 'Обери папку для збереження копій' }); return }
    setMsg(null); setResult(null); setRunning(true)
    setProgress({ done: 0, total: chosen.length * copies, current: '' })
    try {
      const r = await pyFetch('/tigfusion/run', {
        method: 'POST',
        body: {
          files: chosen,
          output_dir: outputDir,
          prefix: prefix || '',
          start_num: Math.max(0, parseInt(startNum) || 1),
          copies: Math.max(1, parseInt(copies) || 1),
        },
      })
      if (!r.ok) {
        setRunning(false)
        setMsg({ type: 'err', text: r.error || 'Не вдалось запустити' })
        return
      }
      pollRef.current = setInterval(pollStatus, 1500)
    } catch (e) {
      setRunning(false)
      setMsg({ type: 'err', text: String(e) })
    }
  }

  const stop = async () => {
    try {
      const r = await pyFetch('/tigfusion/stop', { method: 'POST' })
      if (r.ok) setMsg({ type: 'ok', text: r.stopped ? '⏹ Зупиняю після поточного файлу...' : r.message || 'Процес не активний' })
      else setMsg({ type: 'err', text: r.error || 'Не вдалось зупинити' })
    } catch (e) {
      setMsg({ type: 'err', text: String(e) })
    }
  }

  // ─── LAN Share ───
  const [shareDir, setShareDir] = useState('')
  const [share, setShare] = useState({ running: false, ip: '', port: 8000, folder: '' })

  const pickShareDir = async () => {
    if (!isElectron) { setMsg({ type: 'err', text: 'Вибір папки працює тільки в Electron' }); return }
    const p = await window.api.dialog.openFile({
      title: 'Оберіть папку, яку роздавати телефонам',
      properties: ['openDirectory'],
    })
    if (p) setShareDir(p)
  }

  const shareStart = async () => {
    setMsg(null)
    try {
      let ip = ''
      try { const r = await pyFetch('/share/local-ip'); ip = r.ip || '' } catch (_) {}
      const r = await pyFetch('/share/start', { method: 'POST', body: { folder: shareDir, port: 8000 } })
      if (r.ok) {
        setShare(s => ({ ...s, running: true, port: r.port, folder: r.folder, ip }))
      } else {
        setMsg({ type: 'err', text: r.error || 'Не вдалось запустити сервер' })
      }
    } catch (e) { setMsg({ type: 'err', text: String(e) }) }
  }

  const shareStop = async () => {
    try {
      const r = await pyFetch('/share/stop', { method: 'POST' })
      if (r.ok) setShare(s => ({ ...s, running: false }))
      else setMsg({ type: 'err', text: r.error || 'Не вдалось зупинити' })
    } catch (e) { setMsg({ type: 'err', text: String(e) }) }
  }

  // Створення zip-архіву роздаваної папки
  const [zipBusy, setZipBusy] = useState(false)
  const [zipInfo, setZipInfo] = useState(null) // {size_mb}

  const shareZip = async () => {
    setZipBusy(true); setMsg(null)
    try {
      const r = await pyFetch('/share/zip', { method: 'POST' })
      if (r.ok) setZipInfo({ size_mb: r.size_mb })
      else setMsg({ type: 'err', text: r.error || 'Не вдалось створити архів' })
    } catch (e) { setMsg({ type: 'err', text: String(e) }) }
    finally { setZipBusy(false) }
  }

  const pollStatus = async () => {
    try {
      const s = await pyFetch('/tigfusion/status')
      setProgress({ done: s.progress || 0, total: s.total || 0, current: s.current || '' })
      if (s.done) {
        clearInterval(pollRef.current)
        setRunning(false)
        setResult({ ok: !s.error, results: s.result || [], error: s.error })
      }
    } catch { /* наступний тік */ }
  }

  const pct = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0

  return (
    <div className="page">
      <h1 style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ fontSize: 28 }}>🧬</span> Ytc Fusion
        <span style={{ fontSize: 13, color: '#888', fontWeight: 400 }}>
          унікалізація відео батчем (TIGFUSION)
        </span>
      </h1>

      {/* Статус ffmpeg */}
      <div className="section" style={{ marginBottom: 16 }}>
        {ffmpeg === null && <span style={{ color: '#888' }}>⏳ Перевіряю ffmpeg...</span>}
        {ffmpeg === true && (
          <span style={{ color: '#4caf50' }}>✓ ffmpeg знайдено</span>
        )}
        {ffmpeg === false && (
          <div>
            <span style={{ color: '#f44336' }}>✗ ffmpeg не знайдено. </span>
            <span style={{ color: '#888', fontSize: 13 }}>
              Встанови: <code>winget install Gyan.FFmpeg</code> і перезапусти застосунок
            </span>
            <button className="btn btn-ghost" style={{ marginLeft: 12 }} onClick={checkFfmpeg}>Перевірити ще раз</button>
          </div>
        )}
      </div>

      {/* Крок 1: звідки */}
      <div className="section" style={{ marginBottom: 16 }}>
        <h3>1. Звідки завантажити відео</h3>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="btn btn-secondary" onClick={pickSourceDir} disabled={running}>
            📂 Обрати папку з відео
          </button>
          <button className="btn btn-secondary" onClick={pickSourceFiles} disabled={running}>
            🎬 Обрати окремі файли
          </button>
          {sourceDir && <code style={{ fontSize: 12, color: '#aaa' }}>{sourceDir}</code>}
        </div>
        {sourceFiles.length > 0 && (
          <div style={{ marginTop: 10, fontSize: 13, color: '#ccc' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
              Знайдено <b>{sourceFiles.length}</b>, вибрано <b style={{ color: '#7ec8e3' }}>{selected.size}</b>:
              <button className="btn btn-ghost" style={{ padding: '2px 10px', fontSize: 12 }} onClick={toggleAll} disabled={running}>
                {selected.size === sourceFiles.length ? 'зняти всі' : 'вибрати всі'}
              </button>
            </div>
            <div style={{ maxHeight: 220, overflowY: 'auto', fontSize: 12, border: '1px solid #26263a', borderRadius: 6, padding: 6 }}>
              {sourceFiles.map((f, i) => (
                <label key={f} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 6px', cursor: 'pointer', color: '#bbb' }}>
                  <input type="checkbox" checked={selected.has(i)} onChange={() => toggleFile(i)} disabled={running} />
                  {f.split(/[/\\]/).pop()}
                </label>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Крок 2: куди */}
      <div className="section" style={{ marginBottom: 16 }}>
        <h3>2. Куди зберегти копії</h3>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="btn btn-secondary" onClick={pickOutputDir} disabled={running}>
            📁 Обрати папку для копій
          </button>
          {outputDir && <code style={{ fontSize: 12, color: '#aaa' }}>{outputDir}</code>}
        </div>
      </div>

      {/* Крок 3: іменування */}
      <div className="section" style={{ marginBottom: 16 }}>
        <h3>3. Назви файлів</h3>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div>
            <label style={{ display: 'block', fontSize: 12, color: '#888', marginBottom: 4 }}>Префікс</label>
            <input className="input" value={prefix} onChange={e => setPrefix(e.target.value)}
              placeholder="напр. hokan_" disabled={running}
              style={{ width: 160, padding: '8px 10px', background: '#1a1a2e', border: '1px solid #333', borderRadius: 6, color: '#eee' }} />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 12, color: '#888', marginBottom: 4 }}>Перший номер</label>
            <input className="input" type="number" value={startNum} onChange={e => setStartNum(e.target.value)}
              disabled={running} min="0"
              style={{ width: 110, padding: '8px 10px', background: '#1a1a2e', border: '1px solid #333', borderRadius: 6, color: '#eee' }} />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 12, color: '#888', marginBottom: 4 }}>Копій на відео</label>
            <input className="input" type="number" value={copies} onChange={e => setCopies(e.target.value)}
              disabled={running} min="1" max="20"
              style={{ width: 110, padding: '8px 10px', background: '#1a1a2e', border: '1px solid #333', borderRadius: 6, color: '#eee' }} />
          </div>
          {sourceFiles.length > 0 && (
            <div style={{ fontSize: 13, color: '#aaa' }}>
              Прев'ю: <code style={{ color: '#7ec8e3' }}>{previewNames().join(',  ')}</code>
              <div style={{ fontSize: 11, color: '#777', marginTop: 4 }}>
                Всього буде {sourceFiles.length * Math.max(1, copies)} файлів, номери {startNum}–{startNum + sourceFiles.length * copies - 1}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Запуск */}
      <div className="section" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="btn btn-primary" onClick={start}
            disabled={running || ffmpeg !== true || !selected.size || !outputDir}
            style={{ padding: '12px 32px', fontSize: 15 }}>
            {running ? '⏳ Працюю...' : `🚀 Унікалізувати ${selected.size * Math.max(1, copies) || ''} відео`}
          </button>
          {running && (
            <button className="btn btn-danger" onClick={stop} style={{ padding: '12px 24px', fontSize: 15 }}>
              ⏹ СТОП
            </button>
          )}
        </div>
        {running && (
          <div style={{ marginTop: 14 }}>
            <div style={{ background: '#222', borderRadius: 6, height: 10, overflow: 'hidden' }}>
              <div style={{ background: 'linear-gradient(90deg,#4caf50,#8bc34a)', width: `${pct}%`, height: '100%', transition: 'width .4s' }} />
            </div>
            <div style={{ fontSize: 12, color: '#999', marginTop: 6 }}>
              {progress.done}/{progress.total} ({pct}%) — {progress.current}
            </div>
          </div>
        )}
      </div>

      {/* Результат */}
      {result && (
        <div className="section">
          <h3>{result.ok ? '✅ Готово' : '⚠️ Завершено з помилками'}</h3>
          {result.error && <div style={{ color: '#f44336', fontSize: 13, marginBottom: 8 }}>{result.error}</div>}
          <div style={{ maxHeight: 260, overflowY: 'auto', fontSize: 13 }}>
            {result.results.map((r, i) => (
              <div key={i} style={{ padding: '6px 0', borderBottom: '1px solid #222' }}>
                {r.ok
                  ? <span style={{ color: '#4caf50' }}>✓ {r.src.split(/[/\\]/).pop()} → {r.outputs.join(', ')}</span>
                  : <span style={{ color: '#f44336' }}>✗ {r.src.split(/[/\\]/).pop()} — {r.error}</span>}
              </div>
            ))}
          </div>
          {result.ok && (
            <div style={{ marginTop: 10, fontSize: 13, color: '#888' }}>
              Копії в: <code style={{ color: '#7ec8e3' }}>{outputDir}</code>
            </div>
          )}
        </div>
      )}

      {/* Повідомлення */}
      {msg && (
        <div style={{
          marginTop: 12, padding: '10px 14px', borderRadius: 6, fontSize: 13,
          background: msg.type === 'ok' ? '#1b3a1b' : '#3a1b1b',
          color: msg.type === 'ok' ? '#8bc34a' : '#ef5350',
        }}>
          {msg.text}
        </div>
      )}

      {/* LAN Share: роздача файлів телефонам */}
      <div className="section" style={{ marginTop: 24, border: '1px solid #26263a', borderRadius: 8, padding: 16 }}>
        <h3>📡 Роздати файли по мережі (телефони)</h3>
        <div style={{ fontSize: 13, color: '#999', marginBottom: 10 }}>
          Обери папку — і відкрий адресу на телефоні в тому ж Wi-Fi. Скачування йде напряму по локальній мережі, без хмар.
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="btn btn-secondary" onClick={pickShareDir} disabled={share.running}>
            📂 Обрати папку для роздачі
          </button>
          {!share.running ? (
            <button className="btn btn-primary" onClick={shareStart} disabled={!shareDir}
              style={{ padding: '8px 20px' }}>
              📡 Запустити сервер
            </button>
          ) : (
            <>
              <button className="btn btn-danger" onClick={shareStop} style={{ padding: '8px 20px' }}>
                ⏹ Зупинити сервер
              </button>
              <button className="btn btn-secondary" onClick={shareZip} disabled={zipBusy} style={{ padding: '8px 20px' }}>
                {zipBusy ? '⏳ Архівую...' : '📦 Створити архів (все одним файлом)'}
              </button>
            </>
          )}
          {share.folder && <code style={{ fontSize: 12, color: '#aaa' }}>{share.folder}</code>}
        </div>
        {zipInfo && (
          <div style={{ marginTop: 10, fontSize: 13, color: '#8bc34a' }}>
            ✓ Архів готовий ({zipInfo.size_mb} MB). На телефоні/ноутбуці онови сторінку — зверху з'явиться посилання "📦 Завантажити все одним архівом".
          </div>
        )}
        {share.running && (
          <div style={{ marginTop: 14, padding: 12, background: '#102a12', borderRadius: 6, border: '1px solid #1e4d1e' }}>
            <div style={{ color: '#8bc34a', fontSize: 14, fontWeight: 600, marginBottom: 6 }}>
              Сервер працює — відкрий на телефоні:
            </div>
            <div style={{ fontSize: 18, color: '#7ec8e3', fontFamily: 'monospace', userSelect: 'all' }}>
              http://{share.ip}:{share.port}/browse
            </div>
            <div style={{ fontSize: 12, color: '#888', marginTop: 6 }}>
              Обидва пристрої мають бути в одній Wi-Fi мережі. Файли з'являться списком — тап завантажує.
            </div>
          </div>
        )}
      </div>

      {/* Інфо про метод */}
      <div style={{ marginTop: 24, padding: 14, background: '#14141f', borderRadius: 8, fontSize: 12, color: '#777', lineHeight: 1.6 }}>
        <b style={{ color: '#999' }}>TIGFUSION метод:</b> ghost-оверлей (копія кадру віддзеркалюється і накладається з 1% прозорості) +
        унікальний кроп-зсув і мікроротація на кожну копію + тональність звуку знижена (швидкість не змінюється) +
        trim країв + fade-in + метадані під CapCut. Smart Detector порівнює перцептивні хеші копій і перерендерює
        занадто схожі. Шум/колор-фільтри не використовуються — вони створюють мозаїку на темних сценах.
      </div>
    </div>
  )
}