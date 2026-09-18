import { useState, useEffect, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import './Pages.css'

const isElectron = typeof window !== 'undefined' && !!window.api

const PYTHON_PORT = 8765

const IMAGE_PROVIDERS = [
  { value: 'flow', label: '🌊 Google Flow (автоматично)' },
  { value: 'google', label: '⭐ Google Gemini 2.0 (Imagen)' },
  { value: 'stability', label: 'Stability AI' },
  { value: 'openai', label: 'OpenAI DALL-E 3' },
  { value: 'replicate', label: 'Replicate (Flux)' },
]

const VIDEO_PROVIDERS = [
  { value: 'nhungoc_veo3', label: '🔥 VEO 3 (Nhungoc - безлімітний)' },
  { value: 'veo', label: '⭐ Google Veo 3 (AI Studio)' },
  { value: 'kling', label: 'Kling AI' },
  { value: 'runway', label: 'Runway ML' },
  { value: 'luma', label: 'Luma Dream Machine' },
]

// Степи: config → prompt → image → video → compose → done
const STEPS = ['config', 'prompt', 'image', 'video', 'compose', 'done']

// CSS-фільтри для live-прев'ю ефектів (наближають FFmpeg)
const EFFECT_FILTERS = {
  cinematic:  (s) => ({ filter:`contrast(${1+0.25*s}) saturate(${1+0.15*s}) brightness(${1-0.05*s})`,                 overlay:`linear-gradient(180deg, rgba(255,130,50,${0.08*s}) 0%, transparent 45%, rgba(20,10,0,${0.25*s}) 100%)` }),
  cold_steel: (s) => ({ filter:`contrast(${1+0.2*s}) saturate(${1-0.45*s}) brightness(${1-0.1*s}) hue-rotate(${-10*s}deg)`, overlay:`rgba(30,70,140,${0.15*s})` }),
  blood_ash:  (s) => ({ filter:`contrast(${1+0.25*s}) saturate(${1-0.4*s}) sepia(${0.3*s})`,                           overlay:`rgba(110,20,10,${0.18*s})` }),
  fog_ghost:  (s) => ({ filter:`contrast(${1-0.15*s}) brightness(${1+0.12*s}) saturate(${1-0.55*s}) blur(${0.7*s}px)`, overlay:`rgba(200,200,220,${0.12*s})` }),
  noir:       (s) => ({ filter:`grayscale(${s}) contrast(${1+0.4*s}) brightness(${1-0.05*s})`,                          overlay:`rgba(0,0,0,${0.12*s})` }),
}

const FONT_MAP = {
  'YuGothM.ttc': { family:'"Yu Gothic", "Yu Gothic UI", sans-serif', weight:500 },
  'YuGothB.ttc': { family:'"Yu Gothic", "Yu Gothic UI", sans-serif', weight:700 },
  'meiryo.ttc':  { family:'Meiryo, sans-serif',                      weight:400 },
  'msgothic.ttc':{ family:'"MS Gothic", monospace',                  weight:400 },
}

// Timeline у стилі відеоредактора — з draggable handles на обох кінцях + playhead
function TrimTimeline({ duration, fullDuration, trimStart, trimEnd, currentTime, onTrimChange, onSeek, color = 'orange', clipLabel = '' }) {
  // fullDuration — загальна шкала таймлайну (для синхронізації video+music по секундах).
  // Якщо задано, clip-бар займає `duration / fullDuration * 100%`, решта — empty tail.
  const trackRef = useRef(null)
  const [dragging, setDragging] = useState(null)
  const end = trimEnd || duration || 0
  const scale = fullDuration && fullDuration > duration ? fullDuration : (duration || 0)

  useEffect(() => {
    if (!dragging) return
    const onMove = (e) => {
      const rect = trackRef.current?.getBoundingClientRect()
      if (!rect || !scale) return
      const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width))
      const t = (x / rect.width) * scale
      // Обмежуємо межами реального clip (duration), не всієї шкали
      const clipEnd = duration || scale
      if (dragging === 'start')   onTrimChange(Math.min(Math.max(t, 0), end - 0.2), trimEnd)
      else if (dragging === 'end') onTrimChange(trimStart, Math.min(Math.max(t, trimStart + 0.2), clipEnd))
      else if (dragging === 'play' && onSeek) onSeek(Math.max(trimStart, Math.min(t, end)))
    }
    const onUp = () => setDragging(null)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
  }, [dragging, duration, scale, end, trimStart, trimEnd, onTrimChange, onSeek])

  const pct = (t) => scale > 0 ? (t / scale) * 100 : 0
  const accent = color === 'blue' ? '#3b82f6' : color === 'green' ? '#22c55e' : '#f97316'

  const trackClick = (e) => {
    if (!onSeek || !scale) return
    const rect = trackRef.current?.getBoundingClientRect()
    if (!rect) return
    const t = ((e.clientX - rect.left) / rect.width) * scale
    onSeek(Math.max(trimStart, Math.min(t, end)))
  }

  return (
    <div>
      <div style={{ display:'flex', justifyContent:'space-between', fontSize:10, color:'#888', marginBottom:4, fontFamily:'monospace' }}>
        <span style={{ color:accent }}>▶ {trimStart.toFixed(1)}s</span>
        <span style={{ color:'#666' }}>тривалість: {(end - trimStart).toFixed(1)}s</span>
        <span style={{ color:accent }}>⏹ {end.toFixed(1)}s</span>
      </div>
      <div ref={trackRef} onClick={trackClick}
        style={{ position:'relative', height:46, background:'#0a0a14', borderRadius:6,
          border:'1px solid #2a2a3a', overflow:'visible', cursor: onSeek ? 'pointer' : 'default', userSelect:'none' }}>
        {/* Темні зони поза trim */}
        <div style={{ position:'absolute', top:0, bottom:0, left:0, width:`${pct(trimStart)}%`,
          background:'rgba(0,0,0,0.75)', borderRadius:'6px 0 0 6px' }} />
        <div style={{ position:'absolute', top:0, bottom:0, right:0, width:`${100 - pct(end)}%`,
          background:'rgba(0,0,0,0.75)', borderRadius:'0 6px 6px 0' }} />
        {/* Активний регіон — обрізаний кліп */}
        <div style={{ position:'absolute', top:0, bottom:0,
          left:`${pct(trimStart)}%`, width:`${Math.max(0, pct(end) - pct(trimStart))}%`,
          background:`linear-gradient(180deg, ${accent}55, ${accent}20)`,
          borderTop:`2px solid ${accent}`, borderBottom:`2px solid ${accent}`,
          display:'flex', alignItems:'center', justifyContent:'center', overflow:'hidden' }}>
          <div style={{ position:'absolute', inset:0,
            backgroundImage:`repeating-linear-gradient(45deg, transparent 0 8px, ${accent}18 8px 10px)` }} />
          {clipLabel && (
            <span style={{ position:'relative', fontSize:11, color:'#fff', fontWeight:500,
              padding:'2px 8px', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis',
              textShadow:'0 1px 3px rgba(0,0,0,0.8)', pointerEvents:'none' }}>{clipLabel}</span>
          )}
        </div>
        {/* Playhead */}
        {currentTime !== undefined && currentTime !== null && duration > 0 && (
          <div onMouseDown={(e) => { e.stopPropagation(); setDragging('play') }}
            style={{ position:'absolute', top:-4, bottom:-4, left:`calc(${pct(currentTime)}% - 1px)`,
              width:2, background:'#fff', boxShadow:'0 0 6px rgba(255,255,255,0.9)',
              zIndex:4, cursor: onSeek ? 'ew-resize' : 'default' }}>
            <div style={{ position:'absolute', top:-5, left:-5, width:12, height:12,
              background:'#fff', borderRadius:'50%', boxShadow:'0 0 6px rgba(255,255,255,0.9)' }} />
          </div>
        )}
        {/* Start handle */}
        <div onMouseDown={(e) => { e.stopPropagation(); setDragging('start') }}
          style={{ position:'absolute', top:-2, bottom:-2, left:`calc(${pct(trimStart)}% - 7px)`,
            width:14, cursor:'ew-resize', background:accent, borderRadius:3,
            boxShadow:'inset 0 0 0 1px rgba(255,255,255,0.4), 0 2px 6px rgba(0,0,0,0.5)',
            zIndex:5, display:'flex', alignItems:'center', justifyContent:'center' }}>
          <div style={{ width:2, height:20, background:'rgba(255,255,255,0.8)', borderRadius:1,
            boxShadow:'3px 0 0 rgba(255,255,255,0.4), -3px 0 0 rgba(255,255,255,0.4)' }} />
        </div>
        {/* End handle */}
        <div onMouseDown={(e) => { e.stopPropagation(); setDragging('end') }}
          style={{ position:'absolute', top:-2, bottom:-2, left:`calc(${pct(end)}% - 7px)`,
            width:14, cursor:'ew-resize', background:accent, borderRadius:3,
            boxShadow:'inset 0 0 0 1px rgba(255,255,255,0.4), 0 2px 6px rgba(0,0,0,0.5)',
            zIndex:5, display:'flex', alignItems:'center', justifyContent:'center' }}>
          <div style={{ width:2, height:20, background:'rgba(255,255,255,0.8)', borderRadius:1,
            boxShadow:'3px 0 0 rgba(255,255,255,0.4), -3px 0 0 rgba(255,255,255,0.4)' }} />
        </div>
      </div>
    </div>
  )
}

