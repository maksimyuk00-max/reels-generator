import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import './Pages.css'

const isElectron = typeof window !== 'undefined' && !!window.api
const PYTHON_PORT = 8765

export default function History() {
  const navigate = useNavigate()
  const [generations, setGenerations] = useState([])
  const [selected, setSelected] = useState(null)
  const [loading, setLoading] = useState(true)

  const handleEdit = (gen) => {
    navigate('/generator', { state: { editGen: gen } })
  }

  // Відкрити у Редакторі (окрема сторінка /editor).
  // sourceType='final' — редагуємо вже змонтоване відео (overlay'і)
  // sourceType='i2v'   — редагуємо сире image-to-video з етапу 4 (без цитати/музики)
  const handleEditInEditor = (gen, sourceType = 'final') => {
    // Якщо сире — прибираємо final_path + compose_params, щоб редактор почав з чистого
    const payload = { ...gen }
    if (sourceType === 'i2v') {
      payload.final_path = null
      payload.compose_params = null
    }
    navigate('/editor', { state: { editGen: payload, sourceType } })
  }

  // Редагувати Post/Carousel — відкриває /posts з передачею state
  const handleEditPostCarousel = (gen) => {
    navigate('/posts', { state: { editGen: gen } })
  }

  const load = async () => {
    if (!isElectron) return
    setLoading(true)
    try {
      const data = await window.api.generations.getAll()
      setGenerations(data || [])
    } catch {}
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  const handleDelete = async (id) => {
    if (!confirm('Видалити цю генерацію?')) return
    await window.api.generations.delete(id)
    if (selected?.id === id) setSelected(null)
    load()
  }

  const getFileUrl = (filePath) => {
    if (!filePath) return null
    const filename = filePath.split(/[/\\]/).pop()
    return `http://127.0.0.1:${PYTHON_PORT}/files/${filename}`
  }

  const formatDate = (dateStr) => {
    if (!dateStr) return ''
    try {
      return new Date(dateStr + 'Z').toLocaleString('uk-UA', {
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
      })
    } catch {
      return dateStr
    }
  }

  if (selected) {
    return (
      <div className="page">
        <div className="page-header">
          <h1 className="page-title">📁 Генерація</h1>
          <button className="btn-ghost" onClick={() => setSelected(null)}>← Назад</button>
        </div>

        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
          {/* Carousel slides — для content_type='carousel' */}
          {selected.content_type === 'carousel' && selected.slides_json && (() => {
            let slides = []
            try { slides = JSON.parse(selected.slides_json) || [] } catch {}
            if (!slides.length) return null
            return (
              <div style={{ flex: '1 1 100%' }}>
                <div className="form-label" style={{ marginBottom: 8 }}>
                  📚 Карусель — {slides.length} слайдів
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12 }}>
                  {slides.map((sl, i) => (
                    <div key={i} style={{ position: 'relative' }}>
                      {sl.image_path && (
                        <img
                          src={getFileUrl(sl.image_path)}
                          alt=""
                          style={{ width: '100%', aspectRatio: '1/1', objectFit: 'cover', borderRadius: 8, cursor: 'pointer' }}
                          onClick={() => window.api.shell.openExternal(`file://${sl.image_path}`)}
                        />
                      )}
                      <div style={{
                        position: 'absolute', top: 6, left: 6,
                        background: 'rgba(0,0,0,0.7)', color: '#fff',
                        padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 600,
                      }}>
                        {i + 1}/{slides.length}
                      </div>
                      {sl.angle && (
                        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                          {sl.angle}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )
          })()}

          {/* Single Image (для reel/post) */}
          {selected.content_type !== 'carousel' && selected.image_path && (
            <div style={{ flex: '0 0 280px' }}>
              <div className="form-label" style={{ marginBottom: 8 }}>Зображення</div>
              <img
                src={getFileUrl(selected.image_path)}
                alt=""
                style={{ width: '100%', borderRadius: 12, cursor: 'pointer' }}
                onClick={() => window.api.shell.openExternal(`file://${selected.image_path}`)}
              />
            </div>
          )}

          {/* Video */}
          {selected.video_path && (
            <div style={{ flex: '0 0 280px' }}>
              <div className="form-label" style={{ marginBottom: 8 }}>Відео</div>
              <video
                src={getFileUrl(selected.video_path)}
                controls
                loop
                style={{ width: '100%', borderRadius: 12 }}
              />
            </div>
          )}

          {/* Final */}
          {selected.final_path && (
            <div style={{ flex: '0 0 280px' }}>
              <div className="form-label" style={{ marginBottom: 8 }}>Фінальне відео</div>
              <video
                src={getFileUrl(selected.final_path)}
                controls
                loop
                style={{ width: '100%', borderRadius: 12 }}
              />
            </div>
          )}
        </div>

        {/* Details */}
        <div className="settings-card" style={{ marginTop: 20 }}>
          <div className="settings-card-title">Деталі</div>
          <table style={{ width: '100%', fontSize: 13 }}>
            <tbody>
              {[
                ['Стиль', selected.style],
                ['Варіант', selected.variant_name],
                ['Цитата', selected.quote],
                ['Провайдер відео', selected.video_provider],
                ['Дата', formatDate(selected.created_at)],
              ].filter(([,v]) => v).map(([label, value]) => (
                <tr key={label}>
                  <td style={{ padding: '6px 12px 6px 0', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>{label}</td>
                  <td style={{ padding: '6px 0' }}>{value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {selected.image_prompt && (
          <div className="settings-card" style={{ marginTop: 12 }}>
            <div className="settings-card-title">Image Prompt</div>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', whiteSpace: 'pre-wrap' }}>{selected.image_prompt}</div>
          </div>
        )}

        {selected.video_prompt && (
          <div className="settings-card" style={{ marginTop: 12 }}>
            <div className="settings-card-title">Video Prompt</div>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', whiteSpace: 'pre-wrap' }}>{selected.video_prompt}</div>
          </div>
        )}

        <div style={{ display: 'flex', gap: 10, marginTop: 16, flexWrap: 'wrap' }}>
          {/* Дії для Post/Carousel */}
          {(selected.content_type === 'post' || selected.content_type === 'carousel') && (
            <button
              className="btn-primary"
              onClick={() => handleEditPostCarousel(selected)}
              title="Редагувати у вкладці 'Пости / Карусель'"
            >
              ✏️ Редагувати {selected.content_type === 'carousel' ? 'карусель' : 'пост'}
            </button>
          )}

          {/* Дії для Reel */}
          {(!selected.content_type || selected.content_type === 'reel') && (
            <>
              <button
                className="btn-primary"
                onClick={() => handleEditInEditor(selected, 'final')}
                disabled={!selected.final_path}
                title={selected.final_path ? 'Редагувати змонтоване відео у Редакторі' : 'Спочатку змонтуй відео (ще нема final)'}
              >
                ✏️ Редагувати фінальне
              </button>
              <button
                className="btn-secondary"
                onClick={() => handleEditInEditor(selected, 'i2v')}
                disabled={!selected.video_path}
                title="Перемонтувати з сирого image-to-video (без цитати/музики)"
              >
                🎞 Редагувати сире (i2v)
              </button>
              <button className="btn-ghost" onClick={() => handleEdit(selected)} title="Відкрити у повному пайплайні Генератора">
                ⚡ У Генератор
              </button>
            </>
          )}

          <button className="btn-ghost" onClick={() => selected.final_path
            ? window.api.shell.openExternal(`file://${selected.final_path}`)
            : selected.image_path && window.api.shell.openExternal(`file://${selected.image_path}`)}>
            📁 Відкрити файл
          </button>
          <button className="btn-ghost" style={{ color: '#ef4444' }} onClick={() => handleDelete(selected.id)}>
            🗑 Видалити
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">📁 Історія генерацій</h1>
        <span style={{ color: 'var(--text-secondary)' }}>{generations.length} збережено</span>
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: 40 }}>
          <div className="spinner" />
        </div>
      ) : generations.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">📁</div>
          <div className="empty-state-title">Немає збережених генерацій</div>
          <div className="empty-state-sub">Після генерації натисніть "💾 Зберегти" щоб додати сюди</div>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 16 }}>
          {generations.map(gen => (
            <div
              key={gen.id}
              onClick={() => setSelected(gen)}
              style={{
                background: 'var(--card-bg)',
                borderRadius: 12,
                overflow: 'hidden',
                cursor: 'pointer',
                border: '1px solid var(--border)',
                transition: 'transform 0.15s, box-shadow 0.15s',
              }}
              onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.boxShadow = '0 8px 24px rgba(0,0,0,0.3)' }}
              onMouseLeave={e => { e.currentTarget.style.transform = ''; e.currentTarget.style.boxShadow = '' }}
            >
              {gen.image_path ? (
                <img
                  src={getFileUrl(gen.image_path)}
                  alt=""
                  style={{ width: '100%', height: 260, objectFit: 'cover' }}
                />
              ) : (
                <div style={{ width: '100%', height: 260, background: 'var(--bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 40 }}>
                  🎬
                </div>
              )}
              <div style={{ padding: '10px 12px' }}>
                <div style={{ fontWeight: 600, fontSize: 13 }}>{gen.style} — {gen.variant_name || 'Custom'}</div>
                <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4 }}>{formatDate(gen.created_at)}</div>
                {gen.quote && (
                  <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    "{gen.quote}"
                  </div>
                )}
                <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                  {(gen.content_type === 'post' || gen.content_type === 'carousel') ? (
                    <button
                      onClick={(e) => { e.stopPropagation(); handleEditPostCarousel(gen) }}
                      title={`Редагувати ${gen.content_type === 'carousel' ? 'карусель' : 'пост'}`}
                      style={{
                        flex: 1, padding: '6px 10px', fontSize: 11, borderRadius: 6,
                        background: 'var(--accent, #3b82f6)', color: '#fff',
                        border: 'none', cursor: 'pointer', fontWeight: 500,
                      }}
                    >
                      ✏️ {gen.content_type === 'carousel' ? 'Карусель' : 'Пост'}
                    </button>
                  ) : (
                    <button
                      onClick={(e) => { e.stopPropagation(); handleEditInEditor(gen, 'final') }}
                      disabled={!gen.final_path}
                      title={gen.final_path ? 'Редагувати у Редакторі' : 'Спочатку змонтуй (ще нема final)'}
                      style={{
                        flex: 1, padding: '6px 10px', fontSize: 11, borderRadius: 6,
                        background: gen.final_path ? 'var(--accent, #3b82f6)' : 'var(--bg)',
                        color: gen.final_path ? '#fff' : 'var(--text-muted)',
                        border: 'none',
                        cursor: gen.final_path ? 'pointer' : 'not-allowed',
                        fontWeight: 500,
                        opacity: gen.final_path ? 1 : 0.5,
                      }}
                    >
                      ✂️ Редактор
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
