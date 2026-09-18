import { useState, useEffect, useRef } from 'react'
import './Pages.css'

const isElectron = typeof window !== 'undefined' && !!window.api
const PYTHON_PORT = 8765

// Dual-thumb range slider
function RangeSlider({ min, max, step = 1, value, onChange, accent = '#6366f1' }) {
  const trackRef = useRef(null)
  const [dragging, setDragging] = useState(null)
  const [lo, hi] = value

  useEffect(() => {
    if (!dragging) return
    const onMove = (e) => {
      const rect = trackRef.current?.getBoundingClientRect()
      if (!rect) return
      const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width))
      const raw = min + (x / rect.width) * (max - min)
      const snapped = Math.round(raw / step) * step
      const clamped = Math.max(min, Math.min(max, snapped))
      if (dragging === 'lo') onChange([Math.min(clamped, hi - step), hi])
      else onChange([lo, Math.max(clamped, lo + step)])
    }
    const onUp = () => setDragging(null)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [dragging, lo, hi, min, max, step, onChange])

  const pct = (v) => ((v - min) / (max - min)) * 100

  return (
    <div
      ref={trackRef}
      style={{
        position: 'relative', height: 24, userSelect: 'none',
        cursor: 'pointer', margin: '4px 10px',
      }}
    >
      {/* Track (full) */}
      <div style={{
        position: 'absolute', left: 0, right: 0, top: '50%', transform: 'translateY(-50%)',
        height: 4, background: 'var(--bg)', borderRadius: 2,
      }} />
      {/* Active range */}
      <div style={{
        position: 'absolute', top: '50%', transform: 'translateY(-50%)',
        left: `${pct(lo)}%`, width: `${pct(hi) - pct(lo)}%`,
        height: 4, background: accent, borderRadius: 2,
      }} />
      {/* Low thumb */}
      <div
        onMouseDown={(e) => { e.preventDefault(); setDragging('lo') }}
        style={{
          position: 'absolute', top: '50%', left: `${pct(lo)}%`,
          transform: 'translate(-50%, -50%)',
          width: 16, height: 16, borderRadius: '50%', background: accent,
          border: '2px solid var(--card-bg, #1a1a24)', cursor: 'grab',
          boxShadow: '0 2px 6px rgba(0,0,0,0.4)', zIndex: dragging === 'lo' ? 3 : 2,
        }}
      />
      {/* High thumb */}
      <div
        onMouseDown={(e) => { e.preventDefault(); setDragging('hi') }}
        style={{
          position: 'absolute', top: '50%', left: `${pct(hi)}%`,
          transform: 'translate(-50%, -50%)',
          width: 16, height: 16, borderRadius: '50%', background: accent,
          border: '2px solid var(--card-bg, #1a1a24)', cursor: 'grab',
          boxShadow: '0 2px 6px rgba(0,0,0,0.4)', zIndex: dragging === 'hi' ? 3 : 2,
        }}
      />
    </div>
  )
}