export default function VideoGenerator({ editorMode = false } = {}) {
  const location = useLocation()
  const navigate = useNavigate()
  const [editingId, setEditingId] = useState(null)
  const [step, setStep] = useState('config')

  // Форма
  const [style, setStyle] = useState('Hokan')
  const [quote, setQuote] = useState('Той, хто перемагає себе — сильніший за того, хто завойовує міста.')
  const [prompt, setPrompt] = useState('')
  const [logoPath, setLogoPath] = useState('')
  const [imageProvider, setImageProvider] = useState('flow')
  const [videoProvider, setVideoProvider] = useState('kling')

  // Стилі
  const [styles, setStyles] = useState([])

  // Результати
  const [imagePath, setImagePath] = useState(null)
  const [imageUrl, setImageUrl] = useState(null)
  const [videoPath, setVideoPath] = useState(null)
  const [videoUrl, setVideoUrl] = useState(null)
  const [claudeVideoPrompt, setClaudeVideoPrompt] = useState('')
  const [claudeVideoPromptText, setClaudeVideoPromptText] = useState('') // assembled text for generator
  const [generatedImagePrompt, setGeneratedImagePrompt] = useState('')   // JSON for UI display
  const [generatedImagePromptText, setGeneratedImagePromptText] = useState('') // assembled text for generator
  const [generatedQuote, setGeneratedQuote] = useState('')
  const [slowMotion, setSlowMotion] = useState(false)
  const [slowMotionMode, setSlowMotionMode] = useState('blend') // blend | rife | mci
  const [slowMotionFactor, setSlowMotionFactor] = useState(0.7) // 0.3-1.0, менше = повільніше
  const [finalPath, setFinalPath] = useState(null)
  const [finalUrl, setFinalUrl] = useState(null)

  // Compose editor
  const [overlayOpacity, setOverlayOpacity] = useState(0.3)
  const [trimStart, setTrimStart] = useState(0)
  const [trimEnd, setTrimEnd] = useState(0)
  const [videoDuration, setVideoDuration] = useState(0)
  const composeVideoRef = useRef(null)
  const composeAudioRef = useRef(null)
  // Music
  const [musicPath, setMusicPath] = useState('')
  const [musicDuration, setMusicDuration] = useState(0)
  const [musicTrimStart, setMusicTrimStart] = useState(0)
  const [musicTrimEnd, setMusicTrimEnd] = useState(0)
  const [musicVolume, setMusicVolume] = useState(0.8)
  const musicRef = useRef(null)
  // Playback tracking
  const [videoCurrentTime, setVideoCurrentTime] = useState(0)
  const [musicCurrentTime, setMusicCurrentTime] = useState(0)
  // Effects
  const [videoEffect, setVideoEffect] = useState('')
  const [effectStrength, setEffectStrength] = useState(1.0)
  // Text
  const [textSize, setTextSize] = useState(100)
  const [textWeight, setTextWeight] = useState(500)
  const [textPosition, setTextPosition] = useState(75)
  const [textFont, setTextFont] = useState('YuGothM.ttc')

  // Стани
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [settings, setSettings] = useState(null)

  // Публікація
  const [publishCaption, setPublishCaption] = useState('')
  const [publishing, setPublishing] = useState(false)
  const [publishResult, setPublishResult] = useState(null) // { ok, url, error }
  const [scheduleMode, setScheduleMode] = useState(false)
  const [scheduleDate, setScheduleDate] = useState('')
  const [scheduleTime, setScheduleTime] = useState('')
  const [scheduling, setScheduling] = useState(false)
  const [scheduleResult, setScheduleResult] = useState(null)

  useEffect(() => {
    if (isElectron) {
      window.api.settings.get().then(s => {
        if (!s) return
        setSettings(s)
        if (s.videoApi?.provider) setVideoProvider(s.videoApi.provider)
        if (s.logoPath) setLogoPath(s.logoPath)
      })
      window.api.python.getPrompts().then(data => {
        if (data?.styles) {
          setStyles(Object.keys(data.styles))
        }
      })
    }
  }, [])

  // Завантажуємо генерацію для редагування з History
  useEffect(() => {
    const gen = location.state?.editGen
    if (!gen) return

    const fileUrl = (p) => {
      if (!p) return null
      const name = p.split(/[/\\]/).pop()
      return `http://127.0.0.1:${PYTHON_PORT}/files/${name}`
    }

    setEditingId(gen.id)
    if (gen.style) setStyle(gen.style)
    if (gen.quote) setQuote(gen.quote)
    if (gen.image_prompt) {
      setPrompt(gen.image_prompt)
      setGeneratedImagePrompt(gen.image_prompt)
    }
    if (gen.video_prompt) {
      setClaudeVideoPrompt(gen.video_prompt)
      setClaudeVideoPromptText(gen.video_prompt)
    }
    if (gen.quote) setGeneratedQuote(gen.quote)
    if (gen.image_provider) setImageProvider(gen.image_provider)
    if (gen.video_provider) setVideoProvider(gen.video_provider)
    if (gen.image_path) { setImagePath(gen.image_path); setImageUrl(fileUrl(gen.image_path)) }
    if (gen.video_path) { setVideoPath(gen.video_path); setVideoUrl(fileUrl(gen.video_path)) }
    if (gen.final_path) { setFinalPath(gen.final_path); setFinalUrl(fileUrl(gen.final_path)) }
    if (gen.music_path) setMusicPath(gen.music_path)
    if (gen.logo_path) setLogoPath(gen.logo_path)
    if (gen.caption) setPublishCaption(gen.caption)

    // Розпаковуємо compose_params (налаштування таймлайну/ефектів/тексту)
    if (gen.compose_params) {
      try {
        const cp = typeof gen.compose_params === 'string' ? JSON.parse(gen.compose_params) : gen.compose_params
        if (cp.slow_motion !== undefined) setSlowMotion(!!cp.slow_motion)
        if (cp.slow_motion_mode) setSlowMotionMode(cp.slow_motion_mode)
        if (cp.slow_motion_factor !== undefined) setSlowMotionFactor(Number(cp.slow_motion_factor))
        if (cp.overlay_opacity !== undefined) setOverlayOpacity(Number(cp.overlay_opacity))
        if (cp.trim_start !== undefined) setTrimStart(Number(cp.trim_start))
        if (cp.trim_end !== undefined) setTrimEnd(Number(cp.trim_end))
        if (cp.video_effect !== undefined) setVideoEffect(cp.video_effect || '')
        if (cp.effect_strength !== undefined) setEffectStrength(Number(cp.effect_strength))
        if (cp.music_trim_start !== undefined) setMusicTrimStart(Number(cp.music_trim_start))
        if (cp.music_trim_end !== undefined) setMusicTrimEnd(Number(cp.music_trim_end))
        if (cp.music_volume !== undefined) setMusicVolume(Number(cp.music_volume))
        if (cp.text_size !== undefined) setTextSize(Number(cp.text_size))
        if (cp.text_weight !== undefined) setTextWeight(Number(cp.text_weight))
        if (cp.text_position !== undefined) setTextPosition(Number(cp.text_position))
        if (cp.text_font !== undefined) setTextFont(cp.text_font || 'YuGothM.ttc')
      } catch (e) {
        console.error('compose_params parse error', e)
      }
    }

    // Переходимо одразу на крок compose (таймлайн і решта)
    setStep('compose')

    // Очищаємо state, щоб при F5 не повторно завантажувало
    navigate(location.pathname, { replace: true, state: {} })
  }, [])

  // Refs для динамічних значень — щоб не перезапускати sync-effect при кожній зміні trim
  const musicTrimStartRef = useRef(0)
  const trimStartRef = useRef(0)
  useEffect(() => { musicTrimStartRef.current = musicTrimStart }, [musicTrimStart])
  useEffect(() => { trimStartRef.current = trimStart }, [trimStart])

  // Live-preview slow motion через HTML5 playbackRate (застосовується у compose preview).
  // rate = 1.0 коли slowMotion вимкнений — навіть якщо user мав повзунок на 0.5.
  useEffect(() => {
    const vid = composeVideoRef.current
    if (!vid) return
    const rate = slowMotion ? slowMotionFactor : 1.0
    try { vid.playbackRate = rate } catch {}
    // Також ставимо коли метадані завантажились (video тільки-що замінилось)
    const onLoad = () => { try { vid.playbackRate = rate } catch {} }
    vid.addEventListener('loadedmetadata', onLoad)
    return () => vid.removeEventListener('loadedmetadata', onLoad)
  }, [slowMotion, slowMotionFactor, videoUrl, step])

  // Sync музика ↔ відео для preview у compose-режимі
  useEffect(() => {
    if (step !== 'compose' || !musicPath) return
    const video = composeVideoRef.current
    const audio = musicRef.current
    if (!video || !audio) return

    let cancelled = false
    let playPromise = null

    // Безпечне play — чекаємо завершення попереднього play promise перед новим викликом
    const safePlay = async () => {
      if (cancelled || video.paused || audio.readyState < 2) return
      // Не викликати play якщо вже грає
      if (!audio.paused && !audio.ended) return
      try {
        audio.currentTime = musicTrimStartRef.current
        playPromise = audio.play()
        await playPromise
      } catch (err) {
        if (err.name !== 'AbortError') console.warn('[music] play failed:', err.message)
      } finally {
        playPromise = null
      }
    }

    // Безпечне pause — чекаємо завершення pending play promise перед pause
    const safePause = async () => {
      if (playPromise) {
        try { await playPromise } catch {}
      }
      audio.pause()
    }

    const onVideoPlay = () => safePlay()
    const onVideoPause = () => safePause()
    const onVideoSeeked = () => {
      // Loop-back: коли відео скакнуло близько до trimStart — перезапустити audio
      const near = Math.abs(video.currentTime - (trimStartRef.current || 0)) < 0.3
      if (near && !video.paused) {
        // Тільки переміщуємо позицію, не викликаємо повторне play якщо audio вже грає
        if (audio.paused || audio.ended) {
          safePlay()
        } else {
          audio.currentTime = musicTrimStartRef.current
        }
      }
    }
    const onAudioCanPlay = () => safePlay()

    video.addEventListener('play', onVideoPlay)
    video.addEventListener('pause', onVideoPause)
    video.addEventListener('seeked', onVideoSeeked)
    audio.addEventListener('canplay', onAudioCanPlay)
    // Initial attempt
    safePlay()

    return () => {
      cancelled = true
      video.removeEventListener('play', onVideoPlay)
      video.removeEventListener('pause', onVideoPause)
      video.removeEventListener('seeked', onVideoSeeked)
      audio.removeEventListener('canplay', onAudioCanPlay)
      safePause()
    }
  }, [step, musicPath])

  // Гучність
  useEffect(() => {
    if (musicRef.current) musicRef.current.volume = musicVolume
  }, [musicVolume])

  // Крок 0.5 → Генерація промпту
  const handleGeneratePrompt = async () => {
    setError('')
    setLoading(true)
    setStep('prompt')

    try {
      const promptResult = await window.api.python.generatePrompt({
        style: style || 'Hokan',
      })
      if (!promptResult?.ok || !promptResult?.prompt) {
        setError(promptResult?.error || 'Не вдалось згенерувати промпт')
        setStep('config')
        setLoading(false)
        return
      }
      // Розбиваємо на 2 поля: image_prompt → поле картинки, video_prompt → поле відео
      setGeneratedImagePrompt(promptResult.prompt)
      setGeneratedImagePromptText(promptResult.prompt_text || '')
      setClaudeVideoPrompt(promptResult.video_prompt || '')
      setClaudeVideoPromptText(promptResult.video_prompt_text || '')
      setGeneratedQuote(promptResult.quote || '')
    } catch (e) {
      setError(String(e))
      setStep('config')
    }
    setLoading(false)
  }

  // Крок 1 → Генерація зображення
  const handleGenerateImage = async () => {
    setError('')
    setLoading(true)
    setStep('image')
    setImagePath(null)
    setImageUrl(null)

    try {
      // Google Flow — окремий шлях
      if (imageProvider === 'flow') {
        let flowPrompt = generatedImagePrompt || generatedImagePromptText
        if (!flowPrompt) {
          setError('Спочатку згенеруйте промпт')
          setStep('prompt')
          setLoading(false)
          return
        }
        const result = await window.api.python.generateFlow({
          prompt: flowPrompt,
          cookies: '',
          project_url: settings?.googleFlow?.projectUrl || '',
        })
        if (result.ok) {
          const filename = result.filename
          setImagePath(result.path)
          setImageUrl(`http://127.0.0.1:${PYTHON_PORT}/files/${filename}`)
        } else {
          setError(result.error || 'Помилка Google Flow')
          setStep('config')
        }
        setLoading(false)
        return
      }

      const apiKey = settings?.imageApi?.apiKey
      if (!apiKey) {
        setError('API ключ для зображень не вказано в Налаштуваннях')
        setLoading(false)
        return
      }

      const claudeKey = settings?.claudeApi?.apiKey || ''
      const geminiKey = settings?.imageApi?.provider === 'google' ? (settings?.imageApi?.apiKey || '') : ''
      const result = await window.api.python.generateImage({
        prompt: generatedImagePromptText || generatedImagePrompt || prompt,
        style,
        provider: imageProvider,
        api_key: apiKey,
        variant_index: -1,
        claude_api_key: claudeKey,
        gemini_api_key: geminiKey,
      })

      if (result.ok) {
        const filename = result.path.split(/[/\\]/).pop()
        setImagePath(result.path)
        setImageUrl(`http://127.0.0.1:${PYTHON_PORT}/files/${filename}`)
      } else {
        setError(result.error || 'Помилка генерації зображення')
        setStep('config')
      }
    } catch (e) {
      setError(String(e))
      setStep('config')
    }
    setLoading(false)
  }

  // Крок 2 → Генерація відео
  const handleGenerateVideo = async () => {
    setError('')
    setLoading(true)
    setStep('video')
    setVideoPath(null)
    setVideoUrl(null)

    try {
      const apiKey = settings?.videoApi?.apiKey
      if (videoProvider !== 'nhungoc_veo3' && !apiKey) {
        setError('API ключ для відео не вказано в Налаштуваннях')
        setLoading(false)
        return
      }

      const videoPrompt = claudeVideoPrompt || claudeVideoPromptText
        || `A continuous single unbroken shot with constant unchanging dim overcast lighting throughout the entire video. The camera slowly pushes in toward the warrior. Rain falls at steady pace. The warrior slowly turns his head toward camera. No flashes no bright light no fire no god rays at any point. Same flat grey light from start to finish.`

      const result = await window.api.python.generateVideo({
        image_path: imagePath,
        prompt: videoPrompt,
        provider: videoProvider,
        api_key: apiKey || '',
      })

      if (result.ok) {
        const filename = result.path.split(/[/\\]/).pop()
        setVideoPath(result.path)
        setVideoUrl(`http://127.0.0.1:${PYTHON_PORT}/files/${filename}`)
      } else {
        setError(result.error || 'Помилка генерації відео')
        setStep('video')
      }
    } catch (e) {
      setError(String(e))
      setStep('video')
    }
    setLoading(false)
  }

  // Крок 3 → Compose
  const handleCompose = () => {
    // Відкриваємо compose editor (без запуску FFmpeg)
    setError('')
    setStep('compose')
  }

  const handleRenderFinal = async () => {
    setError('')
    setLoading(true)

    try {
      const result = await window.api.python.generateCompose({
        video_path: videoPath,
        quote: generatedQuote || quote,
        music_path: musicPath || null,
        logo_path: logoPath || null,
        slow_motion: slowMotion,
        slow_motion_mode: slowMotionMode,
        slow_motion_factor: slowMotionFactor,
        overlay_opacity: overlayOpacity,
        trim_start: trimStart,
        trim_end: trimEnd > 0.5 ? trimEnd : 0,
        video_effect: videoEffect,
        effect_strength: effectStrength,
        music_trim_start: musicTrimStart,
        music_trim_end: musicTrimEnd > 0.5 ? musicTrimEnd : 0,
        text_size: textSize,
        text_weight: textWeight,
        text_position: textPosition,
        text_font: textFont,
      })

      if (result.ok) {
        const filename = result.path.split(/[/\\]/).pop()
        setFinalPath(result.path)
        setFinalUrl(`http://127.0.0.1:${PYTHON_PORT}/files/${filename}`)
        setStep('done')
      } else {
        setError(result.error || 'Помилка compose')
      }
    } catch (e) {
      setError(String(e))
    }
    setLoading(false)
  }

  const handlePickMusic = async () => {
    if (!isElectron) return
    const path = await window.api.dialog.openFile({
      title: 'Оберіть музичний файл',
      filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'aac', 'm4a'] }],
    })
    if (!path) return
    setMusicPath(path)
    setMusicTrimStart(0)
    setMusicTrimEnd(0)
    setMusicCurrentTime(0)
  }

  const handleReset = () => {
    setEditingId(null)
    setStep('config')
    setImagePath(null); setImageUrl(null)
    setVideoPath(null); setVideoUrl(null)
    setFinalPath(null); setFinalUrl(null)
    setError('')
    setPublishResult(null); setScheduleResult(null)
    setPublishCaption(''); setScheduleMode(false)
    setMusicPath(''); setMusicDuration(0); setMusicTrimStart(0); setMusicTrimEnd(0); setMusicCurrentTime(0); setMusicVolume(0.8)
    setVideoEffect(''); setEffectStrength(1.0)
    setTextSize(100); setTextWeight(500); setTextPosition(75); setTextFont('YuGothM.ttc')
    setTrimStart(0); setTrimEnd(0); setVideoDuration(0); setVideoCurrentTime(0)
  }

  const handlePublishNow = async () => {
    if (!finalPath) return
    setPublishing(true)
    setPublishResult(null)
    try {
      const result = await window.api.python.publishReel(finalPath, publishCaption)
      setPublishResult(result)
    } catch (e) {
      setPublishResult({ ok: false, error: String(e) })
    }
    setPublishing(false)
  }

  const handleSchedule = async () => {
    if (!finalPath || !scheduleDate || !scheduleTime) return
    setScheduling(true)
    setScheduleResult(null)
    try {
      const when = `${scheduleDate}T${scheduleTime}:00`
      await window.api.schedule.add(finalPath, publishCaption, when)
      setScheduleResult({ ok: true, when })
      setScheduleMode(false)
    } catch (e) {
      setScheduleResult({ ok: false, error: String(e) })
    }
    setScheduling(false)
  }

  // Встановлюємо дефолтний час планування (+1 година)
  const openScheduleMode = () => {
    const now = new Date(Date.now() + 60 * 60 * 1000)
    setScheduleDate(now.toISOString().split('T')[0])
    setScheduleTime(now.toTimeString().slice(0, 5))
    setScheduleMode(true)
  }

  const handleOpenFile = () => {
    if (finalPath && isElectron) window.api.shell.openExternal(`file://${finalPath}`)
  }

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">
          {editorMode ? '✂️ Редактор' : '⚡ Генератор відео'}
          {editingId && (
            <span style={{ fontSize: 13, marginLeft: 12, padding: '4px 10px', borderRadius: 6, background: 'rgba(59,130,246,0.15)', color: '#3b82f6', fontWeight: 500, verticalAlign: 'middle' }}>
              ✏️ Редагування #{editingId}
            </span>
          )}
        </h1>
        {!editorMode && step !== 'config' && (
          <button className="btn-ghost" onClick={handleReset}>← Спочатку</button>
        )}
      </div>

      {/* Степер — ховаємо у режимі редактора */}
      {!editorMode && <div className="stepper">
        {[
          { key: 'config', label: '1. Налаштування' },
          { key: 'prompt', label: '2. Промт' },
          { key: 'image', label: '3. Зображення' },
          { key: 'video', label: '4. Відео' },
          { key: 'compose', label: '5. Фінал' },
        ].map((s, i) => {
          const currentIdx = STEPS.indexOf(step)
          const stepIdx = STEPS.indexOf(s.key)
          const isDone = currentIdx > stepIdx
          const isActive = s.key === step || (step === 'done' && s.key === 'compose')
          return (
            <div key={s.key} className={`stepper-item ${isActive ? 'stepper-item--active' : ''} ${isDone ? 'stepper-item--done' : ''}`}>
              <div className="stepper-dot">{isDone ? '✓' : i + 1}</div>
              <span>{s.label}</span>
            </div>
          )
        })}
      </div>}

      {error && (
        <div className="gen-error">❌ {error}</div>
      )}

      {/* ===== КРОК 1: Конфіг ===== */}
      {step === 'config' && (
        <div className="gen-config">
          <div className="gen-form">

            <div className="form-section">
              <label className="form-label">Стиль</label>
              <div className="style-chips">
                {(styles.length > 0 ? styles : ['Hokan']).map(s => (
                  <button
                    key={s}
                    className={`style-chip ${style === s ? 'style-chip--active' : ''}`}
                    onClick={() => setStyle(s)}
                  >{s}</button>
                ))}
              </div>
            </div>

            <div style={{ display: 'flex', gap: 12 }}>
              <div className="form-section" style={{ flex: 1 }}>
                <label className="form-label">Image API</label>
                <select className="form-select" value={imageProvider} onChange={e => setImageProvider(e.target.value)}>
                  {IMAGE_PROVIDERS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
                </select>
              </div>
              <div className="form-section" style={{ flex: 1 }}>
                <label className="form-label">Video API</label>
                <select className="form-select" value={videoProvider} onChange={e => setVideoProvider(e.target.value)}>
                  {VIDEO_PROVIDERS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
                </select>
              </div>
            </div>

          </div>

          <div className="gen-or-row">
            <button className="btn-generate" onClick={handleGeneratePrompt}>
              🧠 Згенерувати промпт
            </button>
          </div>
        </div>
      )}

      {/* ===== КРОК 1.5: Перегляд промптів ===== */}
      {step === 'prompt' && (
        <div className="gen-result">
          {loading ? (
            <div className="preview-loading">
              <div className="spinner" />
              <div>Генерація промпту (Claude CLI)...</div>
              <div className="preview-sub">10-30 секунд</div>
            </div>
          ) : (
            <>
              <div className="form-section" style={{ width: '100%', maxWidth: 900 }}>
                <label className="form-label">📸 Промпт для картинки (Nano Banana Pro JSON)</label>
                <textarea
                  className="form-textarea"
                  value={generatedImagePrompt}
                  onChange={e => {
                    setGeneratedImagePrompt(e.target.value)
                    setGeneratedImagePromptText(e.target.value)
                  }}
                  rows={12}
                  style={{ fontFamily: 'monospace', fontSize: 12, width: '100%' }}
                />
              </div>
              <div className="form-section" style={{ width: '100%', maxWidth: 900 }}>
                <label className="form-label">🎬 Промпт для відео</label>
                <textarea
                  className="form-textarea"
                  value={claudeVideoPrompt}
                  onChange={e => setClaudeVideoPrompt(e.target.value)}
                  rows={8}
                  style={{ fontFamily: 'monospace', fontSize: 13, width: '100%' }}
                />
              </div>
              <div className="form-section" style={{ width: '100%', maxWidth: 900 }}>
                <label className="form-label">💬 Цитата для відео</label>
                <input
                  className="form-input"
                  value={generatedQuote}
                  onChange={e => setGeneratedQuote(e.target.value)}
                  placeholder="Цитата згенерується автоматично..."
                  style={{ fontFamily: 'Georgia, serif', fontSize: 15, width: '100%' }}
                />
              </div>
              <div className="gen-actions">
                <button className="btn-secondary" onClick={handleGeneratePrompt}>
                  🔄 Перегенерувати промпт
                </button>
                <button className="btn-generate" onClick={handleGenerateImage}>
                  🖼 Генерувати картинку
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* ===== КРОК 2: Перегляд зображення ===== */}
      {step === 'image' && (
        <div className="gen-result">
          <div className="gen-preview-box">
            {loading ? (
              <div className="preview-loading">
                <div className="spinner" />
                <div>Генерація зображення...</div>
                <div className="preview-sub">Зазвичай 10-30 секунд</div>
              </div>
            ) : imageUrl ? (
              <img src={imageUrl} alt="Generated" style={{ width: '100%', height: '100%', objectFit: 'contain', borderRadius: 12 }} />
            ) : null}
          </div>

          {!loading && imageUrl && (
            <div className="gen-actions">
              <button className="btn-secondary" onClick={handleGenerateImage}>
                🔄 Перегенерувати
              </button>
              <button className="btn-primary" onClick={handleGenerateVideo}>
                🎬 Анімувати відео →
              </button>
            </div>
          )}
          {!loading && imageUrl && (
            <div className="gen-hint">Не подобається? Натисни "Перегенерувати" — буде обрано інший варіант промпту</div>
          )}
        </div>
      )}

      {/* ===== КРОК 3: Генерація відео ===== */}
      {step === 'video' && (
        <div className="gen-result">
          <div className="gen-preview-box">
            {loading ? (
              <div className="preview-loading">
                {imageUrl && (
                  <img src={imageUrl} alt="" style={{
                    position: 'absolute', inset: 0, width: '100%', height: '100%',
                    objectFit: 'cover', borderRadius: 12, opacity: 0.4,
                  }} />
                )}
                <div className="spinner" style={{ position: 'relative', zIndex: 1 }} />
                <div style={{ position: 'relative', zIndex: 1 }}>Генерація відео...</div>
                <div className="preview-sub" style={{ position: 'relative', zIndex: 1 }}>1-3 хвилини залежно від сервісу</div>
              </div>
            ) : videoUrl ? (
              <video src={videoUrl} autoPlay loop controls style={{ width: '100%', height: '100%', objectFit: 'contain', borderRadius: 12 }} />
            ) : null}
          </div>

          {!loading && videoUrl && (
            <div className="gen-actions" style={{ flexDirection: 'column', gap: 12 }}>
              <div style={{ display:'flex', flexDirection:'column', gap:6, padding:10, border:'1px solid var(--border)', borderRadius:8 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13 }}>
                  <input type="checkbox" checked={slowMotion} onChange={e => setSlowMotion(e.target.checked)} />
                  🎬 Slow Motion
                </label>
                {slowMotion && (
                  <label style={{ display:'flex', alignItems:'center', gap:8, fontSize:12, padding:'4px 0' }}>
                    <span style={{ minWidth:80 }}>Швидкість: <b style={{ color:'#6366f1' }}>{slowMotionFactor.toFixed(2)}x</b></span>
                    <input type="range" min="0.3" max="1.0" step="0.05" value={slowMotionFactor}
                      onChange={e => setSlowMotionFactor(parseFloat(e.target.value))}
                      style={{ flex:1 }}
                    />
                    <span style={{ fontSize:10, color:'var(--text-muted)', minWidth:70, textAlign:'right' }}>
                      {slowMotionFactor < 1 ? `${(1/slowMotionFactor).toFixed(2)}× повільніше` : 'норма'}
                    </span>
                  </label>
                )}
                {slowMotion && (
                  <div style={{ display:'flex', gap:6, fontSize:11 }}>
                    {[
                      { val:'blend', label:'⚡ Швидкий', tip:'~20с, CPU-light (blend)' },
                      { val:'rife',  label:'🤖 AI (CapCut)', tip:'~60-120с, RIFE AI (GPU)' },
                      { val:'mci',   label:'💎 Якісний (важкий)', tip:'~60с, 100% CPU (mci)' },
                    ].map(opt => (
                      <label
                        key={opt.val}
                        title={opt.tip}
                        style={{
                          flex:1, padding:'6px 8px', borderRadius:6, cursor:'pointer', textAlign:'center',
                          background: slowMotionMode === opt.val ? 'rgba(99,102,241,0.15)' : 'var(--bg)',
                          border: '1px solid ' + (slowMotionMode === opt.val ? '#6366f1' : 'transparent'),
                        }}
                      >
                        <input type="radio" name="slowmo" value={opt.val}
                          checked={slowMotionMode === opt.val}
                          onChange={() => setSlowMotionMode(opt.val)}
                          style={{ display:'none' }}
                        />
                        <div style={{ fontWeight: slowMotionMode === opt.val ? 600 : 400 }}>{opt.label}</div>
                        <div style={{ fontSize:9, color:'var(--text-muted)', marginTop:2 }}>{opt.tip}</div>
                      </label>
                    ))}
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', gap: 10 }}>
                <button className="btn-secondary" onClick={() => { setStep('image'); setVideoPath(null); setVideoUrl(null) }}>
                  ← Назад
                </button>
                <button className="btn-primary" onClick={handleCompose}>
                  ✨ Додати текст і музику →
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ===== КРОК 4: Compose Editor (video-editor style) ===== */}
      {step === 'compose' && (() => {
        const fx = videoEffect ? EFFECT_FILTERS[videoEffect](effectStrength) : null
        const font = FONT_MAP[textFont] || FONT_MAP['YuGothM.ttc']
        const displayText = generatedQuote || quote
        // Парсинг цитати як у Python (generate.py): "kanji / Romaji — english text"
        const parseQuote = (q) => {
          if (!q) return { kanji:'', romaji:'', english:'' }
          let kanji = '', romaji = '', english = ''
          if (q.includes(' / ')) {
            const i = q.indexOf(' / ')
            kanji = q.substring(0, i).trim()
            const rest = q.substring(i + 3)
            if (rest.includes(' — ')) {
              const j = rest.indexOf(' — ')
              romaji = rest.substring(0, j).trim().toUpperCase()
              english = rest.substring(j + 3).trim().toUpperCase()
            } else {
              romaji = rest.trim().toUpperCase()
            }
          } else {
            english = q.trim().toUpperCase()
          }
          if (english && !/[.…]$/.test(english)) english += '.'
          return { kanji, romaji, english }
        }
        const parsed = parseQuote(displayText)
        // Preview scale: 240px wide / 1080px real → 0.222. Font sizes scaled with textSize.
        const pvScale = 240 / 1080
        const txtScale = textSize / 100
        const kanjiSize   = 120 * txtScale * pvScale
        const romajiSize  = 52  * txtScale * pvScale
        const englishSize = 36  * txtScale * pvScale
        return (
        <div className="gen-result" style={{ alignItems: 'stretch' }}>
          {loading ? (
            <div className="gen-preview-box">
              <div className="preview-loading">
                {videoUrl && <video src={videoUrl} autoPlay loop muted style={{ position:'absolute', inset:0, width:'100%', height:'100%', objectFit:'cover', borderRadius:12, opacity:0.4 }} />}
                <div className="spinner" style={{ position:'relative', zIndex:1 }} />
                <div style={{ position:'relative', zIndex:1 }}>Рендер фінального відео...</div>
                <div className="preview-sub" style={{ position:'relative', zIndex:1 }}>FFmpeg обробляє відео</div>
              </div>
            </div>
          ) : (
            <div style={{ display:'flex', flexDirection:'column', gap:18, width:'100%' }}>

              {/* ═══════ TOP: Preview + Controls ═══════ */}
              <div style={{ display:'flex', gap:24, width:'100%', flexWrap:'wrap' }}>

                {/* ─── Video preview ─── */}
                <div style={{ flex:'0 0 240px' }}>
                  <div style={{ position:'relative', width:240, height:427, borderRadius:12, overflow:'hidden', background:'#000', boxShadow:'0 10px 32px rgba(0,0,0,0.6)' }}>
                    {videoUrl && (
                      <video ref={composeVideoRef} src={videoUrl} autoPlay loop muted playsInline
                        onLoadedMetadata={e => { const d=e.target.duration; setVideoDuration(d); if(trimEnd===0) setTrimEnd(d) }}
                        onTimeUpdate={e => {
                          const v=e.target
                          setVideoCurrentTime(v.currentTime)
                          if(trimStart>0 && v.currentTime<trimStart) v.currentTime=trimStart
                          if(trimEnd>0.5 && v.currentTime>=trimEnd) v.currentTime=trimStart||0
                        }}
                        style={{ width:'100%', height:'100%', objectFit:'cover', filter: fx?.filter || 'none', transition:'filter 0.25s ease' }}
                      />
                    )}
                    {fx?.overlay && (
                      <div style={{ position:'absolute', inset:0, background: fx.overlay, pointerEvents:'none', mixBlendMode:'multiply', transition:'background 0.25s ease' }} />
                    )}
                    <div style={{ position:'absolute', inset:0, background:`rgba(0,0,0,${overlayOpacity})`, pointerEvents:'none' }} />
                    {/* Live-прев'ю тексту — 3 рядки як у фінальному рендері */}
                    {parsed.kanji && (
                      <div style={{
                        position:'absolute', top:`${textPosition - 7}%`, left:0, right:0,
                        transform:'translateY(-50%)', textAlign:'center',
                        fontSize: `${kanjiSize}px`, color:'#fff',
                        fontFamily: font.family, fontWeight: 300,
                        textShadow:'0 2px 10px rgba(0,0,0,0.95), 0 0 24px rgba(0,0,0,0.6)',
                        pointerEvents:'none', lineHeight:1,
                      }}>{parsed.kanji}</div>
                    )}
                    {parsed.romaji && (
                      <div style={{
                        position:'absolute', top:`${textPosition - 2}%`, left:0, right:0,
                        textAlign:'center',
                        fontSize: `${romajiSize}px`, color:'#fff',
                        fontFamily: font.family, fontWeight: textWeight || font.weight,
                        letterSpacing:'0.18em',
                        textShadow:'0 2px 8px rgba(0,0,0,0.9)',
                        pointerEvents:'none', lineHeight:1.1,
                      }}>{parsed.romaji}</div>
                    )}
                    {parsed.english && (
                      <div style={{
                        position:'absolute', top:`${textPosition + 3}%`, left:12, right:12,
                        textAlign:'center',
                        fontSize: `${englishSize}px`, color:'rgba(255,255,255,0.9)',
                        fontFamily: font.family, fontWeight: textWeight || font.weight,
                        letterSpacing:'0.15em',
                        textShadow:'0 2px 8px rgba(0,0,0,0.9)',
                        pointerEvents:'none', lineHeight:1.2,
                      }}>{parsed.english}</div>
                    )}
                    <div style={{ position:'absolute', bottom:6, left:8, fontSize:10, color:'#bbb', fontFamily:'monospace', textShadow:'0 1px 2px #000' }}>
                      {videoCurrentTime.toFixed(1)}s / {videoDuration.toFixed(1)}s
                    </div>
                    <button onClick={() => {
                      const v = composeVideoRef.current; if (!v) return
                      if (v.paused) v.play(); else v.pause()
                    }} style={{
                      position:'absolute', bottom:6, right:6,
                      background:'rgba(0,0,0,0.6)', border:'1px solid rgba(255,255,255,0.2)', borderRadius:18,
                      width:34, height:34, color:'#fff', cursor:'pointer', fontSize:14,
                    }}>⏯</button>
                  </div>
                </div>

                {/* ─── Controls panel ─── */}
                <div style={{ flex:1, minWidth:360, display:'flex', flexDirection:'column', gap:14 }}>

                  {/* TEXT */}
                  <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
                    <label className="form-label">💬 Цитата</label>
                    <input className="form-input" value={displayText} onChange={e => setGeneratedQuote(e.target.value)} style={{ fontSize:13 }} />
                    <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr 1fr', gap:8 }}>
                      <div>
                        <div style={{ fontSize:10, color:'#888', marginBottom:2 }}>Розмір {textSize}%</div>
                        <input type="range" min="50" max="200" step="5" value={textSize}
                          onChange={e => setTextSize(parseInt(e.target.value))} style={{ width:'100%' }} />
                      </div>
                      <div>
                        <div style={{ fontSize:10, color:'#888', marginBottom:2 }}>Позиція {textPosition}%</div>
                        <input type="range" min="10" max="90" step="5" value={textPosition}
                          onChange={e => setTextPosition(parseInt(e.target.value))} style={{ width:'100%' }} />
                      </div>
                      <div>
                        <div style={{ fontSize:10, color:'#888', marginBottom:2 }}>Шрифт</div>
                        <select className="form-select" value={textFont} onChange={e => setTextFont(e.target.value)} style={{ fontSize:11, padding:'4px 6px' }}>
                          <option value="YuGothM.ttc">Yu Gothic</option>
                          <option value="YuGothB.ttc">Yu Gothic Bold</option>
                          <option value="meiryo.ttc">Meiryo</option>
                          <option value="msgothic.ttc">MS Gothic</option>
                        </select>
                      </div>
                      <div>
                        <div style={{ fontSize:10, color:'#888', marginBottom:2 }}>Вага</div>
                        <select className="form-select" value={textWeight} onChange={e => setTextWeight(parseInt(e.target.value))} style={{ fontSize:11, padding:'4px 6px' }}>
                          <option value={300}>Light</option>
                          <option value={400}>Regular</option>
                          <option value={500}>Medium</option>
                          <option value={600}>SemiBold</option>
                          <option value={700}>Bold</option>
                        </select>
                      </div>
                    </div>
                  </div>

                  {/* EFFECTS */}
                  <div>
                    <label className="form-label">🎨 Ефект</label>
                    <div style={{ display:'flex', gap:6, flexWrap:'wrap', alignItems:'center' }}>
                      {[['','—'],['cinematic','Cinematic'],['cold_steel','Cold Steel'],['blood_ash','Blood Ash'],['fog_ghost','Fog Ghost'],['noir','Noir']].map(([val,lbl]) => (
                        <button key={val} onClick={() => setVideoEffect(val)} style={{
                          padding:'4px 10px', borderRadius:6, fontSize:11, cursor:'pointer', border:'1px solid',
                          background: videoEffect===val ? '#f97316' : 'transparent',
                          borderColor: videoEffect===val ? '#f97316' : '#3a3a4a',
                          color: videoEffect===val ? '#fff' : '#aaa',
                          transition:'all 0.15s',
                        }}>{lbl}</button>
                      ))}
                      {videoEffect && (
                        <div style={{ display:'flex', alignItems:'center', gap:6, marginLeft:8, flex:1, minWidth:120 }}>
                          <span style={{ fontSize:10, color:'#888', whiteSpace:'nowrap' }}>Сила {Math.round(effectStrength*100)}%</span>
                          <input type="range" min="0" max="1" step="0.05" value={effectStrength}
                            onChange={e => setEffectStrength(parseFloat(e.target.value))} style={{ flex:1 }} />
                        </div>
                      )}
                    </div>
                  </div>

                  {/* MUSIC PICKER + VOLUME */}
                  <div>
                    <label className="form-label">🎵 Музика</label>
                    <div style={{ display:'flex', gap:8, alignItems:'center' }}>
                      <button className="btn-secondary" onClick={handlePickMusic} style={{ fontSize:12, padding:'6px 12px', maxWidth:240, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                        📁 {musicPath ? musicPath.split(/[/\\]/).pop() : 'Вибрати файл'}
                      </button>
                      {musicPath && (
                        <button onClick={() => setMusicPath('')} style={{ background:'transparent', border:'none', color:'#888', cursor:'pointer', fontSize:16 }} title="Прибрати">✕</button>
                      )}
                      {musicPath && (
                        <div style={{ display:'flex', alignItems:'center', gap:6, marginLeft:'auto' }}>
                          <span style={{ fontSize:10, color:'#888', fontFamily:'monospace' }}>🔊 {Math.round(musicVolume*100)}%</span>
                          <input type="range" min="0" max="1" step="0.05" value={musicVolume}
                            onChange={e => setMusicVolume(parseFloat(e.target.value))} style={{ width:100 }} />
                        </div>
                      )}
                    </div>
                    {musicPath && (
                      <audio ref={musicRef}
                        preload="auto"
                        src={`http://127.0.0.1:${PYTHON_PORT}/local-audio?path=${encodeURIComponent(musicPath)}`}
                        onLoadedMetadata={e => {
                          const d = e.target.duration
                          setMusicDuration(d)
                          if (musicTrimEnd === 0) setMusicTrimEnd(d)
                        }}
                        onTimeUpdate={e => {
                          const el = e.target
                          setMusicCurrentTime(el.currentTime)
                          if (musicTrimEnd > 0.5 && el.currentTime >= musicTrimEnd) el.currentTime = musicTrimStart
                        }}
                        onError={e => console.warn('[audio] load error:', e.target.error?.message || 'unknown', 'src:', e.target.src)}
                      />
                    )}
                  </div>

                  {/* EXTRAS */}
                  <div style={{ display:'flex', flexDirection:'column', gap:8, fontSize:12, color:'#aaa' }}>
                    <div style={{ display:'flex', gap:18, alignItems:'center', flexWrap:'wrap' }}>
                      <label style={{ display:'flex', alignItems:'center', gap:6, cursor:'pointer' }}>
                        <input type="checkbox" checked={slowMotion} onChange={e => setSlowMotion(e.target.checked)} />
                        🎬 Slow Motion
                      </label>
                      <label style={{ display:'flex', alignItems:'center', gap:6, flex:1, minWidth:180 }}>
                        🌑 Затемнення {Math.round(overlayOpacity*100)}%
                        <input type="range" min="0" max="0.8" step="0.05" value={overlayOpacity}
                          onChange={e => setOverlayOpacity(parseFloat(e.target.value))} style={{ flex:1 }} />
                      </label>
                    </div>
                    {slowMotion && (
                      <>
                        {/* Slider швидкості — live preview через video.playbackRate */}
                        <label style={{ display:'flex', alignItems:'center', gap:8, fontSize:12 }}>
                          <span style={{ minWidth:80 }}>Швидкість: <b style={{ color:'#6366f1' }}>{slowMotionFactor.toFixed(2)}x</b></span>
                          <input
                            type="range" min="0.3" max="1.0" step="0.05" value={slowMotionFactor}
                            onChange={e => {
                              const v = parseFloat(e.target.value)
                              setSlowMotionFactor(v)
                              // Live preview: HTML5 video playbackRate
                              const vid = composeVideoRef.current
                              if (vid) { try { vid.playbackRate = v } catch {} }
                            }}
                            style={{ flex:1 }}
                          />
                          <span style={{ fontSize:10, color:'var(--text-muted)', minWidth:70, textAlign:'right' }}>
                            {slowMotionFactor < 1 ? `${(1/slowMotionFactor).toFixed(2)}× повільніше` : 'норма'}
                          </span>
                        </label>
                        <div style={{ display:'flex', gap:6, fontSize:10 }}>
                          {[
                            { val:'blend', label:'⚡ Швидкий',   tip:'~20с, low CPU' },
                            { val:'rife',  label:'🤖 AI (CapCut)', tip:'~60-120с, GPU' },
                            { val:'mci',   label:'💎 Якісний',   tip:'~60с, 100% CPU' },
                          ].map(opt => (
                            <label
                              key={opt.val}
                              title={opt.tip}
                              style={{
                                flex:1, padding:'4px 6px', borderRadius:4, cursor:'pointer', textAlign:'center',
                                background: slowMotionMode === opt.val ? 'rgba(99,102,241,0.2)' : 'transparent',
                                border: '1px solid ' + (slowMotionMode === opt.val ? '#6366f1' : 'var(--border)'),
                              }}
                            >
                              <input type="radio" name="slowmo2" value={opt.val}
                                checked={slowMotionMode === opt.val}
                                onChange={() => setSlowMotionMode(opt.val)}
                                style={{ display:'none' }}
                              />
                              <span style={{ fontWeight: slowMotionMode === opt.val ? 600 : 400 }}>{opt.label}</span>
                            </label>
                          ))}
                        </div>
                      </>
                    )}
                  </div>

                  {error && <div className="status-error">{error}</div>}

                  <div style={{ display:'flex', gap:10, marginTop:'auto' }}>
                    <button className="btn-secondary" onClick={() => setStep('video')}>← Назад</button>
                    <button className="btn-primary" onClick={handleRenderFinal} style={{ flex:1 }}>🎬 Рендер фінального відео</button>
                  </div>

                </div>
              </div>

              {/* ═══════ BOTTOM: Multi-track Timeline (full width) ═══════ */}
              {(() => {
                // Множник slow: відео візуально витягується на таймлайні
                const slowMul = slowMotion ? (1 / Math.max(0.3, slowMotionFactor)) : 1
                const displayVideoDuration = videoDuration * slowMul
                const displayTrimStart = trimStart * slowMul
                const displayTrimEnd = (trimEnd || videoDuration) * slowMul
                const displayVideoTime = videoCurrentTime * slowMul
                // Спільна шкала — max із video (зі slow) та music, щоб секунди на обох доріжках збігались
                const sharedScale = Math.max(displayVideoDuration, musicDuration || 0, 1)
                return (
                <div style={{ width:'100%', background:'#0a0a14', border:'1px solid #2a2a3a', borderRadius:8, padding:'12px 16px' }}>
                  {/* Time ruler */}
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', fontSize:11, color:'#888', fontFamily:'monospace', marginBottom:10, paddingBottom:6, borderBottom:'1px solid #1a1a2a' }}>
                    <span>0:00</span>
                    <span style={{ color:'#aaa', fontFamily:'inherit', fontSize:12 }}>
                      🎞 Таймлайн {slowMotion && <span style={{ color:'#6366f1' }}>· slow {slowMotionFactor.toFixed(2)}x</span>}
                    </span>
                    <span>{sharedScale.toFixed(1)}s</span>
                  </div>

                  {/* VIDEO TRACK */}
                  <div style={{ marginBottom:10 }}>
                    <div style={{ fontSize:10, color:'#aaa', marginBottom:4, display:'flex', alignItems:'center', gap:4 }}>
                      🎬 Відео {slowMotion && <span style={{ color:'#6366f1' }}>({displayVideoDuration.toFixed(1)}s)</span>}
                    </div>
                    <TrimTimeline
                      duration={displayVideoDuration}
                      fullDuration={sharedScale}
                      trimStart={displayTrimStart}
                      trimEnd={displayTrimEnd}
                      currentTime={displayVideoTime}
                      onTrimChange={(s, e) => {
                        // Конвертуємо display → original seconds (Python очікує original)
                        const origStart = s / slowMul
                        const origEnd = e / slowMul
                        setTrimStart(origStart)
                        setTrimEnd(origEnd)
                        if (composeVideoRef.current) composeVideoRef.current.currentTime = origStart
                      }}
                      onSeek={(t) => {
                        if (composeVideoRef.current) composeVideoRef.current.currentTime = t / slowMul
                      }}
                      color="orange"
                    />
                  </div>

                  {/* AUDIO TRACK */}
                  {musicPath && (
                    <div>
                      <div style={{ fontSize:10, color:'#aaa', marginBottom:4, display:'flex', alignItems:'center', gap:4 }}>🎵 Аудіо</div>
                      <TrimTimeline
                        duration={musicDuration}
                        fullDuration={sharedScale}
                        trimStart={musicTrimStart}
                        trimEnd={musicTrimEnd || musicDuration}
                        currentTime={musicCurrentTime}
                        clipLabel={musicPath.split(/[/\\]/).pop()}
                        onTrimChange={(s, e) => {
                          setMusicTrimStart(s); setMusicTrimEnd(e)
                          if (musicRef.current) musicRef.current.currentTime = s
                        }}
                        onSeek={(t) => { if (musicRef.current) musicRef.current.currentTime = t }}
                        color="green"
                      />
                    </div>
                  )}

                  {/* Selection info */}
                  <div style={{ display:'flex', justifyContent:'space-between', fontSize:10, color:'#666', marginTop:8, paddingTop:6, borderTop:'1px solid #1a1a2a', fontFamily:'monospace' }}>
                    <span>Вибрано (фінал): {(displayTrimEnd - displayTrimStart).toFixed(1)}s</span>
                    <span>{displayTrimStart.toFixed(1)}s — {displayTrimEnd.toFixed(1)}s</span>
                  </div>
                </div>
                )
              })()}

            </div>
          )}
        </div>
        )
      })()}

      {/* ===== КРОК 5: Готово ===== */}
      {step === 'done' && (
        <div className="gen-result" style={{ alignItems: 'stretch' }}>
          <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start', width: '100%' }}>
            {/* Превью відео */}
            <div className="gen-preview-box" style={{ flex: '0 0 280px', height: 420 }}>
              {finalUrl && (
                <video src={finalUrl} autoPlay loop controls style={{ width: '100%', height: '100%', objectFit: 'contain', borderRadius: 12 }} />
              )}
            </div>

            {/* Панель публікації */}
            <div className="publish-panel">
              <div className="publish-panel-title">📤 Публікація в Instagram</div>

              {/* Підпис */}
              <div className="form-section">
                <label className="form-label">Підпис до публікації</label>
                <textarea
                  className="form-textarea"
                  placeholder="Напишіть підпис... (emoji, хештеги)"
                  value={publishCaption}
                  onChange={e => setPublishCaption(e.target.value)}
                  rows={4}
                />
              </div>

              {/* Результат публікації */}
              {publishResult && (
                <div className={`publish-result ${publishResult.ok ? 'publish-result--ok' : 'publish-result--err'}`}>
                  {publishResult.ok ? (
                    <>
                      ✅ Опубліковано!{' '}
                      <span
                        className="publish-link"
                        onClick={() => isElectron && window.api.shell.openExternal(publishResult.url)}
                      >
                        Відкрити в Instagram →
                      </span>
                    </>
                  ) : (
                    <>❌ {publishResult.error}</>
                  )}
                </div>
              )}

              {/* Результат планування */}
              {scheduleResult && (
                <div className={`publish-result ${scheduleResult.ok ? 'publish-result--ok' : 'publish-result--err'}`}>
                  {scheduleResult.ok
                    ? `✅ Заплановано на ${new Date(scheduleResult.when).toLocaleString('uk-UA')}`
                    : `❌ ${scheduleResult.error}`}
                </div>
              )}

              {/* Режим планування */}
              {scheduleMode && (
                <div className="schedule-picker">
                  <div style={{ display: 'flex', gap: 8 }}>
                    <div style={{ flex: 1 }}>
                      <label className="form-label">Дата</label>
                      <input
                        type="date"
                        className="form-input"
                        value={scheduleDate}
                        onChange={e => setScheduleDate(e.target.value)}
                        min={new Date().toISOString().split('T')[0]}
                      />
                    </div>
                    <div style={{ flex: 1 }}>
                      <label className="form-label">Час</label>
                      <input
                        type="time"
                        className="form-input"
                        value={scheduleTime}
                        onChange={e => setScheduleTime(e.target.value)}
                      />
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                    <button className="btn-primary" onClick={handleSchedule} disabled={scheduling} style={{ flex: 1 }}>
                      {scheduling ? '⏳ Зберігаємо...' : '📅 Запланувати'}
                    </button>
                    <button className="btn-ghost" onClick={() => setScheduleMode(false)}>Скасувати</button>
                  </div>
                </div>
              )}

              {/* Кнопки дій */}
              {!scheduleMode && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 8 }}>
                  <button
                    className="btn-primary"
                    onClick={handlePublishNow}
                    disabled={publishing || !!publishResult?.ok}
                    style={{ background: '#e1306c' }}
                  >
                    {publishing ? '⏳ Публікуємо...' : '🚀 Опублікувати зараз'}
                  </button>
                  <button
                    className="btn-secondary"
                    onClick={openScheduleMode}
                    disabled={!!scheduleResult?.ok}
                  >
                    📅 Запланувати публікацію
                  </button>
                </div>
              )}

              <div style={{ borderTop: '1px solid var(--border)', marginTop: 16, paddingTop: 16, display: 'flex', gap: 10 }}>
                <button className="btn-secondary" onClick={handleReset} style={{ flex: 1 }}>
                  ⚡ Створити нове
                </button>
                <button className="btn-ghost" onClick={handleOpenFile}>
                  📁 Файл
                </button>
                {isElectron && (
                  <button
                    className="btn-ghost"
                    style={{ color: '#22c55e' }}
                    onClick={async () => {
                      try {
                        const composeParams = JSON.stringify({
                          slow_motion: slowMotion,
                          slow_motion_mode: slowMotionMode,
                          slow_motion_factor: slowMotionFactor,
                          overlay_opacity: overlayOpacity,
                          trim_start: trimStart,
                          trim_end: trimEnd,
                          video_effect: videoEffect,
                          effect_strength: effectStrength,
                          music_trim_start: musicTrimStart,
                          music_trim_end: musicTrimEnd,
                          music_volume: musicVolume,
                          text_size: textSize,
                          text_weight: textWeight,
                          text_position: textPosition,
                          text_font: textFont,
                        })
                        const payload = {
                          style,
                          variant_name: '',
                          image_prompt: generatedImagePrompt || prompt || '',
                          video_prompt: claudeVideoPrompt || '',
                          quote: generatedQuote || quote,
                          image_provider: imageProvider,
                          video_provider: videoProvider,
                          image_path: imagePath,
                          video_path: videoPath,
                          final_path: finalPath,
                          music_path: musicPath || '',
                          logo_path: logoPath || '',
                          caption: publishCaption,
                          compose_params: composeParams,
                        }
                        if (editingId) {
                          await window.api.generations.update(editingId, payload)
                          alert('Оновлено!')
                        } else {
                          await window.api.generations.save(payload)
                          alert('Збережено в Історію!')
                        }
                      } catch (e) {
                        alert('Помилка: ' + String(e))
                      }
                    }}
                  >
                    {editingId ? '💾 Оновити' : '💾 Зберегти'}
                  </button>
                )}
                {isElectron && editorMode && editingId && (
                  <button
                    className="btn-ghost"
                    style={{ color: '#6366f1' }}
                    title="Створити нову генерацію у БД (не перезаписує поточну)"
                    onClick={async () => {
                      try {
                        const composeParams = JSON.stringify({
                          slow_motion: slowMotion,
                          slow_motion_mode: slowMotionMode,
                          slow_motion_factor: slowMotionFactor,
                          overlay_opacity: overlayOpacity,
                          trim_start: trimStart,
                          trim_end: trimEnd,
                          video_effect: videoEffect,
                          effect_strength: effectStrength,
                          music_trim_start: musicTrimStart,
                          music_trim_end: musicTrimEnd,
                          music_volume: musicVolume,
                          text_size: textSize,
                          text_weight: textWeight,
                          text_position: textPosition,
                          text_font: textFont,
                        })
                        const payload = {
                          style,
                          variant_name: '',
                          image_prompt: generatedImagePrompt || prompt || '',
                          video_prompt: claudeVideoPrompt || '',
                          quote: generatedQuote || quote,
                          image_provider: imageProvider,
                          video_provider: videoProvider,
                          image_path: imagePath,
                          video_path: videoPath,
                          final_path: finalPath,
                          music_path: musicPath || '',
                          logo_path: logoPath || '',
                          caption: publishCaption,
                          compose_params: composeParams,
                        }
                        await window.api.generations.save(payload)
                        alert('Збережено як нова генерація!')
                      } catch (e) {
                        alert('Помилка: ' + String(e))
                      }
                    }}
                  >
                    📋 Зберегти як нову
                  </button>
                )}
              </div>

              {finalPath && (
                <div className="gen-hint" style={{ fontSize: 11, marginTop: 8 }}>
                  {finalPath}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
