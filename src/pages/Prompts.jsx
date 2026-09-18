import { useState, useEffect } from 'react'
import './Pages.css'

const isElectron = typeof window !== 'undefined' && !!window.api
const PYTHON_PORT = 8765

export default function Prompts() {
  const [data, setData] = useState({ styles: {} })
  const [selected, setSelected] = useState(null) // { style, index }
  const [editText, setEditText] = useState('')
  const [editVideoText, setEditVideoText] = useState('')
  const [editName, setEditName] = useState('')
  const [saved, setSaved] = useState(false)
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState(null) // null | 'image' | 'video' | 'done'
  const [genImageUrl, setGenImageUrl] = useState(null)
  const [genImagePath, setGenImagePath] = useState(null)
  const [genVideoUrl, setGenVideoUrl] = useState(null)
  const [genError, setGenError] = useState(null)
  const [settings, setSettings] = useState(null)

  useEffect(() => {
    load()
    if (isElectron) window.api.settings.get().then(s => setSettings(s))
  }, [])

  const load = async () => {
    setLoading(true)
    if (isElectron) {
      const result = await window.api.python.getPrompts()
      if (result?.styles) setData(result)
    }
    setLoading(false)
  }

  const selectVariant = (style, index) => {
    const variant = data.styles[style].variants[index]
    setSelected({ style, index })
    setEditText(variant.prompt)
    setEditVideoText(variant.video_prompt || '')
    setEditName(variant.name)
    setGenerating(null)
    setGenImageUrl(null)
    setGenVideoUrl(null)
    setGenError(null)
  }

  const saveVariant = () => {
    if (!selected) return
    const next = JSON.parse(JSON.stringify(data))
    next.styles[selected.style].variants[selected.index] = {
      name: editName,
      prompt: editText,
      video_prompt: editVideoText,
    }
    setData(next)
  }

  const handleGenerate = async () => {
    if (!selected || !isElectron) return
    saveVariant()
    setGenError(null)
    setGenImageUrl(null)
    setGenVideoUrl(null)

    // Step 1: Generate image
    setGenerating('image')
    try {
      const provider = settings?.imageApi?.provider || 'google'
      let imgRes

      if (provider === 'flow') {
        // For Hokan: generate prompt via Claude CLI first
        let flowPrompt = editText
        if (selected.style === 'Hokan') {
          try {
            const pr = await window.api.python.generatePrompt({
              style: 'Hokan',
              custom_prompt: '',
              claude_api_key: 'cli',
            })
            if (pr?.ok && pr?.prompt) {
              flowPrompt = pr.prompt
              setEditVideoText(pr.video_prompt || editVideoText)
            }
          } catch {}
        }
        const flowRes = await window.api.python.generateFlow({
          prompt: flowPrompt,
          project_url: settings?.googleFlow?.projectUrl || '',
          gemini_api_key: settings?.googleFlow?.geminiApiKey || '',
        })
        if (!flowRes?.ok) { setGenError(flowRes?.error || 'Flow error'); setGenerating(null); return }
        // Wait and download
        await new Promise(r => setTimeout(r, 3000))
        imgRes = await window.api.python.downloadFlowLatest({
          project_url: settings?.googleFlow?.projectUrl || '',
        })
      } else {
        imgRes = await window.api.python.generateImage({
          style: selected.style,
          prompt: '',
          quote: '',
          variant_index: selected.index,
          provider,
          api_key: settings?.imageApi?.apiKey || '',
          claude_api_key: settings?.claudeApi?.apiKey || '',
          gemini_api_key: provider === 'google' ? (settings?.imageApi?.apiKey || '') : '',
        })
      }

      if (!imgRes?.ok) { setGenError(imgRes?.error || 'Image error'); setGenerating(null); return }
      const imgFn = imgRes.path.split(/[/\\]/).pop()
      setGenImagePath(imgRes.path)
      setGenImageUrl(`http://127.0.0.1:${PYTHON_PORT}/files/${imgFn}`)

      // Step 2: Generate video
      setGenerating('video')
      const vidRes = await window.api.python.generateVideo({
        image_path: imgRes.path,
        prompt: editVideoText || editText,
        provider: 'nhungoc_veo3',
        api_key: '',
      })
      if (!vidRes.ok) { setGenError(vidRes.error); setGenerating(null); return }
      const vidFn = vidRes.path.split(/[/\\]/).pop()
      setGenVideoUrl(`http://127.0.0.1:${PYTHON_PORT}/files/${vidFn}`)
      setGenerating('done')
    } catch (e) {
      setGenError(String(e))
      setGenerating(null)
    }
  }

  const addVariant = (style) => {
    const next = JSON.parse(JSON.stringify(data))
    const newVariant = { name: 'Новий варіант', prompt: '' }
    next.styles[style].variants.push(newVariant)
    const index = next.styles[style].variants.length - 1
    setData(next)
    setSelected({ style, index })
    setEditText('')
    setEditName('Новий варіант')
  }

  const deleteVariant = (style, index) => {
    const next = JSON.parse(JSON.stringify(data))
    next.styles[style].variants.splice(index, 1)
    setData(next)
    if (selected?.style === style && selected?.index === index) {
      setSelected(null)
      setEditText('')
      setEditName('')
    }
  }

  const handleSaveAll = async () => {
    if (selected) saveVariant()
    if (isElectron) {
      await window.api.python.savePrompts(data)
    }
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  const styles = Object.keys(data.styles)

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">📝 Шаблони промптів</h1>
        <button className="btn-primary" onClick={handleSaveAll}>
          {saved ? '✅ Збережено!' : '💾 Зберегти'}
        </button>
      </div>

      {loading ? (
        <div className="empty-state"><div className="spinner" /></div>
      ) : (
        <div className="prompts-layout">

          {/* Ліва панель — список стилів і варіантів */}
          <div className="prompts-sidebar">
            {styles.map(style => (
              <div key={style} className="prompts-style-group">
                <div className="prompts-style-header">
                  <span>{style}</span>
                  <button className="btn-ghost" style={{ fontSize: 18, padding: '2px 8px' }} onClick={() => addVariant(style)}>+</button>
                </div>
                {data.styles[style].variants.map((v, i) => (
                  <div
                    key={i}
                    className={`prompts-variant ${selected?.style === style && selected?.index === i ? 'prompts-variant--active' : ''}`}
                    onClick={() => selectVariant(style, i)}
                  >
                    <span className="prompts-variant-name">{v.name}</span>
                    <button
                      className="btn-ghost prompts-delete"
                      onClick={e => { e.stopPropagation(); deleteVariant(style, i) }}
                    >✕</button>
                  </div>
                ))}
              </div>
            ))}
          </div>

          {/* Права панель — редактор */}
          <div className="prompts-editor">
            {selected ? (
              <>
                <div className="form-section">
                  <label className="form-label">Назва</label>
                  <input
                    className="form-input"
                    value={editName}
                    onChange={e => setEditName(e.target.value)}
                    onBlur={saveVariant}
                  />
                </div>

                <div className="form-section">
                  <label className="form-label">Image Prompt</label>
                  <textarea
                    className="form-textarea"
                    value={editText}
                    onChange={e => setEditText(e.target.value)}
                    onBlur={saveVariant}
                    rows={5}
                  />
                </div>

                <div className="form-section">
                  <label className="form-label">Video Prompt</label>
                  <textarea
                    className="form-textarea"
                    value={editVideoText}
                    onChange={e => setEditVideoText(e.target.value)}
                    onBlur={saveVariant}
                    rows={5}
                  />
                </div>

                {/* Generate button */}
                <button
                  className="btn-primary"
                  style={{ width: '100%', marginTop: 8, background: '#6366f1' }}
                  onClick={handleGenerate}
                  disabled={!!generating && generating !== 'done'}
                >
                  {generating === 'image' ? '⏳ Генерація картинки...' :
                   generating === 'video' ? '⏳ Генерація відео (1-3 хв)...' :
                   generating === 'done' ? '✅ Готово! Згенерувати ще' :
                   '⚡ Згенерувати картинку + відео'}
                </button>

                {genError && (
                  <div style={{ background: 'rgba(239,68,68,0.15)', color: '#f87171', padding: '8px 12px', borderRadius: 8, fontSize: 12, marginTop: 8 }}>
                    {genError}
                  </div>
                )}

                {/* Preview */}
                {(genImageUrl || genVideoUrl) && (
                  <div style={{ display: 'flex', gap: 12, marginTop: 12 }}>
                    {genImageUrl && (
                      <div style={{ flex: 1 }}>
                        <div className="form-label" style={{ marginBottom: 4, fontSize: 11 }}>Картинка</div>
                        <img src={genImageUrl} alt="" style={{ width: '100%', borderRadius: 8 }} />
                      </div>
                    )}
                    {genVideoUrl && (
                      <div style={{ flex: 1 }}>
                        <div className="form-label" style={{ marginBottom: 4, fontSize: 11 }}>Відео</div>
                        <video src={genVideoUrl} controls loop style={{ width: '100%', borderRadius: 8 }} />
                      </div>
                    )}
                  </div>
                )}

                {generating === 'image' && (
                  <div style={{ textAlign: 'center', padding: 20 }}><div className="spinner" /></div>
                )}
                {generating === 'video' && genImageUrl && (
                  <div style={{ textAlign: 'center', padding: 20, position: 'relative' }}>
                    <img src={genImageUrl} alt="" style={{ width: '60%', borderRadius: 8, opacity: 0.4 }} />
                    <div className="spinner" style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)' }} />
                  </div>
                )}
              </>
            ) : (
              <div className="empty-state">
                <div style={{ fontSize: 40 }}>📝</div>
                <div>Оберіть варіант для редагування</div>
                <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 8 }}>
                  або натисніть + щоб додати новий
                </div>
              </div>
            )}
          </div>

        </div>
      )}
    </div>
  )
}
