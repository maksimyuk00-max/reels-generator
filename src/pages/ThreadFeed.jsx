import { useState, useEffect } from 'react'
import './Pages.css'

const isElectron = typeof window !== 'undefined' && !!window.api?.python

export default function Threads() {
  const [personas, setPersonas] = useState([])
  const [selectedId, setSelectedId] = useState('') // id обраної персони
  const [loading, setLoading] = useState(true)

  const [mode, setMode] = useState('reply') // 'reply' | 'post'
  const [threadPost, setThreadPost] = useState('')
  const [topic, setTopic] = useState('')
  const [userNotes, setUserNotes] = useState('') // мої вказівки/досвід для агента
  const [intent, setIntent] = useState('value') // 'value' | 'light-promo'
  const [result, setResult] = useState(null) // {reply} | {text}
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState(null)
  const [copied, setCopied] = useState(false)
  const [providerStatus, setProviderStatus] = useState(null) // {provider, model, has_api_key}

  useEffect(() => { load() }, [])

  const load = async () => {
    setLoading(true)
    if (isElectron) {
      const list = await window.api.personas.getAll()
      // Тільки threads-персони (плюс порожні platform як fallback)
      const threads = (list || []).filter(p => p.platform === 'threads' || !p.platform)
      setPersonas(threads)
      if (threads && threads.length) setSelectedId(threads[0].id)
      // Який зараз провайдер для генерації (з Reddit Feed settings)
      try {
        const draftModels = await window.api.reddit.draftModels()
        if (draftModels?.current) setProviderStatus(draftModels.current)
      } catch (e) {
        // не критично — просто не покажемо банер
      }
    }
    setLoading(false)
  }

  const selected = personas.find(p => p.id === selectedId)

  const handleGenerate = async () => {
    if (!isElectron) return
    if (!selected) {
      setError('Спершу оберіть персону. Створити персону можна у вкладці «Персони».')
      return
    }
    if (!selected.description?.trim()) {
      setError('В обраної персони порожній опис. Доповніть його у вкладці «Персони».')
      return
    }
    if (mode === 'reply' && !threadPost.trim()) {
      setError('Вставте текст поста, на який треба відповісти.')
      return
    }
    if (mode === 'post' && !topic.trim()) {
      setError('Вкажіть тему / angle для поста.')
      return
    }

    setError(null)
    setResult(null)
    setGenerating(true)
    try {
      const params = {
        persona_description: selected.description,
        intent,
        user_notes: userNotes || '',
      }
      const res = mode === 'reply'
        ? await window.api.python.threadsPersonaReply({ ...params, thread_post: threadPost })
        : await window.api.python.threadsPersonaPost({ ...params, topic })

      if (!res?.ok) {
        setError(res?.error || 'Помилка генерації')
      } else if (mode === 'reply') {
        setResult({ reply: res.reply || '' })
      } else {
        setResult({ text: res.text || '' })
      }
    } catch (e) {
      setError(String(e))
    }
    setGenerating(false)
  }

  const copyResult = () => {
    if (!result) return
    const text = mode === 'reply' ? result.reply : result.text
    navigator.clipboard?.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">🧵 Threads</h1>
      </div>

      {loading ? (
        <div className="empty-state"><div className="spinner" /></div>
      ) : personas.length === 0 ? (
        <div className="empty-state">
          <div style={{ fontSize: 40 }}>🧵</div>
          <div>Ще немає жодної Threads-персони</div>
          <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 8 }}>
            Створіть персону з platform «Threads» у вкладці <b>«Персони»</b>, потім повертайтесь сюди для генерації.
          </div>
        </div>
      ) : (
        <div className="prompts-layout">
          {/* Ліва панель — обір персони */}
          <div className="prompts-sidebar">
            <div style={{ padding: '4px 8px 8px', fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
              Персона
            </div>
            {personas.map(p => (
              <div
                key={p.id}
                className={`prompts-variant ${selectedId === p.id ? 'prompts-variant--active' : ''}`}
                onClick={() => { setSelectedId(p.id); setResult(null); setError(null) }}
              >
                <span className="prompts-variant-name">{p.name || '(без імені)'}</span>
                <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 4 }}>
                  🧵 {p.subreddit || ''}
                </span>
              </div>
            ))}
          </div>

          {/* Права панель — генерація */}
          <div className="prompts-editor">
            {selected ? (
              <>
                <div className="form-section">
                  <label className="form-label">Обрана персона</label>
                  <div style={{ padding: '8px 12px', background: 'rgba(99,102,241,0.1)', borderRadius: 8, fontSize: 13 }}>
                    <b>{selected.name}</b>
                    <span style={{ color: 'var(--text-muted)', marginLeft: 6 }}>
                      Threads
                    </span>
                  </div>
                </div>

                {providerStatus && (
                  <div style={{ padding: '8px 12px', background: 'rgba(34,197,94,0.08)', borderRadius: 8, fontSize: 12, color: 'var(--text-muted)', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 14 }}>{providerStatus.provider === 'ollama' ? '🦙' : '⛅'}</span>
                    <span>
                      Провайдер: <b style={{ color: 'var(--text-primary)' }}>
                        {providerStatus.provider === 'ollama' ? `Ollama (${providerStatus.model})` : 'Claude CLI'}
                      </b>
                      <span style={{ marginLeft: 6, fontSize: 11 }}>
                        · синхронізовано з Reddit Feed
                      </span>
                    </span>
                  </div>
                )}

                {/* Mode toggle */}
                <div className="form-section">
                  <label className="form-label">Режим</label>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      className={mode === 'reply' ? 'btn-primary' : 'btn-ghost'}
                      style={{ flex: 1 }}
                      onClick={() => { setMode('reply'); setResult(null); setError(null) }}
                    >💬 Відповідь на пост</button>
                    <button
                      className={mode === 'post' ? 'btn-primary' : 'btn-ghost'}
                      style={{ flex: 1 }}
                      onClick={() => { setMode('post'); setResult(null); setError(null) }}
                    >✍️ Свій пост по темі</button>
                  </div>
                </div>

                {mode === 'reply' ? (
                  <div className="form-section">
                    <label className="form-label">Threads пост (текст, на який відповісти)</label>
                    <textarea
                      className="form-textarea"
                      value={threadPost}
                      onChange={e => setThreadPost(e.target.value)}
                      rows={8}
                      placeholder="Вставте сюди текст чужого поста, на який треба відповісти..."
                    />
                  </div>
                ) : (
                  <div className="form-section">
                    <label className="form-label">Тема / angle</label>
                    <textarea
                      className="form-textarea"
                      value={topic}
                      onChange={e => setTopic(e.target.value)}
                      rows={5}
                      placeholder="напр. the samurai practice of one small daily act, або: why motivation fades..."
                    />
                  </div>
                )}

                <div className="form-section">
                  <label className="form-label">Мої нотатки / вказівки (опційно)</label>
                  <textarea
                    className="form-textarea"
                    value={userNotes}
                    onChange={e => setUserNotes(e.target.value)}
                    rows={4}
                    placeholder="Напишіть свої думки, досвід або ключі для цього конкретного поста. Агент врахує це при генерації. Напр.: «зроби тредс-стиль — короткі рядки, тихий тон, без емодзі»..."
                  />
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                    Це поле не обовʼязкове. Коли порожнє — агент генерує самостійно. Коли заповнене — пише саме про те, що ви вкажете.
                  </div>
                </div>

                <div className="form-section">
                  <label className="form-label">Інтент</label>
                  <select
                    className="form-input"
                    value={intent}
                    onChange={e => setIntent(e.target.value)}
                  >
                    <option value="value">Value — без згадки додатку (чиста користь)</option>
                    <option value="light-promo">Light promo — згадати додаток раз + disclosure</option>
                  </select>
                </div>

                <button
                  className="btn-primary"
                  style={{ width: '100%', marginTop: 8, background: '#6366f1' }}
                  onClick={handleGenerate}
                  disabled={generating}
                >
                  {generating ? '⏳ Генерація...' : '⚡ Згенерувати'}
                </button>

                {error && (
                  <div style={{ background: 'rgba(239,68,68,0.15)', color: '#f87171', padding: '8px 12px', borderRadius: 8, fontSize: 12, marginTop: 8 }}>
                    {error}
                  </div>
                )}

                {generating && (
                  <div style={{ textAlign: 'center', padding: 20 }}><div className="spinner" /></div>
                )}

                {result && (
                  <div className="form-section" style={{ marginTop: 12 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                      <label className="form-label" style={{ margin: 0 }}>Результат</label>
                      <button className="btn-ghost" style={{ fontSize: 12, padding: '4px 10px' }} onClick={copyResult}>
                        {copied ? '✅ Скопійовано' : '📋 Копіювати'}
                      </button>
                    </div>
                    <textarea
                      className="form-textarea"
                      value={mode === 'reply' ? result.reply : result.text}
                      readOnly
                      rows={10}
                      style={{ whiteSpace: 'pre-wrap' }}
                    />
                  </div>
                )}
              </>
            ) : (
              <div className="empty-state">
                <div style={{ fontSize: 40 }}>🧵</div>
                <div>Оберіть персону зліва</div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
