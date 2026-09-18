import { useState, useEffect } from 'react'
import './Pages.css'

const isElectron = typeof window !== 'undefined' && !!window.api

export default function Accounts() {
  const [accounts, setAccounts] = useState([])
  const [showModal, setShowModal] = useState(false)
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(true)
  const [parsing, setParsing] = useState({}) // { accountId: 'account' | 'reels' | null }

  useEffect(() => { loadAccounts() }, [])

  const loadAccounts = async () => {
    setLoading(true)
    if (isElectron) {
      const data = await window.api.accounts.getAll()
      setAccounts(data)
    }
    setLoading(false)
  }

  const handleAdd = async () => {
    const handle = input.trim()
      .replace(/^@/, '')
      .replace(/.*instagram\.com\//, '')
      .replace(/\/$/, '')
    if (!handle) return
    if (isElectron) {
      await window.api.accounts.add(handle)
      await loadAccounts()
    } else {
      setAccounts(prev => [...prev, {
        id: Date.now(), username: handle,
        followers: 0, reels_count: 0, reels_parsed: 0,
      }])
    }
    setInput('')
    setShowModal(false)
  }

  const handleRemove = async (id) => {
    if (isElectron) {
      await window.api.accounts.delete(id)
      await loadAccounts()
    } else {
      setAccounts(prev => prev.filter(a => a.id !== id))
    }
  }

  const handleParse = async (acc) => {
    if (!isElectron) return
    setParsing(p => ({ ...p, [acc.id]: 'account' }))

    // 1. Отримати інфо про акаунт
    const info = await window.api.python.parseAccount(acc.username)
    if (!info.ok) {
      alert(`Помилка: ${info.error}`)
      setParsing(p => ({ ...p, [acc.id]: null }))
      return
    }

    // 2. Завантажити Reels
    setParsing(p => ({ ...p, [acc.id]: 'reels' }))
    const result = await window.api.python.parseReels(acc.username, acc.id, 50)

    if (!result.ok) {
      alert(`Помилка завантаження Reels: ${result.error}`)
    }

    setParsing(p => ({ ...p, [acc.id]: null }))
    await loadAccounts()
  }

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">👤 Instagram Акаунти</h1>
        <button className="btn-primary" onClick={() => setShowModal(true)}>
          + Додати акаунт
        </button>
      </div>

      {loading ? (
        <div className="empty-state">
          <div className="spinner" />
          <div>Завантаження...</div>
        </div>
      ) : accounts.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">📱</div>
          <div className="empty-text">Немає акаунтів</div>
          <div className="empty-sub">Додайте Instagram акаунти конкурентів для моніторингу</div>
          <button className="btn-primary" style={{ marginTop: 16 }} onClick={() => setShowModal(true)}>
            Додати перший акаунт
          </button>
        </div>
      ) : (
        <div className="accounts-list">
          {accounts.map(acc => {
            const state = parsing[acc.id]
            return (
              <div key={acc.id} className="account-card">
                <div className="account-avatar">
                  {acc.username[0].toUpperCase()}
                </div>
                <div className="account-info">
                  <div className="account-handle">@{acc.username}</div>
                  <div className="account-meta">
                    {acc.followers > 0 && <span>Підписники: {fmtNum(acc.followers)}</span>}
                    {acc.reels_count > 0 && <span>Reels: {acc.reels_count}</span>}
                    <span>Спарсовано: {acc.reels_parsed || 0}</span>
                    {acc.last_parsed_at
                      ? <span className="account-status">Оновлено {fmtDate(acc.last_parsed_at)}</span>
                      : <span className="account-status--pending">Ще не парсилось</span>}
                  </div>
                  {state && (
                    <div className="parse-progress">
                      <div className="spinner spinner--sm" />
                      {state === 'account' ? 'Завантаження інфо...' : 'Завантаження Reels...'}
                    </div>
                  )}
                </div>
                <div className="account-actions">
                  <button
                    className="btn-secondary"
                    onClick={() => isElectron && window.api.shell.openExternal(`https://instagram.com/${acc.username}`)}
                    title="Відкрити в Instagram"
                  >
                    🔗
                  </button>
                  <button
                    className="btn-primary"
                    onClick={() => handleParse(acc)}
                    disabled={!!state}
                  >
                    {state ? '⏳' : '🔄'} Парсити
                  </button>
                  <button className="btn-danger" onClick={() => handleRemove(acc.id)}>
                    Видалити
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {showModal && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <span>📱 Додати Instagram акаунт</span>
              <button className="modal-close" onClick={() => setShowModal(false)}>✕</button>
            </div>
            <div className="modal-body">
              <label className="form-label">Нікнейм або URL акаунту</label>
              <input
                className="form-input"
                placeholder="@username або https://instagram.com/username"
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleAdd()}
                autoFocus
              />
            </div>
            <div className="modal-footer">
              <button className="btn-ghost" onClick={() => setShowModal(false)}>Скасувати</button>
              <button className="btn-primary" onClick={handleAdd}>Додати акаунт</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function fmtNum(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
  return n
}

function fmtDate(iso) {
  return new Date(iso).toLocaleDateString('uk-UA')
}
