import { useState, useEffect } from 'react'

const isElectron = typeof window !== 'undefined' && !!window.api

// ─────────────────────────────────────────────────────────────
// Status Badge
// ─────────────────────────────────────────────────────────────
export function StatusBadge({ status, compact = false }) {
  const map = {
    connected:    { color: '#22c55e', bg: 'rgba(34,197,94,0.15)',  icon: '🟢', label: 'Connected' },
    reconnecting: { color: '#eab308', bg: 'rgba(234,179,8,0.15)',  icon: '🟡', label: 'Reconnecting' },
    recovering:   { color: '#eab308', bg: 'rgba(234,179,8,0.15)',  icon: '🟡', label: 'USB recovery' },
    lost:         { color: '#ef4444', bg: 'rgba(239,68,68,0.15)',  icon: '🔴', label: 'Lost' },
    busy:         { color: '#6366f1', bg: 'rgba(99,102,241,0.15)', icon: '🟣', label: 'Running' },
    mismatch:     { color: '#f97316', bg: 'rgba(249,115,22,0.15)', icon: '🟠', label: 'Account mismatch' },
    unknown:      { color: '#9ca3af', bg: 'rgba(156,163,175,0.15)',icon: '⚪', label: 'Checking' },
  }
  const s = map[status] || map.unknown
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: compact ? '2px 8px' : '4px 10px',
      borderRadius: 12, fontSize: compact ? 10 : 11,
      background: s.bg, color: s.color, fontWeight: 500, whiteSpace: 'nowrap',
    }}>
      {s.icon} {compact ? '' : s.label}
    </span>
  )
}

