import { useState, useEffect, useRef } from 'react'
import './Pages.css'
import './Posting.css'

const DAYS   = ['Нд', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб']
const MONTHS = ['Січень','Лютий','Березень','Квітень','Травень','Червень',
                'Липень','Серпень','Вересень','Жовтень','Листопад','Грудень']

const isElectron = typeof window !== 'undefined' && !!window.api
const PYTHON_PORT = 8765

export default function Posting() {
  const today = new Date()
  const [year, setYear]   = useState(today.getFullYear())
  const [month, setMonth] = useState(today.getMonth())
  const [selected, setSelected] = useState(today.getDate())

  // Posts per day: { 'YYYY-MM-DD': [post, ...] }
  const [postDays, setPostDays] = useState({})

  // Panel state for selected day
  const [videoPath, setVideoPath]     = useState(null)
  const [videoUrl, setVideoUrl]       = useState(null)
  const [caption, setCaption]         = useState('')
  const [hashtags, setHashtags]       = useState('')
  const [generating, setGenerating]   = useState(false)
  const [publishing, setPublishing]   = useState(false)
  const [testing, setTesting]         = useState(false)
  const [scheduling, setScheduling]   = useState(false)
  const [scheduleTime, setScheduleTime] = useState('12:00')
  const [scheduleDryRun, setScheduleDryRun] = useState(false)
  const [showSchedule, setShowSchedule] = useState(false)
  const [msg, setMsg] = useState(null) // { type: 'ok'|'err', text }
  const [settings, setSettings] = useState(null)

  // History picker
  const [showHistoryPicker, setShowHistoryPicker] = useState(false)
  const [historyItems, setHistoryItems] = useState([])

  // Accounts (для вибору акаунту постингу)
  const [accounts, setAccounts] = useState([])
  const [selectedAccountId, setSelectedAccountId] = useState(null)

  // Devices + cascade (Device → Account)
  const [allDevices, setAllDevices] = useState([])
  const [selectedDeviceId, setSelectedDeviceId] = useState(null)

  // Контекст з обраного відео (з історії — для генерації релевантного підпису)
  const [videoContext, setVideoContext] = useState(null) // { quote, style, image_prompt, video_prompt }

  // Edit modal для запланованих постів
  const [editPost, setEditPost]           = useState(null)
  const [editVideoPath, setEditVideoPath] = useState('')
  const [editCaption, setEditCaption]     = useState('')
  const [editDate, setEditDate]           = useState('')
  const [editTime, setEditTime]           = useState('')
  const [editAccountId, setEditAccountId] = useState(null)
  const [savingEdit, setSavingEdit]       = useState(false)

  // Тип контенту: 'reel' (video) | 'post' (1 image) | 'carousel' (multi image)
  const [contentType, setContentType] = useState('reel')
  // Для post/carousel — вибрана генерація з Історії
  const [selectedGen, setSelectedGen] = useState(null)
  // Поточний список фото для публікації (можна вилучати окремі перед scheduling)
  const [editedImagePaths, setEditedImagePaths] = useState([])
  // Для вибору з історії
  const [showGenPicker, setShowGenPicker] = useState(false)
  const [allGens, setAllGens] = useState([])

  // Android posting
  const [useAndroid, setUseAndroid] = useState(false)
  const [androidDevices, setAndroidDevices] = useState([])
  const [androidSerial, setAndroidSerial] = useState('')
  const [androidStatus, setAndroidStatus] = useState(null)

  // Warm-up scroll
  const [showWarmup, setShowWarmup] = useState(false)
  const [warmupDuration, setWarmupDuration] = useState(5)    // хвилини
  const [warmupLikeProb, setWarmupLikeProb] = useState(15)  // %
  const [warmupBusy, setWarmupBusy] = useState(false)
  const [warmupResult, setWarmupResult] = useState(null)     // { ok, reels_watched, likes_given, duration } | { ok: false, error }

  // WiFi ADB
  const [showWifi, setShowWifi] = useState(false)
  const [wifiMethod, setWifiMethod] = useState('modern') // 'modern' | 'legacy'
  const [wifiPairHost, setWifiPairHost] = useState('')   // IP:port для паринг-коду (Android 11+)
  const [wifiPairCode, setWifiPairCode] = useState('')   // 6-значний код
  const [wifiIp, setWifiIp] = useState('')               // IP для підключення після pair/tcpip
  const [wifiBusy, setWifiBusy] = useState(false)
  const [wifiMsg, setWifiMsg] = useState(null)           // { type: 'ok'|'err', text }

  const refreshAndroid = async () => {
    if (!isElectron) return
    const d = await window.api.python.androidDevices()
    if (d?.ok) {
      setAndroidDevices(d.devices || [])
      if (!androidSerial && d.devices?.[0]) setAndroidSerial(d.devices[0])
    }
    const s = await window.api.python.androidStatus(androidSerial || null)
    setAndroidStatus(s)
  }

  const handleWarmup = async () => {
    setWarmupBusy(true); setWarmupResult(null)
    try {
      const r = await window.api.python.androidScrollReels(
        androidSerial || null,
        warmupDuration * 60,
        warmupLikeProb / 100,
        settings?.androidProxy || null,
      )
      setWarmupResult(r)
    } catch (e) {
      setWarmupResult({ ok: false, error: String(e) })
    }
    setWarmupBusy(false)
  }

  const handleWifiPair = async () => {
    if (!wifiPairHost || !wifiPairCode) return
    setWifiBusy(true); setWifiMsg(null)
    try {
      const r = await window.api.python.androidPair(wifiPairHost, wifiPairCode)
      if (r.ok) {
        setWifiMsg({ type: 'ok', text: `✅ Сполучено! Тепер підключи: введи IP телефону і натисни "Підключити"` })
        // Автовиставляємо IP для підключення (беремо з pair-host без порту)
        if (!wifiIp) setWifiIp(wifiPairHost.split(':')[0])
      } else {
        setWifiMsg({ type: 'err', text: r.error || 'Помилка сполучення' })
      }
    } catch (e) { setWifiMsg({ type: 'err', text: String(e) }) }
    setWifiBusy(false)
  }

  const handleWifiConnect = async () => {
    if (!wifiIp) return
    setWifiBusy(true); setWifiMsg(null)
    try {
      const host = wifiIp.includes(':') ? wifiIp : `${wifiIp}:5555`
      const r = await window.api.python.androidConnect(host)
      if (r.ok) {
        setWifiMsg({ type: 'ok', text: `📡 ${r.message || 'Підключено!'}` })
        await refreshAndroid()
      } else {
        setWifiMsg({ type: 'err', text: r.error || 'Не вдалось підключити' })
      }
    } catch (e) { setWifiMsg({ type: 'err', text: String(e) }) }
    setWifiBusy(false)
  }

  const handleWifiTcpip = async () => {
    setWifiBusy(true); setWifiMsg(null)
    try {
      const r = await window.api.python.androidTcpip(androidSerial || null, 5555)
      if (r.ok) {
        setWifiMsg({ type: 'ok', text: `✅ ${r.message || 'TCP режим увімкнено'}. Відключи USB-кабель, потім введи IP і натисни "Підключити".` })
      } else {
        setWifiMsg({ type: 'err', text: r.error || 'Помилка tcpip' })
      }
    } catch (e) { setWifiMsg({ type: 'err', text: String(e) }) }
    setWifiBusy(false)
  }

  const handleWifiDisconnect = async (host) => {
    setWifiBusy(true); setWifiMsg(null)
    try {
      const r = await window.api.python.androidDisconnect(host)
      setWifiMsg({ type: r.ok ? 'ok' : 'err', text: r.message || r.error || '' })
      await refreshAndroid()
    } catch (e) { setWifiMsg({ type: 'err', text: String(e) }) }
    setWifiBusy(false)
  }

  useEffect(() => {
    if (useAndroid) refreshAndroid()
  }, [useAndroid])

  useEffect(() => {
    if (!isElectron) return
    window.api.settings.get().then(s => { if (s) setSettings(s) })
    window.api.accounts.getAll().then(data => {
      setAccounts(data || [])
    })
    window.api.devices.getAll().then(list => {
      setAllDevices(list || [])
      if ((list || []).length > 0) setSelectedDeviceId(list[0].id)
    })
    loadScheduled()
    if (window.api.on) {
      const unsub = window.api.on('schedule:published', () => loadScheduled())
      return unsub
    }
  }, [])

  // Авто-вибір першого акаунта привʼязаного до обраного device
  useEffect(() => {
    if (!selectedDeviceId) { setSelectedAccountId(null); return }
    const deviceAccounts = accounts.filter(a => a.device_id === selectedDeviceId)
    if (deviceAccounts.length === 0) {
      setSelectedAccountId(null)
    } else if (!deviceAccounts.find(a => a.id === selectedAccountId)) {
      setSelectedAccountId(deviceAccounts[0].id)
    }
  }, [selectedDeviceId, accounts])

  // Reset panel when day changes
  useEffect(() => {
    setVideoPath(null); setVideoUrl(null)
    setVideoContext(null)
    setCaption(''); setHashtags('')
    setMsg(null)
    setShowSchedule(false)
  }, [selected, month, year])

  const loadScheduled = async () => {
    if (!isElectron) return
    const data = await window.api.schedule.getAll()
    const byDay = {}
    for (const p of (data || [])) {
      const day = p.scheduled_at.split('T')[0]
      if (!byDay[day]) byDay[day] = []
      byDay[day].push(p)
    }
    setPostDays(byDay)
  }

  const dayKey = (d) => {
    if (!d) return null
    return `${year}-${String(month + 1).padStart(2,'0')}-${String(d).padStart(2,'0')}`
  }

  const selectedKey = dayKey(selected)
  const selectedPosts = selectedKey ? (postDays[selectedKey] || []) : []

  // Calendar nav
  const prev = () => { if (month === 0) { setMonth(11); setYear(y=>y-1) } else setMonth(m=>m-1) }
  const next = () => { if (month === 11) { setMonth(0); setYear(y=>y+1) } else setMonth(m=>m+1) }

  const firstDay    = new Date(year, month, 1).getDay()
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const cells = []
  for (let i = 0; i < firstDay; i++) cells.push(null)
  for (let d = 1; d <= daysInMonth; d++) cells.push(d)

  const isToday = (d) => d === today.getDate() && month === today.getMonth() && year === today.getFullYear()
  const isPast  = (d) => new Date(year, month, d) < new Date(today.getFullYear(), today.getMonth(), today.getDate())

  // Pick video file
  const handlePickVideo = async () => {
    if (!isElectron) return
    let audioDir
    try { audioDir = await window.api.getTempAudioDir() } catch(_) {}
    const path = await window.api.dialog.openFile({
      title: 'Оберіть відео файл',
      filters: [{ name: 'Video', extensions: ['mp4', 'mov', 'avi', 'mkv'] }],
    })
    if (!path) return
    setVideoPath(path)
    const filename = path.split(/[/\\]/).pop()
    setVideoUrl(`http://127.0.0.1:${PYTHON_PORT}/files/${filename}`)
    setVideoContext(null) // файл без контексту
    setMsg(null)
  }

  // Generate caption + hashtags via Claude CLI
  const handleGenerate = async () => {
    const claudeKey = settings?.claudeApi?.apiKey || ''
    setGenerating(true)
    setMsg(null)
    try {
      const result = await window.api.python.generateCaption({
        style: videoContext?.style || '',
        custom_text: '',
        claude_api_key: claudeKey,
        quote: videoContext?.quote || '',
        image_prompt: videoContext?.image_prompt || '',
        video_prompt: videoContext?.video_prompt || '',
      })
      if (result.ok) {
        setCaption(result.caption || '')
        setHashtags(result.hashtags || '')
      } else {
        setMsg({ type: 'err', text: result.error || 'Не вдалось згенерувати' })
      }
    } catch(e) {
      setMsg({ type: 'err', text: String(e) })
    }
    setGenerating(false)
  }

  // Publish now
  const handlePublish = async () => {
    if (!videoPath) return
    setPublishing(true); setMsg(null)
    try {
      const fullCaption = [caption, hashtags].filter(Boolean).join('\n\n')
      const expectedUsername = accounts.find(a => a.id === selectedAccountId)?.username || null
      const result = useAndroid
        ? await window.api.python.androidPost(videoPath, fullCaption, androidSerial || null, false, settings?.androidProxy || null, expectedUsername)
        : await window.api.python.publishReel(videoPath, fullCaption)
      if (result.ok) {
        setMsg({
          type: 'ok',
          text: useAndroid
            ? `✅ Опубліковано через Android${result.step ? ` (${result.step})` : ''}`
            : `✅ Опубліковано! ${result.url}`,
        })
        await loadScheduled()
      } else {
        setMsg({ type: 'err', text: `${result.error}${result.step ? ` [${result.step}]` : ''}` })
      }
    } catch(e) {
      setMsg({ type: 'err', text: String(e) })
    }
    setPublishing(false)
  }

  // Dry-run test через v2 (проходить весь flow, НЕ натискає Share)
  const handleDryRun = async () => {
    if (!videoPath) return
    setTesting(true); setMsg(null)
    try {
      const fullCaption = [caption, hashtags].filter(Boolean).join('\n\n')
      const expectedUsername = accounts.find(a => a.id === selectedAccountId)?.username || null
      const result = await window.api.python.androidPostV2(
        videoPath,
        fullCaption,
        androidSerial || null,
        true, // dry_run
        settings?.androidProxy || null,
        expectedUsername,
      )
      if (result.ok) {
        setMsg({
          type: 'ok',
          text: `🧪 Dry run OK · step=${result.step} · ${result.elapsed?.toFixed(1)}s${result.message ? ` · ${result.message}` : ''}`,
        })
      } else {
        setMsg({ type: 'err', text: `❌ [${result.step || '?'}] ${result.error}` })
      }
    } catch (e) {
      setMsg({ type: 'err', text: String(e) })
    }
    setTesting(false)
  }

  // Schedule
  const handleSchedule = async () => {
    if (!selectedKey) return
    // Validate по type
    if (contentType === 'reel' && !videoPath) { setMsg({ type: 'err', text: 'Немає відео' }); return }
    if ((contentType === 'post' || contentType === 'carousel') && !selectedGen) {
      setMsg({ type: 'err', text: 'Оберіть пост з Історії' }); return
    }
    setScheduling(true); setMsg(null)
    try {
      const when = `${selectedKey}T${scheduleTime}:00`
      const fullCaption = [caption, hashtags].filter(Boolean).join('\n\n')

      let videoPathArg = videoPath
      let imagePathsJson = ''
      if (contentType !== 'reel' && selectedGen) {
        videoPathArg = ''
        // Використовуємо edited paths (якщо user вилучив фото перед scheduling)
        if (editedImagePaths.length === 0) {
          setMsg({ type: 'err', text: 'Всі фото вилучено — додайте хоча б одне' })
          setScheduling(false)
          return
        }
        imagePathsJson = JSON.stringify(editedImagePaths)
      }

      await window.api.schedule.add(
        videoPathArg, fullCaption, when, selectedAccountId,
        scheduleDryRun, contentType, imagePathsJson,
      )
      setMsg({
        type: 'ok',
        text: scheduleDryRun
          ? `🧪 Тестовий ${contentType} заплановано на ${scheduleTime}`
          : `📅 ${contentType === 'carousel' ? 'Карусель' : contentType === 'post' ? 'Пост' : 'Reel'} заплановано на ${scheduleTime}`,
      })
      setShowSchedule(false)
      setScheduleDryRun(false)
      await loadScheduled()
    } catch(e) {
      setMsg({ type: 'err', text: String(e) })
    }
    setScheduling(false)
  }

  // Завантажує пости/каруселі з Історії (для picker)
  const loadGensForType = async (type) => {
    if (!isElectron) return
    const gens = await window.api.generations.getAll()
    const filtered = (gens || []).filter(g => g.content_type === type)
    setAllGens(filtered)
    setShowGenPicker(true)
  }

  // При виборі gen з picker — ініціалізуємо editedImagePaths зі slides
  const handlePickGen = (gen) => {
    setSelectedGen(gen)
    let slides = []
    try { slides = JSON.parse(gen.slides_json || '[]') } catch {}
    const paths = slides.length > 0
      ? slides.map(s => s.image_path).filter(Boolean)
      : [gen.image_path].filter(Boolean)
    setEditedImagePaths(paths)
    setShowGenPicker(false)
  }

  const removeImagePath = (idx) => {
    setEditedImagePaths(cur => cur.filter((_, i) => i !== idx))
  }

  const resetImagePaths = () => {
    if (!selectedGen) return
    let slides = []
    try { slides = JSON.parse(selectedGen.slides_json || '[]') } catch {}
    const paths = slides.length > 0
      ? slides.map(s => s.image_path).filter(Boolean)
      : [selectedGen.image_path].filter(Boolean)
    setEditedImagePaths(paths)
  }

  const handleDeletePost = async (id) => {
    await window.api.schedule.delete(id)
    await loadScheduled()
  }

  // ===== Edit modal для запланованих постів =====
  const openEditPost = (post) => {
    setEditPost(post)
    setEditVideoPath(post.video_path || '')
    setEditCaption(post.caption || '')
    const [datePart, timePart] = (post.scheduled_at || '').split('T')
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
    await handleDeletePost(editPost.id)
    closeEditPost()
  }

  const statusBadge = (s) => {
    if (s === 'pending')   return <span className="post-badge post-badge--pending">⏳ Заплановано</span>
    if (s === 'running')   return <span className="post-badge post-badge--running">🔄 Публікується</span>
    if (s === 'published') return <span className="post-badge post-badge--ok">✅ Опубліковано</span>
    if (s === 'failed')    return <span className="post-badge post-badge--err">❌ Помилка</span>
    return null
  }

  const pendingCount = Object.values(postDays).flat().filter(p => p.status === 'pending').length

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">📤 Постинг</h1>
        {pendingCount > 0 && (
          <div className="posting-badge-count">⏳ {pendingCount} заплановано</div>
        )}
      </div>

      <div className="posting-layout">
        {/* ===== КАЛЕНДАР ===== */}
        <div className="posting-cal">
          <div className="calendar-nav">
            <button className="cal-btn" onClick={prev}>◀</button>
            <h2 className="cal-month">{MONTHS[month]} {year}</h2>
            <button className="cal-btn" onClick={next}>▶</button>
          </div>

          <div className="calendar-grid">
            {DAYS.map(d => <div key={d} className="cal-day-label">{d}</div>)}
            {cells.map((d, i) => {
              const key = dayKey(d)
              const posts = key ? (postDays[key] || []) : []
              const hasPending   = posts.some(p => p.status === 'pending')
              const hasPublished = posts.some(p => p.status === 'published')
              const hasFailed    = posts.some(p => p.status === 'failed')
              return (
                <div
                  key={i}
                  className={[
                    'cal-cell',
                    d ? 'cal-cell--active' : '',
                    isToday(d) ? 'cal-cell--today' : '',
                    selected === d ? 'cal-cell--selected' : '',
                    d && isPast(d) && !isToday(d) ? 'cal-cell--past' : '',
                  ].join(' ')}
                  onClick={() => d && setSelected(d === selected ? null : d)}
                >
                  {d && <>
                    <span className="cal-date">{d}</span>
                    <div className="cal-dot-row">
                      {hasPending   && <div className="cal-dot" style={{ background: '#f0a500' }} />}
                      {hasPublished && <div className="cal-dot" style={{ background: '#22c55e' }} />}
                      {hasFailed    && <div className="cal-dot" style={{ background: '#e05252' }} />}
                    </div>
                  </>}
                </div>
              )
            })}
          </div>

          <div className="cal-legend">
            <div className="cal-dot" style={{ background: '#f0a500' }} /><span className="cal-legend-item">Заплановано</span>
            <div className="cal-dot" style={{ background: '#22c55e' }} /><span className="cal-legend-item">Опубліковано</span>
            <div className="cal-dot" style={{ background: '#e05252' }} /><span className="cal-legend-item">Помилка</span>
          </div>
        </div>

        {/* ===== ПАНЕЛЬ ДНЯ ===== */}
        <div className="posting-panel">
          {selected ? (
            <>
              <div className="posting-day-title">
                {selected} {MONTHS[month]} {year}
              </div>

              {/* Існуючі пости цього дня */}
              {selectedPosts.length > 0 && (
                <div className="posting-existing">
                  {selectedPosts.map(post => (
                    <div
                      key={post.id}
                      className="posting-post-item"
                      style={{ cursor: post.status === 'pending' ? 'pointer' : 'default' }}
                      onClick={() => post.status === 'pending' && openEditPost(post)}
                    >
                      <div className="posting-post-top">
                        {statusBadge(post.status)}
                        {post.is_dry_run ? <span style={{ fontSize: 11, color: '#f0a500', fontWeight: 600 }}>🧪 DRY</span> : null}
                        <span className="posting-post-time">
                          {new Date(post.scheduled_at).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' })}
                        </span>
                        {post.account_username && (
                          <span style={{ fontSize: 11, color: '#6366f1', fontWeight: 500 }}>@{post.account_username}</span>
                        )}
                        {post.status === 'pending' && (
                          <button
                            className="posting-del-btn"
                            onClick={(e) => { e.stopPropagation(); handleDeletePost(post.id) }}
                          >✕</button>
                        )}
                      </div>
                      <div className="posting-post-file">📹 {post.video_path.split(/[/\\]/).pop()}</div>
                      {post.caption && (
                        <div className="posting-post-caption">{post.caption.slice(0, 100)}{post.caption.length > 100 ? '…' : ''}</div>
                      )}
                      {post.instagram_url && (
                        <span
                          className="posting-post-link"
                          onClick={(e) => { e.stopPropagation(); isElectron && window.api.shell.openExternal(post.instagram_url) }}
                        >Відкрити в Instagram →</span>
                      )}
                      {post.error && <div className="posting-post-error">{post.error}</div>}
                      {post.status === 'pending' && (
                        <div style={{ fontSize: 11, color: '#3b82f6', marginTop: 4 }}>
                          ✏️ Натисни для редагування
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* Форма нового поста */}
              <div className="posting-form">
                <div className="posting-form-title">+ Новий пост</div>

                {/* Тип контенту */}
                <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
                  {[
                    { val: 'reel',     label: '🎬 Reel' },
                    { val: 'post',     label: '🖼️ Post' },
                    { val: 'carousel', label: '📚 Carousel' },
                  ].map(opt => (
                    <button
                      key={opt.val}
                      className={contentType === opt.val ? 'btn-primary' : 'btn-ghost'}
                      onClick={() => { setContentType(opt.val); setSelectedGen(null); setVideoPath(null); setVideoUrl(null) }}
                      style={{ flex: 1, fontSize: 12, padding: '6px 0' }}
                    >{opt.label}</button>
                  ))}
                </div>

                {/* Cascade: Device → Account */}
                <div style={{ marginBottom: 10 }}>
                  <label className="form-label" style={{ display: 'block', marginBottom: 4, fontSize: 12 }}>
                    📱 Пристрій
                  </label>
                  {allDevices.length === 0 ? (
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: 8, border: '1px dashed var(--border)', borderRadius: 6 }}>
                      Немає пристроїв. Додай у вкладці "Warmup" → Пристрої.
                    </div>
                  ) : (
                    <select
                      className="form-select"
                      value={selectedDeviceId || ''}
                      onChange={e => setSelectedDeviceId(e.target.value ? Number(e.target.value) : null)}
                      style={{ width: '100%' }}
                    >
                      <option value="">— оберіть пристрій —</option>
                      {allDevices.map(d => (
                        <option key={d.id} value={d.id}>
                          {d.name} ({d.serial}) {d.status !== 'active' ? `· ${d.status}` : ''}
                        </option>
                      ))}
                    </select>
                  )}
                </div>

                <div style={{ marginBottom: 10 }}>
                  <label className="form-label" style={{ display: 'block', marginBottom: 4, fontSize: 12 }}>
                    👤 Акаунт
                  </label>
                  {(() => {
                    const deviceAccounts = selectedDeviceId
                      ? accounts.filter(a => a.device_id === selectedDeviceId)
                      : []
                    if (!selectedDeviceId) {
                      return (
                        <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: 8, border: '1px dashed var(--border)', borderRadius: 6 }}>
                          Спочатку оберіть пристрій
                        </div>
                      )
                    }
                    if (deviceAccounts.length === 0) {
                      return (
                        <div style={{ fontSize: 12, color: '#f0a500', padding: 8, border: '1px dashed #f0a500', borderRadius: 6 }}>
                          На цьому пристрої немає привʼязаних акаунтів.<br />
                          Відкрий Warmup → обери пристрій → "🔎 Знайти і прив'язати всі акаунти".
                        </div>
                      )
                    }
                    return (
                      <select
                        className="form-select"
                        value={selectedAccountId || ''}
                        onChange={e => setSelectedAccountId(e.target.value ? Number(e.target.value) : null)}
                        style={{ width: '100%' }}
                      >
                        {deviceAccounts.map(a => (
                          <option key={a.id} value={a.id}>@{a.username}</option>
                        ))}
                      </select>
                    )
                  })()}
                </div>

                {/* Post/Carousel: вибір генерації з Історії */}
                {contentType !== 'reel' && !selectedGen && (
                  <div
                    className="posting-video-picker"
                    onClick={() => loadGensForType(contentType)}
                    style={{ marginBottom: 8, borderColor: '#6366f1' }}
                  >
                    <div className="pvp-icon">{contentType === 'carousel' ? '📚' : '🖼️'}</div>
                    <div className="pvp-name">{contentType === 'carousel' ? 'Обрати карусель з Історії' : 'Обрати пост з Історії'}</div>
                    <div className="pvp-sub">Згенеровані у вкладці "Пости / Карусель"</div>
                  </div>
                )}

                {/* Post/Carousel preview — з можливістю видаляти окремі фото */}
                {contentType !== 'reel' && selectedGen && (
                  <div style={{ marginBottom: 8, padding: 10, border: '1px solid var(--border)', borderRadius: 8 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                        {contentType === 'carousel' ? `📚 Карусель · ${editedImagePaths.length} слайдів` : '🖼️ Пост'} · {selectedGen.style}
                      </span>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button className="btn-ghost" onClick={resetImagePaths}
                          title="Повернути всі фото з оригінальної генерації"
                          style={{ fontSize: 10, padding: '2px 6px' }}>↺ Reset</button>
                        <button className="btn-ghost" onClick={() => { setSelectedGen(null); setEditedImagePaths([]) }}
                          style={{ fontSize: 10, padding: '2px 6px' }}>✕ Змінити</button>
                      </div>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(80px, 1fr))', gap: 6 }}>
                      {editedImagePaths.map((p, i) => (
                        <div key={i} style={{ position: 'relative' }}>
                          <img src={`http://127.0.0.1:${PYTHON_PORT}/files/${p.split(/[/\\]/).pop()}`}
                            alt="" style={{ width: '100%', aspectRatio: '1/1', objectFit: 'cover', borderRadius: 4 }} />
                          {/* Номер слайду */}
                          <div style={{
                            position: 'absolute', top: 2, left: 2,
                            background: 'rgba(0,0,0,0.7)', color: '#fff',
                            padding: '1px 5px', borderRadius: 3, fontSize: 10, fontWeight: 600,
                          }}>{i + 1}</div>
                          {/* Кнопка видалення */}
                          {(contentType === 'carousel' || editedImagePaths.length > 1) && (
                            <button
                              onClick={() => removeImagePath(i)}
                              title="Видалити це фото з публікації"
                              style={{
                                position: 'absolute', top: 2, right: 2,
                                width: 20, height: 20, borderRadius: '50%',
                                background: 'rgba(224,82,82,0.9)', color: '#fff',
                                border: 'none', cursor: 'pointer', fontSize: 12,
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                padding: 0,
                              }}
                            >✕</button>
                          )}
                        </div>
                      ))}
                    </div>
                    {editedImagePaths.length === 0 && (
                      <div style={{ fontSize: 11, color: '#e05252', marginTop: 6, textAlign: 'center' }}>
                        Всі фото вилучено. Натисніть "↺ Reset" щоб повернути.
                      </div>
                    )}
                  </div>
                )}

                {/* Gen picker для post/carousel */}
                {showGenPicker && (
                  <div style={{ background: 'var(--card-bg)', border: '1px solid var(--border)', borderRadius: 10, padding: 12, marginBottom: 8, maxHeight: 300, overflowY: 'auto' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                      <span style={{ fontWeight: 600, fontSize: 13 }}>
                        Оберіть {contentType === 'carousel' ? 'карусель' : 'пост'}:
                      </span>
                      <button className="btn-ghost" onClick={() => setShowGenPicker(false)}
                        style={{ fontSize: 11, padding: '2px 8px' }}>✕</button>
                    </div>
                    {allGens.length === 0 ? (
                      <div style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', padding: 20 }}>
                        Немає збережених {contentType === 'carousel' ? 'карусель' : 'постів'}.
                        Створи у вкладці "📸 Пости / Карусель".
                      </div>
                    ) : (
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(100px, 1fr))', gap: 8 }}>
                        {allGens.map(gen => (
                          <div key={gen.id} onClick={() => handlePickGen(gen)}
                            style={{ cursor: 'pointer', borderRadius: 8, overflow: 'hidden', border: '1px solid var(--border)' }}
                            onMouseEnter={e => e.currentTarget.style.borderColor = '#6366f1'}
                            onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--border)'}>
                            {gen.image_path ? (
                              <img src={`http://127.0.0.1:${PYTHON_PORT}/files/${gen.image_path.split(/[/\\]/).pop()}`}
                                alt="" style={{ width: '100%', aspectRatio: '1/1', objectFit: 'cover' }} />
                            ) : (
                              <div style={{ width: '100%', aspectRatio: '1/1', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)' }}>📄</div>
                            )}
                            <div style={{ padding: '4px 6px', fontSize: 10, color: 'var(--text-secondary)' }}>{gen.style}</div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* Відео: завантажити або вибрати з історії (тільки для Reel) */}
                {contentType === 'reel' && !videoPath && (
                  <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                    <div className="posting-video-picker" onClick={handlePickVideo} style={{ flex: 1 }}>
                      <div className="pvp-icon">⬆️</div>
                      <div className="pvp-name">Завантажити</div>
                      <div className="pvp-sub">mp4, mov, avi</div>
                    </div>
                    <div
                      className="posting-video-picker"
                      onClick={async () => {
                        if (!isElectron) return
                        const gens = await window.api.generations.getAll()
                        if (!gens || gens.length === 0) {
                          setMsg({ type: 'err', text: 'Немає збережених генерацій. Спочатку створіть відео в Генераторі і натисніть 💾 Зберегти.' })
                          return
                        }
                        // Show picker
                        setShowHistoryPicker(true)
                        setHistoryItems(gens)
                      }}
                      style={{ flex: 1, borderColor: '#6366f1' }}
                    >
                      <div className="pvp-icon">📁</div>
                      <div className="pvp-name">З Історії</div>
                      <div className="pvp-sub">Збережені генерації</div>
                    </div>
                  </div>
                )}

                {/* History picker (Reels only) */}
                {contentType === 'reel' && showHistoryPicker && (
                  <div style={{ background: 'var(--card-bg)', border: '1px solid var(--border)', borderRadius: 10, padding: 12, marginBottom: 8, maxHeight: 300, overflowY: 'auto' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                      <span style={{ fontWeight: 600, fontSize: 13 }}>Оберіть відео:</span>
                      <button className="btn-ghost" onClick={() => setShowHistoryPicker(false)} style={{ fontSize: 11, padding: '2px 8px' }}>✕</button>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(100px, 1fr))', gap: 8 }}>
                      {historyItems.map(gen => (
                        <div
                          key={gen.id}
                          onClick={() => {
                            const p = gen.final_path || gen.video_path
                            if (p) {
                              setVideoPath(p)
                              const fn = p.split(/[/\\]/).pop()
                              setVideoUrl(`http://127.0.0.1:${PYTHON_PORT}/files/${fn}`)
                              // Зберігаємо контекст для генерації релевантного підпису
                              setVideoContext({
                                quote: gen.quote || '',
                                style: gen.style || '',
                                image_prompt: gen.image_prompt || '',
                                video_prompt: gen.video_prompt || '',
                              })
                            }
                            setShowHistoryPicker(false)
                          }}
                          style={{ cursor: 'pointer', borderRadius: 8, overflow: 'hidden', border: '1px solid var(--border)', transition: 'border-color 0.15s' }}
                          onMouseEnter={e => e.currentTarget.style.borderColor = '#6366f1'}
                          onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--border)'}
                        >
                          {gen.image_path ? (
                            <img src={`http://127.0.0.1:${PYTHON_PORT}/files/${gen.image_path.split(/[/\\]/).pop()}`} alt="" style={{ width: '100%', height: 130, objectFit: 'cover' }} />
                          ) : (
                            <div style={{ width: '100%', height: 130, background: 'var(--bg)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>🎬</div>
                          )}
                          <div style={{ padding: '4px 6px', fontSize: 10, color: 'var(--text-secondary)' }}>{gen.style}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Video preview (тільки для Reel) */}
                {contentType === 'reel' && videoPath && (
                  <div style={{ marginBottom: 8 }}>
                    {videoUrl && (
                      <video src={videoUrl} controls loop style={{ width: '100%', maxHeight: 300, borderRadius: 10, background: '#000' }} />
                    )}
                    <button className="btn-ghost" onClick={() => { setVideoPath(null); setVideoUrl(null); setVideoContext(null) }} style={{ fontSize: 12, marginTop: 4 }}>
                      ✕ Змінити відео
                    </button>
                  </div>
                )}

                {/* Caption generation */}
                <div style={{ display: 'flex', gap: 8, marginBottom: 4 }}>
                  <button
                    className="btn-secondary"
                    onClick={handleGenerate}
                    disabled={generating}
                    style={{ flex: 1, fontSize: 13 }}
                  >
                    {generating ? '⏳ Генерую...' : '✨ Генерувати підпис'}
                  </button>
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 8 }}>
                  {videoContext ? (
                    <>
                      🎯 <span style={{ color: '#22c55e' }}>Релевантний підпис</span> — використає
                      {videoContext.quote && ' цитату'}
                      {videoContext.style && (videoContext.quote ? ',' : '') + ' стиль'}
                      {videoContext.image_prompt && ', опис кадру'}
                    </>
                  ) : (
                    <>💭 Загальний підпис (вибери відео з історії для релевантного)</>
                  )}
                </div>

                <textarea
                  className="form-textarea"
                  placeholder="Підпис до публікації..."
                  value={caption}
                  onChange={e => setCaption(e.target.value)}
                  rows={3}
                />

                <textarea
                  className="form-textarea"
                  placeholder="#хештеги #через #пробіл"
                  value={hashtags}
                  onChange={e => setHashtags(e.target.value)}
                  rows={2}
                  style={{ marginTop: 6 }}
                />

                {/* Android постинг перемикач */}
                <div style={{ marginTop: 10, padding: 10, border: '1px solid var(--border)', borderRadius: 8, background: 'var(--card-bg)' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13 }}>
                    <input
                      type="checkbox"
                      checked={useAndroid}
                      onChange={e => setUseAndroid(e.target.checked)}
                    />
                    <span>📱 Постити через Android (uiautomator2)</span>
                  </label>
                  {useAndroid && (
                    <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-secondary)' }}>
                      {androidDevices.length > 0 ? (
                        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                          <select
                            className="form-select"
                            value={androidSerial}
                            onChange={e => setAndroidSerial(e.target.value)}
                            style={{ flex: 1, fontSize: 12 }}
                          >
                            {androidDevices.map(s => <option key={s} value={s}>{s}</option>)}
                          </select>
                          <button className="btn-ghost" onClick={refreshAndroid} style={{ fontSize: 11, padding: '4px 8px' }}>🔄</button>
                          <button
                            className="btn-ghost"
                            title="Дзеркало екрану (scrcpy)"
                            onClick={async () => {
                              const r = await window.api.python.scrcpy(androidSerial || null)
                              if (!r.ok) setMsg({ type: 'err', text: r.error })
                            }}
                            style={{ fontSize: 14, padding: '4px 8px' }}
                          >📺</button>
                        </div>
                      ) : (
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <span>Пристроїв не знайдено. Підключи телефон по USB і увімкни debugging.</span>
                          <button className="btn-ghost" onClick={refreshAndroid} style={{ fontSize: 11, padding: '4px 8px' }}>🔄</button>
                        </div>
                      )}
                      {androidStatus?.ok && androidStatus.device && (
                        <div style={{ marginTop: 4, fontSize: 11 }}>
                          ✓ {androidStatus.device.brand} {androidStatus.device.model} · {androidStatus.device.screen}
                          {!androidStatus.instagram_installed && <span style={{ color: '#e05252' }}> · Instagram не встановлено</span>}
                        </div>
                      )}
                      {androidStatus && !androidStatus.ok && (
                        <div style={{ marginTop: 4, fontSize: 11, color: '#e05252' }}>✗ {androidStatus.error}</div>
                      )}

                      {/* Прогрів — скролінг Reels */}
                      <div style={{ marginTop: 8, borderTop: '1px solid var(--border)', paddingTop: 8 }}>
                        <button
                          className="btn-ghost"
                          onClick={() => { setShowWarmup(v => !v); setWarmupResult(null) }}
                          style={{ fontSize: 11, padding: '3px 8px', width: '100%', textAlign: 'left' }}
                        >
                          🔥 {showWarmup ? '▲ Сховати прогрів' : '▼ Прогрів акаунту (скролінг Reels)'}
                        </button>

                        {showWarmup && (
                          <div style={{ marginTop: 8, fontSize: 12 }}>
                            <div style={{ color: 'var(--text-muted)', marginBottom: 8, lineHeight: 1.4 }}>
                              Відкриє Instagram і буде скролити Reels як жива людина — випадкові паузи, перегляд, іноді лайк.
                            </div>

                            <div style={{ display: 'flex', gap: 10, marginBottom: 8, alignItems: 'center' }}>
                              <div style={{ flex: 1 }}>
                                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 3 }}>Тривалість (хв)</div>
                                <input
                                  type="number"
                                  className="form-input"
                                  value={warmupDuration}
                                  onChange={e => setWarmupDuration(Math.max(1, Math.min(60, Number(e.target.value))))}
                                  min={1} max={60}
                                  style={{ fontSize: 12, width: '100%' }}
                                />
                              </div>
                              <div style={{ flex: 1 }}>
                                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 3 }}>Лайки ({warmupLikeProb}%)</div>
                                <input
                                  type="range"
                                  min={0} max={50} step={5}
                                  value={warmupLikeProb}
                                  onChange={e => setWarmupLikeProb(Number(e.target.value))}
                                  style={{ width: '100%' }}
                                />
                              </div>
                            </div>

                            <button
                              className="btn-secondary"
                              onClick={handleWarmup}
                              disabled={warmupBusy || (!androidSerial && androidDevices.length === 0)}
                              style={{ width: '100%', fontSize: 12 }}
                            >
                              {warmupBusy
                                ? `⏳ Скролю... (~${warmupDuration} хв)`
                                : '▶ Запустити прогрів'}
                            </button>

                            {warmupResult && (
                              <div style={{
                                marginTop: 6, fontSize: 11, padding: '6px 8px', borderRadius: 6,
                                background: warmupResult.ok ? 'rgba(34,197,94,0.1)' : 'rgba(224,82,82,0.1)',
                                color: warmupResult.ok ? '#22c55e' : '#e05252',
                              }}>
                                {warmupResult.ok
                                  ? `✅ Переглянуто: ${warmupResult.reels_watched} рілсів · Лайків: ${warmupResult.likes_given} · Час: ${warmupResult.duration}с`
                                  : `❌ ${warmupResult.error}`}
                              </div>
                            )}
                          </div>
                        )}
                      </div>

                      {/* WiFi ADB */}
                      <div style={{ marginTop: 8, borderTop: '1px solid var(--border)', paddingTop: 8 }}>
                        <button
                          className="btn-ghost"
                          onClick={() => { setShowWifi(v => !v); setWifiMsg(null) }}
                          style={{ fontSize: 11, padding: '3px 8px', width: '100%', textAlign: 'left' }}
                        >
                          📶 {showWifi ? '▲ Сховати WiFi налаштування' : '▼ Підключити по WiFi (без кабеля)'}
                        </button>

                        {showWifi && (
                          <div style={{ marginTop: 8, fontSize: 12 }}>
                            {/* Метод-перемикач */}
                            <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
                              <button
                                onClick={() => { setWifiMethod('modern'); setWifiMsg(null) }}
                                style={{
                                  flex: 1, padding: '4px 0', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 11,
                                  background: wifiMethod === 'modern' ? '#6366f1' : 'var(--bg)',
                                  color: wifiMethod === 'modern' ? '#fff' : 'var(--text-secondary)',
                                }}
                              >
                                Android 11+ (код)
                              </button>
                              <button
                                onClick={() => { setWifiMethod('legacy'); setWifiMsg(null) }}
                                style={{
                                  flex: 1, padding: '4px 0', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 11,
                                  background: wifiMethod === 'legacy' ? '#6366f1' : 'var(--bg)',
                                  color: wifiMethod === 'legacy' ? '#fff' : 'var(--text-secondary)',
                                }}
                              >
                                Старіший (USB→WiFi)
                              </button>
                            </div>

                            {wifiMethod === 'modern' ? (
                              <>
                                <div style={{ color: 'var(--text-muted)', marginBottom: 6, lineHeight: 1.4 }}>
                                  📖 Телефон → Налаштування → Параметри розробника → Бездротове налагодження → «Сполучити пристрій з кодом»
                                </div>
                                <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                                  <input
                                    className="form-input"
                                    placeholder="IP:port (напр. 192.168.1.5:41234)"
                                    value={wifiPairHost}
                                    onChange={e => setWifiPairHost(e.target.value)}
                                    style={{ flex: 2, fontSize: 11 }}
                                  />
                                  <input
                                    className="form-input"
                                    placeholder="Код (123456)"
                                    value={wifiPairCode}
                                    onChange={e => setWifiPairCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                                    style={{ flex: 1, fontSize: 11 }}
                                    maxLength={6}
                                  />
                                  <button
                                    className="btn-secondary"
                                    onClick={handleWifiPair}
                                    disabled={wifiBusy || !wifiPairHost || wifiPairCode.length !== 6}
                                    style={{ fontSize: 11, padding: '4px 10px', whiteSpace: 'nowrap' }}
                                  >
                                    {wifiBusy ? '⏳' : '🔗 Сполучити'}
                                  </button>
                                </div>
                              </>
                            ) : (
                              <>
                                <div style={{ color: 'var(--text-muted)', marginBottom: 6, lineHeight: 1.4 }}>
                                  📖 Підключи телефон по USB, натисни кнопку нижче, потім відключи кабель і підключи по IP.
                                </div>
                                <button
                                  className="btn-secondary"
                                  onClick={handleWifiTcpip}
                                  disabled={wifiBusy}
                                  style={{ fontSize: 11, padding: '4px 10px', marginBottom: 6 }}
                                >
                                  {wifiBusy ? '⏳' : '📲 Увімкнути TCP-режим (USB)'}
                                </button>
                              </>
                            )}

                            {/* Підключення по IP (спільне для обох методів) */}
                            <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                              <input
                                className="form-input"
                                placeholder="IP телефону (192.168.1.50)"
                                value={wifiIp}
                                onChange={e => setWifiIp(e.target.value)}
                                style={{ flex: 1, fontSize: 11 }}
                              />
                              <button
                                className="btn-primary"
                                onClick={handleWifiConnect}
                                disabled={wifiBusy || !wifiIp}
                                style={{ fontSize: 11, padding: '4px 12px', whiteSpace: 'nowrap' }}
                              >
                                {wifiBusy ? '⏳' : '📡 Підключити'}
                              </button>
                            </div>

                            {/* Відключити WiFi пристрої */}
                            {androidDevices.filter(s => s.includes('.')).length > 0 && (
                              <div style={{ marginTop: 8 }}>
                                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>WiFi пристрої:</div>
                                {androidDevices.filter(s => s.includes('.')).map(s => (
                                  <div key={s} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                                    <span style={{ flex: 1, fontSize: 11, color: '#22c55e' }}>📡 {s}</span>
                                    <button
                                      className="btn-ghost"
                                      onClick={() => handleWifiDisconnect(s)}
                                      disabled={wifiBusy}
                                      style={{ fontSize: 10, padding: '2px 6px', color: '#e05252' }}
                                    >
                                      ✕ Відключити
                                    </button>
                                  </div>
                                ))}
                              </div>
                            )}

                            {wifiMsg && (
                              <div style={{
                                marginTop: 6, fontSize: 11, padding: '6px 8px', borderRadius: 6,
                                background: wifiMsg.type === 'ok' ? 'rgba(34,197,94,0.1)' : 'rgba(224,82,82,0.1)',
                                color: wifiMsg.type === 'ok' ? '#22c55e' : '#e05252',
                                lineHeight: 1.4,
                              }}>
                                {wifiMsg.text}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>

                {msg && (
                  <div className={`posting-msg posting-msg--${msg.type}`}>{msg.text}</div>
                )}

                {/* Час публікації */}
                {showSchedule && (
                  <div className="posting-time-row">
                    <label className="form-label">Час публікації</label>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <input
                        type="time"
                        className="form-input"
                        value={scheduleTime}
                        onChange={e => setScheduleTime(e.target.value)}
                        style={{ flex: 1 }}
                      />
                      <button
                        className="btn-primary"
                        onClick={handleSchedule}
                        disabled={scheduling || (contentType === 'reel' ? !videoPath : (!selectedGen || editedImagePaths.length === 0))}
                      >
                        {scheduling ? '⏳' : (scheduleDryRun ? '🧪 Зберегти' : '📅 Зберегти')}
                      </button>
                      <button className="btn-ghost" onClick={() => setShowSchedule(false)}>✕</button>
                    </div>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, fontSize: 12, cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={scheduleDryRun}
                        onChange={e => setScheduleDryRun(e.target.checked)}
                      />
                      <span>🧪 Тестовий режим (dry-run) — пройде весь flow без реального Share</span>
                    </label>
                  </div>
                )}

                <div className="posting-actions">
                  {contentType === 'reel' ? (
                    <>
                      <button
                        className="btn-primary posting-publish-btn"
                        onClick={handlePublish}
                        disabled={publishing || testing || !videoPath}
                        style={{ background: '#e1306c' }}
                      >
                        {publishing ? '⏳ Публікуємо...' : '🚀 Опублікувати зараз'}
                      </button>
                      {useAndroid && (
                        <button
                          className="btn-secondary"
                          onClick={handleDryRun}
                          disabled={publishing || testing || !videoPath}
                          title="Пройде весь flow (push → create → caption) але НЕ натисне Share. Безпечно для тестів."
                        >
                          {testing ? '⏳ Тестую...' : '🧪 Dry run (v2)'}
                        </button>
                      )}
                    </>
                  ) : (
                    <div style={{ flex: 1, padding: 10, background: 'rgba(240,165,0,0.1)',
                      color: '#f0a500', fontSize: 12, borderRadius: 6, textAlign: 'center' }}>
                      ⚠️ Публікація {contentType === 'carousel' ? 'карусель' : 'постів'} зараз тільки через планувальник (Android automation — Фаза 2).
                    </div>
                  )}
                  {!showSchedule && (
                    <button
                      className="btn-secondary"
                      onClick={() => setShowSchedule(true)}
                      disabled={contentType === 'reel' ? !videoPath : !selectedGen}
                    >
                      📅 Запланувати
                    </button>
                  )}
                </div>
              </div>
            </>
          ) : (
            <div className="cal-side-empty">
              <div className="cal-side-icon">📅</div>
              <div className="cal-side-text">Обери день</div>
              <div className="cal-side-sub">Клікни на дату щоб додати пост</div>
            </div>
          )}
        </div>
      </div>

      {/* ===== Edit Modal для запланованих постів ===== */}
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
            <div style={{ marginBottom: 12, fontSize: 12 }}>
              {statusBadge(editPost.status)}
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
    </div>
  )
}
