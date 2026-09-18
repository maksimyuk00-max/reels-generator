import { useState, useEffect } from 'react'
import './Pages.css'

const isElectron = typeof window !== 'undefined' && !!window.api

export default function Personas() {
  const [personas, setPersonas] = useState([])
  const [selected, setSelected] = useState(null) // persona object (або blank для нової)
  const [editName, setEditName] = useState('')
  const [editDescription, setEditDescription] = useState('')
  const [editPlatform, setEditPlatform] = useState('reddit')
  const [editSubreddit, setEditSubreddit] = useState('')
  const [saved, setSaved] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => { load() }, [])

  const load = async () => {
    setLoading(true)
    if (isElectron) {
      const list = await window.api.personas.getAll()
      setPersonas(list || [])
    }
    setLoading(false)
  }

  const selectPersona = (p) => {
    setSelected(p)
    setEditName(p?.name || '')
    setEditDescription(p?.description || '')
    setEditPlatform(p?.platform || 'reddit')
    setEditSubreddit(p?.subreddit || '')
  }

  const addPersona = () => {
    const blank = { id: '', name: 'Нова персона', description: '', platform: 'reddit', subreddit: '' }
    setSelected(blank)
    setEditName(blank.name)
    setEditDescription('')
    setEditPlatform('reddit')
    setEditSubreddit('')
  }

  const savePersona = async () => {
    if (!isElectron || !selected) return
    const saved_p = await window.api.personas.save({
      id: selected.id || undefined,
      name: editName,
      description: editDescription,
      platform: editPlatform,
      subreddit: editSubreddit,
    })
    if (saved_p?.id) {
      setSelected(saved_p)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
      await load()
      const fresh = await window.api.personas.getAll()
      const me = (fresh || []).find(x => x.id === saved_p.id)
      if (me) setSelected(me)
    }
  }

  const deletePersona = async (id) => {
    if (!isElectron) return
    await window.api.personas.delete(id)
    if (selected?.id === id) {
      setSelected(null)
      setEditName('')
      setEditDescription('')
    }
    await load()
  }

  const dirty = selected && (
    selected.name !== editName ||
    selected.description !== editDescription ||
    (selected.platform || 'reddit') !== editPlatform ||
    (selected.subreddit || '') !== editSubreddit
  )

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">🎭 Персони</h1>
        <button className="btn-primary" onClick={addPersona}>＋ Додати персону</button>
      </div>

      {loading ? (
        <div className="empty-state"><div className="spinner" /></div>
      ) : (
        <div className="prompts-layout">

          {/* Ліва панель — список персони */}
          <div className="prompts-sidebar">
            {personas.length === 0 && (
              <div style={{ padding: 12, color: 'var(--text-muted)', fontSize: 13 }}>
                Персони ще не створено. Натисніть «Додати персону».
              </div>
            )}
            {personas.map(p => (
              <div
                key={p.id}
                className={`prompts-variant ${selected?.id === p.id ? 'prompts-variant--active' : ''}`}
                onClick={() => selectPersona(p)}
              >
                <span className="prompts-variant-name">{p.name || '(без імені)'}</span>
                <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 4 }}>
                  {p.platform === 'threads' ? '🧵' : '🔵'} {p.subreddit || ''}
                </span>
                <button
                  className="btn-ghost prompts-delete"
                  onClick={e => { e.stopPropagation(); deletePersona(p.id) }}
                >✕</button>
              </div>
            ))}
          </div>

          {/* Права панель — редактор персони */}
          <div className="prompts-editor">
            {selected ? (
              <>
                <div className="form-section">
                  <label className="form-label">Назва персони</label>
                  <input
                    className="form-input"
                    value={editName}
                    onChange={e => setEditName(e.target.value)}
                    placeholder="напр. The Stoic (P2)"
                  />
                </div>

                <div className="form-section">
                  <label className="form-label">Платформа</label>
                  <select
                    className="form-input"
                    value={editPlatform}
                    onChange={e => setEditPlatform(e.target.value)}
                  >
                    <option value="reddit">Reddit</option>
                    <option value="threads">Threads</option>
                  </select>
                </div>

                <div className="form-section">
                  <label className="form-label">Сабредіт / ніші за замовчуванням</label>
                  <input
                    className="form-input"
                    value={editSubreddit}
                    onChange={e => setEditSubreddit(e.target.value)}
                    placeholder="напр. Stoicism (опційно)"
                  />
                </div>

                <div className="form-section">
                  <label className="form-label">Опис персони (легенда, voice, quirks, guardrails)</label>
                  <textarea
                    className="form-textarea"
                    value={editDescription}
                    onChange={e => setEditDescription(e.target.value)}
                    rows={18}
                    placeholder="Вставте сюди повний опис персони — origin_story, voice (tone/vocabulary/quirks/never_says), niche_subs, consistency_guardrails..."
                  />
                </div>

                <button
                  className="btn-primary"
                  style={{ width: '100%', marginTop: 4 }}
                  onClick={savePersona}
                  disabled={!editName.trim() && !editDescription.trim()}
                >
                  {saved ? '✅ Збережено!' : dirty ? '💾 Зберегти персону' : '💾 Зберегти'}
                </button>

                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 10, lineHeight: 1.5 }}>
                  Збережені персони доступні у вкладці <b>«Контент»</b> для генерації відповідей і постів.
                </div>
              </>
            ) : (
              <div className="empty-state">
                <div style={{ fontSize: 40 }}>🎭</div>
                <div>Оберіть персону для редагування</div>
                <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 8 }}>
                  або натисніть «Додати персону»
                </div>
              </div>
            )}
          </div>

        </div>
      )}
    </div>
  )
}