// ─────────────────────────────────────────────────────────────
// Add Device — USB-first flow
// ─────────────────────────────────────────────────────────────
export function AddDeviceModal({ onAdded, onClose }) {
  const [step, setStep]               = useState('scan')  // 'scan' | 'select' | 'registering' | 'done'
  const [usbDevices, setUsbDevices]   = useState([])
  const [customName, setCustomName]   = useState('')
  const [selected, setSelected]       = useState(null)
  const [busy, setBusy]               = useState(false)
  const [msg, setMsg]                 = useState('')

  const handleScan = async () => {
    setBusy(true); setMsg('')
    try {
      const r = await window.api.python.androidScanUsb()
      if (!r?.ok) {
        setMsg(`❌ ${r?.error || 'Сканування провалилось'}`)
      } else if (r.devices.length === 0) {
        setMsg('⚠️ Жодного USB пристрою не знайдено. Підключи телефон по кабелю і увімкни USB Debugging.')
      } else {
        setUsbDevices(r.devices)
        setStep('select')
        setMsg('')
      }
    } catch (e) { setMsg(`❌ ${String(e)}`) }
    setBusy(false)
  }

  const handleRegister = async (dev) => {
    setSelected(dev)
    setStep('registering')
    setBusy(true); setMsg('')
    try {
      const r = await window.api.python.androidRegisterUsb(dev.serial)
      if (!r?.ok) {
        setMsg(`❌ ${r?.error || 'Реєстрація провалилась'}`)
        setStep('select')
        setBusy(false); return
      }

      // Додаємо у БД (включно з wifi_mac для auto-rediscover при DHCP-зміні IP)
      const finalName = customName.trim() || dev.model || r.model || dev.serial
      const addR = await window.api.devices.add({
        name: finalName,
        serial: r.wifi_host,
        transport: 'wifi',
        wifi_host: r.wifi_host,
        wifi_mac: r.wifi_mac || dev.wifi_mac || null,
      })
      if (!addR.ok) {
        setMsg(`❌ ${addR.error}`)
        setStep('select')
        setBusy(false); return
      }

      setMsg(`✅ ${finalName} додано: ${r.wifi_host}`)
      setStep('done')
      setTimeout(() => onAdded?.(addR.device), 1200)
    } catch (e) {
      setMsg(`❌ ${String(e)}`)
      setStep('select')
    }
    setBusy(false)
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: 'var(--card-bg, #1a1a24)', borderRadius: 12, padding: 24,
          maxWidth: 560, width: '90%', maxHeight: '85vh', overflow: 'auto',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 600 }}>📱 Додати пристрій</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
              Підключення через USB кабель
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', fontSize: 22, cursor: 'pointer' }}>✕</button>
        </div>

        {step === 'scan' && (
          <div>
            <div style={{ padding: 16, background: 'rgba(99,102,241,0.08)', borderRadius: 10, marginBottom: 16, fontSize: 13, lineHeight: 1.6 }}>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>Перед скануванням:</div>
              <div>1. Підключи телефон по <b>USB кабелю</b></div>
              <div>2. На телефоні: <b>Developer Options → USB Debugging → ON</b></div>
              <div>3. Дозволь debug на цьому комп'ютері (ключ RSA)</div>
              <div>4. Телефон має бути у тій самій <b>Wi-Fi мережі</b></div>
            </div>
            <button
              className="btn-primary"
              onClick={handleScan}
              disabled={busy}
              style={{ width: '100%', padding: 14, fontSize: 14 }}
            >
              {busy ? '⏳ Сканую...' : '🔍 Сканувати USB пристрої'}
            </button>
            {msg && (
              <div style={{
                marginTop: 12, padding: 10, borderRadius: 6, fontSize: 12,
                background: msg.startsWith('⚠️') ? 'rgba(240,165,0,0.1)' : 'rgba(224,82,82,0.1)',
                color: msg.startsWith('⚠️') ? '#f0a500' : '#e05252',
              }}>{msg}</div>
            )}
          </div>
        )}

        {step === 'select' && (
          <div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10 }}>
              Знайдено <b>{usbDevices.length}</b> USB пристрій(їв). Обери який додати:
            </div>

            {usbDevices.map(dev => (
              <div
                key={dev.serial}
                style={{
                  padding: 14, marginBottom: 10, borderRadius: 10,
                  background: 'rgba(0,0,0,0.25)', border: '1px solid var(--border)',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 14, fontWeight: 600 }}>
                      📱 {dev.model || 'Unknown device'}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, fontFamily: 'monospace' }}>
                      USB: {dev.serial}
                    </div>
                    {dev.wifi_ip ? (
                      <div style={{ fontSize: 11, color: '#22c55e', marginTop: 2 }}>
                        Wi-Fi: {dev.wifi_ip}
                      </div>
                    ) : (
                      <div style={{ fontSize: 11, color: '#e05252', marginTop: 2 }}>
                        ⚠️ Не підключений до Wi-Fi
                      </div>
                    )}
                    {dev.android_version && (
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                        Android {dev.android_version}
                      </div>
                    )}
                  </div>
                  <button
                    className="btn-primary"
                    onClick={() => handleRegister(dev)}
                    disabled={busy || !dev.wifi_ip}
                    style={{ fontSize: 12, padding: '8px 16px' }}
                  >
                    Додати
                  </button>
                </div>
              </div>
            ))}

            <div style={{ marginTop: 16 }}>
              <label className="form-label" style={{ fontSize: 11 }}>
                Назва пристрою (необов'язково)
              </label>
              <input
                className="form-input"
                placeholder="Наприклад: Xiaomi Sofa, Робочий телефон..."
                value={customName}
                onChange={e => setCustomName(e.target.value)}
                style={{ fontSize: 13 }}
              />
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
                Якщо пусто — використається модель телефону
              </div>
            </div>

            <button className="btn-ghost" onClick={handleScan} disabled={busy}
                    style={{ width: '100%', marginTop: 12, fontSize: 12 }}>
              🔄 Сканувати знову
            </button>
            {msg && (
              <div style={{
                marginTop: 12, padding: 10, borderRadius: 6, fontSize: 12,
                background: 'rgba(224,82,82,0.1)', color: '#e05252',
              }}>{msg}</div>
            )}
          </div>
        )}

        {step === 'registering' && (
          <div style={{ textAlign: 'center', padding: 30 }}>
            <div style={{ fontSize: 40 }}>⏳</div>
            <div style={{ fontWeight: 600, marginTop: 12 }}>Реєструю пристрій...</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6 }}>
              adb tcpip 5555 → adb connect {selected?.wifi_ip}:5555
            </div>
          </div>
        )}

        {step === 'done' && (
          <div style={{ textAlign: 'center', padding: 30 }}>
            <div style={{ fontSize: 60 }}>✅</div>
            <div style={{ fontWeight: 600, marginTop: 12 }}>{msg.replace('✅ ', '')}</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>
              Кабель можна відключити — пристрій буде працювати по Wi-Fi
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// Device Card — grid style (like History posts)
// ─────────────────────────────────────────────────────────────
export function DeviceCard({ device, selected, status, accounts = [], onClick, onDelete, onReconnect, reconnecting }) {
  return (
    <div
      onClick={onClick}
      style={{
        padding: 14, borderRadius: 12, cursor: 'pointer',
        background: selected ? 'rgba(99,102,241,0.1)' : 'var(--card-bg, #1a1a24)',
        border: selected ? '2px solid #6366f1' : '1px solid var(--border)',
        transition: 'all 0.15s',
        display: 'flex', flexDirection: 'column', minHeight: 140,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, marginBottom: 10 }}>
        <div style={{ fontSize: 22 }}>📱</div>
        <StatusBadge status={status} compact />
      </div>

      <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {device.name}
      </div>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'monospace', marginBottom: 8 }}>
        {device.serial}
      </div>

      <div style={{ flex: 1 }} />

      <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 6 }}>
        {accounts.length}/2 акаунтів
      </div>
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        {accounts.map(a => (
          <span key={a.id} style={{
            fontSize: 10, padding: '2px 6px', borderRadius: 4,
            background: 'rgba(99,102,241,0.15)', color: '#818cf8',
          }}>
            @{a.username}
          </span>
        ))}
      </div>

      {selected && (
        <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
          {onReconnect && (
            <button
              onClick={e => { e.stopPropagation(); onReconnect() }}
              disabled={reconnecting}
              style={{
                flex: 1, background: 'transparent', border: '1px solid rgba(99,102,241,0.4)',
                color: reconnecting ? 'var(--text-muted)' : '#818cf8',
                fontSize: 11, padding: '6px 10px', borderRadius: 6,
                cursor: reconnecting ? 'wait' : 'pointer',
              }}
              title="Перевірити пінг і знайти новий IP за збереженою MAC-адресою"
            >
              {reconnecting ? '⏳ Шукаю…' : '🔄 Відновити'}
            </button>
          )}
          {onDelete && (
            <button
              onClick={e => { e.stopPropagation(); onDelete() }}
              style={{
                background: 'transparent', border: '1px solid rgba(224,82,82,0.3)',
                color: '#e05252', fontSize: 11, padding: '6px 10px', borderRadius: 6, cursor: 'pointer',
              }}
            >
              🗑
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// Add Device Card — tile зі знаком + для грід
// ─────────────────────────────────────────────────────────────
export function AddDeviceCard({ onClick }) {
  return (
    <div
      onClick={onClick}
      style={{
        padding: 14, borderRadius: 12, cursor: 'pointer',
        background: 'transparent',
        border: '2px dashed var(--border)',
        transition: 'all 0.15s',
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        minHeight: 140, color: 'var(--text-muted)',
      }}
      onMouseEnter={e => { e.currentTarget.style.borderColor = '#6366f1'; e.currentTarget.style.color = '#6366f1' }}
      onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = 'var(--text-muted)' }}
    >
      <div style={{ fontSize: 32, marginBottom: 6 }}>+</div>
      <div style={{ fontSize: 13, fontWeight: 500 }}>Додати пристрій</div>
      <div style={{ fontSize: 11, marginTop: 4, opacity: 0.7 }}>по USB кабелю</div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// Account Binder — прив'язка акаунтів до пристрою (до 2)
// ─────────────────────────────────────────────────────────────
export function AccountBinder({ device, onChanged }) {
  const [allAccounts, setAllAccounts] = useState([])
  const [boundAccounts, setBoundAccounts] = useState([])
  const [newUsername, setNewUsername] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  const reload = async () => {
    if (!device) return
    const all = await window.api.accounts.getAll()
    const bound = await window.api.devices.getAccounts(device.id)
    setAllAccounts(all || [])
    setBoundAccounts(bound || [])
  }

  useEffect(() => { reload() }, [device?.id])

  // Прив'язати акаунт (створити у БД якщо треба)
  const handleAdd = async () => {
    const username = newUsername.trim().toLowerCase().replace(/^@/, '')
    if (!username) return
    if (!/^[a-z0-9._]{1,30}$/.test(username)) {
      setMsg('❌ Невалідний username (тільки a-z, 0-9, ., _)')
      return
    }
    if (boundAccounts.length >= 2) {
      setMsg('❌ Максимум 2 акаунти на пристрій')
      return
    }
    if (boundAccounts.find(a => a.username === username)) {
      setMsg('⚠️ Цей акаунт уже прив\'язаний')
      return
    }

    setBusy(true); setMsg('')
    try {
      // Знаходимо або створюємо у БД
      let dbAcc = allAccounts.find(a => a.username === username)
      if (!dbAcc) {
        await window.api.accounts.add(username)
        const updated = await window.api.accounts.getAll()
        setAllAccounts(updated || [])
        dbAcc = (updated || []).find(a => a.username === username)
      }
      if (!dbAcc) { setMsg('❌ Не вдалось створити акаунт'); setBusy(false); return }

      // Прив'язуємо
      const r = await window.api.accounts.setDevice(dbAcc.id, device.id)
      if (!r.ok) { setMsg(`❌ ${r.error}`); setBusy(false); return }

      setMsg(`✅ @${username} прив'язано`)
      setNewUsername('')
      await reload()
      onChanged?.()
      setTimeout(() => setMsg(''), 2000)
    } catch (e) {
      setMsg(`❌ ${String(e)}`)
    }
    setBusy(false)
  }

  const handleUnbind = async (accountId) => {
    if (!confirm('Відв\'язати акаунт від пристрою?')) return
    await window.api.accounts.setDevice(accountId, null)
    await reload()
    onChanged?.()
  }

  return (
    <div>
      <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>
        🔗 Прив'язані акаунти ({boundAccounts.length}/2)
      </div>

      {boundAccounts.length === 0 && (
        <div style={{ padding: 10, fontSize: 12, color: 'var(--text-muted)', fontStyle: 'italic', marginBottom: 10 }}>
          Жоден акаунт не прив'язано. Додай нижче.
        </div>
      )}

      {boundAccounts.map(acc => (
        <div key={acc.id} style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: 8, marginBottom: 6, borderRadius: 6,
          background: 'rgba(99,102,241,0.08)',
        }}>
          <span style={{ fontSize: 13, fontWeight: 500 }}>@{acc.username}</span>
          <button
            onClick={() => handleUnbind(acc.id)}
            style={{ background: 'transparent', border: 'none', color: '#e05252', cursor: 'pointer', fontSize: 12 }}
          >
            Відв'язати
          </button>
        </div>
      ))}

      {/* Scan all accounts — find + link all logged-in IG accounts on device */}
      <div style={{ marginTop: 8, marginBottom: 8 }}>
        <button
          className="btn-secondary"
          disabled={busy}
          onClick={async () => {
            setBusy(true); setMsg('⏳ Відкриваю IG → Profile → Account switcher...')
            try {
              const r = await window.api.devices.scanAccounts(device.id)
              if (!r?.ok) { setMsg(`❌ ${r?.error || 'Не вдалось'}`); setBusy(false); return }
              const found = r.accounts || []
              const linked = r.linked || []
              const created = r.created || []
              if (found.length === 0) {
                setMsg('⚠️ Жодного IG акаунту не знайдено')
              } else {
                const parts = [`🔎 Знайдено ${found.length}: ${found.map(u => '@'+u).join(', ')}`]
                if (created.length) parts.push(`створено: ${created.length}`)
                if (linked.length) parts.push(`прив'язано: ${linked.length}`)
                if (!r.switcher_opened && found.length === 1) parts.push('(switcher недоступний — можливо залогінено тільки 1)')
                setMsg('✅ ' + parts.join(' · '))
                await reload()
                onChanged?.()
              }
            } catch (e) { setMsg(`❌ ${String(e)}`) }
            setBusy(false)
          }}
          style={{ width: '100%', fontSize: 12 }}
          title="Сканує IG на цьому пристрої, додає всіх залогінених акаунтів у БД і прив'язує до цього device"
        >
          {busy ? '⏳ Сканую...' : '🔎 Знайти і прив\'язати всі акаунти з цього пристрою'}
        </button>
      </div>

      {/* Форма ручного додавання */}
      {boundAccounts.length < 2 && (
        <div style={{ marginTop: 12, padding: 10, background: 'rgba(0,0,0,0.2)', borderRadius: 8 }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>
            Або додати вручну (Instagram username, залогінений на цьому телефоні):
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              className="form-input"
              placeholder="@username"
              value={newUsername}
              onChange={e => setNewUsername(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleAdd()}
              disabled={busy}
              style={{ flex: 1, fontSize: 13 }}
            />
            <button
              className="btn-ghost"
              onClick={async () => {
                setBusy(true); setMsg('⏳ Відкриваю IG → Profile tab...')
                try {
                  const r = await window.api.python.androidActiveAccount(device.serial)
                  if (r?.ok) {
                    setNewUsername(r.username)
                    setMsg(`✅ Знайдено: @${r.username}`)
                  } else {
                    setMsg(`❌ ${r?.error || 'Не вдалось'}`)
                  }
                } catch (e) { setMsg(`❌ ${String(e)}`) }
                setBusy(false)
              }}
              disabled={busy}
              style={{ fontSize: 12, padding: '0 12px' }}
              title="Відкрити IG → Profile tab → прочитати username активного"
            >
              🔍 Активний
            </button>
            <button
              className="btn-primary"
              onClick={handleAdd}
              disabled={busy || !newUsername.trim()}
              style={{ fontSize: 12, padding: '0 16px' }}
            >
              {busy ? '⏳' : 'Додати'}
            </button>
          </div>
          {msg && (
            <div style={{
              marginTop: 8, padding: 6, borderRadius: 4, fontSize: 11,
              background: msg.startsWith('✅') ? 'rgba(34,197,94,0.1)' : msg.startsWith('⚠️') ? 'rgba(240,165,0,0.1)' : 'rgba(224,82,82,0.1)',
              color: msg.startsWith('✅') ? '#22c55e' : msg.startsWith('⚠️') ? '#f0a500' : '#e05252',
            }}>{msg}</div>
          )}
        </div>
      )}
      {!(boundAccounts.length < 2) && msg && (
        <div style={{
          marginTop: 8, padding: 6, borderRadius: 4, fontSize: 11,
          background: msg.startsWith('✅') ? 'rgba(34,197,94,0.1)' : msg.startsWith('⚠️') ? 'rgba(240,165,0,0.1)' : 'rgba(224,82,82,0.1)',
          color: msg.startsWith('✅') ? '#22c55e' : msg.startsWith('⚠️') ? '#f0a500' : '#e05252',
        }}>{msg}</div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// Segment Control — Run Now vs Schedule
// ─────────────────────────────────────────────────────────────
export function SegmentControl({ value, onChange, options, disabledOption }) {
  return (
    <div style={{
      display: 'inline-flex', padding: 4, background: 'rgba(0,0,0,0.25)',
      borderRadius: 10, gap: 2,
    }}>
      {options.map(opt => {
        const active = value === opt.value
        const disabled = disabledOption === opt.value
        return (
          <button
            key={opt.value}
            onClick={() => !disabled && onChange(opt.value)}
            disabled={disabled}
            title={disabled ? 'Недоступно — інший режим активний' : ''}
            style={{
              padding: '10px 20px', fontSize: 13, fontWeight: 600, border: 'none',
              borderRadius: 8, cursor: disabled ? 'not-allowed' : 'pointer',
              background: active ? '#6366f1' : 'transparent',
              color: active ? '#fff' : (disabled ? 'var(--text-muted)' : 'var(--text-secondary)'),
              opacity: disabled ? 0.5 : 1,
              transition: 'all 0.15s',
            }}
          >
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}
