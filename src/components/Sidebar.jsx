import { NavLink } from 'react-router-dom'
import { useState, useEffect } from 'react'
import './Sidebar.css'

const navItems = [
  {
    section: 'ГОЛОВНЕ',
    items: [
      { path: '/overview', label: 'Огляд', icon: '📊' },
      { path: '/accounts', label: 'Акаунти', icon: '👤' },
    ],
  },
  {
    section: 'INSTAGRAM',
    items: [
      { path: '/analytics', label: 'Аналітика', icon: '🎬' },
      { path: '/calendar', label: 'Календар', icon: '📅' },
      { path: '/posting', label: 'Постинг', icon: '📤' },
      { path: '/warmup',  label: 'Прогрів',  icon: '🔥' },
    ],
  },
  {
    section: 'THREADS',
    items: [
      { path: '/threads', label: 'Threads', icon: '🧵' },
    ],
  },
  {
    section: 'ІНСТРУМЕНТИ',
    items: [
      { path: '/generator', label: 'Генератор відео', icon: '⚡' },
      { path: '/ytcfusion', label: 'Ytc Fusion', icon: '🧬' },
      { path: '/editor',    label: 'Редактор',        icon: '✂️' },
      { path: '/posts',     label: 'Пости / Карусель', icon: '📸' },
      { path: '/carousel-agent', label: 'Carousel Agent', icon: '🤖' },
      { path: '/personas',  label: 'Персони',          icon: '🎭' },
      { path: '/content',   label: 'Контент',           icon: '✍️' },
      { path: '/reddit',    label: 'Reddit feed',       icon: '🛎' },
      { path: '/utm',       label: 'UTM Links',         icon: '🔗' },
      { path: '/iphone',    label: 'iPhone Bridge',     icon: '📱' },
      { path: '/history', label: 'Історія', icon: '📁' },
    ],
  },
  {
    section: 'СИСТЕМА',
    items: [
      { path: '/sync',     label: 'Синхронізація', icon: '🔄' },
      { path: '/settings', label: 'Налаштування', icon: '⚙️' },
    ],
  },
]

const isElectron = typeof window !== 'undefined' && !!window.api

export default function Sidebar() {
  const [pythonStatus, setPythonStatus] = useState('checking') // checking | ok | error

  useEffect(() => {
    checkPython()
    const interval = setInterval(checkPython, 5000)
    return () => clearInterval(interval)
  }, [])

  const checkPython = async () => {
    if (!isElectron) { setPythonStatus('ok'); return }
    try {
      const result = await window.api.python.status()
      setPythonStatus(result.running ? 'ok' : 'error')
    } catch {
      setPythonStatus('error')
    }
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-logo">
        <div className="logo-icon">🎬</div>
        <div className="logo-text">
          <span className="logo-title">Reels</span>
          <span className="logo-sub">GENERATOR</span>
        </div>
      </div>

      <nav className="sidebar-nav">
        {navItems.map((group) => (
          <div key={group.section} className="nav-group">
            <span className="nav-section-label">{group.section}</span>
            {group.items.map((item) => (
              <NavLink
                key={item.path}
                to={item.path}
                className={({ isActive }) =>
                  `nav-item ${isActive ? 'nav-item--active' : ''}`
                }
              >
                <span className="nav-icon">{item.icon}</span>
                <span className="nav-label">{item.label}</span>
              </NavLink>
            ))}
          </div>
        ))}
      </nav>

      <div className="sidebar-footer">
        <div className="python-status">
          <div className={`python-dot python-dot--${pythonStatus}`} />
          <span className="python-label">
            {pythonStatus === 'ok' && 'Сервер працює'}
            {pythonStatus === 'error' && 'Сервер не працює'}
            {pythonStatus === 'checking' && 'Перевірка...'}
          </span>
        </div>
        <span className="sidebar-version">Reels Generator v1.0</span>
      </div>
    </aside>
  )
}
