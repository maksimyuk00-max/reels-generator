import { useState, useEffect, useCallback } from 'react'

const MOBAI_NOT_RUNNING = 'MobAI не запущено. Відкрий MobAI Desktop і під' +
  'єднай iPhone.'

export default function iPhoneBridge() {
  const [devices, setDevices] = useState([])
  const [selectedDevice, setSelectedDevice] = useState(null)
  const [status, setStatus] = useState('checking') // checking | ok | error
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null) // { type: 'ok'|'err', text }

  // Текст для вставки на iPhone
  const [textToSend, setTextToSend] = useState('')

  // Текст з буфера iPhone
  const [clipboardText, setClipboardText] = useState('')

  // OCR результат
  const [ocrTexts, setOcrTexts] = useState([])
  const [ocrRaw, setOcrRaw] = useState(null)

  // Скріншот
  const [screenshotPath, setScreenshotPath] = useState(null)

  const isElectron = typeof window !== 'undefined' && !!window.api

  const flash = (type, text) => {
    setMsg({ type, text })
    setTimeout(() => setMsg(null), 4000)
  }

  // Завантажуємо список пристроїв
  const loadDevices = useCallback(async () => {
    if (!isElectron) { setStatus('ok'); return }
    try {
      const result = await window.api.mobai.devices()
      if (result.error) {
        setStatus('error')
        return
      }
      const devs = result.devices || []
      setDevices(devs)
      if (devs.length > 0 && !selectedDevice) {
        setSelectedDevice(devs[0].id)
      }
      setStatus('ok')
    } catch {
      setStatus('error')
    }
  }, [isElectron, selectedDevice])

  useEffect(() => {
    loadDevices()
    const interval = setInterval(loadDevices, 10000)
    return () => clearInterval(interval)
  }, [loadDevices])

  // ── Дії ──

  const handleClipboardGet = async () => {
    if (!selectedDevice) return
    setBusy(true)
    try {
      const result = await window.api.mobai.clipboardGet(selectedDevice)
      if (result.error) {
        flash('err', 'Помилка: ' + result.error)
      } else {
        setClipboardText(result.text || '(порожньо)')
        flash('ok', 'Буфер зчитано')
      }
    } catch (e) {
      flash('err', 'Помилка: ' + e.message)
    }
    setBusy(false)
  }

  const handleClipboardSet = async () => {
    if (!selectedDevice || !textToSend) return
    setBusy(true)
    try {
      const result = await window.api.mobai.clipboardSet(selectedDevice, textToSend)
      if (result.error) {
        flash('err', 'Помилка: ' + result.error)
      } else {
        flash('ok', 'Текст скопійовано в буфер iPhone')
      }
    } catch (e) {
      flash('err', 'Помилка: ' + e.message)
    }
    setBusy(false)
  }

  const handleType = async () => {
    if (!selectedDevice || !textToSend) return
    setBusy(true)
    try {
      const result = await window.api.mobai.type(selectedDevice, textToSend)
      if (result.error) {
        flash('err', 'Помилка: ' + result.error)
      } else {
        flash('ok', 'Текст введено в активне поле на iPhone')
      }
    } catch (e) {
      flash('err', 'Помилка: ' + e.message)
    }
    setBusy(false)
  }

  const handleScreenshot = async () => {
    if (!selectedDevice) return
    setBusy(true)
    try {
      const result = await window.api.mobai.screenshot(selectedDevice)
      if (result.error) {
        flash('err', 'Помилка: ' + result.error)
      } else {
        setScreenshotPath(result.path)
        flash('ok', 'Скріншот зроблено')
      }
    } catch (e) {
      flash('err', 'Помилка: ' + e.message)
    }
    setBusy(false)
  }

  const handleOCR = async () => {
    if (!selectedDevice) return
    setBusy(true)
    try {
      const result = await window.api.mobai.ocr(selectedDevice)
      if (result.error) {
        flash('err', 'Помилка: ' + result.error)
      } else {
        setOcrTexts(result.texts || [])
        setOcrRaw(result.raw || null)
        flash('ok', `Розпізнано ${result.texts?.length || 0} фрагментів`)
      }
    } catch (e) {
      flash('err', 'Помилка: ' + e.message)
    }
    setBusy(false)
  }

  const copyOcrToClipboard = () => {
    const fullText = ocrTexts.join('\n')
    navigator.clipboard.writeText(fullText)
    flash('ok', 'Текст скопійовано в буфер ПК')
  }

  const copyOcrLine = (text) => {
    navigator.clipboard.writeText(text)
    flash('ok', 'Скопійовано')
  }

  // ── Рендер ──

  if (status === 'checking') {
    return (
      <div style={{ padding: 24, color: '#888' }}>
        Перевірка підключення MobAI...
      </div>
    )
  }

  if (status === 'error') {
    return (
      <div style={{ padding: 24 }}>
        <h2 style={{ fontSize: 18, marginBottom: 12 }}>iPhone Bridge</h2>
        <div style={{
          padding: 16, borderRadius: 8,
          background: '#3a1a1a', color: '#ff6b6b',
          border: '1px solid #ff444433',
        }}>
          {MOBAI_NOT_RUNNING}
        </div>
        <button
          onClick={loadDevices}
          style={{
            marginTop: 12, padding: '8px 16px',
            background: '#444', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer',
          }}
        >
          Перевірити знову
        </button>
      </div>
    )
  }

  return (
    <div style={{ padding: 24, maxWidth: 700 }}>
      <h2 style={{ fontSize: 18, marginBottom: 16 }}>iPhone Bridge (MobAI)</h2>

      {/* Пристрій */}
      <div style={{ marginBottom: 20 }}>
        <label style={{ display: 'block', marginBottom: 6, fontSize: 13, color: '#aaa' }}>
          Пристрій
        </label>
        <select
          value={selectedDevice || ''}
          onChange={(e) => setSelectedDevice(e.target.value)}
          style={{
            width: '100%', padding: '8px 12px',
            background: '#222', color: '#fff', border: '1px solid #444', borderRadius: 6,
          }}
        >
          {devices.map(d => (
            <option key={d.id} value={d.id}>
              {d.name} ({d.model}) — {d.osVersion}
            </option>
          ))}
        </select>
      </div>

      {/* Повідомлення */}
      {msg && (
        <div style={{
          padding: '8px 12px', marginBottom: 16, borderRadius: 6, fontSize: 13,
          background: msg.type === 'ok' ? '#1a3a1a' : '#3a1a1a',
          color: msg.type === 'ok' ? '#6bff6b' : '#ff6b6b',
        }}>
          {msg.text}
        </div>
      )}

      {/* Вставити текст на iPhone */}
      <div style={{
        padding: 16, marginBottom: 16, borderRadius: 8,
        background: '#1a1a2e', border: '1px solid #2a2a4e',
      }}>
        <h3 style={{ fontSize: 14, marginBottom: 10, color: '#E8E2D0' }}>
          Вставити текст на iPhone
        </h3>
        <textarea
          value={textToSend}
          onChange={(e) => setTextToSend(e.target.value)}
          placeholder="Введи текст для вставки..."
          rows={3}
          style={{
            width: '100%', padding: 10, marginBottom: 10,
            background: '#111', color: '#fff',
            border: '1px solid #333', borderRadius: 6,
            fontSize: 13, fontFamily: 'monospace', resize: 'vertical',
          }}
        />
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={handleType}
            disabled={busy || !textToSend}
            style={btnStyle}
          >
            Ввести в поле
          </button>
          <button
            onClick={handleClipboardSet}
            disabled={busy || !textToSend}
            style={btnStyle}
          >
            Скопіювати в буфер
          </button>
        </div>
      </div>

      {/* Зчитати буфер iPhone */}
      <div style={{
        padding: 16, marginBottom: 16, borderRadius: 8,
        background: '#1a1a2e', border: '1px solid #2a2a4e',
      }}>
        <h3 style={{ fontSize: 14, marginBottom: 10, color: '#E8E2D0' }}>
          Зчитати буфер iPhone
        </h3>
        <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
          <button
            onClick={handleClipboardGet}
            disabled={busy}
            style={btnStyle}
          >
            Зчитати буфер
          </button>
        </div>
        <div style={{
          padding: 10, background: '#111', borderRadius: 6,
          color: clipboardText ? '#fff' : '#666', fontSize: 13,
          fontFamily: 'monospace', minHeight: 36,
          border: '1px solid #333', wordBreak: 'break-word',
        }}>
          {clipboardText || '(порожньо)'}
        </div>
        <p style={{ fontSize: 11, color: '#666', marginTop: 6 }}>
          Увага: iOS обмежує читання буфера з фону. Якщо порожньо — відкрий MobAI bridge на iPhone.
        </p>
      </div>

      {/* Розпізнати текст (OCR) */}
      <div style={{
        padding: 16, marginBottom: 16, borderRadius: 8,
        background: '#1a1a2e', border: '1px solid #2a2a4e',
      }}>
        <h3 style={{ fontSize: 14, marginBottom: 10, color: '#E8E2D0' }}>
          Розпізнати текст з екрана (OCR)
        </h3>
        <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
          <button
            onClick={handleScreenshot}
            disabled={busy}
            style={btnStyle}
          >
            Скріншот
          </button>
          <button
            onClick={handleOCR}
            disabled={busy}
            style={btnStyle}
          >
            Розпізнати текст
          </button>
        </div>
        {screenshotPath && (
          <p style={{ fontSize: 11, color: '#666', marginBottom: 8 }}>
            Скріншот: {screenshotPath}
          </p>
        )}
        {ocrTexts.length > 0 && (
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
              <span style={{ fontSize: 12, color: '#888' }}>
                {ocrTexts.length} фрагментів
              </span>
              <button
                onClick={copyOcrToClipboard}
                style={{ ...btnStyle, padding: '4px 10px', fontSize: 12 }}
              >
                Скопіювати все
              </button>
            </div>
            <div style={{ maxHeight: 300, overflowY: 'auto' }}>
              {ocrTexts.map((text, i) => (
                <div
                  key={i}
                  onClick={() => copyOcrLine(text)}
                  style={{
                    padding: '6px 10px', marginBottom: 4,
                    background: '#111', borderRadius: 4,
                    color: '#ddd', fontSize: 13,
                    fontFamily: 'monospace', cursor: 'pointer',
                    border: '1px solid #2a2a3e',
                    transition: 'background 0.15s',
                  }}
                  onMouseEnter={(e) => e.target.style.background = '#1a1a2e'}
                  onMouseLeave={(e) => e.target.style.background = '#111'}
                >
                  {text}
                </div>
              ))}
            </div>
            <p style={{ fontSize: 11, color: '#666', marginTop: 6 }}>
              Натисни на фрагмент щоб скопіювати його в буфер ПК
            </p>
          </div>
        )}
      </div>

      {busy && (
        <div style={{ textAlign: 'center', color: '#888', fontSize: 13 }}>
          Виконую...
        </div>
      )}
    </div>
  )
}

const btnStyle = {
  padding: '8px 16px',
  background: '#333',
  color: '#fff',
  border: '1px solid #444',
  borderRadius: 6,
  cursor: 'pointer',
  fontSize: 13,
  transition: 'background 0.15s',
}