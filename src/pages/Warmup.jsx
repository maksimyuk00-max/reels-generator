import { useState, useEffect, useRef } from 'react'
import RangeSlider from '../components/RangeSlider'
import NicheEditor from '../components/NicheEditor'
import {
  AddDeviceModal, AddDeviceCard, DeviceCard, AccountBinder, SegmentControl, StatusBadge,
} from '../components/WarmupDevices'
import './Pages.css'

const isElectron = typeof window !== 'undefined' && !!window.api
const PYTHON_PORT = 8765

export default function Warmup() {
  // ── Пристрої ──────────────────────────────────────────────
  const [devices, setDevices]           = useState([])
  const [allAccounts, setAllAccounts]   = useState([])
  const [selectedDeviceId, setSelectedDeviceId] = useState(null)
  // Per-device wifi state: { [serial]: { status, lastError, ... } }
  const [wifiState, setWifiState]       = useState({})
  const [addMode, setAddMode]           = useState(false)

  // ── Поточний акаунт (активний у Warmup) ──────────────────
  const [activeAccountId, setActiveAccountId] = useState(null)
  const [deviceAccounts, setDeviceAccounts]   = useState([])

  // ── Режим: Run Now vs Schedule ────────────────────────────
  const [mode, setMode] = useState('runnow')  // 'runnow' | 'schedule'

  // ── Run Now стан ─────────────────────────────────────────
  // Per-device running state — Set<deviceId> щоб одночасно різні телефони могли працювати незалежно
  const [runningDeviceIds, setRunningDeviceIds] = useState(new Set())
  const [elapsed, setElapsed]   = useState(0)
  const [result, setResult]     = useState(null)
  const [duration, setDuration] = useState(5)     // хв
  const [likeProb, setLikeProb] = useState(20)    // %
  const [useAi, setUseAi]       = useState(true)
  const timerRef                = useRef(null)
  const startRef                = useRef(null)

  // ── Schedule стан (per account) ──────────────────────────
  const [config, setConfig]     = useState(null)  // account_warmup_config
  const [scheduleRunning, setScheduleRunning] = useState(false)
  const [now, setNow]           = useState(Date.now())

  // ── План сесій ───────────────────────────────────────────
  const today = new Date().toISOString().split('T')[0]
  const threeDaysAhead = new Date(Date.now() + 2 * 86400000).toISOString().split('T')[0]
  const [planStartDate, setPlanStartDate] = useState(today)
  const [planEndDate, setPlanEndDate]     = useState(threeDaysAhead)
  const [plannedSessions, setPlannedSessions] = useState([])
  const [generating, setGenerating]       = useState(false)
  const [viewingSession, setViewingSession] = useState(null)
  const [settings, setSettings]           = useState(null)
  const [configSavedAt, setConfigSavedAt] = useState(null)  // timestamp останнього збереження

  // Auto-refresh viewingSession коли сесія оновилась у plannedSessions (polling)
  useEffect(() => {
    if (!viewingSession?.id) return
    const fresh = plannedSessions.find(s => s.id === viewingSession.id)
    if (fresh && (fresh.status !== viewingSession.status
      || fresh.reels_watched !== viewingSession.reels_watched
      || fresh.likes_given !== viewingSession.likes_given
      || fresh.saves_given !== viewingSession.saves_given
      || fresh.finished_at !== viewingSession.finished_at
      || fresh.ai_decisions !== viewingSession.ai_decisions)) {
      // Забираємо свіжу повну версію з БД (для ai_decisions тощо)
      window.api.warmup.getSession(viewingSession.id).then(setViewingSession)
    }
  }, [plannedSessions, viewingSession?.id])

  // ── Init ─────────────────────────────────────────────────
  useEffect(() => {
    if (!isElectron) return

    window.api.settings.get().then(setSettings)
    loadDevices()
    loadPlan()

    const nowInterval = setInterval(() => setNow(Date.now()), 1000)

    const unsubStart = window.api.on?.('warmup:started', () => {
      setScheduleRunning(true); loadPlan()
    })
    const unsubEnd = window.api.on?.('warmup:finished', () => {
      setScheduleRunning(false); loadPlan()
    })
    window.api.wifiAdb?.getStatus?.().then(setWifiState).catch(() => {})
    const unsubWifi = window.api.on?.('wifi-adb:status', setWifiState)

    // Polling: кожні 5 сек щоб підхопити завершені сесії навіть якщо IPC event загубився
    const pollInterval = setInterval(() => { loadPlan() }, 5000)

    // Refresh при поверненні фокусу на вікно
    const onFocus = () => loadPlan()
    const onVisibility = () => { if (!document.hidden) loadPlan() }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      clearInterval(nowInterval)
      clearInterval(pollInterval)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibility)
      if (unsubStart) unsubStart()
      if (unsubEnd) unsubEnd()
      if (unsubWifi) unsubWifi()
    }
  }, [])

  useEffect(() => {
    if (selectedDeviceId) loadDeviceAccounts(selectedDeviceId)
  }, [selectedDeviceId])

  useEffect(() => {
    if (activeAccountId) loadConfig(activeAccountId)
    else setConfig(null)
  }, [activeAccountId])

  // ── Data loaders ──────────────────────────────────────────
  const loadDevices = async () => {
    const [list, accs] = await Promise.all([
      window.api.devices.getAll(),
      window.api.accounts.getAll(),
    ])
    setDevices(list || [])
    setAllAccounts(accs || [])
    if (!selectedDeviceId && list?.length) setSelectedDeviceId(list[0].id)
    else if (selectedDeviceId && !list.find(d => d.id === selectedDeviceId)) {
      setSelectedDeviceId(list[0]?.id || null)
    }
  }

  const loadDeviceAccounts = async (deviceId) => {
    const accs = await window.api.devices.getAccounts(deviceId)
    setDeviceAccounts(accs || [])
    if (accs?.length && !accs.find(a => a.id === activeAccountId)) {
      setActiveAccountId(accs[0].id)
    } else if (!accs?.length) {
      setActiveAccountId(null)
    }
  }

  const loadConfig = async (accountId) => {
    const cfg = await window.api.warmupConfig.get(accountId)
    setConfig(cfg)
  }

  const saveConfig = async (patch) => {
    if (!activeAccountId || !config) return
    const next = { ...config, ...patch }
    setConfig(next)
    const r = await window.api.warmupConfig.save(activeAccountId, next)
    if (r?.ok !== false) setConfigSavedAt(Date.now())
  }

  const loadPlan = async () => {
    const s = await window.api.warmup.getSessions()
    setPlannedSessions(s || [])
  }

  // ── Actions ──────────────────────────────────────────────
  const handleDeviceAdded = (device) => {
    loadDevices()
    if (device?.id) setSelectedDeviceId(device.id)
    setAddMode(false)
  }

  const handleDeviceDelete = async () => {
    if (!selectedDeviceId) return
    if (!confirm('Видалити пристрій? Прив\'язані акаунти будуть відв\'язані.')) return
    await window.api.devices.delete(selectedDeviceId)
    loadDevices()
  }

  const [reconnecting, setReconnecting] = useState(false)
  const handleDeviceReconnect = async () => {
    if (!selectedDeviceId || reconnecting) return
    setReconnecting(true)
    try {
      const r = await window.api.devices.reconnect(selectedDeviceId)
      if (r.ok) {
        alert(r.message || 'З\'єднання відновлено')
        await loadDevices()
      } else {
        alert('Помилка: ' + (r.error || 'unknown'))
      }
    } catch (e) {
      alert('Помилка: ' + String(e))
    } finally {
      setReconnecting(false)
    }
  }

  const handleStartRunNow = async () => {
    const dev = devices.find(d => d.id === selectedDeviceId)
    if (!dev) return
    if (scheduleRunning) { alert('Планувальник зараз виконує сесію — спробуй пізніше'); return }
    if (runningDeviceIds.has(dev.id)) { alert('На цьому пристрої вже йде прогрів'); return }

    const devId = dev.id
    setRunningDeviceIds(prev => new Set(prev).add(devId))
    setElapsed(0); setResult(null)
    startRef.current = Date.now()
    timerRef.current = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startRef.current) / 1000))
    }, 500)

    try {
      const r = await window.api.python.androidScrollReels(
        dev.serial,
        duration * 60,
        likeProb / 100,
        settings?.androidProxy || null,
        useAi,
        '',
        activeAccountId,   // для v2: завантажити нішу з БД
      )
      setResult(r)
    } catch (e) {
      setResult({ ok: false, error: String(e) })
    } finally {
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
      setRunningDeviceIds(prev => { const next = new Set(prev); next.delete(devId); return next })
      // Перезавантажити список сесій — RunNow теж пише в БД
      await loadPlan()
    }
  }

  const handleGeneratePlan = async (replace = false) => {
    const dev = devices.find(d => d.id === selectedDeviceId)
    if (!dev || !activeAccountId || !config) return
    setGenerating(true)
    try {
      const r = await window.api.warmup.generatePlan(
        {
          sessionsPerDay: config.sessions_per_day,
          activeHourStart: config.active_hour_start,
          activeHourEnd: config.active_hour_end,
          durationMin: config.duration_min,
          durationMax: config.duration_max,
          likeProbMin: config.like_prob_min,
          likeProbMax: config.like_prob_max,
          useAi: !!config.use_ai,
          serial: dev.serial,
          accountId: activeAccountId,
        },
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
    if (!confirm('Видалити всі заплановані (невиконані) сесії цього акаунту?')) return
    await window.api.warmup.deletePending()
    await loadPlan()
  }

  const triggerScheduleNow = async () => {
    // Передаємо обраний device щоб не запустився прогрів на іншому телефоні
    const r = await window.api.warmup.triggerNow(selectedDeviceId, null)
    if (!r.ok) alert(r.error)
    else await loadPlan()
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

  // ── Derived ───────────────────────────────────────────────
  const selectedDevice = devices.find(d => d.id === selectedDeviceId)
  const activeAccount  = deviceAccounts.find(a => a.id === activeAccountId)
  // Per-device status. running ставиться ТІЛЬКИ для пристрою на якому реально йде сесія.
  // scheduleRunning — тільки для selectedDevice (як і раніше — це global scheduler state).
  const getDeviceStatus = (device) => {
    if (!device) return 'unknown'
    if (runningDeviceIds.has(device.id)) return 'busy'
    if (scheduleRunning && device.id === selectedDeviceId) return 'busy'
    return wifiState?.[device.serial]?.status || 'unknown'
  }
  const deviceStatus = getDeviceStatus(selectedDevice)
  // Чи активна manual сесія саме на selected device — для UI controls (timer, кнопки)
  const isSelectedRunning = !!(selectedDeviceId && runningDeviceIds.has(selectedDeviceId))

  const totalSec  = duration * 60
  const progress  = isSelectedRunning ? Math.min((elapsed / totalSec) * 100, 100) : (result ? 100 : 0)
  const remaining = Math.max(0, totalSec - elapsed)
  const fmtTime   = (iso) => iso ? new Date(iso).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' }) : ''

  // Сесії тільки для активного акаунту
  const myPlannedSessions = activeAccountId
    ? plannedSessions.filter(s => s.account_id === activeAccountId)
    : plannedSessions
  const upcomingPending = myPlannedSessions
    .filter(s => s.status === 'pending' && new Date(s.scheduled_at).getTime() > now - 60000)
    .sort((a, b) => new Date(a.scheduled_at) - new Date(b.scheduled_at))

  // ───────────────────────────────────────────────────────────────
  // RENDER
  // ───────────────────────────────────────────────────────────────

  if (!isElectron) {
    return <div className="page"><h1>Warmup працює тільки в Electron</h1></div>
  }

  // Engine — per-account (з config), показуємо для активного акаунту
  const engine = config?.warmup_engine || 'manual'
  const engineColors = {
    manual: { bg: 'rgba(156,163,175,0.15)', fg: '#9ca3af', label: 'Manual' },
    v1:     { bg: 'rgba(99,102,241,0.15)',  fg: '#6366f1', label: 'v1 (AI)' },
    v2:     { bg: 'rgba(34,197,94,0.15)',   fg: '#22c55e', label: 'v2 (beta)' },
  }
  const ec = engineColors[engine] || engineColors.manual

  return (
    <div className="page">
      <div className="page-header" style={{ display: 'flex', alignItems: 'center',
                                              justifyContent: 'space-between' }}>
        <div>
          <h1 className="page-title">🔥 Прогрів акаунтів</h1>
          <p style={{ color: 'var(--text-secondary)', fontSize: 13, margin: 0 }}>
            Multi-device скролінг Reels через Android
          </p>
        </div>
        {activeAccount && (
          <span style={{
            fontSize: 11, padding: '4px 10px', borderRadius: 12,
            background: ec.bg, color: ec.fg, fontWeight: 600,
            border: `1px solid ${ec.fg}40`,
          }}>
            @{activeAccount.username} · {ec.label}
          </span>
        )}
      </div>

      {/* ═══ SECTION 1: DEVICES GRID ═══ */}
      <div className="card" style={{ marginBottom: 12, maxWidth: 1200 }}>
        <SectionHeader num="1" title="Пристрої"
                        hint={`Підключено: ${devices.length}`} />
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
          gap: 12,
        }}>
          <AddDeviceCard onClick={() => setAddMode(true)} />
          {devices.map(d => {
            const accs = allAccounts.filter(a => a.device_id === d.id)
            return (
              <DeviceCard
                key={d.id}
                device={d}
                accounts={accs}
                selected={d.id === selectedDeviceId}
                status={getDeviceStatus(d)}
                onClick={() => setSelectedDeviceId(d.id)}
                onDelete={d.id === selectedDeviceId ? handleDeviceDelete : null}
                onReconnect={d.id === selectedDeviceId ? handleDeviceReconnect : null}
                reconnecting={d.id === selectedDeviceId && reconnecting}
              />
            )
          })}
        </div>
      </div>

      {/* ═══ SECTION 2: DEVICE STATUS + ACCOUNT BINDING ═══ */}
      {selectedDevice && (
        <div className="card" style={{ marginBottom: 12, maxWidth: 1000 }}>
          <SectionHeader num="2" title="Пристрій і акаунти" />
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <div>
              <div style={{ fontWeight: 600, fontSize: 16 }}>📱 {selectedDevice.name}</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'monospace', marginTop: 2 }}>
                {selectedDevice.serial}
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <StatusBadge status={deviceStatus} />
              <ReconnectButton
                status={deviceStatus}
                onReconnect={async () => {
                  const r = await window.api.wifiAdb?.checkNow?.(selectedDevice?.serial)
                  if (r) setWifiState(r)
                }}
              />
            </div>
          </div>

          <div style={{ padding: 12, background: 'rgba(0,0,0,0.15)', borderRadius: 8 }}>
            <AccountBinder
              device={selectedDevice}
              onChanged={() => { loadDeviceAccounts(selectedDevice.id); loadDevices() }}
            />
          </div>
        </div>
      )}

      {/* ═══ SECTION 3: ACCOUNT SELECTOR (якщо > 1 акаунту) ═══ */}
      {selectedDevice && deviceAccounts.length > 1 && (
        <div className="card" style={{ marginBottom: 12, maxWidth: 1000 }}>
          <SectionHeader num="3" title="Активний акаунт" />
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {deviceAccounts.map(a => (
              <button
                key={a.id}
                onClick={() => setActiveAccountId(a.id)}
                style={{
                  padding: '10px 18px', borderRadius: 8, border: 'none',
                  fontSize: 13, cursor: 'pointer', fontWeight: 600,
                  background: a.id === activeAccountId ? '#6366f1' : 'var(--bg)',
                  color: a.id === activeAccountId ? '#fff' : 'var(--text-secondary)',
                  transition: 'all 0.15s',
                }}
              >
                @{a.username}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ═══ SECTION 4: NICHE AI CONFIG (ОКРЕМА картка) ═══ */}
      {selectedDevice && activeAccount && config && (
        <div className="card" style={{ marginBottom: 12, maxWidth: 1000 }}>
          <SectionHeader num={deviceAccounts.length > 1 ? '4' : '3'}
                          title={`Ніша для AI · @${activeAccount.username}`} />
          <CollapsibleNiche config={config} onChange={saveConfig}
                              savedAt={configSavedAt} />
        </div>
      )}

      {/* ═══ ADD DEVICE MODAL ═══ */}
      {addMode && (
        <AddDeviceModal
          onClose={() => setAddMode(false)}
          onAdded={handleDeviceAdded}
        />
      )}

      {/* ═══ SECTION 5: MODE SELECTION ═══ */}
      {selectedDevice && activeAccount && (
        <div style={{ maxWidth: 1000 }}>
          <div className="card" style={{ marginBottom: 12 }}>
            <SectionHeader num={deviceAccounts.length > 1 ? '5' : '4'}
                            title="Режим прогріву" />
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <SegmentControl
                value={mode}
                onChange={setMode}
                options={[
                  { value: 'runnow',   label: '▶ Запустити зараз' },
                  { value: 'schedule', label: '📅 Запланувати' },
                ]}
                disabledOption={isSelectedRunning ? 'schedule' : scheduleRunning ? 'runnow' : null}
              />
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                {mode === 'runnow' ? 'Одна сесія на вимогу' : 'Автоматичний розклад'}
              </span>
            </div>
          </div>

          {mode === 'runnow' && (
            <RunNowPanel
              device={selectedDevice}
              account={activeAccount}
              engine={engine}
              duration={duration} setDuration={setDuration}
              likeProb={likeProb} setLikeProb={setLikeProb}
              useAi={useAi} setUseAi={setUseAi}
              running={isSelectedRunning} elapsed={elapsed} result={result}
              totalSec={totalSec} progress={progress} remaining={remaining}
              onStart={handleStartRunNow}
              disabled={scheduleRunning}
            />
          )}

          {mode === 'schedule' && config && (
            <SchedulePanel
              device={selectedDevice}
              account={activeAccount}
              engine={engine}
              config={config}
              saveConfig={saveConfig}
              planStartDate={planStartDate} setPlanStartDate={setPlanStartDate}
              planEndDate={planEndDate} setPlanEndDate={setPlanEndDate}
              myPlannedSessions={myPlannedSessions}
              upcomingPending={upcomingPending}
              scheduleRunning={scheduleRunning}
              generating={generating}
              onGenerate={handleGeneratePlan}
              onDeletePending={handleDeletePending}
              onTriggerNow={triggerScheduleNow}
              onViewSession={id => window.api.warmup.getSession(id).then(setViewingSession)}
              formatCountdown={formatCountdown}
              fmtTime={fmtTime}
            />
          )}
        </div>
      )}

      {/* Session details modal */}
      {viewingSession && (
        <SessionDetailsModal
          session={viewingSession}
          onClose={() => setViewingSession(null)}
        />
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// RECONNECT BUTTON — triggers wifi-adb:checkNow with full recovery
// ═══════════════════════════════════════════════════════════════

function ReconnectButton({ status, onReconnect }) {
  const [busy, setBusy] = useState(false)
  const needsAction = status !== 'connected' && status !== 'busy'

  const handleClick = async () => {
    if (busy) return
    setBusy(true)
    try { await onReconnect() } catch {}
    finally { setBusy(false) }
  }

  return (
    <button
      onClick={handleClick}
      disabled={busy}
      title={needsAction
        ? 'Спробувати відновити з\'єднання (USB recovery якщо треба)'
        : 'Перевірити з\'єднання'}
      style={{
        padding: '6px 12px', borderRadius: 8,
        border: `1px solid ${needsAction ? '#eab308' : 'var(--border)'}`,
        background: needsAction ? 'rgba(234,179,8,0.1)' : 'transparent',
        color: needsAction ? '#eab308' : 'var(--text-secondary)',
        fontSize: 12, fontWeight: 600,
        cursor: busy ? 'wait' : 'pointer',
        display: 'inline-flex', alignItems: 'center', gap: 6,
        transition: 'all 0.15s',
      }}
    >
      {busy ? '⏳ Перевіряю...' : needsAction ? '🔄 Reconnect' : '🔄 Check'}
    </button>
  )
}

// ═══════════════════════════════════════════════════════════════
// SECTION HEADER — common section title for warmup page
// ═══════════════════════════════════════════════════════════════

function SectionHeader({ num, title, hint }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10,
      marginBottom: 12, paddingBottom: 8,
      borderBottom: '1px solid var(--border)',
    }}>
      {num && (
        <span style={{
          minWidth: 24, height: 24, borderRadius: '50%',
          background: 'var(--bg)', color: 'var(--text-muted)',
          fontSize: 12, fontWeight: 600,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          border: '1px solid var(--border)',
        }}>{num}</span>
      )}
      <span style={{ fontSize: 14, fontWeight: 600 }}>{title}</span>
      {hint && (
        <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 'auto' }}>
          {hint}
        </span>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// COLLAPSIBLE NICHE — compact wrapper around NicheEditor
// ═══════════════════════════════════════════════════════════════

function CollapsibleNiche({ config, onChange, savedAt }) {
  const hasNiche = !!(config.niche_description
                      || (config.niche_keywords || []).length
                      || (config.niche_avoid || []).length)
  const [open, setOpen] = useState(!hasNiche)  // відкрито якщо пусто — підказка заповнити

  // Показуємо індикатор "Збережено ✓" 2.5 сек після останнього save
  const [showSaved, setShowSaved] = useState(false)
  useEffect(() => {
    if (!savedAt) return
    setShowSaved(true)
    const t = setTimeout(() => setShowSaved(false), 2500)
    return () => clearTimeout(t)
  }, [savedAt])

  const summary = hasNiche
    ? `${config.niche_description?.slice(0, 60) || '(без опису)'}${config.niche_description?.length > 60 ? '…' : ''}`
    : 'Не налаштовано — AI не буде лайкати (клацни щоб заповнити)'

  // Коли відкрито — яскрава рамка щоб блок виділявся
  const accentColor = hasNiche ? '#22c55e' : '#eab308'

  return (
    <div style={{
      marginBottom: 0,
      ...(open ? {
        borderLeft: `3px solid ${accentColor}`,
        paddingLeft: 12,
        background: `${accentColor}08`,
        borderRadius: 6,
        paddingTop: 6,
        paddingBottom: 6,
      } : {}),
    }}>
      <div
        onClick={() => setOpen(!open)}
        style={{
          padding: '10px 14px',
          background: hasNiche ? 'rgba(34,197,94,0.10)' : 'rgba(234,179,8,0.10)',
          border: `1px solid ${open ? accentColor + '60' : 'var(--border)'}`,
          borderRadius: 8,
          cursor: 'pointer',
          display: 'flex', alignItems: 'center', gap: 10,
          transition: 'border-color 0.2s',
        }}
      >
        <span style={{ fontSize: 16 }}>{hasNiche ? '🎯' : '⚠️'}</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 600,
                         display: 'flex', alignItems: 'center', gap: 8 }}>
            {hasNiche ? 'Налаштовано' : 'Потребує заповнення'}
            {showSaved && (
              <span style={{
                fontSize: 11, color: '#22c55e', fontWeight: 500,
                background: 'rgba(34,197,94,0.15)',
                padding: '2px 8px', borderRadius: 4,
              }}>
                ✓ Збережено
              </span>
            )}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
            {summary}
          </div>
        </div>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          {open ? '▲ Згорнути' : '▼ Редагувати'}
        </span>
      </div>
      {open && (
        <div style={{ marginTop: 10 }}>
          <NicheEditor config={config} onChange={onChange} />

          {/* Engine selector — per-account (v1/v2) */}
          <EngineSelector config={config} onChange={onChange} />

          <div style={{ fontSize: 11, color: 'var(--text-muted)',
                         marginTop: 8, textAlign: 'center',
                         fontStyle: 'italic' }}>
            💾 Зміни зберігаються автоматично
          </div>
        </div>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// ENGINE SELECTOR — per-account v1/v2 choice (internal block)
// ═══════════════════════════════════════════════════════════════

function EngineSelector({ config, onChange }) {
  const current = config?.warmup_engine || 'v1'
  // Ніша "заповнена" = є опис АБО хоча б один keyword
  const nicheReady = !!(config?.niche_description?.trim()
                        || (config?.niche_keywords || []).length > 0)

  // Якщо обраний v1/v2 але ніша пуста — примусово перемикаємо на manual
  useEffect(() => {
    if (!nicheReady && current !== 'manual') {
      onChange({ warmup_engine: 'manual' })
    }
  }, [nicheReady, current])

  return (
    <div className="card" style={{ marginTop: 12, background: 'rgba(0,0,0,0.2)' }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8,
                     display: 'flex', alignItems: 'center', gap: 8 }}>
        ⚙️ Режим прогріву для цього акаунту
      </div>

      {!nicheReady && (
        <div style={{ fontSize: 11, color: '#eab308', marginBottom: 8,
                       padding: '6px 10px', background: 'rgba(234,179,8,0.1)',
                       borderRadius: 6 }}>
          ⚠️ Заповни опис ніші або ключові теми щоб увімкнути v1/v2 режими з AI
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <EngineOption
          value="manual"
          current={current}
          onChange={onChange}
          title="Manual"
          subtitle="Без AI — тільки скрол + випадкові лайки за ймовірністю"
          color="#9ca3af"
          badge=""
          disabled={false}
        />
        <EngineOption
          value="v1"
          current={current}
          onChange={onChange}
          title="Classic v1"
          subtitle="Reels tab, Claude vision з урахуванням ніші. Стабільно."
          color="#6366f1"
          badge="з AI"
          disabled={!nicheReady}
          disabledHint="Потрібна ніша"
        />
        <EngineOption
          value="v2"
          current={current}
          onChange={onChange}
          title="Smart v2"
          subtitle="Home + Reels + Stories + Explore, peek authors, AI relevance."
          color="#22c55e"
          badge="beta"
          disabled={!nicheReady}
          disabledHint="Потрібна ніша"
        />
      </div>
    </div>
  )
}

function EngineOption({ value, current, onChange, title, subtitle, color, badge,
                         disabled = false, disabledHint = '' }) {
  const active = current === value
  return (
    <label style={{
      display: 'flex', alignItems: 'flex-start', gap: 10,
      cursor: disabled ? 'not-allowed' : 'pointer',
      padding: 10, borderRadius: 6,
      border: `1px solid ${active ? color : 'var(--border)'}`,
      background: active ? color + '14' : 'transparent',
      opacity: disabled ? 0.45 : 1,
      transition: 'all 0.15s',
    }}>
      <input
        type="radio"
        name={`warmup_engine_${Math.random()}`}
        value={value}
        checked={active}
        disabled={disabled}
        onChange={() => !disabled && onChange({ warmup_engine: value })}
        style={{ marginTop: 2 }}
      />
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13, fontWeight: 600,
                       display: 'flex', alignItems: 'center', gap: 6 }}>
          {title}
          {badge && (
            <span style={{
              fontSize: 10, padding: '1px 6px', borderRadius: 4,
              background: color + '30', color: color, fontWeight: 500,
            }}>{badge}</span>
          )}
          {disabled && disabledHint && (
            <span style={{
              fontSize: 10, padding: '1px 6px', borderRadius: 4,
              background: 'rgba(234,179,8,0.15)', color: '#eab308', fontWeight: 500,
            }}>🔒 {disabledHint}</span>
          )}
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
          {subtitle}
        </div>
      </div>
    </label>
  )
}

// ═══════════════════════════════════════════════════════════════
// RUN NOW PANEL — manual session
// ═══════════════════════════════════════════════════════════════

function RunNowPanel({
  engine,
  duration, setDuration, likeProb, setLikeProb, useAi, setUseAi,
  running, elapsed, result, totalSec, progress, remaining, onStart, disabled,
}) {
  const remMin = String(Math.floor(remaining / 60)).padStart(2, '0')
  const remSec = String(remaining % 60).padStart(2, '0')
  const elMin  = String(Math.floor(elapsed / 60)).padStart(2, '0')
  const elSec  = String(elapsed % 60).padStart(2, '0')

  // Повзунок % лайків актуальний тільки для Manual — у v1/v2 AI сам вирішує
  const isManual = engine === 'manual'

  return (
    <div className="card">
      <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 12 }}>
        ⚙️ Параметри одноразового запуску
      </div>

      <div style={{ display: 'grid',
                     gridTemplateColumns: isManual ? '1fr 1fr' : '1fr',
                     gap: 16, marginBottom: 16 }}>
        <div>
          <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            Тривалість: <b style={{ color: 'var(--text)' }}>{duration} хв</b>
          </label>
          <input
            type="range" min={1} max={30} value={duration}
            onChange={e => setDuration(+e.target.value)}
            disabled={running}
            style={{ width: '100%' }}
          />
        </div>

        {isManual && (
        <div>
          <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            % лайків: <b style={{ color: 'var(--text)' }}>{likeProb}%</b>
          </label>
          <input
            type="range" min={0} max={50} value={likeProb}
            onChange={e => setLikeProb(+e.target.value)}
            disabled={running}
            style={{ width: '100%' }}
          />
        </div>
        )}
      </div>

      {!isManual && (
        <div style={{ marginBottom: 12, padding: 8,
                       background: 'rgba(99,102,241,0.08)',
                       borderRadius: 6, fontSize: 11,
                       color: 'var(--text-muted)' }}>
          💡 У режимі {engine === 'v2' ? 'v2 (beta)' : 'v1 (AI)'} лайки/сейви
          визначає AI на основі ніші — повзунок відсотка не потрібен
        </div>
      )}

      {running && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 6 }}>
            <span>⏱ {elMin}:{elSec} / {String(Math.floor(totalSec / 60)).padStart(2, '0')}:00</span>
            <span style={{ color: 'var(--text-muted)' }}>Залишилось: {remMin}:{remSec}</span>
          </div>
          <div style={{ height: 8, background: 'var(--bg)', borderRadius: 4, overflow: 'hidden' }}>
            <div style={{
              width: `${progress}%`, height: '100%', background: '#6366f1',
              transition: 'width 0.4s ease',
            }} />
          </div>
        </div>
      )}

      <button
        className="btn-primary"
        onClick={onStart}
        disabled={running || disabled}
        style={{ width: '100%', padding: 14, fontSize: 15 }}
      >
        {running ? '⏳ Йде прогрів...' : disabled ? '🔒 Планувальник активний' : '▶ Запустити прогрів'}
      </button>

      {result && !running && (
        <div style={{
          marginTop: 16, padding: 12, borderRadius: 8,
          background: result.ok ? 'rgba(34,197,94,0.1)' : 'rgba(224,82,82,0.1)',
          color: result.ok ? '#22c55e' : '#e05252',
        }}>
          {result.ok ? (
            <div>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>✅ Успіх</div>
              <div style={{ fontSize: 12, display: 'flex', gap: 16 }}>
                <span>Рілсів: <b>{result.reels_watched || 0}</b></span>
                <span>Лайки: <b>{result.likes_given || 0}</b></span>
                <span>Saves: <b>{result.saves_given || 0}</b></span>
                <span>Тривалість: <b>{result.duration}с</b></span>
              </div>
            </div>
          ) : (
            <div>❌ {result.error}</div>
          )}
        </div>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// SCHEDULE PANEL — planning
// ═══════════════════════════════════════════════════════════════

function SchedulePanel({
  device, account, engine, config, saveConfig,
  planStartDate, setPlanStartDate, planEndDate, setPlanEndDate,
  myPlannedSessions, upcomingPending, scheduleRunning, generating,
  onGenerate, onDeletePending, onTriggerNow, onViewSession,
  formatCountdown, fmtTime,
}) {
  // Групуємо по днях
  const groups = {}
  for (const s of myPlannedSessions) {
    const day = s.scheduled_at.split('T')[0]
    if (!groups[day]) groups[day] = []
    groups[day].push(s)
  }

  return (
    <div>
      <div className="card" style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <span style={{ fontWeight: 600, fontSize: 14 }}>🎛 Конфігурація розкладу</span>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={!!config.enabled}
              onChange={e => saveConfig({ enabled: e.target.checked ? 1 : 0 })}
              style={{ width: 18, height: 18 }}
            />
            <span style={{ fontSize: 13, fontWeight: 600, color: config.enabled ? '#22c55e' : 'var(--text-muted)' }}>
              {config.enabled ? 'УВІМКНЕНО' : 'ВИМКНЕНО'}
            </span>
          </label>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 16 }}>
          <div>
            <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              Сесій на день: <b style={{ color: 'var(--text)' }}>{config.sessions_per_day}</b>
            </label>
            <input
              type="range" min={1} max={10} value={config.sessions_per_day}
              onChange={e => saveConfig({ sessions_per_day: +e.target.value })}
              style={{ width: '100%' }}
            />
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)',
                         display: 'flex', alignItems: 'center' }}>
            💡 Режим прогріву (Manual / v1 / v2) налаштовується у блоці "Ніша для AI"
          </div>
          <div>
            <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              Активні години: <b style={{ color: 'var(--text)' }}>
                {String(config.active_hour_start).padStart(2,'0')}:00 –
                {String(config.active_hour_end).padStart(2,'0')}:00
              </b>
            </label>
            <RangeSlider
              min={0} max={23} step={1}
              value={[config.active_hour_start, config.active_hour_end]}
              onChange={([s, e]) => saveConfig({ active_hour_start: s, active_hour_end: e })}
            />
          </div>
          <div>
            <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              Тривалість: <b style={{ color: 'var(--text)' }}>{config.duration_min}–{config.duration_max} хв</b>
            </label>
            <RangeSlider
              min={1} max={30} step={1}
              value={[config.duration_min, config.duration_max]}
              onChange={([s, e]) => saveConfig({ duration_min: s, duration_max: e })}
            />
          </div>
          {engine === 'manual' ? (
            <div>
              <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                % лайків: <b style={{ color: 'var(--text)' }}>{config.like_prob_min}–{config.like_prob_max}%</b>
              </label>
              <RangeSlider
                min={0} max={50} step={1}
                value={[config.like_prob_min, config.like_prob_max]}
                onChange={([s, e]) => saveConfig({ like_prob_min: s, like_prob_max: e })}
              />
            </div>
          ) : (
            <div style={{ fontSize: 11, color: 'var(--text-muted)',
                           display: 'flex', alignItems: 'center',
                           padding: '6px 10px',
                           background: 'rgba(99,102,241,0.08)', borderRadius: 6 }}>
              🤖 У режимі {engine === 'v2' ? 'v2' : 'v1'} лайки визначає AI
            </div>
          )}
          <div>
            <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              Тайм-гап між сесіями: <b style={{ color: 'var(--text)' }}>{config.min_gap_minutes} хв</b>
            </label>
            <input
              type="range" min={10} max={120} step={5} value={config.min_gap_minutes}
              onChange={e => saveConfig({ min_gap_minutes: +e.target.value })}
              style={{ width: '100%' }}
            />
          </div>
        </div>
      </div>

      {upcomingPending.length > 0 && (
        <div className="card" style={{
          marginBottom: 12, padding: 12,
          background: scheduleRunning ? 'rgba(99,102,241,0.1)' : 'rgba(34,197,94,0.08)',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                {scheduleRunning ? '⏳ Сесія виконується' : '✅ Найближча сесія'}
              </div>
              <div style={{ fontSize: 14, fontWeight: 600 }}>
                {scheduleRunning ? 'Йде прогрів...' :
                  `${new Date(upcomingPending[0].scheduled_at).toLocaleString('uk-UA')} · ${formatCountdown(upcomingPending[0].scheduled_at)}`}
              </div>
            </div>
            <button
              className="btn-primary"
              onClick={onTriggerNow}
              disabled={scheduleRunning}
              style={{ fontSize: 12, padding: '8px 14px' }}
            >
              🚀 Запустити зараз
            </button>
          </div>
        </div>
      )}

      <div className="card" style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 160 }}>
            <label className="form-label" style={{ fontSize: 11 }}>Від</label>
            <input
              type="date" className="form-input" value={planStartDate}
              onChange={e => setPlanStartDate(e.target.value)} style={{ fontSize: 13 }}
            />
          </div>
          <div style={{ flex: 1, minWidth: 160 }}>
            <label className="form-label" style={{ fontSize: 11 }}>До</label>
            <input
              type="date" className="form-input" value={planEndDate}
              onChange={e => setPlanEndDate(e.target.value)} style={{ fontSize: 13 }}
            />
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className="btn-primary" onClick={() => onGenerate(false)}
              disabled={generating} style={{ fontSize: 13 }}
            >
              {generating ? '⏳' : '📅 Запланувати'}
            </button>
            <button
              className="btn-ghost" onClick={() => onGenerate(true)}
              disabled={generating} style={{ fontSize: 12, color: '#f0a500' }}
              title="Видалить невиконані і створить новий план"
            >
              🔄 Замінити
            </button>
            {myPlannedSessions.filter(s => s.status === 'pending').length > 0 && (
              <button
                className="btn-ghost" onClick={onDeletePending}
                style={{ fontSize: 12, color: '#e05252' }}
              >
                🗑 Очистити
              </button>
            )}
          </div>
        </div>
      </div>

      {/* План по днях */}
      {Object.keys(groups).sort().map(day => (
        <div key={day} className="card" style={{ marginBottom: 8, padding: 10 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 8 }}>
            {new Date(day + 'T12:00:00').toLocaleDateString('uk-UA', {
              weekday: 'short', day: 'numeric', month: 'short',
            })}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {groups[day].map(s => (
              <button
                key={s.id}
                onClick={() => onViewSession(s.id)}
                style={{
                  padding: '6px 10px', borderRadius: 6, border: 'none', cursor: 'pointer',
                  fontSize: 11,
                  background: s.status === 'done'    ? 'rgba(34,197,94,0.15)'
                            : s.status === 'failed'  ? 'rgba(224,82,82,0.15)'
                            : s.status === 'running' ? 'rgba(99,102,241,0.2)'
                            : 'var(--bg)',
                  color: s.status === 'done'    ? '#22c55e'
                       : s.status === 'failed'  ? '#e05252'
                       : s.status === 'running' ? '#6366f1'
                       : 'var(--text-secondary)',
                }}
              >
                {s.status === 'done' ? '✅' : s.status === 'failed' ? '❌' : s.status === 'running' ? '⏳' : '⏰'}
                {' '}{fmtTime(s.scheduled_at)} · {s.duration_min}хв
              </button>
            ))}
          </div>
        </div>
      ))}

      {myPlannedSessions.length === 0 && (
        <div style={{ padding: 30, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
          Жодної сесії не заплановано. Налаштуй розклад і натисни "Запланувати".
        </div>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// SESSION DETAILS MODAL
// ═══════════════════════════════════════════════════════════════

function SessionDetailsModal({ session, onClose }) {
  let decisions = []
  try { decisions = session.ai_decisions ? JSON.parse(session.ai_decisions) : [] } catch {}

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: 'var(--card-bg, #1a1a24)', borderRadius: 12, padding: 20,
          maxWidth: 600, width: '90%', maxHeight: '80vh', overflow: 'auto',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div>
            <div style={{ fontWeight: 600, fontSize: 16 }}>Сесія #{session.id}</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
              <div>📅 Заплановано: {fmtDateTime(session.scheduled_at)}</div>
              {session.started_at && (
                <div>▶️ Старт: {fmtDateTime(session.started_at)}</div>
              )}
              {session.finished_at && (
                <div>✅ Завершення: {fmtDateTime(session.finished_at)}
                  {session.started_at && (
                    <span style={{ marginLeft: 6, opacity: 0.7 }}>
                      (тривала {fmtDuration(session.started_at, session.finished_at)})
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', fontSize: 20, cursor: 'pointer' }}>✕</button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 16 }}>
          <Stat label="Статус" value={session.status} />
          <Stat label="Рілсів" value={session.reels_watched} />
          <Stat label="Лайки" value={session.likes_given} />
          <Stat label="Saves" value={session.saves_given} />
        </div>

        {/* AI cost stats (тільки якщо використовувався AI) */}
        {session.ai_calls > 0 && (
          <div style={{
            padding: 12, marginBottom: 12, borderRadius: 8,
            background: 'rgba(99,102,241,0.06)',
            border: '1px solid rgba(99,102,241,0.2)',
          }}>
            <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8,
                           display: 'flex', justifyContent: 'space-between' }}>
              <span>🧠 AI витрати ({session.engine || '—'})</span>
              <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 400 }}>
                {session.ai_calls} виклик{session.ai_calls > 1 ? 'ів' : ''}
              </span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
              <MiniStat label="Input" value={formatNum(session.ai_input_tokens)} suffix="tok" />
              <MiniStat label="Output" value={formatNum(session.ai_output_tokens)} suffix="tok" />
              <MiniStat label="Cache read" value={formatNum(session.ai_cache_read_tokens)}
                         suffix="tok" hint="10× дешевше" />
              <MiniStat label="Якби API" value={`$${(session.ai_cost_usd || 0).toFixed(4)}`}
                         hint="підписка = $0" />
            </div>
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 6, textAlign: 'center' }}>
              💳 Через Claude Code підписку — безкоштовно
            </div>
          </div>
        )}

        {session.error && (
          <div style={{ padding: 10, marginBottom: 12, borderRadius: 6, background: 'rgba(224,82,82,0.1)', color: '#e05252', fontSize: 12 }}>
            ❌ {session.error}
          </div>
        )}

        {decisions.length > 0 && (
          <div>
            <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>🤖 AI рішення ({decisions.length})</div>
            {decisions.map((d, i) => (
              <div key={i} style={{
                padding: 8, marginBottom: 6, borderRadius: 6,
                background: d.action === 'like' ? 'rgba(34,197,94,0.08)'
                          : d.action === 'save' ? 'rgba(99,102,241,0.08)'
                          : 'rgba(0,0,0,0.2)',
                fontSize: 12,
              }}>
                <b>[{d.mode}] {d.action}</b>
                {d.downgraded_from && (
                  <span style={{ fontSize: 11, color: '#f0a500', marginLeft: 6 }}>
                    (з {d.downgraded_from} — {d.downgrade_reason})
                  </span>
                )}
                {' — '}{d.reason}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function Stat({ label, value }) {
  return (
    <div style={{ padding: 10, background: 'rgba(0,0,0,0.2)', borderRadius: 6, textAlign: 'center' }}>
      <div style={{ fontSize: 18, fontWeight: 700 }}>{value ?? '—'}</div>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase' }}>{label}</div>
    </div>
  )
}

function MiniStat({ label, value, suffix, hint }) {
  return (
    <div style={{ padding: '6px 8px', background: 'rgba(0,0,0,0.25)',
                   borderRadius: 4, textAlign: 'center' }}>
      <div style={{ fontSize: 13, fontWeight: 600 }}>
        {value}{suffix && <span style={{ fontSize: 9, color: 'var(--text-muted)',
                                          marginLeft: 2 }}>{suffix}</span>}
      </div>
      <div style={{ fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase' }}>
        {label}
      </div>
      {hint && <div style={{ fontSize: 9, color: 'var(--text-muted)',
                               fontStyle: 'italic' }}>{hint}</div>}
    </div>
  )
}

function formatNum(n) {
  if (!n && n !== 0) return '—'
  if (n < 1000) return String(n)
  if (n < 10000) return (n / 1000).toFixed(1) + 'k'
  return Math.round(n / 1000) + 'k'
}

function fmtDateTime(iso) {
  if (!iso) return '—'
  try {
    const d = new Date(iso)
    return d.toLocaleString('uk-UA', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    })
  } catch { return iso }
}

function fmtDuration(startIso, endIso) {
  try {
    const diff = (new Date(endIso) - new Date(startIso)) / 1000
    if (diff < 60) return `${Math.round(diff)}с`
    const m = Math.floor(diff / 60)
    const s = Math.round(diff % 60)
    return s ? `${m}хв ${s}с` : `${m}хв`
  } catch { return '' }
}
