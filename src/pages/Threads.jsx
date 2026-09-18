/**
 * Threads — full version. Publish + Comment session + Planner.
 * Inline styles to avoid CSS class fragility.
 */
import { useEffect, useRef, useState, useCallback } from 'react'

const isElectron = typeof window !== 'undefined' && !!window.api

const S = {
  page:    { padding: 24, maxWidth: 1100 },
  title:   { fontSize: 24, marginBottom: 4 },
  sub:     { color: '#aaa', marginBottom: 20, fontSize: 13 },
  card:    { padding: 16, marginBottom: 16, background: '#1a1a24', border: '1px solid #2a2a35', borderRadius: 10 },
  label:   { display: 'block', fontSize: 12, color: '#aaa', marginBottom: 4 },
  input:   { width: '100%', padding: 8, background: '#0f0f17', color: '#fff', border: '1px solid #333', borderRadius: 6, fontSize: 13, fontFamily: 'inherit' },
  row:     { display: 'flex', gap: 12, flexWrap: 'wrap' },
  field:   { flex: 1, minWidth: 200 },
  btn:     { padding: '10px 18px', borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: 'pointer', border: 'none' },
  primary: { background: '#6366f1', color: '#fff' },
  ghost:   { background: 'transparent', color: '#aaa', border: '1px solid #333' },
  danger:  { background: 'transparent', color: '#e05252', border: '1px solid #e0525244' },
  hint:    { fontSize: 11, color: '#888', marginTop: 4 },
  err:     { padding: 12, borderRadius: 6, fontSize: 12, background: 'rgba(224,82,82,0.1)', color: '#e05252', marginBottom: 16 },
  ok:      { padding: 10, borderRadius: 6, fontSize: 12, background: 'rgba(34,197,94,0.1)', color: '#22c55e', marginTop: 12 },
  bad:     { padding: 10, borderRadius: 6, fontSize: 12, background: 'rgba(224,82,82,0.1)', color: '#e05252', marginTop: 12 },
  timer:   { marginTop: 16, padding: 12, borderRadius: 8, background: 'rgba(99,102,241,0.1)', border: '1px solid #6366f140', display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  table:   { width: '100%', borderCollapse: 'collapse', fontSize: 12 },
  th:      { textAlign: 'left', padding: '8px 6px', borderBottom: '1px solid #2a2a35', color: '#aaa', fontWeight: 600, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 },
  td:      { padding: '8px 6px', borderBottom: '1px solid #20202a', color: '#ddd' },
  badge:   (color, bg) => ({ display: 'inline-block', padding: '2px 8px', borderRadius: 12, fontSize: 11, fontWeight: 600, color, background: bg }),
  iconBtn: { padding: '4px 10px', borderRadius: 4, fontSize: 11, cursor: 'pointer', border: '1px solid #333', background: 'transparent', color: '#aaa' },
  checkRow: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#ddd', cursor: 'pointer', marginTop: 8 },
}

const STATUS_BADGE = {
  planned:   S.badge('#818cf8', 'rgba(99,102,241,0.15)'),
  running:   S.badge('#fbbf24', 'rgba(251,191,36,0.15)'),
  done:      S.badge('#22c55e', 'rgba(34,197,94,0.15)'),
  failed:    S.badge('#e05252', 'rgba(224,82,82,0.15)'),
  cancelled: S.badge('#888',    'rgba(136,136,136,0.15)'),
}

function todayIso() {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.toISOString().slice(0, 10)
}

function addDaysIso(iso, days) {
  const d = new Date(iso + 'T00:00:00')
  d.setDate(d.getDate() + days)
  return d.toISOString().slice(0, 10)
}

function fmtDate(iso) {
  const d = new Date(iso)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function fmtTime(iso) {
  const d = new Date(iso)
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

export default function Threads() {
  const [devices, setDevices]   = useState([])
  const [accounts, setAccounts] = useState([])
  const [deviceId, setDeviceId] = useState('')
  const [accountId, setAccountId] = useState('')
  const [loadError, setLoadError] = useState('')
  const [mode, setMode] = useState('publish')

  const [postText, setPostText] = useState('')
  const [publishing, setPublishing] = useState(false)
  const [publishResult, setPublishResult] = useState(null)

  const [duration, setDuration] = useState(15)
  const [likeProb, setLikeProb] = useState(40)
  const [aiPrompt, setAiPrompt] = useState('')
  const [running, setRunning] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [sessionResult, setSessionResult] = useState(null)

  // ===== Planner state =====
  const [plannerStart, setPlannerStart] = useState(todayIso())
  const [plannerEnd, setPlannerEnd] = useState(addDaysIso(todayIso(), 6))
  const [planConfig, setPlanConfig] = useState({
    sessionsPerDay: 3,
    activeHourStart: 9,
    activeHourEnd: 22,
    durationMin: 10,
    durationMax: 20,
    likeProbMin: 20,
    likeProbMax: 40,
    aiPrompt: '',
  })
  const [replaceExisting, setReplaceExisting] = useState(false)
  const [planRows, setPlanRows] = useState([])
  const [planBusy, setPlanBusy] = useState(false)
  const [planMsg, setPlanMsg] = useState(null)

  const timerRef = useRef(null)
  const startRef = useRef(0)

  useEffect(() => {
    if (!isElectron) { setLoadError('Not running in Electron'); return }
    let alive = true
    ;(async () => {
      try {
        const d = await window.api.devices.getAll()
        if (alive) setDevices(Array.isArray(d) ? d : [])
      } catch (e) { if (alive) setLoadError('devices: ' + String(e)) }
      try {
        const a = await window.api.accounts.getAll()
        if (alive) setAccounts(Array.isArray(a) ? a : [])
      } catch (e) { if (alive) setLoadError('accounts: ' + String(e)) }
    })()
    return () => { alive = false }
  }, [])

  const deviceAccounts = accounts.filter(a => String(a.device_id) === String(deviceId))
  const selectedDevice  = devices.find(d => String(d.id) === String(deviceId))
  const busy = publishing || running
  const canRun = !!selectedDevice && !!accountId && !busy

  const refreshPlan = useCallback(async () => {
    if (!accountId) { setPlanRows([]); return }
    if (!window.api?.threadsPlan?.get) {
      setPlanMsg({ ok: false, error: 'threadsPlan.get not in preload - restart Electron' })
      return
    }
    try {
      const rows = await window.api.threadsPlan.get(
        Number(accountId),
        plannerStart + 'T00:00:00',
        plannerEnd + 'T23:59:59',
      )
      setPlanRows(Array.isArray(rows) ? rows : [])
    } catch (e) {
      setPlanMsg({ ok: false, error: 'Load plan: ' + String(e) })
    }
  }, [accountId, plannerStart, plannerEnd])

  useEffect(() => {
    if (mode === 'planner' && accountId) refreshPlan()
  }, [mode, accountId, plannerStart, plannerEnd, refreshPlan])

  // Listen to backend scheduler events to auto-refresh
  useEffect(() => {
    if (!isElectron || mode !== 'planner') return
    const offStarted  = window.api.on?.('threads:started',  () => refreshPlan())
    const offFinished = window.api.on?.('threads:finished', () => refreshPlan())
    return () => { offStarted && offStarted(); offFinished && offFinished() }
  }, [mode, refreshPlan])

  const handlePublish = async () => {
    if (!canRun || !postText.trim()) return
    if (!window.api?.python?.threadsPublish) {
      setPublishResult({ ok: false, error: 'threadsPublish not in preload - restart Electron' })
      return
    }
    setPublishing(true); setPublishResult(null)
    try {
      const r = await window.api.python.threadsPublish(
        selectedDevice.serial, postText.trim(), Number(accountId),
      )
      setPublishResult(r)
      if (r?.ok) setPostText('')
    } catch (e) {
      setPublishResult({ ok: false, error: String(e) })
    } finally { setPublishing(false) }
  }

  const handleStartComment = async () => {
    if (!canRun) return
    if (!window.api?.python?.threadsScrollComment) {
      setSessionResult({ ok: false, error: 'threadsScrollComment not in preload - restart Electron' })
      return
    }
    setRunning(true); setSessionResult(null); setElapsed(0)
    startRef.current = Date.now()
    timerRef.current = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startRef.current) / 1000))
    }, 500)
    try {
      const r = await window.api.python.threadsScrollComment(
        selectedDevice.serial,
        duration * 60,
        likeProb / 100,
        aiPrompt.trim() || null,
        Number(accountId),
      )
      setSessionResult(r)
    } catch (e) {
      setSessionResult({ ok: false, error: String(e) })
    } finally {
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
      setRunning(false)
    }
  }

  const handleGeneratePlan = async () => {
    if (!accountId) { setPlanMsg({ ok: false, error: 'Select account first' }); return }
    if (!window.api?.threadsPlan?.generate) {
      setPlanMsg({ ok: false, error: 'threadsPlan.generate not in preload - restart Electron' })
      return
    }
    if (planConfig.activeHourEnd <= planConfig.activeHourStart) {
      setPlanMsg({ ok: false, error: 'Active hour end must be > start' })
      return
    }
    if (planConfig.durationMax < planConfig.durationMin) {
      setPlanMsg({ ok: false, error: 'Duration max must be >= min' })
      return
    }
    if (planConfig.likeProbMax < planConfig.likeProbMin) {
      setPlanMsg({ ok: false, error: 'Like% max must be >= min' })
      return
    }

    setPlanBusy(true); setPlanMsg(null)
    try {
      const cfg = {
        accountId: Number(accountId),
        deviceId: Number(deviceId) || undefined,
        sessionsPerDay: Number(planConfig.sessionsPerDay),
        activeHourStart: Number(planConfig.activeHourStart),
        activeHourEnd: Number(planConfig.activeHourEnd),
        durationMin: Number(planConfig.durationMin),
        durationMax: Number(planConfig.durationMax),
        likeProbMin: Number(planConfig.likeProbMin),
        likeProbMax: Number(planConfig.likeProbMax),
        aiPrompt: planConfig.aiPrompt.trim() || null,
      }
      const r = await window.api.threadsPlan.generate(
        cfg,
        { startDate: plannerStart, endDate: plannerEnd },
        replaceExisting,
      )
      if (r?.ok) {
        setPlanMsg({ ok: true, msg: `Generated ${r.count} session(s)` })
        await refreshPlan()
      } else {
        setPlanMsg({ ok: false, error: r?.error || 'Generation failed' })
      }
    } catch (e) {
      setPlanMsg({ ok: false, error: String(e) })
    } finally { setPlanBusy(false) }
  }

  const handleCancelSession = async (sessionId) => {
    if (!window.api?.threadsPlan?.cancel) return
    setPlanBusy(true)
    try {
      await window.api.threadsPlan.cancel(sessionId)
      await refreshPlan()
    } catch (e) {
      setPlanMsg({ ok: false, error: 'Cancel: ' + String(e) })
    } finally { setPlanBusy(false) }
  }

  const handleDeletePlan = async () => {
    if (!accountId) return
    if (!window.api?.threadsPlan?.delete) return
    if (!confirm('Delete all planned sessions in this date range?')) return
    setPlanBusy(true)
    try {
      const r = await window.api.threadsPlan.delete(
        Number(accountId),
        plannerStart + 'T00:00:00',
        plannerEnd + 'T23:59:59',
        true,
      )
      setPlanMsg({ ok: true, msg: `Deleted ${r?.count || 0} session(s)` })
      await refreshPlan()
    } catch (e) {
      setPlanMsg({ ok: false, error: 'Delete: ' + String(e) })
    } finally { setPlanBusy(false) }
  }

  const fmt = (s) => {
    const m = Math.floor(s / 60); const sec = s % 60
    return `${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`
  }

  const setCfg = (k, v) => setPlanConfig(prev => ({ ...prev, [k]: v }))

  return (
    <div style={S.page}>
      <h1 style={S.title}>Threads</h1>
      <p style={S.sub}>English-only, sounds like a real person</p>

      {loadError && <div style={S.err}>{loadError}</div>}

      <div style={S.card}>
        <div style={S.row}>
          <div style={S.field}>
            <label style={S.label}>Device ({devices.length})</label>
            <select
              style={S.input}
              value={deviceId}
              onChange={e => { setDeviceId(e.target.value); setAccountId('') }}
            >
              <option value="">- select -</option>
              {devices.map(d => (
                <option key={d.id} value={d.id}>{d.name} ({d.serial})</option>
              ))}
            </select>
          </div>
          <div style={S.field}>
            <label style={S.label}>Account ({deviceAccounts.length} bound)</label>
            <select
              style={S.input}
              value={accountId}
              onChange={e => setAccountId(e.target.value)}
              disabled={deviceAccounts.length === 0}
            >
              <option value="">- {deviceAccounts.length === 0 ? 'none bound' : 'select'} -</option>
              {deviceAccounts.map(a => (
                <option key={a.id} value={a.id}>@{a.username}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      <div style={S.card}>
        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          <button
            style={{ ...S.btn, ...(mode === 'publish' ? S.primary : S.ghost), flex: 1 }}
            onClick={() => setMode('publish')}
            disabled={busy}
          >Publish</button>
          <button
            style={{ ...S.btn, ...(mode === 'comment' ? S.primary : S.ghost), flex: 1 }}
            onClick={() => setMode('comment')}
            disabled={busy}
          >Comment session</button>
          <button
            style={{ ...S.btn, ...(mode === 'planner' ? S.primary : S.ghost), flex: 1 }}
            onClick={() => setMode('planner')}
            disabled={busy}
          >Planner</button>
        </div>

        {mode === 'publish' && (
          <>
            <label style={S.label}>Post text (English, casual)</label>
            <textarea
              style={{ ...S.input, resize: 'vertical' }}
              value={postText}
              onChange={e => setPostText(e.target.value)}
              placeholder="just had the wildest coffee of my life. not even kidding"
              rows={5}
              maxLength={500}
              disabled={publishing}
            />
            <div style={S.hint}>{postText.length} / 500</div>
            <button
              style={{ ...S.btn, ...S.primary, marginTop: 16, width: '100%', padding: 12, opacity: (!canRun || !postText.trim()) ? 0.5 : 1 }}
              onClick={handlePublish}
              disabled={!canRun || !postText.trim()}
            >{publishing ? 'Publishing...' : 'Publish to Threads'}</button>
            {publishResult && (
              <div style={publishResult.ok ? S.ok : S.bad}>
                {publishResult.ok ? 'Published' : (publishResult.error || 'Error')}
              </div>
            )}
          </>
        )}

        {mode === 'comment' && (
          <>
            <div style={{ ...S.row, marginBottom: 12 }}>
              <div style={S.field}>
                <label style={S.label}>Duration (min)</label>
                <input type="number" style={S.input} value={duration}
                  onChange={e => setDuration(Math.max(1, Number(e.target.value) || 1))}
                  min={1} max={120} disabled={running} />
              </div>
              <div style={S.field}>
                <label style={S.label}>Like %</label>
                <input type="number" style={S.input} value={likeProb}
                  onChange={e => setLikeProb(Math.min(100, Math.max(0, Number(e.target.value) || 0)))}
                  min={0} max={100} disabled={running} />
              </div>
            </div>
            <label style={S.label}>Persona / style (optional, English)</label>
            <textarea
              style={{ ...S.input, resize: 'vertical' }}
              value={aiPrompt}
              onChange={e => setAiPrompt(e.target.value)}
              placeholder="mid-20s guy in tech, dry humor, no emoji, sometimes lowercase"
              rows={3} disabled={running}
            />
            <div style={S.hint}>AI comments forced English + humanlike.</div>

            {running && (
              <div style={S.timer}>
                <span style={{ fontSize: 13 }}>Session in progress...</span>
                <span style={{ fontSize: 18, fontWeight: 700, fontFamily: 'monospace', color: '#818cf8' }}>
                  {fmt(elapsed)} / {fmt(duration * 60)}
                </span>
              </div>
            )}

            <button
              style={{ ...S.btn, ...S.primary, marginTop: 16, width: '100%', padding: 12, opacity: !canRun ? 0.5 : 1 }}
              onClick={handleStartComment}
              disabled={!canRun}
            >{running ? 'Running...' : 'Start comment session'}</button>

            {sessionResult && (
              <div style={sessionResult.ok ? S.ok : S.bad}>
                {sessionResult.ok
                  ? `Done. viewed ${sessionResult.viewed ?? '?'} . commented ${sessionResult.commented ?? '?'} . liked ${sessionResult.liked ?? '?'}`
                  : (sessionResult.error || 'Error')}
              </div>
            )}
          </>
        )}

        {mode === 'planner' && (
          <PlannerView
            canRun={!!accountId && !!deviceId}
            accountId={accountId}
            deviceId={deviceId}
            plannerStart={plannerStart}
            plannerEnd={plannerEnd}
            setPlannerStart={setPlannerStart}
            setPlannerEnd={setPlannerEnd}
            planConfig={planConfig}
            setCfg={setCfg}
            replaceExisting={replaceExisting}
            setReplaceExisting={setReplaceExisting}
            planRows={planRows}
            planBusy={planBusy}
            planMsg={planMsg}
            onGenerate={handleGeneratePlan}
            onRefresh={refreshPlan}
            onCancelSession={handleCancelSession}
            onDeletePlan={handleDeletePlan}
          />
        )}
      </div>
    </div>
  )
}

function PlannerView({
  canRun, accountId, plannerStart, plannerEnd, setPlannerStart, setPlannerEnd,
  planConfig, setCfg, replaceExisting, setReplaceExisting,
  planRows, planBusy, planMsg, onGenerate, onRefresh, onCancelSession, onDeletePlan,
}) {
  return (
    <>
      <div style={{ ...S.row, marginBottom: 12 }}>
        <div style={S.field}>
          <label style={S.label}>Start date</label>
          <input type="date" style={S.input} value={plannerStart}
            onChange={e => setPlannerStart(e.target.value)} disabled={planBusy} />
        </div>
        <div style={S.field}>
          <label style={S.label}>End date</label>
          <input type="date" style={S.input} value={plannerEnd}
            onChange={e => setPlannerEnd(e.target.value)} disabled={planBusy} />
        </div>
      </div>

      <div style={{ ...S.row, marginBottom: 12 }}>
        <div style={S.field}>
          <label style={S.label}>Sessions per day</label>
          <input type="number" style={S.input} value={planConfig.sessionsPerDay}
            onChange={e => setCfg('sessionsPerDay', Math.max(1, Math.min(12, Number(e.target.value) || 1)))}
            min={1} max={12} disabled={planBusy} />
        </div>
        <div style={S.field}>
          <label style={S.label}>Active hours</label>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="number" style={S.input} value={planConfig.activeHourStart}
              onChange={e => setCfg('activeHourStart', Math.max(0, Math.min(23, Number(e.target.value) || 0)))}
              min={0} max={23} disabled={planBusy} />
            <span style={{ color: '#aaa', fontSize: 12 }}>to</span>
            <input type="number" style={S.input} value={planConfig.activeHourEnd}
              onChange={e => setCfg('activeHourEnd', Math.max(1, Math.min(24, Number(e.target.value) || 24)))}
              min={1} max={24} disabled={planBusy} />
          </div>
        </div>
      </div>

      <div style={{ ...S.row, marginBottom: 12 }}>
        <div style={S.field}>
          <label style={S.label}>Duration min (min)</label>
          <input type="number" style={S.input} value={planConfig.durationMin}
            onChange={e => setCfg('durationMin', Math.max(1, Math.min(60, Number(e.target.value) || 1)))}
            min={1} max={60} disabled={planBusy} />
        </div>
        <div style={S.field}>
          <label style={S.label}>Duration max (min)</label>
          <input type="number" style={S.input} value={planConfig.durationMax}
            onChange={e => setCfg('durationMax', Math.max(1, Math.min(60, Number(e.target.value) || 1)))}
            min={1} max={60} disabled={planBusy} />
        </div>
      </div>

      <div style={{ ...S.row, marginBottom: 12 }}>
        <div style={S.field}>
          <label style={S.label}>Like % min</label>
          <input type="number" style={S.input} value={planConfig.likeProbMin}
            onChange={e => setCfg('likeProbMin', Math.max(0, Math.min(100, Number(e.target.value) || 0)))}
            min={0} max={100} disabled={planBusy} />
        </div>
        <div style={S.field}>
          <label style={S.label}>Like % max</label>
          <input type="number" style={S.input} value={planConfig.likeProbMax}
            onChange={e => setCfg('likeProbMax', Math.max(0, Math.min(100, Number(e.target.value) || 0)))}
            min={0} max={100} disabled={planBusy} />
        </div>
      </div>

      <label style={S.label}>AI prompt (persona / style, optional)</label>
      <textarea
        style={{ ...S.input, resize: 'vertical' }}
        value={planConfig.aiPrompt}
        onChange={e => setCfg('aiPrompt', e.target.value)}
        placeholder="mid-20s guy in tech, dry humor, no emoji, sometimes lowercase"
        rows={2} disabled={planBusy}
      />

      <label style={S.checkRow}>
        <input type="checkbox" checked={replaceExisting}
          onChange={e => setReplaceExisting(e.target.checked)} disabled={planBusy} />
        Replace existing planned sessions in this date range
      </label>

      <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
        <button
          style={{ ...S.btn, ...S.primary, flex: 1, padding: 12, opacity: (!canRun || planBusy) ? 0.5 : 1 }}
          onClick={onGenerate}
          disabled={!canRun || planBusy}
        >{planBusy ? 'Working...' : 'Generate plan'}</button>
        <button
          style={{ ...S.btn, ...S.ghost, padding: 12 }}
          onClick={onRefresh}
          disabled={!canRun || planBusy}
        >Refresh</button>
        <button
          style={{ ...S.btn, ...S.danger, padding: 12 }}
          onClick={onDeletePlan}
          disabled={!canRun || planBusy || planRows.length === 0}
        >Delete planned</button>
      </div>

      {planMsg && (
        <div style={planMsg.ok ? S.ok : S.bad}>
          {planMsg.ok ? planMsg.msg : (planMsg.error || 'Error')}
        </div>
      )}

      {!canRun && (
        <div style={{ ...S.hint, marginTop: 12 }}>Select device and account to start planning</div>
      )}

      {canRun && (
        <div style={{ marginTop: 20 }}>
          <div style={{ fontSize: 13, color: '#ddd', marginBottom: 8 }}>
            Plan ({planRows.length} session{planRows.length === 1 ? '' : 's'})
          </div>
          {planRows.length === 0 ? (
            <div style={S.hint}>No sessions in this range. Generate a plan above.</div>
          ) : (
            <div style={{ maxHeight: 400, overflowY: 'auto', border: '1px solid #20202a', borderRadius: 6 }}>
              <table style={S.table}>
                <thead>
                  <tr>
                    <th style={S.th}>Date</th>
                    <th style={S.th}>Time</th>
                    <th style={S.th}>Duration</th>
                    <th style={S.th}>Like%</th>
                    <th style={S.th}>Status</th>
                    <th style={S.th}>Result</th>
                    <th style={S.th}></th>
                  </tr>
                </thead>
                <tbody>
                  {planRows.map(r => (
                    <tr key={r.id}>
                      <td style={S.td}>{fmtDate(r.scheduled_at)}</td>
                      <td style={S.td}>{fmtTime(r.scheduled_at)}</td>
                      <td style={S.td}>{r.duration_min}m</td>
                      <td style={S.td}>{Math.round((r.like_prob || 0) * 100)}%</td>
                      <td style={S.td}>
                        <span style={STATUS_BADGE[r.status] || S.badge('#aaa', 'rgba(255,255,255,0.05)')}>
                          {r.status}
                        </span>
                      </td>
                      <td style={S.td}>
                        {r.status === 'done' && `v${r.viewed ?? 0} c${r.commented ?? 0} l${r.liked ?? 0}`}
                        {r.status === 'failed' && (
                          <span style={{ color: '#e05252' }} title={r.error || ''}>
                            {(r.error || 'failed').slice(0, 30)}
                          </span>
                        )}
                      </td>
                      <td style={S.td}>
                        {r.status === 'planned' && (
                          <button style={S.iconBtn}
                            onClick={() => onCancelSession(r.id)}
                            disabled={planBusy}>cancel</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </>
  )
}
