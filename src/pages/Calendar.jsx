import { useState, useEffect } from 'react'
import './Pages.css'

const DAYS   = ['Нд', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб']
const MONTHS = ['Січень','Лютий','Березень','Квітень','Травень','Червень',
                'Липень','Серпень','Вересень','Жовтень','Листопад','Грудень']

const isElectron = typeof window !== 'undefined' && !!window.api

export default function Calendar() {
  const today = new Date()
  const [year, setYear]         = useState(today.getFullYear())
  const [month, setMonth]       = useState(today.getMonth())
  const [selected, setSelected] = useState(null)
  const [accounts, setAccounts] = useState([])
  // Мульти-вибір: Set з account IDs (кілька акаунтів одночасно)
  const [activeAccountIds, setActiveAccountIds] = useState(new Set())
  const [reels, setReels]       = useState([])
  const [postDays, setPostDays] = useState({}) // { 'YYYY-MM-DD': [reel, ...] }

  const [scheduled, setScheduled]   = useState([]) // all scheduled posts
  const [schedDays, setSchedDays]   = useState({}) // { 'YYYY-MM-DD': [post, ...] }
  const [deletingId, setDeletingId] = useState(null)

  // Edit modal
  const [editPost, setEditPost]     = useState(null) // Post being edited
  const [editVideoPath, setEditVideoPath] = useState('')
  const [editCaption, setEditCaption]     = useState('')
  const [editDate, setEditDate]           = useState('')
  const [editTime, setEditTime]           = useState('')
  const [editAccountId, setEditAccountId] = useState(null)
  const [savingEdit, setSavingEdit]       = useState(false)

  useEffect(() => {
    loadAccounts()
    loadScheduled()
    if (isElectron && window.api.on) {
      // Оновлюємо коли щось опублікувалось по розкладу
      const unsub = window.api.on('schedule:published', () => loadScheduled())
      return unsub
    }
  }, [])

  useEffect(() => {
    if (activeAccountIds.size > 0) loadReelsForAccounts(Array.from(activeAccountIds))
    else { setReels([]); setPostDays({}) }
  }, [activeAccountIds])

  const loadAccounts = async () => {
    if (!isElectron) return
    const data = await window.api.accounts.getAll()
    setAccounts(data)
    // За замовчуванням вибираємо ВСІ акаунти
    if (data.length > 0) setActiveAccountIds(new Set(data.map(a => a.id)))
  }

  const loadReelsForAccounts = async (accountIds) => {
    if (!isElectron) return
    const allReels = []
    for (const id of accountIds) {
      try {
        const data = await window.api.reels.getByAccount(id, 'published_at')
        if (Array.isArray(data)) allReels.push(...data)
      } catch {}
    }
    setReels(allReels)
    const byDay = {}
    for (const reel of allReels) {
      if (!reel.published_at) continue
      const day = reel.published_at.split('T')[0]
      if (!byDay[day]) byDay[day] = []
      byDay[day].push(reel)
    }
    setPostDays(byDay)
  }

  // Toggle account у множинному виборі
  const toggleAccount = (accId) => {
    setActiveAccountIds(prev => {
      const next = new Set(prev)
      if (next.has(accId)) next.delete(accId)
      else next.add(accId)
      return next
    })
  }

  const selectAllAccounts = () => setActiveAccountIds(new Set(accounts.map(a => a.id)))
  const clearAccounts = () => setActiveAccountIds(new Set())

  const loadScheduled = async () => {
    if (!isElectron) return
    const data = await window.api.schedule.getAll()
    setScheduled(data || [])
  }

  // Перерахунок schedDays при зміні activeAccountIds або scheduled
  useEffect(() => {
    const byDay = {}
    for (const p of (scheduled || [])) {
      // Фільтр: якщо обрано хоч один акаунт — показуємо тільки пости для цих акаунтів
      // Якщо нічого не обрано — не показуємо (або показуємо все; зараз — нічого)
      if (activeAccountIds.size > 0 && p.account_id && !activeAccountIds.has(p.account_id)) continue
      const day = p.scheduled_at.split('T')[0]
      if (!byDay[day]) byDay[day] = []
      byDay[day].push(p)
    }
    setSchedDays(byDay)
  }, [scheduled, activeAccountIds])

  const handleDeleteScheduled = async (id) => {
    setDeletingId(id)
    await window.api.schedule.delete(id)
    await loadScheduled()
    setDeletingId(null)
  }

  const openEditPost = (post) => {
    setEditPost(post)
    setEditVideoPath(post.video_path || '')
    setEditCaption(post.caption || '')
    const dt = post.scheduled_at || ''
    const [datePart, timePart] = dt.split('T')
    setEditDate(datePart || '')
    setEditTime((timePart || '').slice(0, 5))
    setEditAccountId(post.account_id || null)
  }

  const closeEditPost = () => {
    setEditPost(null)
    setEditVideoPath(''); setEditCaption(''); setEditDate(''); setEditTime(''); setEditAccountId(null)
  }

  const pickEditVideo = async () => {
    if (!isElectron) return
    const p = await window.api.dialog.openFile({
      title: 'Оберіть відео файл',
      filters: [{ name: 'Video', extensions: ['mp4', 'mov', 'avi', 'mkv'] }],
    })
    if (p) setEditVideoPath(p)
  }

  const saveEditPost = async () => {
    if (!editPost || !editDate || !editTime || !editVideoPath) return
    setSavingEdit(true)
    try {
      await window.api.schedule.update(editPost.id, {
        video_path: editVideoPath,
        caption: editCaption,
        scheduled_at: `${editDate}T${editTime}:00`,
        account_id: editAccountId || null,
      })
      await loadScheduled()
      closeEditPost()
    } catch (e) {
      alert('Помилка: ' + String(e))
    }
    setSavingEdit(false)
  }

  const deleteEditPost = async () => {
    if (!editPost) return
    if (!confirm('Видалити цей запланований пост?')) return
    await handleDeleteScheduled(editPost.id)
    closeEditPost()
  }

  const prev = () => {
    if (month === 0) { setMonth(11); setYear(y => y - 1) }
    else setMonth(m => m - 1)
  }
  const next = () => {
    if (month === 11) { setMonth(0); setYear(y => y + 1) }
    else setMonth(m => m + 1)
  }

  const firstDay    = new Date(year, month, 1).getDay()
  const daysInMonth = new Date(year, month + 1, 0).getDate()

  const cells = []
  for (let i = 0; i < firstDay; i++) cells.push(null)
  for (let d = 1; d <= daysInMonth; d++) cells.push(d)

  const isToday = (d) =>
    d === today.getDate() && month === today.getMonth() && year === today.getFullYear()

  const dayKey = (d) => {
    if (!d) return null
    return `${year}-${String(month + 1).padStart(2,'0')}-${String(d).padStart(2,'0')}`
  }

  const selectedReels = selected ? (postDays[dayKey(selected)] || []) : []
  const selectedSched = selected ? (schedDays[dayKey(selected)] || []) : []

  const statusLabel = (s) => {
    if (s === 'pending')   return { label: '⏳ Заплановано', color: '#f0a500' }
    if (s === 'running')   return { label: '🔄 Публікується', color: '#3b82f6' }
    if (s === 'published') return { label: '✅ Опубліковано', color: '#22c55e' }
    if (s === 'failed')    return { label: '❌ Помилка', color: '#e05252' }
    return { label: s, color: '#888' }
  }

  const pendingCount = scheduled.filter(p => p.status === 'pending').length

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">📅 Контент Календар</h1>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          {pendingCount > 0 && (
            <div style={{ fontSize: 13, color: '#f0a500', background: 'rgba(240,165,0,0.1)', padding: '4px 12px', borderRadius: 20 }}>
              ⏳ {pendingCount} запланованих
            </div>
          )}
          {accounts.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <div className="sort-tabs">
                {accounts.map(acc => {
                  const isActive = activeAccountIds.has(acc.id)
                  return (
                    <button
                      key={acc.id}
                      className={`sort-tab ${isActive ? 'sort-tab--active' : ''}`}
                      onClick={() => toggleAccount(acc.id)}
                      title={isActive ? 'Натисни щоб прибрати' : 'Натисни щоб додати'}
                    >
                      {isActive ? '✓ ' : ''}@{acc.username}
                    </button>
                  )
                })}
              </div>
              {accounts.length > 1 && (
                <div style={{ display: 'flex', gap: 4, marginLeft: 4 }}>
                  <button
                    className="btn-ghost"
                    onClick={selectAllAccounts}
                    style={{ fontSize: 11, padding: '3px 8px' }}
                    title="Вибрати всі"
                  >Всі</button>
                  <button
                    className="btn-ghost"
                    onClick={clearAccounts}
                    style={{ fontSize: 11, padding: '3px 8px' }}
                    title="Скинути вибір"
                  >✕</button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="calendar-layout">
        <div className="calendar-main">
          <div className="calendar-nav">
            <button className="cal-btn" onClick={prev}>◀ Назад</button>
            <h2 className="cal-month">{MONTHS[month]} {year}</h2>
            <button className="cal-btn" onClick={next}>Вперед ▶</button>
          </div>

          <div className="calendar-grid">
            {DAYS.map(d => (
              <div key={d} className="cal-day-label">{d}</div>
            ))}
            {cells.map((d, i) => {
              const key  = dayKey(d)
              const hasPosts = key && postDays[key]?.length > 0
              const hasSched = key && schedDays[key]?.length > 0
              const count = hasPosts ? postDays[key].length : 0
              return (
                <div
                  key={i}
                  className={`cal-cell ${d ? 'cal-cell--active' : ''} ${isToday(d) ? 'cal-cell--today' : ''} ${selected === d ? 'cal-cell--selected' : ''}`}
                  onClick={() => d && setSelected(d === selected ? null : d)}
                >
                  {d && (
                    <>
                      <span className="cal-date">{d}</span>
                      {hasPosts && (
                        <div className="cal-dot-row">
                          {count > 1
                            ? <span className="cal-count">{count}</span>
                            : <div className="cal-dot" />}
                        </div>
                      )}
                      {hasSched && (
                        <div className="cal-dot-row" style={{ marginTop: 1 }}>
                          <div className="cal-dot" style={{ background: '#f0a500' }} />
                        </div>
                      )}
                    </>
                  )}
                </div>
              )
            })}
          </div>

          <div className="cal-legend">
            <span className="cal-legend-label">ЛЕГЕНДА:</span>
            <span className="cal-legend-dot cal-legend-dot--purple" />
            <span className="cal-legend-item">Опубліковано</span>
            <span className="cal-legend-dot" style={{ background: '#f0a500', borderRadius: '50%', width: 8, height: 8, display: 'inline-block' }} />
            <span className="cal-legend-item">Заплановано</span>
            <span className="cal-legend-item" style={{ marginLeft: 'auto', color: 'var(--text-muted)' }}>
              {Object.keys(postDays).length} днів з публікаціями
            </span>
          </div>
        </div>

        {editPost && (
          <div
            onClick={closeEditPost}
            style={{
              position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
              zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            <div
              onClick={e => e.stopPropagation()}
              style={{
                background: 'var(--card-bg, #1a1a24)', border: '1px solid var(--border)',
                borderRadius: 12, padding: 20, maxWidth: 560, width: '90%',
                maxHeight: '90vh', overflowY: 'auto',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                <h2 style={{ margin: 0, fontSize: 18 }}>
                  ✏️ Запланований пост #{editPost.id}
                </h2>
                <button className="btn-ghost" onClick={closeEditPost} style={{ fontSize: 18, padding: '2px 10px' }}>✕</button>
              </div>

              {/* Статус */}
              <div style={{ marginBottom: 12, fontSize: 12, color: statusLabel(editPost.status).color, fontWeight: 600 }}>
                {statusLabel(editPost.status).label}
              </div>

              {/* Акаунт */}
              <div style={{ marginBottom: 12 }}>
                <label className="form-label" style={{ display: 'block', marginBottom: 4, fontSize: 12 }}>📱 Акаунт</label>
                {accounts.length === 0 ? (
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Немає акаунтів</div>
                ) : (
                  <select
                    className="form-select"
                    value={editAccountId || ''}
                    onChange={e => setEditAccountId(e.target.value ? Number(e.target.value) : null)}
                    style={{ width: '100%' }}
                  >
                    <option value="">— не вказано —</option>
                    {accounts.map(a => (
                      <option key={a.id} value={a.id}>@{a.username}</option>
                    ))}
                  </select>
                )}
              </div>

              {/* Відео */}
              <div style={{ marginBottom: 12 }}>
                <label className="form-label" style={{ display: 'block', marginBottom: 4, fontSize: 12 }}>📹 Відео</label>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input
                    className="form-input"
                    value={editVideoPath}
                    onChange={e => setEditVideoPath(e.target.value)}
                    style={{ flex: 1, fontSize: 11 }}
                    placeholder="Шлях до відео"
                  />
                  <button className="btn-ghost" onClick={pickEditVideo} style={{ fontSize: 12 }}>📁</button>
                </div>
                {editVideoPath && (
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
                    {editVideoPath.split(/[/\\]/).pop()}
                  </div>
                )}
              </div>

              {/* Дата + час */}
              <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                <div style={{ flex: 1 }}>
                  <label className="form-label" style={{ display: 'block', marginBottom: 4, fontSize: 12 }}>📅 Дата</label>
                  <input
                    type="date"
                    className="form-input"
                    value={editDate}
                    onChange={e => setEditDate(e.target.value)}
                    style={{ width: '100%' }}
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <label className="form-label" style={{ display: 'block', marginBottom: 4, fontSize: 12 }}>🕒 Час</label>
                  <input
                    type="time"
                    className="form-input"
                    value={editTime}
                    onChange={e => setEditTime(e.target.value)}
                    style={{ width: '100%' }}
                  />
                </div>
              </div>

              {/* Підпис */}
              <div style={{ marginBottom: 12 }}>
                <label className="form-label" style={{ display: 'block', marginBottom: 4, fontSize: 12 }}>📝 Підпис</label>
                <textarea
                  className="form-textarea"
                  value={editCaption}
                  onChange={e => setEditCaption(e.target.value)}
                  rows={5}
                  style={{ width: '100%', resize: 'vertical' }}
                  placeholder="Підпис до публікації..."
                />
              </div>

              {/* Результат публікації */}
              {editPost.instagram_url && (
                <div style={{ marginBottom: 12, fontSize: 12 }}>
                  <span style={{ color: 'var(--text-muted)' }}>URL: </span>
                  <span
                    style={{ color: '#e1306c', cursor: 'pointer' }}
                    onClick={() => window.api.shell.openExternal(editPost.instagram_url)}
                  >
                    {editPost.instagram_url}
                  </span>
                </div>
              )}

              {editPost.error && (
                <div style={{ marginBottom: 12, padding: 10, background: 'rgba(224,82,82,0.1)', borderRadius: 6, fontSize: 12, color: '#e05252' }}>
                  ❌ {editPost.error}
                </div>
              )}

              {/* Дії */}
              <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'space-between' }}>
                <button
                  className="btn-ghost"
                  onClick={deleteEditPost}
                  style={{ color: '#e05252' }}
                  disabled={savingEdit}
                >
                  🗑 Видалити
                </button>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn-ghost" onClick={closeEditPost} disabled={savingEdit}>
                    Скасувати
                  </button>
                  {editPost.status === 'pending' && (
                    <button
                      className="btn-primary"
                      onClick={saveEditPost}
                      disabled={savingEdit || !editVideoPath || !editDate || !editTime}
                    >
                      {savingEdit ? '⏳' : '💾 Зберегти'}
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="calendar-side">
          {selected ? (
            <div className="cal-day-detail">
              <div className="cal-day-title">
                {selected} {MONTHS[month]} {year}
              </div>

              {/* Заплановані пости */}
              {selectedSched.length > 0 && (
                <>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    Заплановані публікації
                  </div>
                  <div className="cal-events-list">
                    {selectedSched.map(post => {
                      const st = statusLabel(post.status)
                      return (
                        <div
                          key={post.id}
                          className="cal-event"
                          style={{ flexDirection: 'column', gap: 6, cursor: 'pointer' }}
                          onClick={() => openEditPost(post)}
                        >
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span style={{ fontSize: 12, color: st.color, fontWeight: 600 }}>{st.label}</span>
                            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                              {new Date(post.scheduled_at).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' })}
                            </span>
                          </div>
                          {post.account_username && (
                            <div style={{ fontSize: 11, color: '#6366f1', fontWeight: 500 }}>
                              📱 @{post.account_username}
                            </div>
                          )}
                          <div style={{ fontSize: 12, color: 'var(--text-muted)', wordBreak: 'break-all' }}>
                            📹 {post.video_path.split(/[/\\]/).pop()}
                          </div>
                          {post.caption && (
                            <div style={{ fontSize: 12 }}>{post.caption.slice(0, 80)}{post.caption.length > 80 ? '...' : ''}</div>
                          )}
                          {post.instagram_url && (
                            <span
                              style={{ fontSize: 12, color: '#e1306c', cursor: 'pointer' }}
                              onClick={(e) => { e.stopPropagation(); isElectron && window.api.shell.openExternal(post.instagram_url) }}
                            >
                              Відкрити →
                            </span>
                          )}
                          {post.error && (
                            <div style={{ fontSize: 11, color: '#e05252' }}>{post.error}</div>
                          )}
                          <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                            {post.status === 'pending' && (
                              <>
                                <button
                                  className="btn-ghost"
                                  style={{ fontSize: 11, padding: '2px 8px', color: '#3b82f6' }}
                                  onClick={(e) => { e.stopPropagation(); openEditPost(post) }}
                                >
                                  ✏️ Редагувати
                                </button>
                                <button
                                  className="btn-ghost"
                                  style={{ fontSize: 11, padding: '2px 8px', color: '#e05252' }}
                                  onClick={(e) => { e.stopPropagation(); handleDeleteScheduled(post.id) }}
                                  disabled={deletingId === post.id}
                                >
                                  {deletingId === post.id ? '...' : '🗑 Скасувати'}
                                </button>
                              </>
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </>
              )}

              {/* Опубліковані рілси */}
              {selectedReels.length > 0 && (
                <>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', margin: '12px 0 8px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    Рілси цього дня
                  </div>
                  <div className="cal-events-list">
                    {selectedReels.map(reel => (
                      <div key={reel.id} className="cal-event">
                        <div className="cal-event-thumb">🎬</div>
                        <div>
                          <div className="cal-event-title">
                            {reel.title ? reel.title.slice(0, 50) + (reel.title.length > 50 ? '...' : '') : '(без підпису)'}
                          </div>
                          <div className="cal-event-meta">
                            👁 {fmtNum(reel.views)} • ❤️ {fmtNum(reel.likes)} • 💬 {reel.comments}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}

              {selectedReels.length === 0 && selectedSched.length === 0 && (
                <div className="cal-empty-day">Немає публікацій в цей день</div>
              )}
            </div>
          ) : (
            <div className="cal-side-empty">
              <div className="cal-side-icon">📅</div>
              <div className="cal-side-text">Обери день</div>
              <div className="cal-side-sub">Клікни на дату щоб побачити Reels</div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function fmtNum(n) {
  if (!n) return '0'
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
  return String(n)
}