export default function Warmup() {
  // Пристрої
  const [devices, setDevices]       = useState([])
  const [serial, setSerial]         = useState('')
  // Wireless Debugging (Android 11+)
  const [wdOpen, setWdOpen]         = useState(false)
  const [wdPairHost, setWdPairHost] = useState('')
  const [wdPairCode, setWdPairCode] = useState('')
  const [wdBusy, setWdBusy]         = useState(false)
  const [wdMsg, setWdMsg]           = useState('')
  // Wi-Fi ADB watchdog
  const [wifiState, setWifiState]   = useState(null)
  const [deviceInfo, setDeviceInfo] = useState(null)
  const [loadingDev, setLoadingDev] = useState(false)

  // Налаштування сесії
  const [duration, setDuration]         = useState(5)    // хвилини
  const [likeProb, setLikeProb]         = useState(20)   // %
  const [useAi, setUseAi]               = useState(false) // AI vision приймає рішення
  const [settings, setSettings]         = useState(null)

  // Стан сесії
  const [running, setRunning]     = useState(false)
  const [elapsed, setElapsed]     = useState(0)          // секунди
  const [result, setResult]       = useState(null)       // { ok, reels_watched, likes_given, saves_given, duration, ai_decisions }
  const timerRef                  = useRef(null)
  const startRef                  = useRef(null)

  // Дзеркало (screenshot polling)
  const [mirrorOn, setMirrorOn]   = useState(false)
  const [mirrorTick, setMirrorTick] = useState(0)
  const mirrorTimerRef            = useRef(null)

  // Авто-розклад (config)
  const [schedule, setSchedule]   = useState(null)
  const [accounts, setAccounts]   = useState([])
  const [scheduleRunning, setScheduleRunning] = useState(false)
  const [now, setNow]             = useState(Date.now())

  // План (DB)
  const today = new Date().toISOString().split('T')[0]
  const threeDaysAhead = new Date(Date.now() + 2 * 86400000).toISOString().split('T')[0]
  const [planStartDate, setPlanStartDate] = useState(today)
  const [planEndDate, setPlanEndDate]     = useState(threeDaysAhead)
  const [plannedSessions, setPlannedSessions] = useState([])
  const [generating, setGenerating]       = useState(false)
  const [viewingSession, setViewingSession] = useState(null) // session для модалки деталей

  useEffect(() => {
    if (!isElectron) return

    window.api.settings.get().then(s => {
      if (s) {
        setSettings(s)
        if (s.warmupSchedule) setSchedule(s.warmupSchedule)
      }
    })
    window.api.accounts.getAll().then(d => setAccounts(d || []))
    refreshDevices()
    loadPlan()

    // Live countdown
    const nowInterval = setInterval(() => setNow(Date.now()), 1000)

    // Events від scheduler
    const unsubStart = window.api.on?.('warmup:started', () => {
      setScheduleRunning(true)
      loadPlan()
    })
    const unsubEnd = window.api.on?.('warmup:finished', (data) => {
      setScheduleRunning(false)
      loadPlan()
    })

    return () => {
      clearInterval(nowInterval)
      if (unsubStart) unsubStart()
      if (unsubEnd) unsubEnd()
    }
  }, [])

  // Зберігаємо зміни schedule в settings
  const saveSchedule = async (patch) => {
    if (!schedule) return
    const newSchedule = { ...schedule, ...patch }
    setSchedule(newSchedule)
    await window.api.settings.save({ warmupSchedule: newSchedule })
  }

  const loadPlan = async () => {
    if (!isElectron) return
    const sessions = await window.api.warmup.getSessions()
    setPlannedSessions(sessions || [])
  }

  const handleGeneratePlan = async (replace = false) => {
    if (!serial) {
      alert('Обери пристрій вище')
      return
    }
    const config = {
      sessionsPerDay: schedule.sessionsPerDay,
      activeHourStart: schedule.activeHourStart,
      activeHourEnd: schedule.activeHourEnd,
      durationMin: schedule.durationMin,
      durationMax: schedule.durationMax,
      likeProbMin: schedule.likeProbMin,
      likeProbMax: schedule.likeProbMax,
      useAi: schedule.useAi,
      serial: serial,
      accountId: schedule.accountId,
    }
    setGenerating(true)
    try {
      const r = await window.api.warmup.generatePlan(
        config,
        { startDate: planStartDate, endDate: planEndDate },
        replace,
      )
      if (r.ok) {
        await loadPlan()
        alert(`Створено ${r.count} сесій`)
      } else {
        alert('Помилка: ' + (r.error || 'unknown'))
      }
    } catch (e) {
      alert('Помилка: ' + String(e))
    }
    setGenerating(false)
  }

  const handleDeletePending = async () => {
    if (!confirm('Видалити всі заплановані (невиконані) сесії?')) return
    await window.api.warmup.deletePending()
    await loadPlan()
  }

  const triggerScheduleNow = async () => {
    const r = await window.api.warmup.triggerNow()
    if (!r.ok) alert(r.error)
    else await loadPlan()
  }

  const openSessionDetails = async (id) => {
    const full = await window.api.warmup.getSession(id)
    setViewingSession(full)
  }

  const formatCountdown = (isoAt) => {
    if (!isoAt) return '—'
    const diff = new Date(isoAt).getTime() - now
    if (diff <= 0) return 'зараз'
    const h = Math.floor(diff / 3600000)
    const m = Math.floor((diff % 3600000) / 60000)
    if (h > 0) return `через ${h}г ${m}хв`
    const s = Math.floor((diff % 60000) / 1000)
    return `через ${m}хв ${s}с`
  }

  const formatTime = (iso) => iso ? new Date(iso).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' }) : ''

  const refreshDevices = async () => {
    if (!isElectron) return
    setLoadingDev(true)
    try {
      const d = await window.api.python.androidDevices()
      if (d?.ok) {
        setDevices(d.devices || [])
        if (!serial && d.devices?.[0]) setSerial(d.devices[0])
      }
    } finally {
      setLoadingDev(false)
    }
  }

  // ── Wireless Debugging (Android 11+) ──
  const handleMdnsDiscover = async () => {
    setWdBusy(true); setWdMsg('')
    try {
      const r = await window.api.python.androidMdnsDiscover()
      if (!r?.ok) {
        setWdMsg(`❌ ${r?.error || 'mDNS не вдалося'}`)
      } else if (r.devices.length === 0) {
        setWdMsg('⚠️ Пристроїв у мережі не знайдено. Переконайся що Wireless Debugging увімкнено.')
      } else {
        setWdMsg(`✅ Знайдено: ${r.devices.map(d => d.host).join(', ')}`)
        // Конектимось до першого
        const cr = await window.api.python.androidConnect(r.devices[0].host)
        if (cr?.ok) {
          await refreshDevices()
          setSerial(r.devices[0].host)
          setWdMsg(`✅ Підключено до ${r.devices[0].host}`)
        } else {
          setWdMsg(`❌ Знайдено, але не підключилось: ${cr?.error}`)
        }
      }
    } catch (e) { setWdMsg('❌ ' + String(e)) }
    setWdBusy(false)
  }

  const handleWdPair = async () => {
    if (!wdPairHost || wdPairCode.length !== 6) return
    setWdBusy(true); setWdMsg('')
    try {
      const r = await window.api.python.androidPair(wdPairHost, wdPairCode)
      if (r?.ok) {
        setWdMsg('✅ Спаровано! Зараз шукаю пристрій в мережі...')
        setWdPairCode('')
        // Після успішного paring — робимо mDNS discover і connect
        setTimeout(handleMdnsDiscover, 1500)
      } else {
        setWdMsg(`❌ Pair fail: ${r?.error || 'unknown'}`)
      }
    } catch (e) { setWdMsg('❌ ' + String(e)) }
    setWdBusy(false)
  }

  const refreshStatus = async (s) => {
    if (!isElectron || !s) return
    const r = await window.api.python.androidStatus(s)
    setDeviceInfo(r)
  }

  useEffect(() => {
    if (serial) refreshStatus(serial)
  }, [serial])

  // Таймер прогресу
  const startTimer = () => {
    startRef.current = Date.now()
    timerRef.current = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startRef.current) / 1000))
    }, 500)
  }
  const stopTimer = () => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
  }

  const handleStart = async () => {
    setRunning(true)
    setElapsed(0)
    setResult(null)
    startTimer()
    try {
      const r = await window.api.python.androidScrollReels(
        serial || null,
        duration * 60,
        likeProb / 100,
        settings?.androidProxy || null,
        useAi,
        '', // API key не потрібен — використовується claude.exe CLI
      )
      setResult(r)
    } catch (e) {
      setResult({ ok: false, error: String(e) })
    } finally {
      stopTimer()
      setRunning(false)
    }
  }

  // Mirror polling — оновлюємо screenshot кожні 400ms
  useEffect(() => {
    if (!mirrorOn || !serial) {
      if (mirrorTimerRef.current) { clearInterval(mirrorTimerRef.current); mirrorTimerRef.current = null }
      return
    }
    mirrorTimerRef.current = setInterval(() => setMirrorTick(t => t + 1), 400)
    return () => { if (mirrorTimerRef.current) clearInterval(mirrorTimerRef.current) }
  }, [mirrorOn, serial])

  // Wi-Fi ADB watchdog subscription
  useEffect(() => {
    if (!isElectron) return
    window.api.wifiAdb?.getStatus?.().then(setWifiState).catch(() => {})
    const off = window.api.on?.('wifi-adb:status', setWifiState)
    return () => { if (off) off() }
  }, [])

  const handleScrcpy = async () => {
    const r = await window.api.python.scrcpy(serial || null)
    if (!r?.ok) alert(r?.error || 'Помилка запуску scrcpy')
  }

  const totalSec    = duration * 60
  const progress    = running ? Math.min((elapsed / totalSec) * 100, 100) : (result ? 100 : 0)
  const remaining   = Math.max(0, totalSec - elapsed)
  const remMin      = String(Math.floor(remaining / 60)).padStart(2, '0')
  const remSec      = String(remaining % 60).padStart(2, '0')
  const elMin       = String(Math.floor(elapsed / 60)).padStart(2, '0')
  const elSec       = String(elapsed % 60).padStart(2, '0')
  const estReels    = running ? Math.round(elapsed / 14) : 0  // ~14 сек/рілс

  const wifiDevices = devices.filter(s => s.includes('.'))
  const usbDevices  = devices.filter(s => !s.includes('.'))

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">🔥 Прогрів акаунту</h1>
        <p style={{ color: 'var(--text-secondary)', fontSize: 13, margin: 0 }}>
          Скролінг Reels через Android — імітує поведінку живої людини
        </p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: mirrorOn ? '1fr 1fr 280px' : '1fr 1fr', gap: 16, maxWidth: mirrorOn ? 1180 : 860 }}>

        {/* ── Пристрій ── */}
        <div className="card" style={{ gridColumn: mirrorOn ? '1 / 3' : '1 / -1' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontWeight: 600, fontSize: 14 }}>📱 Android пристрій</span>
              {wifiState && (
                <span
                  onClick={() => window.api.wifiAdb?.checkNow?.().then(setWifiState)}
                  title={wifiState.lastError || wifiState.method || ''}
                  style={{
                    fontSize: 11, padding: '3px 8px', borderRadius: 12, cursor: 'pointer',
                    background: wifiState.status === 'connected' ? 'rgba(34,197,94,0.15)' :
                               wifiState.status === 'lost'      ? 'rgba(224,82,82,0.15)' :
                                                                  'rgba(240,165,0,0.15)',
                    color: wifiState.status === 'connected' ? '#22c55e' :
                           wifiState.status === 'lost'      ? '#e05252' : '#f0a500',
                    fontWeight: 500,
                  }}
                >
                  {wifiState.status === 'connected' ? `🟢 Wi-Fi ADB: ${wifiState.host}` :
                   wifiState.status === 'lost'      ? '🔴 Wi-Fi lost — click to retry' :
                   wifiState.status === 'recovering'? '🟡 USB recovery…' :
                   wifiState.status === 'reconnecting'? '🟡 Reconnecting…' :
                                                        '⚪ Checking…'}
                </span>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn-ghost" onClick={refreshDevices} disabled={loadingDev} style={{ fontSize: 12 }}>
                {loadingDev ? '⏳' : '🔄 Оновити'}
              </button>
              {serial && (
                <>
                  <button
                    className="btn-ghost"
                    onClick={() => setMirrorOn(v => !v)}
                    style={{ fontSize: 12, color: mirrorOn ? '#22c55e' : undefined }}
                  >
                    {mirrorOn ? '🟢 Дзеркало ON' : '📺 В програмі'}
                  </button>
                  <button className="btn-ghost" onClick={handleScrcpy} style={{ fontSize: 12 }}>
                    🖥 scrcpy окремо
                  </button>
                </>
              )}
            </div>
          </div>

          {devices.length === 0 ? (
            <div style={{ padding: '16px 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
              Пристроїв не знайдено. Підключи телефон по USB або WiFi.
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {devices.map(s => {
                const isWifi = s.includes('.')
                const isSelected = s === serial
                return (
                  <button
                    key={s}
                    onClick={() => setSerial(s)}
                    style={{
                      padding: '8px 14px', borderRadius: 8, border: 'none', cursor: 'pointer',
                      background: isSelected ? '#6366f1' : 'var(--bg)',
                      color: isSelected ? '#fff' : 'var(--text-secondary)',
                      fontSize: 12, fontWeight: isSelected ? 600 : 400,
                      display: 'flex', alignItems: 'center', gap: 6,
                    }}
                  >
                    {isWifi ? '📡' : '🔌'} {s}
                  </button>
                )
              })}
            </div>
          )}

          {deviceInfo?.ok && deviceInfo.device && (
            <div style={{ marginTop: 10, fontSize: 12, color: 'var(--text-secondary)', display: 'flex', gap: 12 }}>
              <span>📱 {deviceInfo.device.brand} {deviceInfo.device.model}</span>
              <span>🖥 {deviceInfo.device.screen}</span>
              {!deviceInfo.instagram_installed && (
                <span style={{ color: '#e05252' }}>⚠️ Instagram не встановлено</span>
              )}
            </div>
          )}
          {deviceInfo && !deviceInfo.ok && (
            <div style={{ marginTop: 8, fontSize: 12, color: '#e05252' }}>✗ {deviceInfo.error}</div>
          )}

          {/* ── Wireless Debugging (Android 11+) ── */}
          <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
            <button
              className="btn-ghost"
              onClick={() => setWdOpen(v => !v)}
              style={{ fontSize: 12, padding: 0, background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)' }}
            >
              {wdOpen ? '▾' : '▸'} 📡 Wireless Debugging (пошук/паринг)
            </button>

            {wdOpen && (
              <div style={{ marginTop: 10, padding: 12, background: 'rgba(99,102,241,0.06)', borderRadius: 8 }}>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 10, lineHeight: 1.5 }}>
                  <b>Крок 1:</b> На телефоні: Settings → Developer Options → <b>Wireless Debugging</b> → ON<br/>
                  <b>Крок 2 (перший раз):</b> "Pair device with pairing code" → введи IP:port і 6-значний код нижче<br/>
                  <b>Крок 3 (щоразу):</b> натисни "Знайти по Wi-Fi" — телефон знайдеться автоматично
                </div>

                <button
                  className="btn-primary"
                  onClick={handleMdnsDiscover}
                  disabled={wdBusy}
                  style={{ width: '100%', fontSize: 13, marginBottom: 10 }}
                >
                  {wdBusy ? '⏳ Шукаю...' : '🔍 Знайти по Wi-Fi (mDNS)'}
                </button>

                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>
                  Перший раз? Спаруй ↓
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <input
                    className="form-input"
                    placeholder="192.168.0.7:41935"
                    value={wdPairHost}
                    onChange={e => setWdPairHost(e.target.value)}
                    style={{ flex: 2, fontSize: 12 }}
                  />
                  <input
                    className="form-input"
                    placeholder="123456"
                    value={wdPairCode}
                    onChange={e => setWdPairCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    style={{ flex: 1, fontSize: 12 }}
                  />
                  <button
                    className="btn-primary"
                    onClick={handleWdPair}
                    disabled={wdBusy || !wdPairHost || wdPairCode.length !== 6}
                    style={{ fontSize: 12, padding: '0 14px' }}
                  >
                    Спарити
                  </button>
                </div>

                {wdMsg && (
                  <div style={{
                    marginTop: 10, padding: 8, borderRadius: 6, fontSize: 12,
                    background: wdMsg.startsWith('✅') ? 'rgba(34,197,94,0.1)' :
                               wdMsg.startsWith('⚠️') ? 'rgba(240,165,0,0.1)' : 'rgba(224,82,82,0.1)',
                    color: wdMsg.startsWith('✅') ? '#22c55e' :
                           wdMsg.startsWith('⚠️') ? '#f0a500' : '#e05252',
                  }}>{wdMsg}</div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* ── Дзеркало (в програмі) ── */}
        {mirrorOn && serial && (
          <div className="card" style={{ gridRow: 'span 3', gridColumn: '3', padding: 8, display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 8px', marginBottom: 6 }}>
              <span style={{ fontSize: 12, fontWeight: 600 }}>📺 Дзеркало</span>
              <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>~2.5 FPS</span>
            </div>
            <div style={{ flex: 1, background: '#000', borderRadius: 8, overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 480 }}>
              <img
                src={`http://localhost:${PYTHON_PORT}/android/screenshot?serial=${encodeURIComponent(serial)}&t=${mirrorTick}`}
                alt="device mirror"
                style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', display: 'block' }}
                onError={(e) => { e.currentTarget.style.opacity = '0.3' }}
                onLoad={(e) => { e.currentTarget.style.opacity = '1' }}
              />
            </div>
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 6, padding: '0 4px' }}>
              Один кадр кожні 400мс. Для плавного відео використай "🖥 scrcpy окремо".
            </div>
          </div>
        )}

        {/* ── Налаштування ── */}
        <div className="card">
          <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 16 }}>⚙️ Налаштування сесії</div>

          <div style={{ marginBottom: 20 }}>
            <label style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>
              Тривалість: <strong style={{ color: 'var(--text)' }}>{duration} хв</strong>
            </label>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {[2, 5, 10, 15, 20, 30].map(v => (
                <button
                  key={v}
                  onClick={() => setDuration(v)}
                  disabled={running}
                  style={{
                    padding: '6px 14px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 12,
                    background: duration === v ? '#6366f1' : 'var(--bg)',
                    color: duration === v ? '#fff' : 'var(--text-secondary)',
                  }}
                >
                  {v} хв
                </button>
              ))}
            </div>
          </div>

          <div>
            <label style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>
              Ймовірність лайку: <strong style={{ color: 'var(--text)' }}>{likeProb}%</strong>
            </label>
            <input
              type="range" min={0} max={40} step={5}
              value={likeProb}
              onChange={e => setLikeProb(Number(e.target.value))}
              disabled={running}
              style={{ width: '100%', accentColor: '#6366f1' }}
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
              <span>0% (без лайків)</span><span>20%</span><span>40%</span>
            </div>
          </div>

          {/* AI рішення */}
          <div style={{ marginTop: 14, padding: 10, background: useAi ? 'rgba(99,102,241,0.08)' : 'var(--bg)', borderRadius: 8, border: useAi ? '1px solid #6366f1' : '1px solid transparent' }}>
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer', fontSize: 13 }}>
              <input
                type="checkbox"
                checked={useAi}
                onChange={e => setUseAi(e.target.checked)}
                disabled={running}
                style={{ marginTop: 2 }}
              />
              <div>
                <div style={{ fontWeight: 600 }}>🤖 AI приймає рішення</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                  Claude дивиться кожен рілс і вирішує: like / save / skip.
                  Гібрид: спочатку читає caption (~1с), fallback на screenshot (~3с) якщо тексту нема.
                  Використовує твою Claude Code авторизацію. Перебиває "Ймовірність лайку".
                </div>
              </div>
            </label>
          </div>

          {settings?.androidProxy && (
            <div style={{ marginTop: 14, fontSize: 11, color: 'var(--text-muted)', padding: '6px 10px', background: 'var(--bg)', borderRadius: 6 }}>
              🌍 Проксі: {settings.androidProxy.split(':').slice(0,2).join(':')}
            </div>
          )}
        </div>

        {/* ── Прогрес / Результат ── */}
        <div className="card" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
          <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 16 }}>
            {running ? '⏳ Сесія йде...' : result ? (result.ok ? '✅ Сесія завершена' : '❌ Помилка') : '▶ Запуск'}
          </div>

          {/* Прогрес-бар */}
          <div style={{ marginBottom: 20 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>
              <span>{elMin}:{elSec} пройшло</span>
              {running && <span>-{remMin}:{remSec} залишилось</span>}
            </div>
            <div style={{ background: 'var(--bg)', borderRadius: 8, height: 10, overflow: 'hidden' }}>
              <div style={{
                height: '100%', borderRadius: 8,
                background: result?.ok ? '#22c55e' : result && !result.ok ? '#e05252' : '#6366f1',
                width: `${progress}%`,
                transition: 'width 0.5s ease',
              }} />
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6, textAlign: 'right' }}>
              {Math.round(progress)}%
            </div>
          </div>

          {/* Живі лічильники під час сесії */}
          {running && (
            <div style={{ display: 'flex', gap: 12, marginBottom: 20 }}>
              <div style={{ flex: 1, textAlign: 'center', padding: '10px', background: 'var(--bg)', borderRadius: 8 }}>
                <div style={{ fontSize: 22, fontWeight: 700, color: '#6366f1' }}>~{estReels}</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>рілсів</div>
              </div>
              <div style={{ flex: 1, textAlign: 'center', padding: '10px', background: 'var(--bg)', borderRadius: 8 }}>
                <div style={{ fontSize: 22, fontWeight: 700, color: '#e1306c' }}>~{Math.round(estReels * likeProb / 100)}</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>лайків</div>
              </div>
            </div>
          )}

          {/* Фінальні результати */}
          {result && !running && (
            <div style={{ marginBottom: 20 }}>
              {result.ok ? (
                <>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <div style={{ flex: 1, textAlign: 'center', padding: '12px', background: 'rgba(34,197,94,0.08)', borderRadius: 8 }}>
                      <div style={{ fontSize: 24, fontWeight: 700, color: '#22c55e' }}>{result.reels_watched}</div>
                      <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>переглянуто</div>
                    </div>
                    <div style={{ flex: 1, textAlign: 'center', padding: '12px', background: 'rgba(225,48,108,0.08)', borderRadius: 8 }}>
                      <div style={{ fontSize: 24, fontWeight: 700, color: '#e1306c' }}>{result.likes_given}</div>
                      <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>лайків</div>
                    </div>
                    {result.saves_given > 0 && (
                      <div style={{ flex: 1, textAlign: 'center', padding: '12px', background: 'rgba(99,102,241,0.08)', borderRadius: 8 }}>
                        <div style={{ fontSize: 24, fontWeight: 700, color: '#6366f1' }}>{result.saves_given}</div>
                        <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>збережено</div>
                      </div>
                    )}
                  </div>
                  {/* Останні AI рішення */}
                  {result.ai_decisions && result.ai_decisions.length > 0 && (
                    <div style={{ marginTop: 10, padding: 10, background: 'var(--bg)', borderRadius: 8 }}>
                      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 6 }}>
                        Останні AI рішення:
                      </div>
                      {result.ai_decisions.slice(-5).map((d, i) => (
                        <div key={i} style={{ fontSize: 11, marginTop: 3, color: 'var(--text-secondary)' }}>
                          <span style={{
                            display: 'inline-block', minWidth: 50, padding: '1px 6px', borderRadius: 4, marginRight: 6,
                            background: d.action === 'like' ? 'rgba(225,48,108,0.15)' : d.action === 'save' ? 'rgba(99,102,241,0.15)' : 'rgba(120,120,120,0.15)',
                            color: d.action === 'like' ? '#e1306c' : d.action === 'save' ? '#6366f1' : 'var(--text-muted)',
                            fontWeight: 600,
                          }}>
                            {d.action}
                          </span>
                          {d.mode && (
                            <span style={{ fontSize: 9, opacity: 0.6, marginRight: 4, fontFamily: 'monospace' }}>
                              [{d.mode}]
                            </span>
                          )}
                          {d.reason}
                        </div>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <div style={{ padding: '12px', background: 'rgba(224,82,82,0.1)', borderRadius: 8, color: '#e05252', fontSize: 12 }}>
                  {result.error}
                </div>
              )}
            </div>
          )}

          <button
            className={running ? 'btn-secondary' : 'btn-primary'}
            onClick={handleStart}
            disabled={running || !serial}
            style={{ width: '100%', fontSize: 14, padding: '12px' }}
          >
            {running
              ? `⏳ Прогріваю... ${elMin}:${elSec}`
              : `🔥 Запустити прогрів ${duration} хв`}
          </button>
        </div>

      </div>

      {/* ===== АВТО-РОЗКЛАД ===== */}
      {schedule && (
        <div className="card" style={{ maxWidth: 860, marginTop: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <div>
              <div style={{ fontWeight: 600, fontSize: 14 }}>🕐 Автоматичний розклад</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                Програма автоматично запускає прогрів у рандомний час у заданих межах
              </div>
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={!!schedule.enabled}
                onChange={e => saveSchedule({ enabled: e.target.checked, serial: serial || schedule.serial })}
              />
              <span style={{ fontSize: 13, fontWeight: 600, color: schedule.enabled ? '#22c55e' : 'var(--text-muted)' }}>
                {schedule.enabled ? 'УВІМКНЕНО' : 'ВИМКНЕНО'}
              </span>
            </label>
          </div>

          {/* Статус найближчої сесії */}
          {schedule.enabled && plannedSessions.filter(s => s.status === 'pending').length > 0 && (
            <div style={{
              padding: 12, background: scheduleRunning ? 'rgba(99,102,241,0.1)' : 'rgba(34,197,94,0.08)',
              borderRadius: 8, marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            }}>
              <div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  {scheduleRunning ? '⏳ Сесія виконується' : '✅ Найближча сесія'}
                </div>
                <div style={{ fontSize: 14, fontWeight: 600, marginTop: 2 }}>
                  {scheduleRunning ? 'Йде прогрів...' : (() => {
                    const next = plannedSessions.find(s => s.status === 'pending')
                    return next ? `${new Date(next.scheduled_at).toLocaleString('uk-UA')} · ${formatCountdown(next.scheduled_at)}` : '—'
                  })()}
                </div>
              </div>
              <button
                className="btn-ghost"
                onClick={triggerScheduleNow}
                disabled={scheduleRunning}
                style={{ fontSize: 12 }}
              >
                ⚡ Запустити зараз
              </button>
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>

            {/* Акаунт */}
            <div>
              <label style={{ display: 'block', fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>
                📱 Акаунт постингу
              </label>
              <select
                className="form-select"
                value={schedule.accountId || ''}
                onChange={e => saveSchedule({ accountId: e.target.value ? Number(e.target.value) : null })}
                style={{ width: '100%', fontSize: 12 }}
              >
                <option value="">— не вказано —</option>
                {accounts.map(a => <option key={a.id} value={a.id}>@{a.username}</option>)}
              </select>
            </div>

            {/* Пристрій */}
            <div>
              <label style={{ display: 'block', fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>
                🔌 Пристрій
              </label>
              <div style={{ fontSize: 12, padding: '8px 10px', background: 'var(--bg)', borderRadius: 6 }}>
                {schedule.serial || serial || '— оберіть пристрій вище —'}
              </div>
            </div>

            {/* Сесій/день */}
            <div>
              <label style={{ display: 'block', fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>
                Сесій на день: <strong style={{ color: 'var(--text)' }}>{schedule.sessionsPerDay}</strong>
              </label>
              <input
                type="range" min={1} max={8} step={1}
                value={schedule.sessionsPerDay}
                onChange={e => saveSchedule({ sessionsPerDay: Number(e.target.value) })}
                style={{ width: '100%', accentColor: '#6366f1' }}
              />
              <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>1 (мінімум) → 8 (агресивно)</div>
            </div>

            {/* AI */}
            <div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, cursor: 'pointer', padding: '8px 0' }}>
                <input
                  type="checkbox"
                  checked={!!schedule.useAi}
                  onChange={e => saveSchedule({ useAi: e.target.checked })}
                />
                <span style={{ fontWeight: 600 }}>🤖 AI приймає рішення</span>
              </label>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
                Claude аналізує кожен рілс → like/save/skip
              </div>
            </div>

            {/* Активні години */}
            <div style={{ gridColumn: '1 / -1' }}>
              <label style={{ display: 'block', fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>
                Активні години: <strong style={{ color: 'var(--text)' }}>{String(schedule.activeHourStart).padStart(2,'0')}:00 – {String(schedule.activeHourEnd).padStart(2,'0')}:00</strong>
              </label>
              <RangeSlider
                min={0} max={24} step={1}
                value={[schedule.activeHourStart, schedule.activeHourEnd]}
                onChange={([s, e]) => saveSchedule({ activeHourStart: s, activeHourEnd: e })}
              />
            </div>

            {/* Тривалість */}
            <div>
              <label style={{ display: 'block', fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>
                Тривалість: <strong style={{ color: 'var(--text)' }}>{schedule.durationMin}–{schedule.durationMax} хв</strong>
              </label>
              <RangeSlider
                min={1} max={30} step={1}
                value={[schedule.durationMin, schedule.durationMax]}
                onChange={([s, e]) => saveSchedule({ durationMin: s, durationMax: e })}
              />
            </div>

            {/* % лайків */}
            <div>
              <label style={{ display: 'block', fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>
                % лайків: <strong style={{ color: 'var(--text)' }}>{schedule.likeProbMin}–{schedule.likeProbMax}%</strong>
              </label>
              <RangeSlider
                min={0} max={50} step={1}
                value={[schedule.likeProbMin, schedule.likeProbMax]}
                onChange={([s, e]) => saveSchedule({ likeProbMin: s, likeProbMax: e })}
              />
            </div>
          </div>

          {/* ── Генератор плану ── */}
          <div style={{ marginTop: 20, borderTop: '1px solid var(--border)', paddingTop: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>📅 План сесій</div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'end', flexWrap: 'wrap' }}>
              <div>
                <label style={{ display: 'block', fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>Від</label>
                <input
                  type="date" className="form-input"
                  value={planStartDate}
                  onChange={e => setPlanStartDate(e.target.value)}
                  style={{ fontSize: 12 }}
                />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>До</label>
                <input
                  type="date" className="form-input"
                  value={planEndDate}
                  onChange={e => setPlanEndDate(e.target.value)}
                  style={{ fontSize: 12 }}
                />
              </div>
              <button
                className="btn-primary"
                onClick={() => handleGeneratePlan(false)}
                disabled={generating || !serial}
                style={{ fontSize: 13 }}
              >
                {generating ? '⏳' : '📅 Запланувати'}
              </button>
              <button
                className="btn-ghost"
                onClick={() => handleGeneratePlan(true)}
                disabled={generating || !serial}
                style={{ fontSize: 12, color: '#f0a500' }}
                title="Видалить усі невиконані сесії і згенерує новий план"
              >
                🔄 Замінити план
              </button>
              {plannedSessions.filter(s => s.status === 'pending').length > 0 && (
                <button className="btn-ghost" onClick={handleDeletePending} style={{ fontSize: 12, color: '#e05252' }}>
                  🗑 Очистити pending
                </button>
              )}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>
              При `Запланувати` створюються сесії у межах [Від, До], по {schedule.sessionsPerDay} на день, з рандомом.
            </div>
          </div>

          {/* ── Список сесій по днях ── */}
          {plannedSessions.length > 0 && (() => {
            // Групуємо по даті
            const groups = {}
            for (const s of plannedSessions) {
              const day = s.scheduled_at.split('T')[0]
              if (!groups[day]) groups[day] = []
              groups[day].push(s)
            }
            const days = Object.keys(groups).sort()

            // Загальна статистика
            const totalDone = plannedSessions.filter(s => s.status === 'done').length
            const totalFailed = plannedSessions.filter(s => s.status === 'failed').length
            const totalPending = plannedSessions.filter(s => s.status === 'pending').length
            const totalReels = plannedSessions.reduce((acc, s) => acc + (s.reels_watched || 0), 0)
            const totalLikes = plannedSessions.reduce((acc, s) => acc + (s.likes_given || 0), 0)
            const totalSaves = plannedSessions.reduce((acc, s) => acc + (s.saves_given || 0), 0)

            return (
              <div style={{ marginTop: 16 }}>
                <div style={{ display: 'flex', gap: 8, marginBottom: 10, fontSize: 11, flexWrap: 'wrap' }}>
                  <span style={{ padding: '4px 8px', background: 'rgba(34,197,94,0.1)', borderRadius: 4, color: '#22c55e' }}>
                    ✅ {totalDone} виконано
                  </span>
                  <span style={{ padding: '4px 8px', background: 'rgba(240,165,0,0.1)', borderRadius: 4, color: '#f0a500' }}>
                    ⏳ {totalPending} чекає
                  </span>
                  {totalFailed > 0 && (
                    <span style={{ padding: '4px 8px', background: 'rgba(224,82,82,0.1)', borderRadius: 4, color: '#e05252' }}>
                      ❌ {totalFailed} помилок
                    </span>
                  )}
                  <span style={{ padding: '4px 8px', background: 'var(--bg)', borderRadius: 4, color: 'var(--text-muted)' }}>
                    📺 {totalReels} рілсів · ❤ {totalLikes} · 💾 {totalSaves}
                  </span>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxHeight: 500, overflowY: 'auto' }}>
                  {days.map(day => {
                    const ds = groups[day]
                    const dateObj = new Date(day + 'T00:00:00')
                    const label = dateObj.toLocaleDateString('uk-UA', { weekday: 'short', day: '2-digit', month: 'long' })
                    return (
                      <div key={day}>
                        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 4, textTransform: 'uppercase' }}>
                          {label} · {ds.length} сесій
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                          {ds.map(s => {
                            const color = s.status === 'done' ? '#22c55e'
                              : s.status === 'failed' ? '#e05252'
                              : s.status === 'running' ? '#6366f1'
                              : '#f0a500'
                            const icon = s.status === 'done' ? '✅'
                              : s.status === 'failed' ? '❌'
                              : s.status === 'running' ? '⏳'
                              : '🕐'
                            const clickable = s.status === 'done' || s.status === 'failed'
                            return (
                              <div
                                key={s.id}
                                onClick={() => clickable && openSessionDetails(s.id)}
                                style={{
                                  display: 'flex', alignItems: 'center', gap: 10, fontSize: 12,
                                  padding: '8px 12px', background: 'var(--bg)', borderRadius: 6,
                                  borderLeft: `3px solid ${color}`,
                                  cursor: clickable ? 'pointer' : 'default',
                                }}
                              >
                                <span style={{ minWidth: 24 }}>{icon}</span>
                                <span style={{ minWidth: 50, fontFamily: 'monospace', color: 'var(--text)' }}>
                                  {new Date(s.scheduled_at).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' })}
                                </span>
                                <span style={{ minWidth: 55, color: 'var(--text-muted)' }}>{s.duration_min}хв</span>
                                <span style={{ minWidth: 45, color: 'var(--text-muted)' }}>{s.like_prob_pct}%</span>
                                {s.use_ai ? <span style={{ fontSize: 10, color: '#6366f1' }}>🤖</span> : <span style={{ opacity: 0.3 }}>—</span>}
                                {s.status === 'done' && (
                                  <span style={{ marginLeft: 'auto', color: 'var(--text-muted)', fontSize: 11 }}>
                                    📺 {s.reels_watched} · ❤ {s.likes_given}
                                    {s.saves_given > 0 && ` · 💾 ${s.saves_given}`}
                                  </span>
                                )}
                                {s.status === 'failed' && (
                                  <span style={{ marginLeft: 'auto', color: '#e05252', fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 200 }}>
                                    {s.error?.slice(0, 60)}
                                  </span>
                                )}
                                {clickable && (
                                  <span style={{ color: 'var(--text-muted)', fontSize: 10 }}>деталі →</span>
                                )}
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })()}
        </div>
      )}

      {/* ===== Модалка деталей сесії ===== */}
      {viewingSession && (() => {
        let decisions = []
        try {
          decisions = viewingSession.ai_decisions ? JSON.parse(viewingSession.ai_decisions) : []
        } catch (e) { decisions = [] }
        return (
          <div
            onClick={() => setViewingSession(null)}
            style={{
              position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
              zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            <div
              onClick={e => e.stopPropagation()}
              style={{
                background: 'var(--card-bg, #1a1a24)', border: '1px solid var(--border)',
                borderRadius: 12, padding: 20, maxWidth: 720, width: '92%',
                maxHeight: '88vh', overflowY: 'auto',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                <h2 style={{ margin: 0, fontSize: 18 }}>
                  Сесія #{viewingSession.id} — {new Date(viewingSession.scheduled_at).toLocaleString('uk-UA')}
                </h2>
                <button className="btn-ghost" onClick={() => setViewingSession(null)} style={{ fontSize: 18, padding: '2px 10px' }}>✕</button>
              </div>

              {/* Результати */}
              <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
                <div style={{ padding: '10px 14px', background: 'rgba(34,197,94,0.08)', borderRadius: 8, minWidth: 100 }}>
                  <div style={{ fontSize: 22, fontWeight: 700, color: '#22c55e' }}>{viewingSession.reels_watched}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>переглянуто</div>
                </div>
                <div style={{ padding: '10px 14px', background: 'rgba(225,48,108,0.08)', borderRadius: 8, minWidth: 100 }}>
                  <div style={{ fontSize: 22, fontWeight: 700, color: '#e1306c' }}>{viewingSession.likes_given}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>лайків</div>
                </div>
                {viewingSession.saves_given > 0 && (
                  <div style={{ padding: '10px 14px', background: 'rgba(99,102,241,0.08)', borderRadius: 8, minWidth: 100 }}>
                    <div style={{ fontSize: 22, fontWeight: 700, color: '#6366f1' }}>{viewingSession.saves_given}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>збережено</div>
                  </div>
                )}
                <div style={{ padding: '10px 14px', background: 'var(--bg)', borderRadius: 8, minWidth: 100 }}>
                  <div style={{ fontSize: 16, fontWeight: 700 }}>{viewingSession.duration_min} хв</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>тривалість</div>
                </div>
              </div>

              {viewingSession.error && (
                <div style={{ padding: 10, background: 'rgba(224,82,82,0.1)', borderRadius: 6, fontSize: 12, color: '#e05252', marginBottom: 16 }}>
                  ❌ {viewingSession.error}
                </div>
              )}

              {/* AI рішення по кожному рілсу */}
              {decisions.length > 0 ? (
                <>
                  <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
                    🤖 Коментарі AI по кожному рілсу ({decisions.length}):
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {decisions.map((d, i) => (
                      <div key={i} style={{
                        padding: '8px 12px', background: 'var(--bg)', borderRadius: 6,
                        display: 'flex', alignItems: 'flex-start', gap: 10, fontSize: 12,
                      }}>
                        <span style={{ minWidth: 24, color: 'var(--text-muted)', fontFamily: 'monospace', fontSize: 10 }}>
                          #{i + 1}
                        </span>
                        <span style={{
                          minWidth: 55, padding: '2px 8px', borderRadius: 4, textAlign: 'center',
                          background: d.action === 'like' ? 'rgba(225,48,108,0.15)' : d.action === 'save' ? 'rgba(99,102,241,0.15)' : 'rgba(120,120,120,0.15)',
                          color: d.action === 'like' ? '#e1306c' : d.action === 'save' ? '#6366f1' : 'var(--text-muted)',
                          fontWeight: 600, fontSize: 11,
                        }}>
                          {d.action}
                        </span>
                        {d.mode && (
                          <span style={{ fontSize: 9, opacity: 0.5, fontFamily: 'monospace', marginTop: 3 }}>
                            [{d.mode}]
                          </span>
                        )}
                        <span style={{ flex: 1, color: 'var(--text-secondary)' }}>
                          {d.reason}
                        </span>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <div style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', padding: 20 }}>
                  AI рішення не збереглись (режим AI був вимкнений, або сесія провалилась рано).
                </div>
              )}
            </div>
          </div>
        )
      })()}
    </div>
  )
}
