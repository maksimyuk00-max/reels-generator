import { useState, useEffect } from 'react'
import './Pages.css'

const isElectron = typeof window !== 'undefined' && !!window.api

export default function Overview() {
  const [stats, setStats] = useState({ accounts: 0, reels: 0, downloaded: 0 })

  useEffect(() => {
    if (isElectron) {
      window.api.stats.get().then(setStats)
    }
  }, [])

  const cards = [
    { label: 'Акаунти',          value: stats.accounts,   icon: '👤', color: '#e8533a' },
    { label: 'Reels у базі',     value: stats.reels,      icon: '🎬', color: '#7c5cbf' },
    { label: 'Завантажено',      value: stats.downloaded, icon: '⬇️', color: '#4a9eda' },
    { label: 'Згенеровано відео',value: 0,                icon: '⚡', color: '#4caf82' },
  ]

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">📊 Огляд</h1>
        <div className="status-dot status-dot--idle" title="Очікування" />
      </div>

      <div className="stats-grid">
        {cards.map(s => (
          <div key={s.label} className="stat-card" style={{ '--card-color': s.color }}>
            <div className="stat-icon">{s.icon}</div>
            <div className="stat-value">{s.value}</div>
            <div className="stat-label">{s.label}</div>
          </div>
        ))}
      </div>

      <div className="section-title">Останні дії</div>
      <div className="empty-state">
        <div className="empty-icon">📭</div>
        <div className="empty-text">Поки що нічого немає</div>
        <div className="empty-sub">Додайте Instagram акаунт щоб почати</div>
      </div>
    </div>
  )
}
