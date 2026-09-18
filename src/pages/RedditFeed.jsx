import { useState, useEffect, useRef } from 'react'
import './Pages.css'

const isElectron = typeof window !== 'undefined' && !!window.api?.reddit

const STATUS_TABS = [
  { value: 'new',       label: '🆕 New',       color: 'var(--accent)' },
  { value: 'drafted',   label: '✍️ Drafted',   color: 'var(--green)' },
  { value: 'dismissed', label: '🚫 Dismissed', color: 'var(--text-muted)' },
  { value: '',          label: 'Усі',          color: 'var(--blue)' },
]

export default function RedditFeed() {
  const [posts, setPosts] = useState([])
  const [personas, setPersonas] = useState([])
  const [selectedPersona, setSelectedPersona] = useState('')
  const [statusFilter, setStatusFilter] = useState('new')
  const [subredditFilter, setSubredditFilter] = useState('')
  const [sortBy, setSortBy] = useState('newest') // 'newest' | 'oldest'
  const [loading, setLoading] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [scanResult, setScanResult] = useState(null)
  const [scanStatus, setScanStatus] = useState(null)
  const [devvitSyncing, setDevvitSyncing] = useState(false)
  const [devvitResult, setDevvitResult] = useState(null)
  const [devvitConfigured, setDevvitConfigured] = useState(null)
  const [draftsByPost, setDraftsByPost] = useState({})
  const [generatingId, setGeneratingId] = useState(null)
  const [fetchingFullId, setFetchingFullId] = useState(null)
  const [expandedId, setExpandedId] = useState(null)
  const [selectedIds, setSelectedIds] = useState(new Set())
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState(null)
  const _pollRef = useRef(null)

  useEffect(() => {
    loadPersonas()
    loadPosts()
    checkDevvitStatus()
    return () => { if (_pollRef.current) clearInterval(_pollRef.current) }
  }, [])

  useEffect(() => {
    loadPosts()
  }, [statusFilter, subredditFilter])

  const loadPersonas = async () => {
    if (!isElectron) return
    const list = await window.api.personas.getAll()
    setPersonas(list || [])
    if (list?.length && !selectedPersona) setSelectedPersona(list[0].id)
  }

  const loadPosts = async () => {
    if (!isElectron) return
    setLoading(true)
    setError(null)
    try {
      const r = await window.api.reddit.posts({
        status: statusFilter || null,
        subreddit: subredditFilter || null,
        limit: 200,
      })
      if (r?.ok) setPosts(r.posts)
      else setError(r?.error || 'Не вдалось завантажити')
    } catch (e) {
      setError(String(e))
    }
    setLoading(false)
  }

  const handleScan = async () => {
    if (!isElectron) return
    setScanning(true)
    setScanResult(null)
    setError(null)
    try {
      const r = await window.api.reddit.scan({})
      if (r?.ok) {
        if (_pollRef.current) clearInterval(_pollRef.current)
        _pollRef.current = setInterval(async () => {
          try {
            const s = await window.api.reddit.scanStatus()
            setScanStatus(s)
            if (s?.done) {
              clearInterval(_pollRef.current)
              _pollRef.current = null
              setScanning(false)
              if (s.error) {
                setError(s.error)
              } else if (s.result) {
                // Додаємо elapsed у scanResult щоб показати фінальний час
                // (бекенд повертає elapsed тільки коли done=true)
                setScanResult({ ...s.result, elapsed: s.elapsed })
                await loadPosts()
              }
            }
          } catch {}
        }, 3000)
      } else {
        setError(r?.error || 'Scan failed')
        setScanning(false)
      }
    } catch (e) {
      setError(String(e))
      setScanning(false)
    }
  }

  const checkDevvitStatus = async () => {
    if (!isElectron) return
    try {
      const s = await window.api.reddit.devvitStatus()
      setDevvitConfigured(s)
    } catch {}
  }

  const handleDevvitSync = async () => {
    if (!isElectron) return
    setDevvitSyncing(true)
    setDevvitResult(null)
    setError(null)
    try {
      const r = await window.api.reddit.devvitSync()
      if (r?.ok) {
        setDevvitResult(r)
        await loadPosts()
      } else {
        setError(r?.error || 'Devvit sync failed')
      }
    } catch (e) {
      setError(String(e))
    }
    setDevvitSyncing(false)
  }

  const handleGenerate = async (post, intent = 'value') => {
    if (!isElectron) return
    if (!selectedPersona) {
      setError('Спершу оберіть персону у списку вище.')
      return
    }
    const persona = personas.find(p => p.id === selectedPersona)
    if (!persona?.description?.trim()) {
      setError('У обраної персони порожній опис.')
      return
    }
    setGeneratingId(post.id)
    setError(null)
    try {
      const r = await window.api.reddit.draft({
        post_id: post.id,
        persona_id: selectedPersona,
        persona_description: persona.description,
        intent,
      })
      if (r?.ok) {
        setDraftsByPost(prev => ({ ...prev, [post.id]: r.all_drafts || [r.draft] }))
        // Локально оновлюємо статус поста — НЕ перезавантажуємо весь список,
        // щоб пост залишався на своєму місці у сортуванні.
        setPosts(prev => prev.map(p =>
          p.id === post.id ? { ...p, status: 'drafted' } : p
        ))
        setExpandedId(post.id)
      } else {
        setError(r?.error || 'Не вдалось згенерувати драфт')
      }
    } catch (e) {
      setError(String(e))
    }
    setGeneratingId(null)
  }

  const handleStatus = async (post, newStatus) => {
    if (!isElectron) return
    await window.api.reddit.status({ post_id: post.id, status: newStatus })
    // Локально оновлюємо статус, щоб не перерендерювати весь список.
    setPosts(prev => prev.map(p =>
      p.id === post.id ? { ...p, status: newStatus } : p
    ))
  }

  // Вибіркове видалення постів
  const toggleSelect = (postId) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(postId)) next.delete(postId)
      else next.add(postId)
      return next
    })
  }
  const selectAllVisible = () => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      posts.forEach(p => next.add(p.id))
      return next
    })
  }
  const clearSelection = () => setSelectedIds(new Set())
  const handleDeleteSelected = async () => {
    if (!isElectron) return
    const ids = Array.from(selectedIds)
    if (ids.length === 0) return
    if (!confirm(`Видалити ${ids.length} пост${ids.length === 1 ? '' : 'ів'} з бази? Цю дію не можна скасувати.`)) return
    setDeleting(true)
    setError(null)
    try {
      const r = await window.api.reddit.deletePosts({ ids })
      if (r?.ok) {
        // Локально прибираємо видалені пости зі списку (без перезавантаження)
        setPosts(prev => prev.filter(p => !selectedIds.has(p.id)))
        setSelectedIds(new Set())
        // Також оновлюємо статистику — перерахуємо її з поточного posts
        // (stats читає з posts, тож оновиться автоматично)
      } else {
        setError(r?.error || 'Не вдалось видалити')
      }
    } catch (e) {
      setError(String(e))
    }
    setDeleting(false)
  }

  const handleFetchFull = async (post) => {
    if (!isElectron) return
    setFetchingFullId(post.id)
    setError(null)
    try {
      const r = await window.api.reddit.fetchFull(post.id)
      if (r?.ok) {
        setPosts(prev => prev.map(p => p.id === post.id ? r.post : p))
        setExpandedId(post.id)
      } else {
        setError(r?.error || 'Fetch full failed')
      }
    } catch (e) {
      setError(String(e))
    }
    setFetchingFullId(null)
  }

  const handleLoadDrafts = async (postId) => {
    if (!isElectron) return
    if (draftsByPost[postId]) {
      setExpandedId(expandedId === postId ? null : postId)
      return
    }
    const r = await window.api.reddit.drafts(postId)
    if (r?.ok) {
      setDraftsByPost(prev => ({ ...prev, [postId]: r.drafts || [] }))
      setExpandedId(postId)
    }
  }

  const copyDraft = (text) => {
    navigator.clipboard?.writeText(text)
  }

  const [copiedLinkId, setCopiedLinkId] = useState(null)
  const copyLink = async (url, postId) => {
    try {
      await navigator.clipboard.writeText(url)
      setCopiedLinkId(postId)
      setTimeout(() => setCopiedLinkId(null), 1500)
    } catch (e) {
      // Fallback для старих Electron — select+execCommand
      const ta = document.createElement('textarea')
      ta.value = url
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      try { document.execCommand('copy') } catch {}
      document.body.removeChild(ta)
      setCopiedLinkId(postId)
      setTimeout(() => setCopiedLinkId(null), 1500)
    }
  }

  const uniqueSubreddits = [...new Set(posts.map(p => p.subreddit))].sort()
  const stats = {
    total: posts.length,
    new: posts.filter(p => p.status === 'new').length,
    drafted: posts.filter(p => p.status === 'drafted').length,
  }

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">📡 Reddit feed</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            className="btn-primary"
            onClick={handleScan}
            disabled={scanning || !isElectron}
          >
            {scanning ? '🔄 Сканування…' : '🔄 Сканувати RSS'}
          </button>
          <button
            className="btn-primary"
            onClick={handleDevvitSync}
            disabled={devvitSyncing || !isElectron}
            style={{ opacity: devvitConfigured?.configured ? 1 : 0.5 }}
            title={devvitConfigured?.configured ? 'Sync з Devvit (офіційний Reddit API, без IP бану)' : 'Devvit не налаштований — потрібен URL + token'}
          >
            {devvitSyncing ? '⚡ Синхро…' : '⚡ Sync Devvit'}
          </button>
        </div>
      </div>

      {/* Stats row */}
      <div className="stats-grid">
        <div className="stat-card" style={{ '--card-color': 'var(--accent)' }}>
          <div className="stat-icon">📡</div>
          <div className="stat-value">{stats.total}</div>
          <div className="stat-label">Постів у базі</div>
        </div>
        <div className="stat-card" style={{ '--card-color': '#4caf82' }}>
          <div className="stat-icon">🆕</div>
          <div className="stat-value">{stats.new}</div>
          <div className="stat-label">Нові</div>
        </div>
        <div className="stat-card" style={{ '--card-color': '#7c5cbf' }}>
          <div className="stat-icon">✍️</div>
          <div className="stat-value">{stats.drafted}</div>
          <div className="stat-label">З драфтом</div>
        </div>
        <div className="stat-card" style={{ '--card-color': '#4a9eda' }}>
          <div className="stat-icon">🎭</div>
          <div className="stat-value">{personas.length}</div>
          <div className="stat-label">Персон</div>
        </div>
      </div>

      {/* Scan progress / result */}
      {scanning && scanStatus?.running && scanStatus.elapsed != null && (
        <div className="reel-row" style={{ marginBottom: 12, borderColor: 'var(--accent)' }}>
          <div className="spinner spinner--sm" />
          <span style={{ fontSize: 13, color: 'var(--accent)' }}>
            Сканування триває… {Math.round(scanStatus.elapsed)}с
          </span>
        </div>
      )}
      {(scanResult || (scanning === false && scanStatus?.done)) && (
        <div className="reel-row" style={{ marginBottom: 12, borderColor: scanning ? 'var(--accent)' : 'var(--green)' }}>
          <span style={{ fontSize: 20 }}>{scanning ? '🔄' : '✅'}</span>
          <div className="account-info">
            <div className="account-handle">
              {scanning ? 'RSS-скан триває...' : 'RSS-скан завершено'}
            </div>
            <div className="account-meta">
              {scanning && scanStatus?.elapsed != null && (
                <span>⏱ {Math.floor(scanStatus.elapsed / 60)}хв {Math.round(scanStatus.elapsed % 60)}с</span>
              )}
              {scanResult && (
                <>
                  <span>⏱ {Math.floor((scanResult.elapsed || 0) / 60)}хв {Math.round((scanResult.elapsed || 0) % 60)}с</span>
                  <span>Переглянуто: {scanResult.seen}</span>
                  <span style={{ color: 'var(--green)' }}>Нових: {scanResult.inserted}</span>
                  <span>Дублів: {scanResult.duplicates}</span>
                </>
              )}
            </div>
          </div>
        </div>
      )}
      {devvitResult && (
        <div className="reel-row" style={{ marginBottom: 12, borderColor: 'var(--accent)' }}>
          <span style={{ fontSize: 20 }}>⚡</span>
          <div className="account-info">
            <div className="account-handle">Devvit-синхронізація</div>
            <div className="account-meta">
              <span>Отримано: {devvitResult.fetched}</span>
              <span style={{ color: 'var(--green)' }}>Нових: {devvitResult.inserted}</span>
              <span>Оновлено: {devvitResult.updated}</span>
              <span>Без змін: {devvitResult.unchanged}</span>
            </div>
          </div>
        </div>
      )}
      {error && (
        <div className="reel-row" style={{ marginBottom: 12, borderColor: '#e05252' }}>
          <span style={{ fontSize: 18 }}>⚠️</span>
          <span style={{ fontSize: 13, color: '#e05252', flex: 1 }}>{error}</span>
          <button className="btn-ghost" onClick={() => setError(null)}>✕</button>
        </div>
      )}

      {/* Filters toolbar */}
      <div className="reels-table" style={{ marginBottom: 16 }}>
        <div className="reel-row" style={{ padding: '10px 16px', gap: 12, flexWrap: 'wrap' }}>
          {/* Status tabs */}
          <div className="sort-tabs">
            {STATUS_TABS.map(t => (
              <button
                key={t.value}
                className={`sort-tab ${statusFilter === t.value ? 'sort-tab--active' : ''}`}
                onClick={() => setStatusFilter(t.value)}
              >
                {t.label}
              </button>
            ))}
          </div>
          {/* Subreddit filter */}
          <select
            className="form-select"
            style={{ width: 'auto', minWidth: 160, padding: '7px 10px' }}
            value={subredditFilter}
            onChange={e => setSubredditFilter(e.target.value)}
          >
            <option value="">— всі сабреддіти —</option>
            {uniqueSubreddits.map(s => <option key={s} value={s}>r/{s}</option>)}
          </select>
          {/* Sort by post age */}
          <select
            className="form-select"
            style={{ width: 'auto', minWidth: 150, padding: '7px 10px' }}
            value={sortBy}
            onChange={e => setSortBy(e.target.value)}
            title="Сортувати за часом створення поста на Reddit"
          >
            <option value="newest">🕒 Найновіші</option>
            <option value="oldest">🕰 Найдавніші</option>
          </select>
          {/* Bulk selection — з'являється тільки коли є вибрані пости */}
          {selectedIds.size > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 12, padding: '6px 12px', background: 'rgba(239,68,68,0.08)', borderRadius: 8, border: '1px solid rgba(239,68,68,0.3)' }}>
              <span style={{ fontSize: 13, color: 'var(--text-primary)' }}>
                Обрано: <b>{selectedIds.size}</b>
              </span>
              <button
                className="btn-ghost"
                style={{ fontSize: 12, padding: '4px 10px' }}
                onClick={selectAllVisible}
                title="Вибрати всі пости з поточного списку"
              >
                ☑ Усі
              </button>
              <button
                className="btn-ghost"
                style={{ fontSize: 12, padding: '4px 10px' }}
                onClick={clearSelection}
              >
                ✕ Очистити
              </button>
              <button
                className="btn-secondary"
                style={{ fontSize: 12, padding: '5px 12px', background: '#dc2626', color: 'white', border: 'none', borderRadius: 6, cursor: 'pointer' }}
                onClick={handleDeleteSelected}
                disabled={deleting}
                title="Видалити обрані пости з БД (разом з драфтами)"
              >
                {deleting ? '…' : `🗑 Видалити (${selectedIds.size})`}
              </button>
            </div>
          )}
          {/* Persona selector */}
          <select
            className="form-select"
            style={{ width: 'auto', minWidth: 180, padding: '7px 10px', marginLeft: 'auto' }}
            value={selectedPersona}
            onChange={e => setSelectedPersona(e.target.value)}
            title="Персона для генерації драфтів"
          >
            {personas.length === 0 && <option value="">— немає персони —</option>}
            {personas.map(p => (
              <option key={p.id} value={p.id}>{p.name}{p.subreddit ? ` (${p.subreddit})` : ''}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Posts list */}
      <div className="section-title">Пости</div>
      {loading ? (
        <div className="empty-state"><div className="spinner" /></div>
      ) : posts.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">📭</div>
          <div className="empty-text">
            {statusFilter ? 'Немає постів з таким фільтром' : 'Поки що немає постів'}
          </div>
          <div className="empty-sub">
            {statusFilter ? 'Спробуйте змінити фільтр статусу' : 'Натисніть «Сканувати Reddit» щоб зібрати пости'}
          </div>
        </div>
      ) : (
        <div className="reels-table">
          {(() => { const _sorted = [...posts].sort((a, b) => {
            // Сервер уже сортує за status + score. Ми додатково сортуємо
            // за created_utc (час поста на Reddit) у вибраному напрямку.
            // Якщо created_utc немає (0) — кладемо такі пости в кінець.
            const ta = a.created_utc || 0
            const tb = b.created_utc || 0
            return sortBy === 'oldest' ? ta - tb : tb - ta
          }); console.log('[RedditFeed] sortBy=' + sortBy + ' count=' + _sorted.length + ' top3_created_utc=' + _sorted.slice(0,3).map(p=>p.created_utc).join(',')); return _sorted
          })().map(p => (
            <PostCard
              key={p.id}
              post={p}
              expanded={expandedId === p.id}
              drafts={draftsByPost[p.id]}
              generating={generatingId === p.id}
              fetchingFull={fetchingFullId === p.id}
              selected={selectedIds.has(p.id)}
              onToggleSelect={() => toggleSelect(p.id)}
              onGenerate={(intent) => handleGenerate(p, intent)}
              onStatus={(s) => handleStatus(p, s)}
              onToggle={() => handleLoadDrafts(p.id)}
              onCopy={copyDraft}
              onFetchFull={() => handleFetchFull(p)}
              onCopyLink={(url) => copyLink(url, p.id)}
              copiedLinkId={copiedLinkId}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function PostCard({ post, expanded, drafts, generating, fetchingFull, selected, onToggleSelect, onGenerate, onStatus, onToggle, onCopy, onFetchFull, onCopyLink, copiedLinkId }) {
  const statusInfo = {
    new:       { icon: '🆕', text: 'New',       color: 'var(--accent)' },
    drafted:   { icon: '✍️', text: 'Drafted',   color: 'var(--green)' },
    dismissed: { icon: '🚫', text: 'Dismissed', color: 'var(--text-muted)' },
  }
  const si = statusInfo[post.status] || { icon: '❓', text: post.status, color: 'var(--text-muted)' }
  const hasSelftext = post.selftext?.length > 0

  return (
    <>
      <div
        className={`reel-row ${expanded ? 'reel-row--selected' : ''}`}
        style={{ flexDirection: 'column', alignItems: 'stretch', gap: 0, padding: 0 }}
      >
        {/* Main row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '12px 16px' }}>
          {/* Selection checkbox */}
          <input
            type="checkbox"
            checked={!!selected}
            onChange={onToggleSelect}
            title="Вибрати для видалення"
            style={{ flexShrink: 0, width: 18, height: 18, cursor: 'pointer' }}
          />
          {/* Status badge */}
          <div style={{
            flexShrink: 0, width: 36, height: 36, borderRadius: 8,
            background: `${si.color}20`, display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 16, color: si.color, fontWeight: 700,
          }}>
            {si.icon}
          </div>

          {/* Title + meta */}
          <div className="account-info" style={{ flex: 1, minWidth: 0 }}>
            <div className="account-handle" style={{
              fontSize: 13.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }}>
              <a href={post.permalink} target="_blank" rel="noopener noreferrer"
                 style={{ color: 'var(--text-primary)', textDecoration: 'none' }}>
                {post.title}
              </a>
            </div>
            <div className="account-meta">
              <span style={{ color: 'var(--purple)', fontWeight: 600 }}>r/{post.subreddit}</span>
              <span>u/{post.author}</span>
              <span>▲ {post.score}</span>
              <span>💬 {post.num_comments}</span>
              {hasSelftext && <span style={{ color: 'var(--green)' }}>📄 full text</span>}
            </div>
          </div>

          {/* Matched keywords */}
          {post.matched_keywords && (
            <div style={{ display: 'flex', gap: 4, flexShrink: 1, maxWidth: 200, flexWrap: 'wrap' }}>
              {post.matched_keywords.split(' ').filter(Boolean).slice(0, 3).map((k, i) => (
                <span key={i} style={{
                  fontSize: 10, padding: '2px 6px', borderRadius: 4,
                  background: 'var(--bg-hover)', color: 'var(--text-secondary)',
                }}>{k}</span>
              ))}
            </div>
          )}

          {/* Actions */}
          <div className="account-actions" style={{ flexShrink: 0 }}>
            <button
              className="btn-ghost"
              onClick={() => onCopyLink(post.permalink)}
              title="Копіювати посилання на пост"
              style={{ fontSize: 11, padding: '4px 8px' }}
            >
              {copiedLinkId === post.id ? '✅' : '🔗'}
            </button>
            <button
              className="btn-secondary"
              onClick={() => onGenerate('value')}
              disabled={generating}
              title="Згенерувати value-only відповідь"
            >
              {generating ? '…' : '✨ Драфт'}
            </button>
            <button
              className="btn-secondary"
              onClick={onToggle}
              title="Показати драфти"
            >
              {expanded ? '▲' : '▼'}
            </button>
            {post.status !== 'dismissed' && (
              <button
                className="btn-ghost"
                onClick={() => onStatus('dismissed')}
                title="Відхилити пост"
              >✕</button>
            )}
          </div>
        </div>

        {/* Expanded section */}
        {expanded && (
          <div style={{
            padding: '12px 16px', borderTop: '1px solid var(--border)',
            background: 'var(--bg-secondary)',
          }}>
            <DraftsList
              post={post}
              drafts={drafts}
              onCopy={onCopy}
              onGenerate={onGenerate}
              generating={generating}
              onFetchFull={onFetchFull}
              fetchingFull={fetchingFull}
            />
          </div>
        )}
      </div>
    </>
  )
}

function DraftsList({ post, drafts, onCopy, onGenerate, generating, onFetchFull, fetchingFull }) {
  const hasSelftext = post.selftext?.length > 0

  return (
    <div>
      {/* Full text section */}
      {hasSelftext ? (
        <div style={{
          background: 'var(--bg-card)', border: '1px solid var(--border)',
          borderRadius: 8, padding: 12, marginBottom: 12,
        }}>
          <div className="account-meta" style={{ marginBottom: 8 }}>
            <span style={{ color: 'var(--green)' }}>📄 Full post text</span>
            <span>{post.selftext.length} chars</span>
            {post.selftext_fetched_at && <span>fetched {post.selftext_fetched_at.slice(0, 19)}</span>}
          </div>
          <div style={{
            whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: 1.5,
            maxHeight: 300, overflowY: 'auto', color: 'var(--text-secondary)',
          }}>
            {post.selftext}
          </div>
          <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
            <button className="btn-secondary" onClick={() => onCopy(post.selftext)}>📋 Copy</button>
            <button className="btn-secondary" onClick={onFetchFull} disabled={fetchingFull}>
              {fetchingFull ? 'Refreshing…' : '🔄 Refresh'}
            </button>
          </div>
        </div>
      ) : (
        <div style={{ marginBottom: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
          <button className="btn-secondary" onClick={onFetchFull} disabled={fetchingFull}>
            {fetchingFull ? 'Завантажую…' : '📄 Завантажити повний текст'}
          </button>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            Один запит до Reddit JSON API. Не фетчити для всіх одразу — rate-limit.
          </span>
        </div>
      )}

      {/* Generate buttons */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <button className="btn-primary" onClick={() => onGenerate('value')} disabled={generating}>
          {generating ? 'Генерую…' : '✨ Value-драфт'}
        </button>
        <button className="btn-secondary" onClick={() => onGenerate('light-promo')} disabled={generating}>
          🌱 Light promo
        </button>
      </div>

      {/* Drafts list */}
      {(drafts || []).length === 0 ? (
        <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Драфтів поки немає.</div>
      ) : (
        drafts.map(d => (
          <div key={d.id} style={{
            background: 'var(--bg-card)', border: '1px solid var(--border)',
            borderRadius: 8, padding: 12, marginBottom: 8,
          }}>
            <div className="account-meta" style={{ marginBottom: 6 }}>
              <span style={{ color: 'var(--accent)', fontWeight: 600 }}>{d.intent}</span>
              <span>{d.created_at}</span>
              {d.model && <span>{d.model}</span>}
            </div>
            <div style={{ whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: 1.5, marginBottom: 6, color: 'var(--text-primary)' }}>
              {(d.reply || d.reply_text) || (d.error ? `⚠ ${d.error}` : '—')}
            </div>
            {(d.reply || d.reply_text) && (
              <button className="btn-secondary" onClick={() => onCopy(d.reply || d.reply_text)}>📋 Copy</button>
            )}
          </div>
        ))
      )}
    </div>
  )
}