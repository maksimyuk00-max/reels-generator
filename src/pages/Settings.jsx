import { useState, useEffect } from 'react'
import './Pages.css'

const isElectron = typeof window !== 'undefined' && !!window.api

function FlowSetupButton() {
  const [status, setStatus] = useState('idle') // idle | loading | ok | err
  const [msg, setMsg] = useState('')

  const handleSetup = async () => {
    setStatus('loading')
    try {
      const r = await window.api.python.flowSetup()
      if (r.ok) { setStatus('ok'); setMsg(r.message) }
      else       { setStatus('err'); setMsg(r.error) }
    } catch(e) {
      setStatus('err'); setMsg(String(e))
    }
  }

  return (
    <div>
      <button
        className="btn-primary"
        onClick={handleSetup}
        disabled={status === 'loading'}
        style={{ width: '100%' }}
      >
        {status === 'loading' ? '⏳ Запускаємо...' : '🌐 Відкрити Flow браузер'}
      </button>
      {msg && (
        <div style={{
          marginTop: 8, padding: '10px 12px', borderRadius: 8, fontSize: 12,
          background: status === 'ok' ? 'rgba(34,197,94,0.1)' : 'rgba(224,82,82,0.1)',
          color: status === 'ok' ? '#22c55e' : '#e05252',
          whiteSpace: 'pre-line',
        }}>{msg}</div>
      )}
    </div>
  )
}

const OLLAMA_DEFAULT_MODELS = [
  'gpt-oss:120b',
  'gpt-oss:20b',
  'minimax-m3',
  'minimax-m2.7',
  'glm-5.2',
  'glm-5.1',
  'deepseek-v3.1:671b',
  'deepseek-v4-pro:preview',
  'llama-3.3-70b',
  'qwen3-coder:480b',
  'qwen3.5:397b',
  'mistral-large-3:675b',
  'kimi-k3',
]

function OllamaSettings({ settings, set }) {
  const [testStatus, setTestStatus] = useState('idle') // idle | loading | ok | err
  const [testMsg, setTestMsg] = useState('')
  const [availableModels, setAvailableModels] = useState([])

  // Завантажуємо список доступних моделей і поточні налаштування
  useEffect(() => {
    if (isElectron) {
      window.api.reddit.draftModels().then(r => {
        if (r?.ok && r.current) {
          // Не перезаписуємо модель якщо користувач вже вибрав свою
          if (!settings.ollama?.model && r.current.model) {
            set('ollama.model', r.current.model)
          }
          if (!settings.ollama?.endpoint && r.current.endpoint) {
            set('ollama.endpoint', r.current.endpoint)
          }
        }
      }).catch(() => {})
    }
  }, [])

  const handleTest = async () => {
    setTestStatus('loading')
    setTestMsg('')
    setAvailableModels([])
    try {
      const r = await window.api.reddit.draftTest()
      if (r.ok) {
        setTestStatus('ok')
        setTestMsg(`✅ З'єднання OK. Доступно ${(r.models_available || []).length} моделей.`)
        setAvailableModels(r.models_available || [])
      } else {
        setTestStatus('err')
        setTestMsg(r.error || 'Невідома помилка')
      }
    } catch (e) {
      setTestStatus('err')
      setTestMsg(String(e))
    }
  }

  const ollama = settings.ollama || {}

  return (
    <div style={{ marginTop: 12 }}>
      <label className="form-label">Endpoint</label>
      <input
        className="form-input"
        placeholder="https://ollama.com (Cloud) або http://localhost:11434 (локальний)"
        value={ollama.endpoint || ''}
        onChange={e => set('ollama.endpoint', e.target.value)}
      />
      <div className="settings-hint" style={{ marginTop: 4 }}>
        Ollama Cloud: <b>https://ollama.com</b>. Локальний: <b>http://localhost:11434</b> (запустіть <code>ollama serve</code>).
      </div>

      <label className="form-label" style={{ marginTop: 12 }}>API Ключ (тільки для Cloud)</label>
      <input
        className="form-input"
        type="password"
        placeholder="ollama_..."
        value={ollama.apiKey || ''}
        onChange={e => set('ollama.apiKey', e.target.value)}
      />
      <div className="settings-hint">
        Безкоштовний ключ: <b>ollama.com</b> → Settings → API Keys. Для локального Ollama не потрібен.
      </div>

      <label className="form-label" style={{ marginTop: 12 }}>Модель</label>
      <select
        className="form-select"
        value={ollama.model || 'gpt-oss:120b'}
        onChange={e => set('ollama.model', e.target.value)}
      >
        {OLLAMA_DEFAULT_MODELS.map(m => (
          <option key={m} value={m}>{m}</option>
        ))}
        {ollama.model && !OLLAMA_DEFAULT_MODELS.includes(ollama.model) && (
          <option value={ollama.model}>{ollama.model} (custom)</option>
        )}
      </select>
      <input
        className="form-input"
        style={{ marginTop: 6 }}
        placeholder="або введіть свою назву..."
        value={ollama.model || ''}
        onChange={e => set('ollama.model', e.target.value)}
      />

      <button
        className="btn-secondary"
        style={{ marginTop: 12, width: '100%' }}
        onClick={handleTest}
        disabled={testStatus === 'loading'}
      >
        {testStatus === 'loading' ? '⏳ Перевірка...' : '🔌 Перевірити з\'єднання'}
      </button>
      {testMsg && (
        <div style={{
          marginTop: 8, padding: '10px 12px', borderRadius: 8, fontSize: 12,
          background: testStatus === 'ok' ? 'rgba(34,197,94,0.1)' : 'rgba(224,82,82,0.1)',
          color: testStatus === 'ok' ? '#22c55e' : '#e05252',
          whiteSpace: 'pre-line',
        }}>{testMsg}</div>
      )}
      {availableModels.length > 0 && (
        <div className="settings-hint" style={{ marginTop: 6 }}>
          Знайдено: {availableModels.slice(0, 8).join(', ')}{availableModels.length > 8 ? `, +${availableModels.length - 8}` : ''}
        </div>
      )}
    </div>
  )
}

