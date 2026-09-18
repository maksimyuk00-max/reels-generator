import { useState, useEffect } from 'react'
import './Pages.css'

const isElectron = typeof window !== 'undefined' && !!window.api

export default function Analytics() {
  const [accounts, setAccounts] = useState([])
  const [selectedAccount, setSelectedAccount] = useState(null)
  const [reels, setReels] = useState([])
  const [sortBy, setSortBy] = useState('published_at')
  const [loading, setLoading] = useState(false)
  const [enriching, setEnriching] = useState(false)
  const [enrichProgress, setEnrichProgress] = useState(null) // { index, total, updated }

  useEffect(() => {
    loadAccounts()
    // Слухаємо прогрес збагачення
    if (isElectron && window.api.on) {
      const unsub = window.api.on('enrich:progress', (data) => {
        setEnrichProgress(data)
      })
      return unsub
    }
  }, [])

  useEffect(() => {
    if (selectedAccount) loadReels(selectedAccount.id)
  }, [selectedAccount, sortBy])

  const loadAccounts = async () => {
    if (!isElectron) return
    const data = await window.api.accounts.getAll()
    setAccounts(data)
    if (data.length > 0) setSelectedAccount(data[0])
  }

  const loadReels = async (accountId) => {
    if (!isElectron) return
    setLoading(true)
    const data = await window.api.reels.getByAccount(accountId, sortBy)
    setReels(data)
    setLoading(false)
  }

  const [selectedReels, setSelectedReels] = useState(new Set())
  const [downloading, setDownloading] = useState(false)
  const [enrichError, setEnrichError] = useState('')

  const toggleReel = (reelId) => {
    setSelectedReels(prev => {
      const next = new Set(prev)
      if (next.has(reelId)) next.delete(reelId)
      else next.add(reelId)
      return next
    })
  }

  const toggleAll = () => {
    if (selectedReels.size === reels.length) setSelectedReels(new Set())
    else setSelectedReels(new Set(reels.map(r => r.reel_id)))
  }

  const handleDownloadAudio = async () => {
    if (!selectedReels.size) return
    setDownloading(true)
    const selected = reels.filter(r => selectedReels.has(r.reel_id))
    for (const reel of selected) {
      try {
        await window.api.python.extractAudio(reel.reel_id, reel.video_url)
      } catch (e) {
        console.error('Audio extract failed:', e)
      }
    }
    setDownloading(false)
    setSelectedReels(new Set())
    alert(`✅ Аудіо витягнуто з ${selected.length} рілсів → папка reels-generator/audio`)
  }

  const handleEnrichViews = async () => {
    if (!isElectron || !reels.length) return
    setEnriching(true)
    setEnrichError('')
    setEnrichProgress({ index: 0, total: reels.length, updated: 0 })
    const reelIds = reels.map(r => r.reel_id)
    try {
      const result = await window.api.python.enrichViews(reelIds)
      if (!result.ok) {
        setEnrichError(result.error || 'Невідома помилка')
      } else {
        await loadReels(selectedAccount.id)
      }
    } catch (e) {
      setEnrichError(String(e))
    }
    setEnriching(false)
    setEnrichProgress(null)
  }

  const sorts = [
    { key: 'published_at', label: 'Дата' },
    { key: 'views',        label: 'Перегляди' },
    { key: 'likes',        label: 'Лайки' },
    { key: 'comments',     label: 'Коментарі' },
  ]

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">🎬 Аналітика Reels</h1>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <div className="sort-tabs">
            {sorts.map(s => (
              <button
                key={s.key}
                className={`sort-tab ${sortBy === s.key ? 'sort-tab--active' : ''}`}
                onClick={() => setSortBy(s.key)}
              >
                {s.label}
              </button>
            ))}
          </div>
          {reels.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-end' }}>
              <div style={{ display: 'flex', gap: 8 }}>
                {selectedReels.size > 0 && (
                  <button
                    className="btn-secondary"
                    onClick={handleDownloadAudio}
                    disabled={downloading}
                    style={{ background: '#7c3aed' }}
                  >
                    {downloading ? '⏳ Завантаження...' : `🎵 Скачати музику (${selectedReels.size})`}
                  </button>
                )}
                <button
                  className="btn-secondary"
                  onClick={handleEnrichViews}
                  disabled={enriching}
                  title="Завантажити кількість переглядів для всіх Reels"
                >
                  {enriching
                    ? `⏳ ${enrichProgress?.index || 0} / ${enrichProgress?.total || 0}`
                    : '👁 Завантажити перегляди'}
                </button>
              </div>
              {enrichError && (
                <div style={{ fontSize: 12, color: '#e05252', maxWidth: 300, textAlign: 'right' }}>
                  ❌ {enrichError}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Вибір акаунту */}
      {accounts.length > 1 && (
        <div className="account-tabs">
          {accounts.map(acc => (
            <button
              key={acc.id}
              className={`account-tab ${selectedAccount?.id === acc.id ? 'account-tab--active' : ''}`}
              onClick={() => setSelectedAccount(acc)}
            >
              @{acc.username}
              <span className="account-tab-count">{acc.reels_parsed}</span>
            </button>
          ))}
        </div>
      )}

      {loading ? (
        <div className="empty-state"><div className="spinner" /><div>Завантаження...</div></div>
      ) : reels.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">🎬</div>
          <div className="empty-text">Немає даних</div>
          <div className="empty-sub">Спочатку спарсіть акаунт на сторінці Акаунти</div>
        </div>
      ) : (
        <>
          <div className="table-header-row">
            <span style={{ width: 32, cursor: 'pointer' }} onClick={toggleAll}>
              {selectedReels.size === reels.length && reels.length > 0 ? '☑' : '☐'}
            </span>
            <span style={{ flex: 3 }}>ВІДЕО</span>
            <span>ДАТА</span>
            <span>ПЕРЕГЛЯДИ</span>
            <span>ЛАЙКИ</span>
            <span>КОМЕНТАРІ</span>
            <span>ТРИВАЛІСТЬ</span>
            <span></span>
          </div>

          <div className="reels-table">
            {reels.map(reel => (
              <div key={reel.id} className={`reel-row ${selectedReels.has(reel.reel_id) ? 'reel-row--selected' : ''}`}>
                <span
                  style={{ width: 32, cursor: 'pointer', fontSize: 16, flexShrink: 0 }}
                  onClick={() => toggleReel(reel.reel_id)}
                >
                  {selectedReels.has(reel.reel_id) ? '☑' : '☐'}
                </span>
                <div className="reel-title-cell">
                  <div className="reel-thumb">
                    {reel.thumbnail_url
                      ? <img src={reel.thumbnail_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 6 }} />
                      : '🎬'}
                  </div>
                  <span className="reel-title">{reel.title || '(без підпису)'}</span>
                </div>
                <span className="reel-cell">{fmtDate(reel.published_at)}</span>
                <span className="reel-cell reel-cell--accent" title="Instagram приховує перегляди через API">
                  {reel.views > 0 ? fmtNum(reel.views) : '—'}
                </span>
                <span className="reel-cell reel-cell--red">{fmtNum(reel.likes)}</span>
                <span className="reel-cell reel-cell--blue">{reel.comments}</span>
                <span className="reel-cell">{fmtDuration(reel.duration)}</span>
                <div style={{ display: 'flex', gap: 4 }}>
                  <button
                    className="btn-icon"
                    title="Відкрити в Instagram"
                    onClick={() => isElectron && window.api.shell.openExternal(reel.instagram_url || `https://www.instagram.com/reel/${reel.code || reel.reel_id}/`)}
                  >🔗</button>
                  {reel.video_url && (
                    <button
                      className="btn-icon"
                      title="Відкрити відео у браузері"
                      onClick={() => isElectron && window.api.shell.openExternal(reel.video_url)}
                    >▶</button>
                  )}
                </div>
              </div>
            ))}
          </div>

          <div className="table-note">
            Всього: {reels.length} Reels • Акаунт @{selectedAccount?.username}
          </div>
        </>
      )}
    </div>
  )
}

function fmtNum(n) {
  if (!n) return '0'
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
  return String(n)
}

function fmtDate(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('uk-UA')
}

function fmtDuration(sec) {
  if (!sec) return '—'
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}:${String(s).padStart(2, '0')}`
}
