import { useState, useEffect } from 'react'

// UTM Builder — вбудований в Reels Generator як React-компонент, щоб не
// залежати від Electron-налаштувань (file:// iframe блокується при
// contextIsolation: true). Логіка ідентична попередньому utm-builder.html:
// 5 стандартних UTM-параметрів + ref, пресети в localStorage, копіювання.

const FIELDS = [
  { id: 'source',   label: 'utm_source',   placeholder: 'instagram, reddit, twitter, youtube' },
  { id: 'medium',   label: 'utm_medium',   placeholder: 'story, post, reel, bio, comment' },
  { id: 'campaign', label: 'utm_campaign', placeholder: 'warrior_vs_modern, samurai_honor' },
  { id: 'content',  label: 'utm_content',  placeholder: 'l1_comparison, hook_01, cta_blue' },
  { id: 'term',     label: 'utm_term',     placeholder: 'discipline, duty, honor (опц.)' },
  { id: 'ref',      label: 'ref (кастом)', placeholder: 'bio_link, dm_button (опц.)' },
]

const STORAGE_KEY = 'hokan_utm_presets_v1'

export default function UtmBuilder() {
  const [base, setBase] = useState('https://thehokan.vercel.app/')
  const [values, setValues] = useState({
    source: '', medium: '', campaign: '', content: '', term: '', ref: '',
  })
  const [presets, setPresets] = useState([])
  const [toast, setToast] = useState('')

  // Load presets from localStorage on mount. Survives page reload.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) setPresets(JSON.parse(raw))
    } catch { /* ignore */ }
  }, [])

  const setField = (id, v) => setValues((prev) => ({ ...prev, [id]: v }))

  const built = (() => {
    const params = new URLSearchParams()
    const map = { source: 'utm_source', medium: 'utm_medium', campaign: 'utm_campaign', content: 'utm_content', term: 'utm_term' }
    const baseUrl = base.trim() || 'https://thehokan.vercel.app/'
    const safeBase = baseUrl.endsWith('/') || baseUrl.includes('?') ? baseUrl : baseUrl + '/'
    for (const f of FIELDS) {
      const v = values[f.id].trim()
      if (!v) continue
      if (map[f.id]) params.set(map[f.id], v)
      else if (f.id === 'ref') params.set('ref', v)
    }
    const qs = params.toString()
    return qs ? safeBase + '?' + qs : safeBase
  })()

  const showToast = (msg) => {
    setToast(msg)
    setTimeout(() => setToast(''), 1400)
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(built)
      showToast('Скопійовано')
    } catch {
      showToast('Не вдалося скопіювати')
    }
  }

  const savePreset = () => {
    if (!values.source.trim()) {
      showToast('Заповни хоча б source')
      return
    }
    const next = [built, ...presets].slice(0, 20)
    setPresets(next)
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)) } catch { /* ignore */ }
    showToast('Пресет збережено')
  }

  const copyPreset = async (url) => {
    try {
      await navigator.clipboard.writeText(url)
      showToast('Скопійовано')
    } catch {
      showToast('Не вдалося скопіювати')
    }
  }

  const deletePreset = (idx) => {
    const next = presets.filter((_, i) => i !== idx)
    setPresets(next)
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)) } catch { /* ignore */ }
  }

  return (
    <div className="utm-builder-widget">
      <div className="ubw-row">
        <label className="ubw-label">Базова URL лендінгу</label>
        <input
          className="ubw-input"
          value={base}
          onChange={(e) => setBase(e.target.value)}
          placeholder="https://hokan.com/"
        />
      </div>

      <div className="ubw-grid">
        {FIELDS.map((f) => (
          <div key={f.id} className="ubw-row">
            <label className="ubw-label">{f.label}</label>
            <input
              className="ubw-input"
              value={values[f.id]}
              onChange={(e) => setField(f.id, e.target.value)}
              placeholder={f.placeholder}
            />
          </div>
        ))}
      </div>

      <div className="ubw-row">
        <label className="ubw-label">Згенероване посилання</label>
        <div className="ubw-output">{built}</div>
        <div className="ubw-actions">
          <button className="ubw-btn ubw-btn-primary" onClick={copy}>Копіювати</button>
          <button className="ubw-btn" onClick={() => window.open(built, '_blank')}>Відкрити</button>
          <button className="ubw-btn" onClick={savePreset}>+ Зберегти як пресет</button>
        </div>
      </div>

      {presets.length > 0 && (
        <div className="ubw-presets">
          <label className="ubw-label">Збережені пресети ({presets.length})</label>
          <div className="ubw-preset-list">
            {presets.map((url, i) => (
              <div key={i} className="ubw-preset">
                <code className="ubw-preset-url">{url}</code>
                <span className="ubw-preset-actions">
                  <a href={url} target="_blank" rel="noreferrer">open</a>
                  <span> · </span>
                  <a href="#" onClick={(e) => { e.preventDefault(); copyPreset(url) }}>copy</a>
                  <span> · </span>
                  <a href="#" className="ubw-del" onClick={(e) => { e.preventDefault(); deletePreset(i) }}>del</a>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {toast && <div className="ubw-toast">{toast}</div>}
    </div>
  )
}