const defaults = {
  instagram: { sessionId: '' },
  imageApi: { provider: 'stability', apiKey: '' },
  videoApi: { provider: 'kling', apiKey: '' },
  claudeApi: { apiKey: '' },
  ollama: {
    provider: 'claude-cli',
    endpoint: 'https://ollama.com',
    apiKey: '',
    model: 'gpt-oss:120b',
  },
  musicFolder: '',
  logoPath: '',
}

export default function Settings() {
  const [settings, setSettings] = useState(defaults)
  const [sessionStatus, setSessionStatus] = useState('idle')
  const [saved, setSaved] = useState(false)
  const [autostart, setAutostart] = useState(false)

  useEffect(() => {
    if (isElectron) {
      window.api.settings.get().then(data => {
        if (data) setSettings(prev => ({ ...prev, ...data }))
      })
      window.api.app?.getAutostart?.().then(r => setAutostart(!!r?.enabled)).catch(() => {})
    }
  }, [])

  const toggleAutostart = async (enabled) => {
    setAutostart(enabled)
    try { await window.api.app?.setAutostart?.(enabled) } catch {}
  }

  const set = (path, value) => {
    const keys = path.split('.')
    setSettings(prev => {
      const next = { ...prev }
      let cur = next
      for (let i = 0; i < keys.length - 1; i++) {
        cur[keys[i]] = { ...cur[keys[i]] }
        cur = cur[keys[i]]
      }
      cur[keys[keys.length - 1]] = value
      return next
    })
  }

  const handleSave = async () => {
    if (isElectron) await window.api.settings.save(settings)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  const [sessionError, setSessionError] = useState('')

  const handleCheckSession = async () => {
    if (!settings.instagram.sessionId.trim()) return
    if (isElectron) await window.api.settings.save(settings)
    setSessionStatus('checking')
    setSessionError('')
    if (isElectron) {
      const result = await window.api.python.testSession()
      if (result.ok) {
        setSessionStatus('ok')
      } else {
        setSessionStatus('error')
        setSessionError(result.error || 'Невідома помилка')
      }
    }
  }

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">⚙️ Налаштування</h1>
      </div>

      <div className="settings-grid">

        <div className="settings-card">
          <div className="settings-card-title">📱 Instagram сесія</div>
          <div className="settings-card-desc">Введіть sessionid cookie з вашого браузера</div>
          <label className="form-label">Session ID</label>
          <div className="input-row">
            <input
              className="form-input"
              type="password"
              placeholder="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
              value={settings.instagram?.sessionId || ''}
              onChange={e => set('instagram.sessionId', e.target.value)}
            />
            <button className="btn-secondary" onClick={handleCheckSession}>Перевірити</button>
          </div>
          {sessionStatus === 'ok'       && <div className="status-ok">✅ Авторизація успішна</div>}
          {sessionStatus === 'error'    && <div className="status-error">❌ {sessionError || 'Невірний session ID'}</div>}
          {sessionStatus === 'checking' && <div className="status-checking">⏳ Перевірка через Instagram...</div>}
          <div className="settings-hint">F12 → Application → Cookies → instagram.com → sessionid</div>
        </div>

        <div className="settings-card">
          <div className="settings-card-title">🖼 Генерація зображень</div>
          <div className="settings-card-desc">API для створення AI-зображень воїнів</div>
          <label className="form-label">Провайдер</label>
          <select className="form-select" value={settings.imageApi?.provider || 'stability'} onChange={e => set('imageApi.provider', e.target.value)}>
            <option value="google">Google Gemini 2.0 (Imagen) ⭐</option>
            <option value="stability">Stability AI (SDXL)</option>
            <option value="openai">OpenAI (DALL-E 3)</option>
            <option value="replicate">Replicate (Flux)</option>
          </select>
          <label className="form-label" style={{ marginTop: 12 }}>API Ключ</label>
          <input
            className="form-input"
            type="password"
            placeholder="sk-..."
            value={settings.imageApi?.apiKey || ''}
            onChange={e => set('imageApi.apiKey', e.target.value)}
          />
          {settings.imageApi?.provider === 'google' && (
            <div className="settings-hint">Google AI Studio: aistudio.google.com → Get API key</div>
          )}
          {settings.imageApi?.provider === 'stability' && (
            <div className="settings-hint">Отримати на platform.stability.ai</div>
          )}
          {settings.imageApi?.provider === 'openai' && (
            <div className="settings-hint">Отримати на platform.openai.com</div>
          )}
          {settings.imageApi?.provider === 'replicate' && (
            <div className="settings-hint">Отримати на replicate.com/account/api-tokens</div>
          )}
        </div>

        <div className="settings-card">
          <div className="settings-card-title">🎬 Генерація відео</div>
          <div className="settings-card-desc">API для анімації зображень у відео</div>
          <label className="form-label">Сервіс</label>
          <select className="form-select" value={settings.videoApi?.provider || 'nhungoc_veo3'} onChange={e => set('videoApi.provider', e.target.value)}>
            <option value="nhungoc_veo3">VEO 3 (Nhungoc - безлімітний)</option>
            <option value="veo">Google Veo 3 (AI Studio key)</option>
            <option value="kling">Kling AI</option>
            <option value="runway">Runway ML (Gen-3)</option>
            <option value="luma">Luma Dream Machine</option>
          </select>
          {settings.videoApi?.provider === 'nhungoc_veo3' ? (
            <>
              <div className="settings-hint" style={{ marginTop: 8, color: '#22c55e' }}>VIP акаунт - безлімітна генерація. API ключ не потрібен.</div>
            </>
          ) : (
            <>
              <label className="form-label" style={{ marginTop: 12 }}>API Ключ</label>
              <input
                className="form-input"
                type="password"
                placeholder="Введіть API ключ..."
                value={settings.videoApi?.apiKey || ''}
                onChange={e => set('videoApi.apiKey', e.target.value)}
              />
            </>
          )}
          {settings.videoApi?.provider === 'veo' && (
            <div className="settings-hint">Використовує той самий ключ що й для зображень (Google AI Studio). Вставте ключ сюди теж.</div>
          )}
          {settings.videoApi?.provider === 'kling' && (
            <div className="settings-hint">Формат: access_key:secret_key (klingai.com/global/dev)</div>
          )}
          {settings.videoApi?.provider === 'runway' && (
            <div className="settings-hint">Отримати на app.runwayml.com/settings/api-keys</div>
          )}
          {settings.videoApi?.provider === 'luma' && (
            <div className="settings-hint">Отримати на lumalabs.ai/dream-machine/api</div>
          )}
        </div>

        <div className="settings-card">
          <div className="settings-card-title">🤖 Claude AI — генерація промптів</div>
          <div className="settings-card-desc">Claude генерує унікальні промпти для кожного зображення замість шаблонів</div>
          <label className="form-label">Anthropic API Ключ</label>
          <input
            className="form-input"
            type="password"
            placeholder="sk-ant-..."
            value={settings.claudeApi?.apiKey || ''}
            onChange={e => set('claudeApi.apiKey', e.target.value)}
          />
          <div className="settings-hint">
            Отримати на <b>console.anthropic.com</b> → API Keys. Якщо порожній — використовуються шаблони.
          </div>
        </div>

        <div className="settings-card">
          <div className="settings-card-title">🧠 Провайдер для Reddit драфтів</div>
          <div className="settings-card-desc">
            Який LLM генерує драфти-відповіді на пости. Claude CLI потребує логін, Ollama — API ключ.
          </div>
          <label className="form-label">Провайдер</label>
          <select
            className="form-select"
            value={settings.ollama?.provider || 'claude-cli'}
            onChange={e => set('ollama.provider', e.target.value)}
          >
            <option value="claude-cli">Claude CLI (локальний, потребує /login)</option>
            <option value="ollama">Ollama (Cloud або локальний)</option>
          </select>

          {settings.ollama?.provider === 'ollama' && (
            <OllamaSettings settings={settings} set={set} />
          )}
        </div>

        <div className="settings-card">
          <div className="settings-card-title">🌊 Google Flow — автогенерація</div>
          <div className="settings-card-desc">Окремий браузер для автоматичної генерації зображень. Один раз логінишся — далі автоматично.</div>

          <FlowSetupButton />

          <label className="form-label" style={{ marginTop: 12 }}>Gemini API Key (для генерації промтів)</label>
          <input
            className="form-input"
            type="password"
            placeholder="AIzaSy..."
            value={settings.googleFlow?.geminiApiKey || ''}
            onChange={e => set('googleFlow.geminiApiKey', e.target.value)}
          />
          <div className="settings-hint">Google AI Studio: aistudio.google.com → Get API key. Використовується для генерації промтів з майстер-шаблону.</div>

          <label className="form-label" style={{ marginTop: 12 }}>URL проекту</label>
          <input
            className="form-input"
            placeholder="https://labs.google/fx/uk/tools/flow/project/..."
            value={settings.googleFlow?.projectUrl || ''}
            onChange={e => set('googleFlow.projectUrl', e.target.value)}
          />
          <div className="settings-hint">
            <b>Як налаштувати:</b> натисни кнопку вище → залогінься в Google у вікні що відкриється → відкрий labs.google/fx → НЕ закривай це вікно
          </div>
        </div>

        <div className="settings-card">
          <div className="settings-card-title">🌍 Android — Geo маскування (EU/UK)</div>
          <div className="settings-card-desc">Проксі для постингу через Android. Instagram бачитиме UK IP замість України.</div>
          <label className="form-label">Проксі (host:port або host:port:user:pass)</label>
          <input
            className="form-input"
            placeholder="185.120.10.5:3128 або 185.120.10.5:3128:user:pass"
            value={settings.androidProxy || ''}
            onChange={e => set('androidProxy', e.target.value)}
          />
          <div className="settings-hint">
            Підтримує HTTP проксі. Timezone і мова пристрою автоматично переключаться на <b>Europe/London / en-GB</b> під час постингу і повернуться назад після.<br/>
            Рекомендовані провайдери: <b>proxyseller.com</b>, <b>webshare.io</b> (UK або DE сервери).
          </div>
        </div>

        <div className="settings-card">
          <div className="settings-card-title">🎵 Музика та лого</div>
          <div className="settings-card-desc">Фонова музика та водяний знак для відео</div>
          <label className="form-label">Папка з музикою</label>
          <input
            className="form-input"
            placeholder="C:\music\epic..."
            value={settings.musicFolder || ''}
            onChange={e => set('musicFolder', e.target.value)}
          />
          <label className="form-label" style={{ marginTop: 12 }}>Логотип (водяний знак)</label>
          <input
            className="form-input"
            placeholder="C:\logo.png"
            value={settings.logoPath || ''}
            onChange={e => set('logoPath', e.target.value)}
          />
          <div className="settings-hint">PNG з прозорим фоном, рекомендовано 200x200px</div>
        </div>

        <div className="settings-card">
          <div className="settings-card-title">🖥️ Трей та автозапуск</div>
          <div className="settings-card-desc">
            Щоб планувальник прогріву спрацьовував у заплановані години — додаток має працювати (можна у фоні).
          </div>

          <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', marginTop: 8 }}>
            <input
              type="checkbox"
              checked={autostart}
              onChange={e => toggleAutostart(e.target.checked)}
              style={{ width: 18, height: 18 }}
            />
            <span style={{ fontSize: 14 }}>Запускати з Windows (у фоні)</span>
          </label>
          <div className="settings-hint" style={{ marginTop: 6 }}>
            Додаток стартуватиме згорнутим у трей при вході в систему. Іконка — біля годинника.
          </div>

          <div style={{ marginTop: 14, padding: 10, background: 'rgba(99,102,241,0.08)', borderRadius: 8, fontSize: 12, lineHeight: 1.5 }}>
            <b>Як це працює:</b> закриття вікна (✕) ховає додаток у трей — процес залишається живим, планувальник виконує сесії вчасно.
            Щоб повністю вийти: <b>Файл → Вихід</b> або правий клік на іконці трея → <b>Вихід</b>.
          </div>
        </div>

      </div>

      <button className="btn-primary" style={{ marginTop: 24 }} onClick={handleSave}>
        {saved ? '✅ Збережено!' : '💾 Зберегти налаштування'}
      </button>
    </div>
  )
}
