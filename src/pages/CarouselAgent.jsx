import { useState, useEffect } from 'react'
import './Pages.css'

// Carousel Agent — автоматичний генератор каруселей "дві крайності" (Modern vs Samurai).
// Ідеї/промпти → Ollama (gpt-oss:120b). Зображення → Google Flow. Текст → PIL overlay.

const isElectron = typeof window !== 'undefined' && !!window.api
const PYTHON_PORT = 8765

const STYLES = ['hokan', 'hokan-cartoon', 'hokan-storybook', 'mushin']

export default function CarouselAgent() {
  const [template, setTemplate] = useState('')
  const [nSlides, setNSlides] = useState(5)
  const [style, setStyle] = useState('hokan')
  const [generateImages, setGenerateImages] = useState(true)
  const [applyText, setApplyText] = useState(true)

  const [idea, setIdea] = useState(null)      // {idea, hook, cta, template}
  const [slides, setSlides] = useState([])     // [{angle, text, image_prompt, image_path, final_path}]
  const [running, setRunning] = useState(false)
  const [step, setStep] = useState('')         // поточний крок для статусу
  const [msg, setMsg] = useState(null)
  const [settings, setSettings] = useState(null)

  useEffect(() => {
    if (!isElectron) return
    window.api.settings.get().then(s => { if (s) setSettings(s) })
  }, [])

  const ollamaParams = () => ({
    model: settings?.ollama?.model || '',
    endpoint: settings?.ollama?.endpoint || '',
    api_key: settings?.ollama?.apiKey || '',
  })

  // Крок 1: тільки ідея
  const handleGenerateIdea = async () => {
    setRunning(true); setStep('Генерую ідею через Ollama...'); setMsg(null)
    try {
      const r = await window.api.python.carouselAgentIdea({
        template, n_slides: nSlides, style, ...ollamaParams(),
      })
      if (!r.ok) { setMsg({ type: 'err', text: r.error || 'Ollama fail' }); return }
      setIdea(r)
      setMsg({ type: 'ok', text: `💡 Ідея: ${r.idea}` })
    } catch (e) {
      setMsg({ type: 'err', text: String(e) })
    }
    setRunning(false); setStep('')
  }

  // Крок 2: слайди з ідеї (без зображень)
  const handleGenerateSlides = async () => {
    if (!idea?.idea) { setMsg({ type: 'err', text: 'Спершу згенеруй ідею' }); return }
    setRunning(true); setStep('Генерую слайди через Ollama...'); setMsg(null)
    try {
      const r = await window.api.python.carouselAgentSlides({
        template: idea.idea, n_slides: nSlides, style, ...ollamaParams(),
      })
      if (!r.ok) { setMsg({ type: 'err', text: r.error || 'Ollama fail' }); return }
      setSlides(r.slides || [])
      setMsg({ type: 'ok', text: `📚 Згенеровано ${r.slides?.length || 0} слайдів` })
    } catch (e) {
      setMsg({ type: 'err', text: String(e) })
    }
    setRunning(false); setStep('')
  }

  // Повний пайплайн: ідея → слайди → зображення → текст
  const handleRunFull = async () => {
    setRunning(true); setStep('Запускаю повний пайплайн (ідея → слайди → зображення → текст)...'); setMsg(null)
    try {
      const r = await window.api.python.carouselAgentRun({
        template, n_slides: nSlides, style,
        generate_images: generateImages, apply_text: applyText,
        ...ollamaParams(),
      })
      if (!r.ok) { setMsg({ type: 'err', text: r.error || 'Agent fail' }); return }
      setIdea({ idea: r.idea, hook: r.hook, cta: r.cta, template: r.template })
      setSlides(r.slides || [])
      const withImg = (r.slides || []).filter(s => s.image_path).length
      setMsg({ type: 'ok', text: `✅ Готово: ${r.slides?.length || 0} слайдів, ${withImg} з зображеннями` })
    } catch (e) {
      setMsg({ type: 'err', text: String(e) })
    }
    setRunning(false); setStep('')
  }

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">🤖 Carousel Agent</h1>
      </div>

      {/* Налаштування */}
      <div className="card" style={{ padding: 16, marginBottom: 12 }}>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
            Слайдів:
            <input type="range" min="2" max="10" value={nSlides}
              onChange={e => setNSlides(+e.target.value)} />
            <b style={{ minWidth: 20 }}>{nSlides}</b>
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
            Стиль:
            <select className="form-select" value={style} onChange={e => setStyle(e.target.value)}>
              {STYLES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
            <input type="checkbox" checked={generateImages} onChange={e => setGenerateImages(e.target.checked)} />
            Генерувати зображення (Flow)
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
            <input type="checkbox" checked={applyText} onChange={e => setApplyText(e.target.checked)} />
            Накладати текст
          </label>
        </div>

        <div style={{ marginTop: 12 }}>
          <label className="form-label" style={{ fontSize: 12 }}>
            🎯 Шаблон ідеї (порожньо = випадковий з бібліотеки):
          </label>
          <input className="form-input" style={{ width: '100%' }}
            placeholder="наприклад: The average millionaire is 57. You are not behind."
            value={template} onChange={e => setTemplate(e.target.value)} />
        </div>

        <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
          <button className="btn-primary" onClick={handleRunFull} disabled={running} style={{ flex: 1 }}>
            {running ? `⏳ ${step}` : '🚀 Запустити повний пайплайн'}
          </button>
          <button className="btn-secondary" onClick={handleGenerateIdea} disabled={running}>
            💡 Тільки ідея
          </button>
          <button className="btn-secondary" onClick={handleGenerateSlides} disabled={running || !idea?.idea}>
            📚 Тільки слайди
          </button>
        </div>

        {msg && (
          <div style={{ marginTop: 10, padding: '8px 12px', borderRadius: 6, fontSize: 13,
            background: msg.type === 'err' ? 'rgba(239,68,68,0.1)' : 'rgba(34,197,94,0.1)',
            color: msg.type === 'err' ? '#ef4444' : '#22c55e' }}>
            {msg.text}
          </div>
        )}
      </div>

      {/* Ідея */}
      {idea?.idea && (
        <div className="card" style={{ padding: 16, marginBottom: 12, background: 'rgba(99,102,241,0.05)' }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>💡 Ідея</div>
          <div style={{ fontSize: 15, fontWeight: 600 }}>{idea.idea}</div>
          {idea.hook && <div style={{ fontSize: 12, marginTop: 6 }}>🎣 Hook: <i>{idea.hook}</i></div>}
          {idea.cta && <div style={{ fontSize: 12, marginTop: 4 }}>🎯 CTA: <i>{idea.cta}</i></div>}
          {idea.template && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>Шаблон: {idea.template}</div>}
        </div>
      )}

      {/* Слайди */}
      {slides.length > 0 && (
        <div className="card" style={{ padding: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>
            📚 Слайди ({slides.length})
          </div>
          {slides.map((sl, i) => (
            <div key={i} style={{
              display: 'flex', gap: 12, padding: '10px 0',
              borderBottom: i < slides.length - 1 ? '1px solid var(--border)' : 'none',
            }}>
              <div style={{ minWidth: 60, textAlign: 'center' }}>
                {sl.image_path ? (
                  <img src={`http://127.0.0.1:${PYTHON_PORT}/files/${sl.image_path.split(/[/\\]/).pop()}`}
                    alt="" style={{ width: 60, height: 60, objectFit: 'cover', borderRadius: 6 }} />
                ) : (
                  <div style={{ width: 60, height: 60, borderRadius: 6, background: 'var(--bg)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20 }}>
                    {i + 1}
                  </div>
                )}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 11, color: '#6366f1' }}>📐 {sl.angle || '—'}</div>
                <div style={{ fontSize: 13, fontWeight: 500, marginTop: 2 }}>{sl.text || ''}</div>
                {sl.error && <div style={{ fontSize: 11, color: '#ef4444', marginTop: 2 }}>⚠️ {sl.error}</div>}
                {sl.image_prompt && (
                  <details style={{ marginTop: 4 }}>
                    <summary style={{ fontSize: 11, color: 'var(--text-muted)', cursor: 'pointer' }}>
                      Image prompt
                    </summary>
                    <pre style={{ fontSize: 10, whiteSpace: 'pre-wrap', marginTop: 4, maxHeight: 120, overflow: 'auto' }}>
                      {sl.image_prompt}
                    </pre>
                  </details>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
