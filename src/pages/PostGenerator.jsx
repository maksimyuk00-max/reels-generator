import { useState, useEffect } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import './Pages.css'

// Ізольована вкладка для генерації IG постів і карусель.
// НЕ чіпає Reels pipeline (VideoGenerator.jsx).
// Формат 1:1 (1080x1080). Reuse: style presets (hokan/mushin).

const isElectron = typeof window !== 'undefined' && !!window.api
const PYTHON_PORT = 8765
const STYLES = ['hokan', 'mushin']

export default function PostGenerator() {
  const location = useLocation()
  const navigate = useNavigate()
  const [editingId, setEditingId] = useState(null)
  const [contentType, setContentType] = useState('post') // 'post' | 'carousel'
  const [nSlides, setNSlides] = useState(5)
  const [style, setStyle] = useState('mushin')
  const [topic, setTopic] = useState('')

  // Slides: [{ prompt, angle, imagePath, imageUrl, textOverlay, textSize, textPosition, originalImagePath }]
  // originalImagePath зберігає AI-згенерований image (до overlay) щоб можна було re-apply overlay при зміні тексту
  const makeEmptySlide = () => ({
    prompt: '', angle: '',
    imagePath: null, imageUrl: null, originalImagePath: null,
    textOverlay: '', textSize: 120, textPosition: 50,
  })
  const [slides, setSlides] = useState([makeEmptySlide()])
  const [activeIdx, setActiveIdx] = useState(0)

  const [sceneAnchor, setSceneAnchor] = useState('')
  const [caption, setCaption] = useState('')
  const [hashtags, setHashtags] = useState('')

  const [generatingPrompts, setGeneratingPrompts] = useState(false)
  const [generatingImageIdx, setGeneratingImageIdx] = useState(-1)
  const [generatingCaption, setGeneratingCaption] = useState(false)
  const [applyingOverlayIdx, setApplyingOverlayIdx] = useState(-1)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState(null)
  const [settings, setSettings] = useState(null)

  useEffect(() => {
    if (!isElectron) return
    window.api.settings.get().then(s => { if (s) setSettings(s) })
  }, [])

  // Завантаження gen з History → редагування
  useEffect(() => {
    const gen = location.state?.editGen
    if (!gen) return

    setEditingId(gen.id)
    if (gen.style) setStyle(gen.style)
    if (gen.content_type) setContentType(gen.content_type === 'carousel' ? 'carousel' : 'post')
    if (gen.quote) setTopic(gen.quote)
    if (gen.image_prompt) setSceneAnchor(gen.image_prompt)

    // Caption (splitting hashtags)
    if (gen.caption) {
      const parts = gen.caption.split(/\n\n+/)
      const hashPart = parts.findIndex(p => p.trim().startsWith('#'))
      if (hashPart >= 0) {
        setCaption(parts.slice(0, hashPart).join('\n\n'))
        setHashtags(parts.slice(hashPart).join('\n\n'))
      } else {
        setCaption(gen.caption)
      }
    }

    // Loading slides
    let parsedSlides = []
    try { parsedSlides = JSON.parse(gen.slides_json || '[]') } catch {}
    if (parsedSlides.length > 0) {
      setNSlides(parsedSlides.length)
      const loaded = parsedSlides.map(sl => {
        const fn = (sl.image_path || '').split(/[/\\]/).pop()
        return {
          prompt: sl.prompt || '',
          angle: sl.angle || '',
          imagePath: sl.image_path || null,
          imageUrl: sl.image_path ? `http://127.0.0.1:${PYTHON_PORT}/files/${fn}` : null,
          originalImagePath: sl.image_path || null,
          textOverlay: sl.text_overlay || '',
          textSize: sl.text_size || 120,
          textPosition: sl.text_position || 50,
        }
      })
      setSlides(loaded)
    } else if (gen.image_path) {
      // Single image fallback
      const fn = gen.image_path.split(/[/\\]/).pop()
      setSlides([{
        prompt: gen.image_prompt || '',
        angle: '',
        imagePath: gen.image_path,
        imageUrl: `http://127.0.0.1:${PYTHON_PORT}/files/${fn}`,
        originalImagePath: gen.image_path,
        textOverlay: '',
        textSize: 120,
        textPosition: 50,
      }])
    }

    // Clear state щоб при F5 не дублювало
    navigate(location.pathname, { replace: true, state: {} })
  }, [])

  // Змінюємо кількість слайдів для carousel → додаємо/видаляємо слоти
  useEffect(() => {
    if (contentType === 'post') {
      setSlides(cur => cur.slice(0, 1).length ? cur.slice(0, 1) : [makeEmptySlide()])
      setActiveIdx(0)
      return
    }
    setSlides(cur => {
      if (cur.length === nSlides) return cur
      if (cur.length < nSlides) {
        return [...cur, ...Array(nSlides - cur.length).fill(0).map(() => makeEmptySlide())]
      }
      return cur.slice(0, nSlides)
    })
    if (activeIdx >= nSlides) setActiveIdx(0)
  }, [contentType, nSlides])

  const updateSlide = (idx, patch) => {
    setSlides(cur => cur.map((s, i) => i === idx ? { ...s, ...patch } : s))
  }

  // AI генерує scene_anchor + N angle prompts
  const handleGeneratePrompts = async () => {
    setGeneratingPrompts(true); setMsg(null)
    try {
      const n = contentType === 'carousel' ? nSlides : 1
      const r = await window.api.python.generateCarouselPrompts({
        style, topic,
        n_slides: n,
        claude_api_key: settings?.claudeApi?.apiKey || '',
      })
      if (!r.ok) { setMsg({ type: 'err', text: r.error || 'Claude fail' }); return }
      setSceneAnchor(r.scene_anchor || '')
      setSlides(cur => cur.map((s, i) => {
        const sl = r.slides?.[i]
        if (!sl) return s
        return { ...s, prompt: sl.prompt || '', angle: sl.angle || '' }
      }))
      setMsg({ type: 'ok', text: `✨ Згенеровано ${r.slides?.length || 0} prompt-ів` })
    } catch (e) {
      setMsg({ type: 'err', text: String(e) })
    }
    setGeneratingPrompts(false)
  }

  // Генерує зображення через Google Flow (1:1) — той же pipeline що Reels
  const handleGenerateImage = async (idx) => {
    const sl = slides[idx]
    if (!sl?.prompt) { setMsg({ type: 'err', text: `Slide ${idx + 1}: пустий prompt` }); return }
    setGeneratingImageIdx(idx); setMsg(null)
    try {
      const r = await window.api.python.generatePostImage({
        prompt: sl.prompt,
        style,
        project_url: settings?.googleFlow?.projectUrl || '',
        aspect: '1:1',
      })
      if (!r.ok) { setMsg({ type: 'err', text: `Slide ${idx + 1}: ${r.error}` }); return }
      const filename = (r.filename || r.path?.split(/[/\\]/).pop())
      updateSlide(idx, {
        imagePath: r.path,
        imageUrl: `http://127.0.0.1:${PYTHON_PORT}/files/${filename}`,
        originalImagePath: r.path,  // зберігаємо original щоб re-apply overlay з чистого image
      })
      setMsg({ type: 'ok', text: `🎨 Slide ${idx + 1} згенеровано` })
    } catch (e) {
      setMsg({ type: 'err', text: String(e) })
    }
    setGeneratingImageIdx(-1)
  }

  // Генерує всі слайди підряд
  const handleGenerateAllImages = async () => {
    for (let i = 0; i < slides.length; i++) {
      if (slides[i].prompt && !slides[i].imagePath) {
        await handleGenerateImage(i)
      }
    }
  }

  // Генерує caption+hashtags через Claude CLI (reuse Reels endpoint)
  const handleGenerateCaption = async () => {
    setGeneratingCaption(true); setMsg(null)
    try {
      // Беремо image_prompt першого слайду як контекст для Claude
      const firstPrompt = slides[0]?.prompt || ''
      const r = await window.api.python.generateCaption({
        style,
        custom_text: topic || '',
        claude_api_key: settings?.claudeApi?.apiKey || '',
        quote: '',
        image_prompt: firstPrompt,
        video_prompt: '',
      })
      if (!r.ok) { setMsg({ type: 'err', text: r.error || 'Claude fail' }); return }
      setCaption(r.caption || '')
      setHashtags(r.hashtags || '')
      setMsg({ type: 'ok', text: '✨ Caption згенеровано' })
    } catch (e) {
      setMsg({ type: 'err', text: String(e) })
    }
    setGeneratingCaption(false)
  }

  // Burn text overlay на картинку через PIL
  const handleApplyOverlay = async (idx) => {
    const sl = slides[idx]
    if (!sl) return
    const source = sl.originalImagePath || sl.imagePath
    if (!source) { setMsg({ type: 'err', text: `Slide ${idx + 1}: немає image` }); return }
    if (!sl.textOverlay) { setMsg({ type: 'err', text: `Slide ${idx + 1}: порожній text` }); return }
    setApplyingOverlayIdx(idx); setMsg(null)
    try {
      const r = await window.api.python.renderPostOverlay({
        image_path: source,
        text: sl.textOverlay,
        font_size: sl.textSize || 120,
        position: sl.textPosition || 50,
        color: 'white',
        stroke_color: 'black',
        stroke_width: 6,
      })
      if (!r.ok) { setMsg({ type: 'err', text: `Slide ${idx + 1}: ${r.error}` }); return }
      const filename = r.path.split(/[/\\]/).pop()
      updateSlide(idx, {
        imagePath: r.path,
        imageUrl: `http://127.0.0.1:${PYTHON_PORT}/files/${filename}?t=${Date.now()}`,
      })
      setMsg({ type: 'ok', text: `✏️ Overlay застосовано на slide ${idx + 1}` })
    } catch (e) {
      setMsg({ type: 'err', text: String(e) })
    }
    setApplyingOverlayIdx(-1)
  }

  // Remove overlay — повернутись до originalImagePath
  const handleRemoveOverlay = (idx) => {
    const sl = slides[idx]
    if (!sl?.originalImagePath) return
    const filename = sl.originalImagePath.split(/[/\\]/).pop()
    updateSlide(idx, {
      imagePath: sl.originalImagePath,
      imageUrl: `http://127.0.0.1:${PYTHON_PORT}/files/${filename}?t=${Date.now()}`,
    })
  }

  // Upload image з диску
  const handleUploadImage = async (idx) => {
    if (!isElectron) return
    const p = await window.api.dialog.openFile({
      title: 'Оберіть зображення',
      filters: [{ name: 'Image', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
    })
    if (!p) return
    const filename = p.split(/[/\\]/).pop()
    updateSlide(idx, { imagePath: p, imageUrl: `http://127.0.0.1:${PYTHON_PORT}/files/${filename}` })
  }

  // Підготовка payload для save/update
  const buildPayload = () => {
    const slidesPayload = slides.map((s, i) => ({
      order: i, image_path: s.imagePath, prompt: s.prompt,
      angle: s.angle, text_overlay: s.textOverlay || '',
      text_size: s.textSize || 120, text_position: s.textPosition || 50,
    }))
    return {
      style,
      variant_name: '',
      quote: topic || '',
      image_prompt: sceneAnchor || '',
      image_provider: settings?.imageProvider || 'replicate',
      image_path: slides[0]?.imagePath || '',  // cover
      video_path: '',
      final_path: '',
      music_path: '',
      logo_path: '',
      caption: [caption, hashtags].filter(Boolean).join('\n\n'),
      content_type: contentType,
      slides_json: JSON.stringify(slidesPayload),
    }
  }

  // Зберегти як НОВА генерація (завжди новий запис у БД)
  const handleSaveDraft = async () => {
    if (!slides.some(s => s.imagePath)) { setMsg({ type: 'err', text: 'Немає жодного згенерованого зображення' }); return }
    setSaving(true); setMsg(null)
    try {
      await window.api.generations.save(buildPayload())
      setMsg({ type: 'ok', text: '💾 Збережено в Історію як нова' })
    } catch (e) {
      setMsg({ type: 'err', text: String(e) })
    }
    setSaving(false)
  }

  // Оновити існуючий запис (коли редагуємо з Історії)
  const handleUpdate = async () => {
    if (!editingId) return handleSaveDraft()
    if (!slides.some(s => s.imagePath)) { setMsg({ type: 'err', text: 'Немає жодного зображення' }); return }
    setSaving(true); setMsg(null)
    try {
      await window.api.generations.update(editingId, buildPayload())
      setMsg({ type: 'ok', text: `💾 Оновлено #${editingId}` })
    } catch (e) {
      setMsg({ type: 'err', text: String(e) })
    }
    setSaving(false)
  }

  const active = slides[activeIdx] || slides[0]

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">
          📸 Генератор постів
          {editingId && (
            <span style={{ fontSize: 13, marginLeft: 12, padding: '4px 10px', borderRadius: 6,
              background: 'rgba(59,130,246,0.15)', color: '#3b82f6', fontWeight: 500, verticalAlign: 'middle' }}>
              ✏️ Редагування #{editingId}
            </span>
          )}
        </h1>
      </div>

      {/* Тип + стиль */}
      <div className="card" style={{ padding: 16, marginBottom: 12 }}>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
          <div style={{ display: 'flex', gap: 6 }}>
            {[
              { val: 'post',     label: '🖼️ Пост',      tip: '1 зображення' },
              { val: 'carousel', label: '📚 Карусель', tip: '2-10 слайдів' },
            ].map(opt => (
              <button
                key={opt.val}
                onClick={() => setContentType(opt.val)}
                title={opt.tip}
                className={contentType === opt.val ? 'btn-primary' : 'btn-ghost'}
                style={{ fontSize: 13, padding: '6px 14px' }}
              >{opt.label}</button>
            ))}
          </div>

          {contentType === 'carousel' && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
              Слайдів:
              <input type="range" min="2" max="10" value={nSlides}
                onChange={e => setNSlides(+e.target.value)} />
              <b style={{ minWidth: 20 }}>{nSlides}</b>
            </label>
          )}

          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
            Стиль:
            <select className="form-select" value={style} onChange={e => setStyle(e.target.value)}>
              {STYLES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
        </div>

        <div style={{ marginTop: 12 }}>
          <label className="form-label" style={{ fontSize: 12 }}>🎯 Тема / ідея (optional — Claude сам придумає якщо пусто):</label>
          <input className="form-input" style={{ width: '100%' }}
            placeholder="наприклад: ранкова медитація воїна, цитата Марка Аврелія..."
            value={topic} onChange={e => setTopic(e.target.value)} />
        </div>

        <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
          <button className="btn-primary" onClick={handleGeneratePrompts}
            disabled={generatingPrompts} style={{ flex: 1 }}>
            {generatingPrompts ? '⏳ Claude думає...' : '🤖 Згенерувати AI prompts'}
          </button>
          <button className="btn-secondary" onClick={handleGenerateAllImages}
            disabled={generatingImageIdx !== -1 || slides.every(s => !s.prompt)}>
            🎨 Згенерувати всі зображення
          </button>
        </div>
      </div>

      {/* Scene anchor preview (для carousel) */}
      {sceneAnchor && contentType === 'carousel' && (
        <div className="card" style={{ padding: 10, marginBottom: 12, background: 'rgba(99,102,241,0.05)' }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>🎭 Scene anchor (shared у всіх слайдах):</div>
          <div style={{ fontSize: 12 }}>{sceneAnchor}</div>
        </div>
      )}

      {/* Слайди */}
      <div className="card" style={{ padding: 16, marginBottom: 12 }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
          {slides.map((s, i) => (
            <button
              key={i}
              onClick={() => setActiveIdx(i)}
              style={{
                position: 'relative',
                width: 70, height: 70, borderRadius: 8,
                border: `2px solid ${activeIdx === i ? '#6366f1' : 'var(--border)'}`,
                background: s.imageUrl ? `url(${s.imageUrl}) center/cover` : 'var(--bg)',
                cursor: 'pointer', padding: 0, color: '#fff',
              }}
            >
              <span style={{ position: 'absolute', top: 4, left: 6, fontSize: 11, fontWeight: 600,
                textShadow: '0 1px 3px #000', background: 'rgba(0,0,0,0.5)', padding: '1px 5px', borderRadius: 4 }}>
                {i + 1}
              </span>
              {!s.imageUrl && <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>empty</span>}
            </button>
          ))}
        </div>

        {/* Активний слайд */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, alignItems: 'start' }}>
          <div>
            {/* Preview 1:1 */}
            <div style={{ width: '100%', aspectRatio: '1/1', background: 'var(--bg)',
              borderRadius: 8, overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center',
              border: '1px solid var(--border)' }}>
              {active?.imageUrl
                ? <img src={active.imageUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                : <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>Немає зображення</span>}
            </div>
          </div>

          <div>
            {active?.angle && (
              <div style={{ fontSize: 11, color: '#6366f1', marginBottom: 6 }}>
                📐 {active.angle}
              </div>
            )}
            <label className="form-label" style={{ fontSize: 12 }}>Image prompt:</label>
            <textarea
              className="form-textarea"
              value={active?.prompt || ''}
              onChange={e => updateSlide(activeIdx, { prompt: e.target.value })}
              rows={5}
              style={{ width: '100%', fontFamily: 'monospace', fontSize: 12 }}
            />
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button className="btn-primary" onClick={() => handleGenerateImage(activeIdx)}
                disabled={generatingImageIdx === activeIdx || !active?.prompt}
                style={{ flex: 1, fontSize: 12 }}>
                {generatingImageIdx === activeIdx ? '⏳' : active?.imagePath ? '🔄 Перегенерувати' : '🎨 Згенерувати image'}
              </button>
              <button className="btn-ghost" onClick={() => handleUploadImage(activeIdx)}
                style={{ fontSize: 12 }}>
                📁 Upload
              </button>
            </div>

            <label className="form-label" style={{ fontSize: 12, marginTop: 12, display: 'block' }}>
              💬 Text overlay (optional):
            </label>
            <input className="form-input" style={{ width: '100%' }}
              placeholder="Напр: WARRIOR"
              value={active?.textOverlay || ''}
              onChange={e => updateSlide(activeIdx, { textOverlay: e.target.value })} />

            {active?.textOverlay && (
              <>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, marginTop: 8 }}>
                  <span style={{ minWidth: 65 }}>Розмір: <b>{active.textSize || 120}</b></span>
                  <input type="range" min="40" max="300" step="10"
                    value={active.textSize || 120}
                    onChange={e => updateSlide(activeIdx, { textSize: +e.target.value })}
                    style={{ flex: 1 }} />
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, marginTop: 4 }}>
                  <span style={{ minWidth: 65 }}>Позиція: <b>{active.textPosition || 50}%</b></span>
                  <input type="range" min="5" max="95" step="5"
                    value={active.textPosition || 50}
                    onChange={e => updateSlide(activeIdx, { textPosition: +e.target.value })}
                    style={{ flex: 1 }} />
                  <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>0=верх, 100=низ</span>
                </label>
                <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                  <button
                    className="btn-primary"
                    onClick={() => handleApplyOverlay(activeIdx)}
                    disabled={applyingOverlayIdx === activeIdx || !active.imagePath}
                    style={{ flex: 1, fontSize: 11 }}
                  >
                    {applyingOverlayIdx === activeIdx ? '⏳' : '✏️ Застосувати на картинку'}
                  </button>
                  {active.originalImagePath && active.imagePath !== active.originalImagePath && (
                    <button
                      className="btn-ghost"
                      onClick={() => handleRemoveOverlay(activeIdx)}
                      style={{ fontSize: 11 }}
                      title="Повернути оригінал без тексту"
                    >
                      ↺
                    </button>
                  )}
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4 }}>
                  Текст burn'иться у image через PIL. "↺" повертає оригінал.
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Caption */}
      <div className="card" style={{ padding: 16, marginBottom: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <label className="form-label" style={{ fontSize: 12, margin: 0 }}>📝 Caption:</label>
          <button
            className="btn-secondary"
            onClick={handleGenerateCaption}
            disabled={generatingCaption || !slides[0]?.prompt}
            style={{ fontSize: 11, padding: '4px 10px' }}
            title="Claude згенерує caption + hashtags на основі style + image prompt"
          >
            {generatingCaption ? '⏳ Генерую...' : '✨ Генерувати caption'}
          </button>
        </div>
        <textarea className="form-textarea" style={{ width: '100%' }} rows={3}
          value={caption} onChange={e => setCaption(e.target.value)}
          placeholder="Основний текст поста..." />
        <label className="form-label" style={{ fontSize: 12, marginTop: 8, display: 'block' }}>#️⃣ Hashtags:</label>
        <textarea className="form-textarea" style={{ width: '100%' }} rows={2}
          value={hashtags} onChange={e => setHashtags(e.target.value)}
          placeholder="#warrior #stoic ..." />
      </div>

      {/* Повідомлення */}
      {msg && (
        <div style={{
          padding: 10, marginBottom: 12, borderRadius: 6, fontSize: 12,
          background: msg.type === 'ok' ? 'rgba(34,197,94,0.1)' : 'rgba(224,82,82,0.1)',
          color: msg.type === 'ok' ? '#22c55e' : '#e05252',
        }}>{msg.text}</div>
      )}

      {/* Save */}
      <div style={{ display: 'flex', gap: 10 }}>
        {editingId ? (
          <>
            <button className="btn-primary" onClick={handleUpdate} disabled={saving}
              style={{ flex: 1 }}>
              {saving ? '⏳' : `💾 Оновити #${editingId}`}
            </button>
            <button className="btn-ghost" onClick={handleSaveDraft} disabled={saving}
              title="Створити нову генерацію у БД (не перезаписує поточну)"
              style={{ color: '#6366f1' }}>
              📋 Зберегти як нову
            </button>
          </>
        ) : (
          <button className="btn-primary" onClick={handleSaveDraft} disabled={saving}
            style={{ flex: 1 }}>
            {saving ? '⏳' : '💾 Зберегти в Історію'}
          </button>
        )}
      </div>

      <div style={{ marginTop: 16, padding: 10, fontSize: 11, color: 'var(--text-muted)',
        background: 'rgba(240,165,0,0.08)', borderRadius: 6 }}>
        ℹ️ Фаза 1: генерація + збереження. Публікація через Android automation — Фаза 2.
      </div>
    </div>
  )
}
