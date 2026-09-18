const { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, shell } = require('electron')
const path = require('path')
const { spawn } = require('child_process')
const http = require('http')
const db = require('./database')
const { getSettings, saveSettings } = require('./store')

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged
const PYTHON_PORT = 8765
let pythonProcess = null
let mainWindow = null
let tray = null
let isQuitting = false

// Hybrid GPU fix (NVIDIA MX450 + Intel Iris Xe): уникаємо GPU switching при focus вікна
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu-compositing')
app.commandLine.appendSwitch('disable-software-rasterizer')

// Single instance — другий екземпляр просто підняв перше вікно
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      if (!mainWindow.isVisible()) mainWindow.show()
      mainWindow.focus()
    }
  })
}

// ===== PYTHON SERVER =====

let pythonStoppedManually = false
let pythonRespawnAttempts = 0

function startPython() {
  const pythonDir = isDev
    ? path.join(__dirname, '../python')
    : path.join(process.resourcesPath, 'python')
  const scriptPath = path.join(pythonDir, 'main.py')

  // Перевіряємо чи Python вже запущений на порту
  const checkExisting = () => new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${PYTHON_PORT}/health`, (res) => {
      let data = ''
      res.on('data', c => data += c)
      res.on('end', () => resolve(data.includes('"ok"')))
    })
    req.on('error', () => resolve(false))
    req.setTimeout(2000, () => { req.destroy(); resolve(false) })
  })

  checkExisting().then(exists => {
    if (exists) {
      console.log('[Python] Already running on port', PYTHON_PORT, '— skipping spawn')
      return
    }
    trySpawn('python')
  })

  const trySpawn = (cmd) => {
    const proc = spawn(cmd, [scriptPath], {
      cwd: pythonDir,
      env: {
        ...process.env,
        PORT: String(PYTHON_PORT),
        PYTHONUNBUFFERED: '1',
        PYTHONIOENCODING: 'utf-8',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    // Лог-файл для діагностики (особливо AI рішень)
    const fs = require('fs')
    const logPath = path.join(app.getPath('userData'), 'python.log')
    try {
      const header = `\n=== Python session started ${new Date().toISOString()} ===\n`
      fs.appendFileSync(logPath, header)
    } catch (e) {}
    const writeLog = (line) => { try { fs.appendFileSync(logPath, line) } catch (e) {} }

    proc.stdout.setEncoding('utf8')
    proc.stderr.setEncoding('utf8')

    proc.stdout.on('data', (msg) => {
      writeLog(msg)
      // Виводимо AI рішення та інші важливі логи в консоль
      if (msg.includes('[AI]') || msg.includes('[ERROR]') || msg.includes('Traceback')) {
        process.stdout.write('[Python] ' + msg)
      }
    })

    proc.stderr.on('data', (msg) => {
      writeLog(msg)
      // Uvicorn пише в stderr — це нормально
      if (!msg.includes('INFO') && !msg.includes('WARNING')) {
        console.error('[Python]', msg)
      }
    })

    proc.on('exit', (code) => {
      console.log(`[Python] exited with code ${code}`)
      writeLog(`\n=== exited with code ${code} ===\n`)
      pythonProcess = null
      isAuthorized = false  // скидаємо авторизацію при перезапуску сервера

      // Auto-respawn якщо вихід НЕ був запрошений (crash, oom, unicode error тощо).
      // Exponential backoff 1s → 3s → 10s → 30s. Після 4 невдач чекаємо 60s і починаємо заново.
      if (!pythonStoppedManually && !app.isQuitting) {
        const backoffs = [1000, 3000, 10000, 30000]
        const delay = backoffs[Math.min(pythonRespawnAttempts, backoffs.length - 1)]
        pythonRespawnAttempts += 1
        console.log(`[Python] auto-respawn #${pythonRespawnAttempts} in ${delay}ms`)
        setTimeout(() => {
          if (!pythonStoppedManually && !app.isQuitting) {
            startPython()
            // Якщо respawn триматиметься здоровим >30s — скинемо counter
            setTimeout(() => {
              if (pythonProcess) pythonRespawnAttempts = 0
            }, 30000)
          }
        }, delay)
      }
    })

    proc.on('error', (err) => {
      if (cmd === 'python' && err.code === 'ENOENT') {
        console.log('[Python] "python" not found, trying "python3"...')
        trySpawn('python3')
      } else {
        console.error('[Python] spawn error:', err.message)
      }
    })

    pythonProcess = proc
  }
}

function stopPython() {
  pythonStoppedManually = true
  if (pythonProcess) {
    pythonProcess.kill()
    pythonProcess = null
  }
}

function waitForPython(retries = 20) {
  return new Promise((resolve, reject) => {
    const attempt = (n) => {
      http.get(`http://127.0.0.1:${PYTHON_PORT}/health`, (res) => {
        resolve(true)
      }).on('error', () => {
        if (n <= 0) return reject(new Error('Python server did not start'))
        setTimeout(() => attempt(n - 1), 500)
      })
    }
    attempt(retries)
  })
}

async function pyFetch(path, options = {}) {
  // Один retry при transient network errors (WinError 10054, ECONNRESET).
  // Це трапляється коли Python закриває keep-alive з'єднання а Windows SOCKET
  // не встигає доставити response.
  return pyFetchOnce(path, options).then((r) => {
    const transient = r?.error && (
      /10054|ECONNRESET|ECONNABORTED|socket hang up/i.test(String(r.error)) ||
      /terminated|aborted|hang up/i.test(String(r.error))
    )
    if (transient && !options.__retried) {
      console.warn(`[pyFetch] transient error on ${path}, retrying once:`, r.error)
      return pyFetchOnce(path, { ...options, __retried: true })
    }
    return r
  })
}

function pyFetchOnce(path, options = {}) {
  return new Promise((resolve) => {
    const url = `http://127.0.0.1:${PYTHON_PORT}${path}`
    const method = options.method || 'GET'
    const body = options.body ? JSON.stringify(options.body) : null
    const timeout = options.timeout || 30000

    const req = http.request(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      timeout,
      // Disable keep-alive: Windows SOCKET sometimes kills idle connections
      // between Electron and Python uvicorn, surfacing as WinError 10054.
      agent: new http.Agent({ keepAlive: false }),
    }, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        try { resolve(JSON.parse(data)) }
        catch { resolve({ ok: false, error: `Невірна відповідь від сервера: ${data.slice(0, 200)}` }) }
      })
    })

    req.on('timeout', () => {
      req.destroy()
      resolve({ ok: false, error: 'Python сервер не відповідає. Перезапустіть додаток.' })
    })

    req.on('error', (e) => {
      if (e.code === 'ECONNREFUSED') {
        resolve({ ok: false, error: 'Python сервер не запущений. Перезапустіть додаток.' })
      } else {
        resolve({ ok: false, error: e.message, code: e.code })
      }
    })

    if (body) req.write(body)
    req.end()
  })
}

// ===== WINDOW =====

function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show()
    mainWindow.focus()
    return mainWindow
  }

  const startHidden = process.argv.includes('--hidden')
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#1a1a2e',
    icon: path.join(__dirname, 'tray-icon.png'),
    show: !startHidden,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  })

  // Перехоплюємо close → замість quit ховаємо у трей
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault()
      mainWindow.hide()
      // Перше приховування — показати підказку
      if (tray && !mainWindow._trayHintShown) {
        mainWindow._trayHintShown = true
        tray.displayBalloon?.({
          title: 'Reels Generator',
          content: 'Додаток згорнуто у трей. Планувальник прогріву продовжує працювати.',
        })
      }
    }
  })

  mainWindow.on('closed', () => { mainWindow = null })

  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'Файл',
      submenu: [
        { label: 'Згорнути у трей', accelerator: 'CmdOrCtrl+W', click: () => mainWindow?.hide() },
        { type: 'separator' },
        { label: 'Вихід', accelerator: 'CmdOrCtrl+Q', click: () => { isQuitting = true; app.quit() } },
      ],
    },
    {
      label: 'Вигляд',
      submenu: [
        { role: 'reload', label: 'Оновити' },
        { role: 'toggleDevTools', label: 'Інструменти розробника' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Повноекранний режим' },
      ],
    },
    { label: 'Вікно', submenu: [{ role: 'minimize', label: 'Згорнути' }, { role: 'zoom', label: 'Розгорнути' }] },
    { label: 'Допомога', submenu: [{ label: 'Про програму', click: () => {} }] },
  ]))

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173')
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }

  return mainWindow
}

// ===== TRAY =====

function createTray() {
  if (tray) return tray

  const iconPath = path.join(__dirname, 'tray-icon.png')
  let image = nativeImage.createFromPath(iconPath)
  if (image.isEmpty()) {
    // Фолбек: прозора 16x16 іконка (як мінімум щось покажеться)
    image = nativeImage.createEmpty()
  }

  tray = new Tray(image)
  tray.setToolTip('Reels Generator')

  const buildMenu = () => {
    let nextLabel = 'Немає запланованих сесій'
    try {
      const all = db.getWarmupSessions() || []
      const upcoming = all.filter(s => s.status === 'pending').sort(
        (a, b) => new Date(a.scheduled_at) - new Date(b.scheduled_at)
      )
      if (upcoming[0]) {
        nextLabel = `Наступна: ${new Date(upcoming[0].scheduled_at).toLocaleString('uk-UA')}`
      }
    } catch {}

    return Menu.buildFromTemplate([
      { label: 'Reels Generator', enabled: false },
      { type: 'separator' },
      { label: 'Відкрити', click: () => { createWindow(); mainWindow?.show(); mainWindow?.focus() } },
      { label: nextLabel, enabled: false },
      {
        label: 'Запустити прогрів зараз',
        click: async () => {
          try {
            const all = db.getWarmupSessions?.() || []
            const p = all.filter(s => s.status === 'pending')
            if (p.length === 0) {
              tray.displayBalloon?.({ title: 'Reels Generator', content: 'Немає запланованих сесій' })
              return
            }
            db.updateWarmupSession(p[0].id, { scheduled_at: new Date(Date.now() - 1000).toISOString() })
            tray.displayBalloon?.({ title: 'Reels Generator', content: `Сесію #${p[0].id} запущено` })
          } catch (e) {
            console.error('[Tray] trigger failed:', e)
          }
        },
      },
      { type: 'separator' },
      { label: 'Вихід', click: () => { isQuitting = true; app.quit() } },
    ])
  }

  tray.setContextMenu(buildMenu())
  // Оновлюємо меню кожні 30 сек (щоб напис "наступна сесія" був актуальним)
  setInterval(() => { try { tray.setContextMenu(buildMenu()) } catch {} }, 30000)

  // Клік на іконку в треї → показати/приховати вікно
  tray.on('click', () => {
    if (mainWindow?.isVisible()) mainWindow.hide()
    else { createWindow(); mainWindow?.show(); mainWindow?.focus() }
  })

  return tray
}

// ===== IPC: DATABASE =====

ipcMain.handle('accounts:getAll',    ()                  => db.getAllAccounts())
ipcMain.handle('accounts:add',       (_, username)       => db.addAccount(username))
ipcMain.handle('accounts:delete',    (_, id)             => db.deleteAccount(id))
ipcMain.handle('accounts:update',    (_, username, data) => db.updateAccount(username, data))
ipcMain.handle('accounts:setDevice', (_, accountId, deviceId) => {
  try { db.setAccountDevice(accountId, deviceId); return { ok: true } }
  catch (e) { return { ok: false, error: String(e.message || e) } }
})

// Devices
ipcMain.handle('devices:getAll',  () => db.getAllDevices())
ipcMain.handle('devices:get',     (_, id) => db.getDevice(id))
ipcMain.handle('devices:getByAccount', (_, accountId) => {
  const acc = db.getAllAccounts().find(a => a.id === accountId)
  return acc?.device_id ? db.getDevice(acc.device_id) : null
})
ipcMain.handle('devices:getAccounts', (_, deviceId) => db.getAccountsByDevice(deviceId))
ipcMain.handle('devices:add', (_, payload) => {
  try {
    const existing = db.getDeviceBySerial(payload.serial)
    if (existing) return { ok: false, error: 'Пристрій з таким serial вже існує' }
    const id = db.addDevice(payload)
    return { ok: true, id, device: db.getDevice(id) }
  } catch (e) { return { ok: false, error: String(e.message || e) } }
})
ipcMain.handle('devices:update', (_, id, data) => {
  try { db.updateDevice(id, data); return { ok: true, device: db.getDevice(id) } }
  catch (e) { return { ok: false, error: String(e.message || e) } }
})
ipcMain.handle('devices:delete', (_, id) => {
  try { db.deleteDevice(id); return { ok: true } }
  catch (e) { return { ok: false, error: String(e.message || e) } }
})

// Reconnect — multi-stage device recovery:
//   1. Ping saved serial (might already be alive)
//   2. If dead + we have MAC → rediscover-by-mac (ARP table lookup)
//   3. Still dead → scan USB-connected devices, match by wifi_mac,
//      run register-usb (adb tcpip 5555 + connect) to bootstrap WiFi
//   4. Update DB on success
ipcMain.handle('devices:reconnect', async (_, id) => {
  try {
    const dev = db.getDevice(id)
    if (!dev) return { ok: false, error: 'Пристрій не знайдено' }
    if (!dev.serial) return { ok: false, error: 'У пристрою немає serial' }

    const before = dev.serial

    // Stage 1: ping current serial.
    let ping
    try {
      ping = await pyFetch('/android/ping-device', {
        method: 'POST', body: { host: before }, timeout: 5000,
      })
    } catch { ping = { ok: false } }
    if (ping?.ok) {
      return { ok: true, changed: false, serial: before, message: 'З\'єднання вже працює' }
    }

    // Stage 2: ARP-table lookup by MAC.
    if (dev.wifi_mac) {
      let rd
      try {
        rd = await pyFetch('/android/rediscover-by-mac', {
          method: 'POST', body: { wifi_mac: dev.wifi_mac }, timeout: 30000,
        })
      } catch (e) { rd = { ok: false, error: String(e.message || e) } }
      if (rd?.ok && rd.wifi_host && rd.wifi_host !== before) {
        try { db.updateDevice(id, { serial: rd.wifi_host, wifi_host: rd.wifi_host }) } catch {}
        return { ok: true, changed: true, serial: rd.wifi_host, method: 'mac',
                 message: `IP оновлено по MAC: ${before} → ${rd.wifi_host}` }
      }
    }

    // Stage 3: USB fallback. Scan USB-connected devices, match by MAC if
    // we have one (otherwise try the only USB device if exactly one is
    // attached). Then bootstrap WiFi via register-usb.
    let scan
    try {
      scan = await pyFetch('/android/scan-usb', { method: 'GET', timeout: 15000 })
    } catch { scan = { ok: false, devices: [] } }
    const usbDevices = scan?.devices || []

    if (!usbDevices.length) {
      return { ok: false, changed: false, serial: before,
               error: 'Пристрій не відповідає по Wi-Fi і не підключений по USB. Підключи кабель і спробуй знову.' }
    }

    // Pick the right USB device: prefer MAC match, else single attached.
    let target = null
    if (dev.wifi_mac) {
      const targetMac = dev.wifi_mac.toLowerCase().replace(/-/g, ':')
      target = usbDevices.find(d =>
        d.wifi_mac && d.wifi_mac.toLowerCase().replace(/-/g, ':') === targetMac
      )
    }
    if (!target && usbDevices.length === 1) target = usbDevices[0]
    if (!target) {
      return { ok: false, changed: false, serial: before,
               error: `По USB видно ${usbDevices.length} пристроїв, але жоден не збігається по MAC. Залиш підключеним тільки цей телефон і спробуй ще раз.` }
    }
    if (!target.wifi_ip) {
      return { ok: false, changed: false, serial: before,
               error: 'USB-пристрій знайдено, але Wi-Fi на ньому вимкнено. Увімкни Wi-Fi на телефоні.' }
    }

    // Stage 3b: register-usb to bootstrap WiFi ADB.
    let reg
    try {
      reg = await pyFetch('/android/register-usb', {
        method: 'POST', body: { serial: target.serial }, timeout: 20000,
      })
    } catch (e) { reg = { ok: false, error: String(e.message || e) } }
    if (!reg?.ok || !reg.wifi_host) {
      return { ok: false, changed: false, serial: before,
               error: `USB bootstrap fail: ${reg?.error || 'unknown'}` }
    }

    // Update DB. Carry through fresh MAC if discovered.
    try {
      const upd = { serial: reg.wifi_host, wifi_host: reg.wifi_host }
      if (reg.wifi_mac) upd.wifi_mac = reg.wifi_mac
      db.updateDevice(id, upd)
    } catch {}

    return { ok: true, changed: true, serial: reg.wifi_host, method: 'usb',
             message: `Перепідключено по USB: ${before} → ${reg.wifi_host}` }
  } catch (e) {
    return { ok: false, error: String(e.message || e) }
  }
})

// Сканує IG акаунти на пристрої і зв'язує їх з device в БД.
// Нові акаунти створює, існуючим оновлює device_id.
ipcMain.handle('devices:scanAccounts', async (_, deviceId) => {
  try {
    const dev = db.getDevice(deviceId)
    if (!dev) return { ok: false, error: 'Device not found' }
    let serial = dev.serial

    // Якщо Wi-Fi — ensure connection
    if (serial && /^\d+\.\d+\.\d+\.\d+:\d+$/.test(serial)) {
      const ensure = await pyFetch('/android/ensure-wifi', {
        method: 'POST', body: { saved_host: serial }, timeout: 20000,
      })
      if (!ensure.ok) return { ok: false, error: `WiFi: ${ensure.error || 'unknown'}` }
      if (ensure.host && ensure.host !== serial) serial = ensure.host
    }

    // Python scan — відкриває IG, tap Profile, читає active + account switcher
    const scan = await pyFetch('/android/all-accounts', {
      method: 'POST', body: { serial }, timeout: 60000,
    })
    if (!scan.ok) return { ok: false, error: scan.error || 'scan failed' }

    const allFound = (scan.all || []).map(u => String(u).toLowerCase().trim().replace(/^@/, ''))
      .filter(u => /^[a-z0-9._]{1,30}$/.test(u))

    const active = scan.active ? String(scan.active).toLowerCase().trim().replace(/^@/, '') : null

    // Upsert accounts: існуючий (unique by username) — оновлюємо device_id.
    // Новий — створюємо і прив'язуємо.
    const created = []
    const linked = []
    const errors = []
    for (const username of allFound) {
      let acc = db.getAllAccounts().find(a => a.username.toLowerCase() === username)
      if (!acc) {
        try { db.addAccount(username) } catch (e) { errors.push(`${username}: ${e.message || e}`); continue }
        acc = db.getAllAccounts().find(a => a.username.toLowerCase() === username)
        if (acc) created.push(username)
      }
      if (acc && acc.device_id !== deviceId) {
        try { db.setAccountDevice(acc.id, deviceId); linked.push(username) }
        catch (e) { errors.push(`${username} link: ${e.message || e}`) }
      }
    }

    return {
      ok: true,
      active,
      accounts: allFound,
      created,
      linked,
      errors: errors.length ? errors : undefined,
      switcher_opened: scan.debug?.switcher_opened ?? false,
    }
  } catch (e) {
    return { ok: false, error: String(e.message || e) }
  }
})

// Warmup config (per-account)
ipcMain.handle('warmup:getConfig',   (_, accountId) => db.getWarmupConfig(accountId))
ipcMain.handle('warmup:saveConfig',  (_, accountId, config) => {
  try { db.upsertWarmupConfig(accountId, config); return { ok: true } }
  catch (e) { return { ok: false, error: String(e.message || e) } }
})

// Instagram active account detection
ipcMain.handle('python:androidActiveAccount', (_, serial) =>
  pyFetch('/android/active-account', { method: 'POST', body: { serial: serial || null }, timeout: 20000 })
)
ipcMain.handle('python:androidAllAccounts', (_, serial) =>
  pyFetch('/android/all-accounts', { method: 'POST', body: { serial: serial || null }, timeout: 25000 })
)

ipcMain.handle('reels:getByAccount',   (_, accountId, sortBy)       => db.getReelsByAccount(accountId, sortBy))
ipcMain.handle('reels:upsert',         (_, accountId, reel)          => db.upsertReel(accountId, reel))
ipcMain.handle('reels:markDownloaded', (_, reelId, downloadPath)     => db.markReelDownloaded(reelId, downloadPath))
ipcMain.handle('reels:updateViews',    (_, reelId, views)            => db.updateReelViews(reelId, views))

ipcMain.handle('stats:get',      ()      => db.getStats())
ipcMain.handle('shell:openExternal', (_, url) => shell.openExternal(url))

// ===== IPC: MOBAI (iPhone bridge) =====

const MOBAI_BASE = 'http://127.0.0.1:8686/api/v1'

ipcMain.handle('mobai:devices', async () => {
  try {
    const resp = await fetch(`${MOBAI_BASE}/devices`)
    if (!resp.ok) return { error: `HTTP ${resp.status}` }
    const data = await resp.json()
    return { devices: data }
  } catch (e) {
    return { error: e.message }
  }
})

ipcMain.handle('mobai:clipboard:get', async (_, deviceId) => {
  try {
    const resp = await fetch(`${MOBAI_BASE}/devices/${deviceId}/clipboard`)
    if (!resp.ok) return { error: `HTTP ${resp.status}` }
    const data = await resp.json()
    return { text: data.text || '' }
  } catch (e) {
    return { error: e.message }
  }
})

ipcMain.handle('mobai:clipboard:set', async (_, deviceId, text) => {
  try {
    const resp = await fetch(`${MOBAI_BASE}/devices/${deviceId}/clipboard`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    })
    if (!resp.ok) return { error: `HTTP ${resp.status}` }
    return { success: true }
  } catch (e) {
    return { error: e.message }
  }
})

ipcMain.handle('mobai:type', async (_, deviceId, text) => {
  try {
    const resp = await fetch(`${MOBAI_BASE}/devices/${deviceId}/type`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    })
    if (!resp.ok) return { error: `HTTP ${resp.status}` }
    return { success: true }
  } catch (e) {
    return { error: e.message }
  }
})

ipcMain.handle('mobai:screenshot', async (_, deviceId) => {
  try {
    const resp = await fetch(`${MOBAI_BASE}/devices/${deviceId}/screenshot`)
    if (!resp.ok) return { error: `HTTP ${resp.status}` }
    const data = await resp.json()
    return { path: data.path }
  } catch (e) {
    return { error: e.message }
  }
})

ipcMain.handle('mobai:ocr', async (_, deviceId) => {
  try {
    const resp = await fetch(`${MOBAI_BASE}/devices/${deviceId}/ocr`)
    if (!resp.ok) return { error: `HTTP ${resp.status}` }
    const data = await resp.json()
    // Повертаємо масив текстових елементів
    const texts = (data.elements || []).map(el => el.text).filter(t => t && t.trim())
    return { texts, raw: data }
  } catch (e) {
    return { error: e.message }
  }
})
ipcMain.handle('settings:get',   ()      => getSettings())
ipcMain.handle('settings:save',  (_, d)  => saveSettings(d))

// ===== IPC: PYTHON =====

let isAuthorized = false

ipcMain.handle('python:status', () =>
  pyFetch('/health').then(r => ({ running: r.status === 'ok' })).catch(() => ({ running: false }))
)

// Авторизація — викликається з Settings
ipcMain.handle('python:login', async (_, sessionId) => {
  const result = await pyFetch('/auth/login', { method: 'POST', body: { session_id: sessionId } })
  if (result.ok) isAuthorized = true
  return result
})

// Тест сесії — повертає детальний результат
ipcMain.handle('python:testSession', async () => {
  const settings = await getSettings()
  const sessionId = settings?.instagram?.sessionId?.trim()
  if (!sessionId) return { ok: false, error: 'Session ID порожній. Введіть його в Налаштуваннях.' }
  const result = await pyFetch('/auth/login', { method: 'POST', body: { session_id: sessionId } })
  if (result.ok) isAuthorized = true
  return result
})

async function ensureLoggedIn() {
  // Якщо вже авторизовані — не логінимось знову
  if (isAuthorized) return { ok: true }
  const settings = await getSettings()
  const sessionId = settings?.instagram?.sessionId?.trim()
  if (!sessionId) return { ok: false, error: 'Session ID порожній. Введіть його в Налаштуваннях і збережіть.' }
  const result = await pyFetch('/auth/login', { method: 'POST', body: { session_id: sessionId } })
  if (result.ok) isAuthorized = true
  return result
}

ipcMain.handle('python:parseAccount', async (_, username) => {
  const auth = await ensureLoggedIn()
  if (!auth.ok) return auth
  const info = await pyFetch(`/account/${username}`)
  if (info.ok) db.updateAccount(username, info)
  return info
})

ipcMain.handle('python:parseReels', async (_, username, accountId, amount = 50) => {
  const auth = await ensureLoggedIn()
  if (!auth.ok) return auth
  const result = await pyFetch(`/reels/${username}?amount=${amount}`)
  if (result.ok && result.reels) {
    for (const reel of result.reels) {
      db.upsertReel(accountId, reel)
    }
    return { ok: true, count: result.reels.length }
  }
  return result
})

ipcMain.handle('python:downloadReel', (_, videoUrl, savePath) =>
  pyFetch('/download', { method: 'POST', body: { video_url: videoUrl, save_path: savePath } })
)

// Збагачення переглядів — прямий HTTP-запит до Instagram API
ipcMain.handle('python:enrichViews', async (event, reelIds) => {
  const settings = await getSettings()
  const sessionId = settings?.instagram?.sessionId?.trim()
  if (!sessionId) return { ok: false, error: 'Session ID порожній. Введіть його в Налаштуваннях.' }

  return new Promise((resolve) => {
    const url = `http://127.0.0.1:${PYTHON_PORT}/reels/enrich`
    const body = JSON.stringify({ reel_ids: reelIds, session_id: sessionId })
    let updated = 0

    const req = http.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      timeout: 600000, // 10 хвилин для великої кількості
    }, (res) => {
      let buffer = ''
      let authFailed = false
      res.on('data', (chunk) => {
        buffer += chunk.toString()
        const lines = buffer.split('\n')
        buffer = lines.pop()

        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const data = JSON.parse(line)
            // Handle auth error - stop updating
            if (data.status === 'auth_error' || data.error) {
              authFailed = true
              const wins = BrowserWindow.getAllWindows()
              if (wins.length > 0) {
                wins[0].webContents.send('enrich:progress', {
                  index: data.index || 0,
                  total: data.total || 0,
                  updated,
                  error: data.error || 'Auth error',
                })
              }
              continue
            }
            if (data.views > 0 && data.status === 'ok') {
              db.updateReelViews(data.reel_id, data.views)
              updated++
            }
            const wins = BrowserWindow.getAllWindows()
            if (wins.length > 0) {
              wins[0].webContents.send('enrich:progress', {
                index: data.index,
                total: data.total,
                updated,
                status: data.status,
              })
            }
          } catch (parseErr) {
            // Ignore parse errors - don't crash
          }
        }
      })
      res.on('end', () => {
        if (buffer.trim()) {
          try {
            const err = JSON.parse(buffer)
            if (err.ok === false) return resolve(err)
          } catch {}
        }
        resolve({ ok: true, updated, authFailed })
      })
      res.on('error', () => resolve({ ok: true, updated }))
    })

    req.on('error', (e) => resolve({ ok: false, error: e.message }))
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'Timeout (10 min)' }) })
    req.write(body)
    req.end()
  })
})

// ===== GENERATION =====

ipcMain.handle('python:generateFull', async (event, params) => {
  return new Promise((resolve) => {
    const url = `http://127.0.0.1:${PYTHON_PORT}/generate/full`
    const body = JSON.stringify(params)
    let lastUpdate = null

    const req = http.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      timeout: 600000, // 10 min
    }, (res) => {
      let buffer = ''
      res.on('data', (chunk) => {
        buffer += chunk.toString()
        const lines = buffer.split('\n')
        buffer = lines.pop()

        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const data = JSON.parse(line)
            lastUpdate = data
            const wins = BrowserWindow.getAllWindows()
            if (wins.length > 0) {
              wins[0].webContents.send('generate:progress', data)
            }
          } catch {}
        }
      })
      res.on('end', () => {
        if (buffer.trim()) {
          try {
            const data = JSON.parse(buffer)
            lastUpdate = data
          } catch {}
        }
        if (lastUpdate && lastUpdate.status === 'error') {
          resolve({ ok: false, error: lastUpdate.message })
        } else if (lastUpdate && lastUpdate.step === 'compose' && lastUpdate.status === 'done') {
          resolve({ ok: true, path: lastUpdate.path })
        } else {
          resolve({ ok: false, error: 'Невідома помилка генерації' })
        }
      })
    })

    req.on('error', (e) => resolve({ ok: false, error: e.message }))
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'Timeout генерації (10 хв)' }) })
    req.write(body)
    req.end()
  })
})

// ===== PROMPTS =====

ipcMain.handle('python:generateImage',   (_, p) => pyFetch('/generate/image',   { method: 'POST', body: p, timeout: 120000 }))
ipcMain.handle('python:generateVideo',   (_, p) => pyFetch('/generate/video',   { method: 'POST', body: p, timeout: 600000 }))
ipcMain.handle('python:generateCompose', (_, p) => pyFetch('/generate/compose', { method: 'POST', body: p, timeout: 600000 }))
// Post/Carousel (1:1) — той же pipeline що Reels (Claude Sonnet + Google Flow)
ipcMain.handle('python:generatePostImage',       (_, p) => pyFetch('/generate/post-image',       { method: 'POST', body: p, timeout: 300000 }))  // Flow Playwright може тривати 2-3 хв
ipcMain.handle('python:generateCarouselPrompts', (_, p) => pyFetch('/generate/carousel-prompts', { method: 'POST', body: p, timeout: 300000 }))  // Claude CLI × N
ipcMain.handle('python:carouselAgentRun',    (_, p) => pyFetch('/carousel-agent/run',    { method: 'POST', body: p, timeout: 600000 }))
ipcMain.handle('python:carouselAgentIdea',   (_, p) => pyFetch('/carousel-agent/idea',   { method: 'POST', body: p, timeout: 300000 }))
ipcMain.handle('python:carouselAgentSlides', (_, p) => pyFetch('/carousel-agent/slides', { method: 'POST', body: p, timeout: 300000 }))
ipcMain.handle('python:renderPostOverlay',       (_, p) => pyFetch('/render/post-overlay',       { method: 'POST', body: p, timeout: 30000  }))  // PIL quick

ipcMain.handle('python:extractAudio', async (_, reelId, videoUrl) => {
  const settings = await getSettings()
  const sessionId = settings.instagram?.sessionId || ''
  return pyFetch('/extract-audio', { method: 'POST', body: { reel_id: reelId, video_url: videoUrl, session_id: sessionId }, timeout: 60000 })
})

ipcMain.handle('python:flowSetup', () => pyFetch('/flow/setup'))
ipcMain.handle('python:generateFlow', (_, params) =>
  pyFetch('/generate/flow', { method: 'POST', body: params, timeout: 180000 })
)
ipcMain.handle('python:generatePrompt', (_, params) =>
  pyFetch('/generate/prompt', { method: 'POST', body: params, timeout: 120000 })
)
ipcMain.handle('python:downloadFlowLatest', (_, params) =>
  pyFetch('/generate/flow-latest', { method: 'POST', body: params, timeout: 120000 })
)
ipcMain.handle('python:importImage', (_, filePath) =>
  pyFetch('/import/image', { method: 'POST', body: { file_path: filePath } })
)
ipcMain.handle('python:generateCaption', (_, params) =>
  pyFetch('/generate/caption', { method: 'POST', body: params })
)
ipcMain.handle('python:getPrompts', () => pyFetch('/prompts'))
ipcMain.handle('python:savePrompts', (_, data) => pyFetch('/prompts', { method: 'POST', body: data }))
ipcMain.handle('python:generatePersonaReply', (_, params) =>
  pyFetch('/generate/persona-reply', { method: 'POST', body: params, timeout: 180000 })
)
ipcMain.handle('python:generatePersonaPost', (_, params) =>
  pyFetch('/generate/persona-post', { method: 'POST', body: params, timeout: 180000 })
)
// Threads persona pipeline (Content-style, adapted for Threads)
ipcMain.handle('threads:personaReply', (_, params) =>
  pyFetch('/threads/persona-reply', { method: 'POST', body: params, timeout: 180000 })
)
ipcMain.handle('threads:personaPost', (_, params) =>
  pyFetch('/threads/persona-post', { method: 'POST', body: params, timeout: 180000 })
)

// ===== Reddit feed monitor =====
ipcMain.handle('reddit:scan', (_, params) =>
  pyFetch('/reddit/scan', { method: 'POST', body: params || {}, timeout: 10000 })
)
ipcMain.handle('reddit:scanStatus', () =>
  pyFetch('/reddit/scan/status', { timeout: 10000 })
)
ipcMain.handle('reddit:posts', (_, params) => {
  const q = new URLSearchParams()
  if (params?.status) q.set('status', params.status)
  if (params?.subreddit) q.set('subreddit', params.subreddit)
  if (params?.limit) q.set('limit', String(params.limit))
  return pyFetch(`/reddit/posts?${q.toString()}`)
})
ipcMain.handle('reddit:draft', (_, params) =>
  pyFetch('/reddit/draft', { method: 'POST', body: params, timeout: 180000 })
)
ipcMain.handle('reddit:status', (_, params) =>
  pyFetch('/reddit/status', { method: 'POST', body: params })
)
ipcMain.handle('reddit:deletePosts', (_, params) =>
  pyFetch('/reddit/posts/delete', { method: 'POST', body: params })
)
ipcMain.handle('reddit:drafts', (_, postId) =>
  pyFetch(`/reddit/drafts/${postId}`)
)
ipcMain.handle('reddit:fetchFull', (_, postId) =>
  pyFetch(`/reddit/fetch-full/${postId}`, { method: 'POST', timeout: 60000 })
)
ipcMain.handle('reddit:getFullPost', (_, postId) => {
  // Локальне читання з SQLite (бо RSS не дає повний body поста).
  return db.getFoundPostById(postId)
})
ipcMain.handle('reddit:devvitSync', () =>
  pyFetch('/reddit/devvit/sync', { method: 'POST', timeout: 30000 })
)
ipcMain.handle('reddit:devvitStatus', () =>
  pyFetch('/reddit/devvit/status', { timeout: 5000 })
)
// Ollama: список моделей для Settings dropdown + поточні налаштування.
ipcMain.handle('reddit:draftModels', () =>
  pyFetch('/reddit/draft/models', { timeout: 10000 })
)
// Ollama: ping /api/tags для перевірки endpoint + API key.
ipcMain.handle('reddit:draftTest', () =>
  pyFetch('/reddit/draft/test', { method: 'POST', timeout: 15000 })
)

// ===== Threads feed monitor =====
ipcMain.handle('threads:feedPosts', (_, params) => {
  const q = new URLSearchParams()
  if (params?.status) q.set('status', params.status)
  if (params?.limit) q.set('limit', String(params.limit))
  return pyFetch(`/threads/feed/posts?${q.toString()}`)
})
ipcMain.handle('threads:feedStatus', (_, params) =>
  pyFetch('/threads/feed/status', { method: 'POST', body: params })
)
ipcMain.handle('threads:feedDelete', (_, params) =>
  pyFetch('/threads/feed/delete', { method: 'POST', body: params })
)
ipcMain.handle('threads:feedDraft', (_, params) =>
  pyFetch('/threads/feed/draft', { method: 'POST', body: params, timeout: 180000 })
)
ipcMain.handle('threads:feedDrafts', (_, postId) =>
  pyFetch(`/threads/feed/drafts/${postId}`)
)
// Threads generator (original posts)
ipcMain.handle('threads:generate', (_, params) =>
  pyFetch('/threads/generate', { method: 'POST', body: params, timeout: 180000 })
)
ipcMain.handle('threads:generated', (_, params) => {
  const q = new URLSearchParams()
  if (params?.status) q.set('status', params.status)
  if (params?.limit) q.set('limit', String(params.limit))
  return pyFetch(`/threads/generated?${q.toString()}`)
})
ipcMain.handle('threads:generatedUpdate', (_, params) =>
  pyFetch('/threads/generated/update', { method: 'POST', body: params })
)
ipcMain.handle('threads:generatedDelete', (_, genId) =>
  pyFetch(`/threads/generated/${genId}`, { method: 'DELETE' })
)

// ===== PUBLISH & SCHEDULE =====

ipcMain.handle('python:publishReel', async (_, videoPath, caption) => {
  const auth = await ensureLoggedIn()
  if (!auth.ok) return auth
  return pyFetch('/publish/reel', { method: 'POST', body: { video_path: videoPath, caption }, timeout: 120000 })
})

// Android posting (uiautomator2) — does not require Instagram session
ipcMain.handle('python:androidDevices', () => pyFetch('/android/devices'))
ipcMain.handle('python:androidStatus',  (_, serial) =>
  pyFetch(`/android/status${serial ? `?serial=${encodeURIComponent(serial)}` : ''}`)
)
ipcMain.handle('python:androidPost', async (_, videoPath, caption, serial, dryRun, proxy, expectedUsername) => {
  serial = await ensureFreshSerial(serial)
  return runAdbOp(serial, pyFetch('/android/post', {
    method: 'POST',
    body: {
      video_path: videoPath, caption, serial: serial || null,
      dry_run: !!dryRun, proxy: proxy || null,
      expected_username: expectedUsername || null,
    },
    timeout: 180000,
  }))
})
ipcMain.handle('python:androidPostV2', async (_, videoPath, caption, serial, dryRun, proxy, expectedUsername) => {
  serial = await ensureFreshSerial(serial)
  return runAdbOp(serial, pyFetch('/android/post-v2', {
    method: 'POST',
    body: {
      video_path: videoPath, caption, serial: serial || null,
      dry_run: !!dryRun, proxy: proxy || null,
      expected_username: expectedUsername || null,
    },
    timeout: 300000,
  }))
})

// ── scrcpy screen mirror ──────────────────────────────────────────────────────
const SCRCPY_PATH = path.join(
  app.isPackaged ? process.resourcesPath : path.join(__dirname, '..'),
  'tools', 'scrcpy-win64', 'scrcpy-win64-v3.3.4', 'scrcpy.exe'
)
let scrcpyProcess = null

ipcMain.handle('android:scrcpy', (_, serial) => {
  // Kill previous instance if running
  if (scrcpyProcess && !scrcpyProcess.killed) {
    scrcpyProcess.kill()
    scrcpyProcess = null
  }

  if (!require('fs').existsSync(SCRCPY_PATH)) {
    return { ok: false, error: `scrcpy.exe не знайдено: ${SCRCPY_PATH}` }
  }

  const args = [
    '--window-title', 'Instagram Mirror',
    '--stay-awake',
    '--window-width', '400',
    '--window-height', '850',
    '--always-on-top',
  ]
  if (serial) args.push('--serial', serial)

  try {
    scrcpyProcess = spawn(SCRCPY_PATH, args, {
      detached: false,
      stdio: 'ignore',
      cwd: path.dirname(SCRCPY_PATH),
    })
    scrcpyProcess.on('error', () => { scrcpyProcess = null })
    scrcpyProcess.on('exit',  () => { scrcpyProcess = null })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
})

ipcMain.handle('android:scrcpy-stop', () => {
  if (scrcpyProcess && !scrcpyProcess.killed) {
    scrcpyProcess.kill()
    scrcpyProcess = null
  }
  return { ok: true }
})
// ─────────────────────────────────────────────────────────────────────────────

// Android Reels warm-up scroll — routes to manual/v1/v2 based on per-account config
ipcMain.handle('python:androidScrollReels', async (_, serial, durationSeconds, likeProbability, proxy, _useAi, claudeApiKey, accountId) => {
  serial = await ensureFreshSerial(serial)
  // Engine з per-account config (default 'v1' якщо є ніша, інакше 'manual')
  let engine = 'manual'
  let niche = { description: '', keywords: [], avoid: [], examples: [] }
  if (accountId) {
    try {
      const cfg = db.getWarmupConfig(accountId)
      engine = cfg.warmup_engine || 'manual'
      niche = {
        description: cfg.niche_description || '',
        keywords: Array.isArray(cfg.niche_keywords) ? cfg.niche_keywords : [],
        avoid: Array.isArray(cfg.niche_avoid) ? cfg.niche_avoid : [],
        examples: Array.isArray(cfg.niche_examples) ? cfg.niche_examples : [],
      }
    } catch (e) { console.error('[warmup] config load failed:', e) }
  }

  // Створюємо запис сесії у БД (щоб Run Now теж з'являвся в історії)
  let sessionId = null
  try {
    const created = db.addWarmupSession({
      account_id: accountId || null,
      device_id: null,
      serial: serial || '',
      scheduled_at: new Date().toISOString(),
      duration_min: Math.round((durationSeconds || 120) / 60),
      like_prob_pct: Math.round((likeProbability || 0.15) * 100),
      use_ai: engine !== 'manual',
    })
    sessionId = created.id
    db.updateWarmupSession(sessionId, {
      status: 'running',
      started_at: new Date().toISOString(),
      engine: engine,
    })
  } catch (e) { console.error('[RunNow] session record failed:', e) }

  // Виконуємо warmup і зберігаємо результат у БД
  let result
  try {
    if (engine === 'v2') {
      result = await runAdbOp(serial, pyFetch('/android/warmup-v2', {
        method: 'POST',
        body: {
          serial: serial || null,
          duration_seconds: durationSeconds || 120,
          proxy: proxy || null,
          use_ai: true,
          niche_description: niche.description,
          niche_keywords: niche.keywords,
          niche_avoid: niche.avoid,
          niche_examples: niche.examples,
        },
        timeout: (durationSeconds || 120) * 1000 + 120000,
      }))
    } else {
      // v1 (з AI + niche) АБО manual (без AI)
      const useAi = engine === 'v1'
      result = await runAdbOp(serial, pyFetch('/android/scroll-reels', {
        method: 'POST',
        body: {
          serial: serial || null,
          duration_seconds: durationSeconds || 120,
          like_probability: likeProbability ?? 0.15,
          proxy: proxy || null,
          use_ai: useAi,
          claude_api_key: claudeApiKey || '',
          niche_description: useAi ? niche.description : '',
          niche_keywords: useAi ? niche.keywords : [],
          niche_avoid: useAi ? niche.avoid : [],
          niche_examples: useAi ? niche.examples : [],
        },
        timeout: (durationSeconds || 120) * 1000 + 60000,
      }))
    }
  } catch (e) {
    result = { ok: false, error: String(e.message || e) }
  }

  // Update session у БД з фінальним результатом
  if (sessionId) {
    try {
      const ai = result?.ai_stats || {}
      db.updateWarmupSession(sessionId, {
        status: result?.ok ? 'done' : 'failed',
        finished_at: new Date().toISOString(),
        reels_watched: result?.reels_watched || 0,
        likes_given: result?.likes_given || 0,
        saves_given: result?.saves_given || 0,
        error: result?.ok ? null : (result?.error || 'unknown'),
        ai_decisions: result?.ai_decisions ? JSON.stringify(result.ai_decisions) : null,
        ai_input_tokens: ai.input_tokens || 0,
        ai_output_tokens: ai.output_tokens || 0,
        ai_cache_read_tokens: ai.cache_read_tokens || 0,
        ai_cost_usd: ai.cost_usd_if_api || 0,
        ai_calls: ai.calls || 0,
      })
    } catch (e) { console.error('[RunNow] session update failed:', e) }
  }

  return result
})

// Android WiFi ADB
ipcMain.handle('python:androidPair',       (_, host, code)   => pyFetch('/android/adb-pair',       { method: 'POST', body: { host, code } }))
ipcMain.handle('python:androidConnect',    (_, host)          => pyFetch('/android/adb-connect',    { method: 'POST', body: { host } }))
ipcMain.handle('python:androidTcpip',      (_, serial, port)  => pyFetch('/android/adb-tcpip',      { method: 'POST', body: { serial: serial || null, port: port || 5555 } }))
ipcMain.handle('python:androidDisconnect', (_, host)          => pyFetch('/android/adb-disconnect', { method: 'POST', body: { host } }))
ipcMain.handle('python:androidMdnsDiscover', () => pyFetch('/android/mdns-discover'))
ipcMain.handle('python:androidEnsureWifi',   (_, savedHost) => pyFetch('/android/ensure-wifi', { method: 'POST', body: { saved_host: savedHost || null } }))
ipcMain.handle('python:androidScanUsb',      () => pyFetch('/android/scan-usb'))
ipcMain.handle('python:androidRegisterUsb',  (_, serial) => pyFetch('/android/register-usb', { method: 'POST', body: { serial }, timeout: 15000 }))

// Threads (com.instagram.barcelona) — Android UI automation
ipcMain.handle('python:threadsStatus', (_, serial) =>
  pyFetch(`/threads/status?serial=${encodeURIComponent(serial || '')}`)
)
ipcMain.handle('python:threadsPublish', (_, serial, text, accountId) =>
  pyFetch('/threads/publish', {
    method: 'POST',
    body: { serial, text, account_id: accountId ?? null },
    timeout: 30000,
  })
)
ipcMain.handle('python:threadsScrollComment', (_, serial, durationSec, likeProb, aiPrompt, accountId) =>
  pyFetch('/threads/scroll-comment', {
    method: 'POST',
    body: {
      serial,
      duration_sec: durationSec,
      like_prob: likeProb,
      ai_prompt: aiPrompt || null,
      account_id: accountId ?? null,
    },
    timeout: ((durationSec || 0) + 60) * 1000,
  })
)

ipcMain.handle('schedule:getAll',    ()                                      => db.getScheduledPosts())
ipcMain.handle('schedule:get',       (_, id)                                 => db.getScheduledPost(id))
ipcMain.handle('schedule:add',       (_, videoPath, caption, when, accountId, isDryRun, contentType, imagePathsJson) =>
  db.addScheduledPost(videoPath, caption, when, accountId || null, !!isDryRun,
    contentType || 'reel', imagePathsJson || ''))
ipcMain.handle('schedule:update',    (_, id, data)                           => db.updateScheduledPost(id, data))
ipcMain.handle('schedule:delete',    (_, id)                                 => db.deleteScheduledPost(id))

// ===== IPC: GENERATIONS HISTORY =====

ipcMain.handle('generations:getAll', () => db.getAllGenerations())

ipcMain.handle('generations:save', async (_, data) => {
  const fs = require('fs')
  const genDir = path.join(app.getPath('userData'), 'generations')
  if (!fs.existsSync(genDir)) fs.mkdirSync(genDir, { recursive: true })

  const ts = Date.now()
  const copyFile = (src) => {
    if (!src || !fs.existsSync(src)) return null
    const ext = path.extname(src)
    const dest = path.join(genDir, `${ts}_${path.basename(src)}`)
    fs.copyFileSync(src, dest)
    return dest
  }

  const saved = {
    ...data,
    image_path: copyFile(data.image_path),
    video_path: copyFile(data.video_path),
    final_path: copyFile(data.final_path),
  }
  return db.saveGeneration(saved)
})

ipcMain.handle('generations:delete', (_, id) => {
  const fs = require('fs')
  const gen = db.getAllGenerations().find(g => g.id === id)
  if (gen) {
    [gen.image_path, gen.video_path, gen.final_path].forEach(p => {
      if (p) try { fs.unlinkSync(p) } catch {}
    })
  }
  return db.deleteGeneration(id)
})

ipcMain.handle('generations:saveDraft', async (_, data) => {
  const fs = require('fs')
  const genDir = path.join(app.getPath('userData'), 'generations')
  if (!fs.existsSync(genDir)) fs.mkdirSync(genDir, { recursive: true })

  const ts = Date.now()
  const copyFile = (src) => {
    if (!src || !fs.existsSync(src)) return null
    // Не копіюємо якщо вже в genDir
    if (src.startsWith(genDir)) return src
    const ext = path.extname(src)
    const dest = path.join(genDir, `${ts}_${path.basename(src)}`)
    fs.copyFileSync(src, dest)
    return dest
  }

  const saved = {
    ...data,
    image_path: copyFile(data.image_path) || data.image_path || '',
    video_path: copyFile(data.video_path) || data.video_path || '',
    final_path: copyFile(data.final_path) || data.final_path || '',
  }
  return db.saveDraft(saved)
})

ipcMain.handle('generations:update', async (_, id, data) => {
  const fs = require('fs')
  const genDir = path.join(app.getPath('userData'), 'generations')
  if (!fs.existsSync(genDir)) fs.mkdirSync(genDir, { recursive: true })

  const ts = Date.now()
  // Copy new files if paths changed and are in temp
  const updates = { ...data }
  for (const key of ['image_path', 'video_path', 'final_path']) {
    if (updates[key] && !updates[key].startsWith(genDir) && fs.existsSync(updates[key])) {
      const dest = path.join(genDir, `${ts}_${path.basename(updates[key])}`)
      fs.copyFileSync(updates[key], dest)
      updates[key] = dest
    }
  }
  return db.updateGeneration(id, updates)
})

// ===== IPC: PERSONAS =====

ipcMain.handle('personas:getAll', () => db.getAllPersonas())
ipcMain.handle('personas:save',   (_, p)  => db.savePersona(p))
ipcMain.handle('personas:delete', (_, id) => db.deletePersona(id))

// Планувальник — перевіряємо кожну хвилину
async function runScheduler() {
  const due = db.getPendingDuePosts()
  for (const post of due) {
    const ctype = post.content_type || 'reel'
    console.log(`[Scheduler] Publishing post #${post.id} (${ctype}): ${post.video_path || post.image_paths_json}`)
    // позначаємо як "running" одразу щоб не задвоїти
    db.updateScheduledPostStatus(post.id, 'running', null, null)
    try {
      // Визначаємо serial з account.device (якщо є)
      let serial = null
      let expectedUsername = null
      if (post.account_id) {
        try {
          const acc = db.getAllAccounts().find(a => a.id === post.account_id)
          if (acc) {
            expectedUsername = acc.username || null
            if (acc.device_id) {
              const dev = db.getDevice(acc.device_id)
              if (dev?.serial) serial = dev.serial
            }
          }
        } catch (e) { console.error('[Scheduler] serial resolve:', e) }
      }
      // Fallback на warmupSchedule.serial якщо акаунт не прив'язаний до девайсу
      if (!serial) {
        const settings = await getSettings()
        serial = settings?.warmupSchedule?.serial || null
      }

      // Якщо Wi-Fi serial — спершу швидкий MAC rediscover, потім ensure connection
      if (serial && /^\d+\.\d+\.\d+\.\d+:\d+$/.test(serial)) {
        serial = await ensureFreshSerial(serial)
        const ensure = await pyFetch('/android/ensure-wifi', {
          method: 'POST',
          body: { saved_host: serial },
          timeout: 20000,
        })
        if (!ensure.ok) {
          db.updateScheduledPostStatus(post.id, 'failed', null,
            `WiFi connect failed: ${ensure.error || 'unknown'}`)
          continue
        }
        if (ensure.host && ensure.host !== serial) serial = ensure.host
      }

      // Публікація через Android (v2 для reel, carousel endpoint для post/carousel)
      const settings = await getSettings()
      const dbPath = path.join(app.getPath('userData'), 'reels-generator.db')
      const isDryRun = !!post.is_dry_run
      if (isDryRun) {
        console.log(`[Scheduler] Post #${post.id} (${ctype}) is DRY RUN — will stop at caption screen`)
      }

      let result
      if (ctype === 'post' || ctype === 'carousel') {
        // Parse image_paths_json
        let imagePaths = []
        try { imagePaths = JSON.parse(post.image_paths_json || '[]') } catch {}
        if (!Array.isArray(imagePaths) || imagePaths.length === 0) {
          db.updateScheduledPostStatus(post.id, 'failed', null,
            `${ctype}: image_paths_json порожній або невалідний`)
          continue
        }
        console.log(`[Scheduler] ${ctype} #${post.id} — ${imagePaths.length} images`)
        result = await runAdbOp(serial, pyFetch('/android/post-carousel', {
          method: 'POST',
          body: {
            image_paths: imagePaths,
            caption: post.caption || '',
            serial: serial,
            proxy: settings?.androidProxy || null,
            post_id: isDryRun ? null : post.id,
            db_path: isDryRun ? null : dbPath,
            expected_username: expectedUsername,
            dry_run: isDryRun,
          },
          timeout: 240000,  // carousel довше: push кожної фото + IG render
        }))
      } else {
        // Reel — існуючий flow
        result = await runAdbOp(serial, pyFetch('/android/post-v2', {
          method: 'POST',
          body: {
            video_path: post.video_path,
            caption: post.caption || '',
            serial: serial,
            proxy: settings?.androidProxy || null,
            post_id: isDryRun ? null : post.id,
            db_path: isDryRun ? null : dbPath,
            expected_username: expectedUsername,
            dry_run: isDryRun,
          },
          timeout: 180000,
        }))
      }

      if (result.ok) {
        if (isDryRun) {
          // dry-run успіх — позначаємо спец статусом щоб було видно в UI
          db.updateScheduledPostStatus(post.id, 'published', null,
            `DRY RUN OK · ${result.step} · ${result.elapsed?.toFixed(1)}s`)
          console.log(`[Scheduler] DRY RUN #${post.id} OK in ${result.elapsed?.toFixed(1)}s (step=${result.step})`)
        } else {
          db.updateScheduledPostStatus(post.id, 'published', null, null)
          console.log(`[Scheduler] Published #${post.id} in ${result.elapsed?.toFixed(1)}s`)
        }
        BrowserWindow.getAllWindows().forEach(w =>
          w.webContents.send('schedule:published', { id: post.id })
        )
      } else {
        const err = `${isDryRun ? '[DRY RUN] ' : ''}[${result.step || '?'}] ${result.error || 'unknown'}`
        db.updateScheduledPostStatus(post.id, 'failed', null, err)
        console.error(`[Scheduler] Failed #${post.id}: ${err}`)
      }
    } catch (e) {
      db.updateScheduledPostStatus(post.id, 'failed', null, String(e))
    }
  }
}

setInterval(runScheduler, 60 * 1000) // кожну хвилину

// ===== Reddit feed auto-scan =====
// Сканує RSS Reddit раз на годину, зберігає нові pain-пости у SQLite.
let redditScanRunning = false
async function runRedditScan() {
  if (redditScanRunning) return
  redditScanRunning = true
  try {
    const r = await pyFetch('/reddit/scan', { method: 'POST', body: {}, timeout: 120000 })
    if (r?.ok) {
      console.log(`[reddit] scan: seen=${r.seen} inserted=${r.inserted} dup=${r.duplicates}`)
    } else {
      console.error('[reddit] scan failed:', r?.error)
    }
  } catch (e) {
    console.error('[reddit] scan exception:', e)
  }
  redditScanRunning = false
}

// ВИМКНЕНО: Reddit 429 Too Many Requests на всі RSS-ендпоінти
// setTimeout(runRedditScan, 30 * 1000)
// setInterval(runRedditScan, 12 * 60 * 60 * 1000) // 12 годин (2 рази на добу)

// ===== WARMUP AUTO-SCHEDULER (plan-based) =====

let warmupRunning = false

function _randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

// Генерує план сесій прогріву для діапазону дат
// config: { sessionsPerDay, activeHourStart, activeHourEnd, durationMin, durationMax, likeProbMin, likeProbMax, useAi, serial, accountId }
// dateRange: { startDate: 'YYYY-MM-DD', endDate: 'YYYY-MM-DD' } (inclusive)
function generateWarmupPlan(config, dateRange) {
  const sessions = []
  const start = new Date(dateRange.startDate + 'T00:00:00')
  const end = new Date(dateRange.endDate + 'T00:00:00')

  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const windowMinutes = (config.activeHourEnd - config.activeHourStart) * 60
    if (windowMinutes <= 0) continue
    const bucketSize = windowMinutes / config.sessionsPerDay

    for (let i = 0; i < config.sessionsPerDay; i++) {
      // Для кожної сесії беремо свій "bucket" часу + random у ньому
      // Це гарантує рознесення сесій по дню (без злипання)
      const bucketStart = config.activeHourStart * 60 + i * bucketSize
      const bucketEnd = bucketStart + bucketSize
      // Поля безпеки: маємо хоча б 5 хв у кожен бік від межі
      const safeStart = bucketStart + Math.min(5, bucketSize * 0.1)
      const safeEnd = bucketEnd - Math.min(5, bucketSize * 0.1)
      const minuteOfDay = _randInt(Math.floor(safeStart), Math.floor(safeEnd))
      const hour = Math.floor(minuteOfDay / 60)
      const minute = minuteOfDay % 60

      const when = new Date(d)
      when.setHours(hour, minute, 0, 0)

      // Пропускаємо сесії у минулому
      if (when.getTime() < Date.now()) continue

      sessions.push({
        account_id: config.accountId || null,
        device_id: config.deviceId || null,
        serial: config.serial || '',
        scheduled_at: when.toISOString(),
        duration_min: _randInt(config.durationMin, config.durationMax),
        like_prob_pct: _randInt(config.likeProbMin, config.likeProbMax),
        use_ai: !!config.useAi,
      })
    }
  }
  return sessions
}

async function runWarmupScheduler() {
  // Runtime orphan cleanup: якщо у нас є 'running' сесії які давно мали б завершитись,
  // позначаємо їх як failed. Це strumnijо потому що Electron міг втратити зв'язок з Python,
  // або Python killed, або інша причина що залишила status='running' назавжди.
  try {
    const all = db.getWarmupSessions() || []
    const stuck = all.filter(s => s.status === 'running')
    const now = Date.now()
    for (const s of stuck) {
      const startedAt = s.started_at ? new Date(s.started_at).getTime() : now
      const elapsedMin = (now - startedAt) / 60000
      const durationMin = s.duration_min || 5
      // Вважаємо застряглою якщо пройшло duration + 15 хв запасу
      // (більший буфер бо Python може робити dismiss_dialog, wake, retries, compose-цикли)
      if (elapsedMin > durationMin + 15) {
        db.updateWarmupSession(s.id, {
          status: 'failed',
          finished_at: new Date().toISOString(),
          error: `Orphaned — stuck in 'running' ${elapsedMin.toFixed(0)}min > ${durationMin}min+5 (Python/Electron zv'yazok loss)`,
        })
        console.log(`[Warmup] cleaned orphan #${s.id} (elapsed ${elapsedMin.toFixed(1)}min)`)
        BrowserWindow.getAllWindows().forEach(w =>
          w.webContents.send('warmup:finished', { id: s.id })
        )
      }
    }
  } catch (e) { console.error('[Warmup] orphan cleanup fail:', e) }

  if (warmupRunning) return

  const due = db.getPendingDueWarmups()
  if (!due || due.length === 0) return

  const session = due[0]
  warmupRunning = true

  const now = new Date()
  db.updateWarmupSession(session.id, { status: 'running', started_at: now.toISOString() })
  console.log(`[Warmup] starting session #${session.id}: ${session.duration_min}min, like=${session.like_prob_pct}%, ai=${session.use_ai}`)

  BrowserWindow.getAllWindows().forEach(win =>
    win.webContents.send('warmup:started', { id: session.id })
  )

  let result = null
  try {
    const settings = await getSettings()

    // Вибираємо serial: з сесії або з налаштувань
    let serial = session.serial || settings?.warmupSchedule?.serial || null

    // Якщо це Wi-Fi serial (містить ":" і IP) — спочатку MAC rediscover, потім ensure connection
    const isWifi = serial && /^\d+\.\d+\.\d+\.\d+:\d+$/.test(serial)
    if (isWifi) {
      serial = await ensureFreshSerial(serial)
      console.log(`[Warmup] #${session.id} ensuring WiFi connection to ${serial}...`)
      const ensure = await pyFetch('/android/ensure-wifi', {
        method: 'POST',
        body: { saved_host: serial },
        timeout: 20000,
      })
      if (!ensure.ok) {
        setWifiState(serial, { status: ensure.need_usb ? 'lost' : 'reconnecting', lastError: ensure.error })
        throw new Error(`WiFi connect failed: ${ensure.error || 'unknown'}`)
      }
      if (ensure.host && ensure.host !== serial) {
        console.log(`[Warmup] #${session.id} WiFi host змінився: ${serial} → ${ensure.host} (via ${ensure.method})`)
        serial = ensure.host
        // Зберігаємо новий host для наступних сесій
        try {
          const current = await getSettings()
          await saveSettings({
            ...current,
            warmupSchedule: { ...(current.warmupSchedule || {}), serial },
          })
        } catch (e) { console.error('[Warmup] save new serial failed:', e) }
      } else {
        console.log(`[Warmup] #${session.id} WiFi reused ${serial} (via ${ensure.method})`)
      }
      // Sync UI status: warmup успішно під'єднався → оновлюємо wifiAdbState
      setWifiState(serial, { status: 'connected', host: serial, method: ensure.method, lastError: null })
    }

    // Engine з per-account config (default 'manual' якщо немає account_id)
    let engine = 'manual'
    let niche = { description: '', keywords: [], avoid: [], examples: [] }
    if (session.account_id) {
      try {
        const cfg = db.getWarmupConfig(session.account_id)
        engine = cfg.warmup_engine || 'manual'
        niche = {
          description: cfg.niche_description || '',
          keywords: Array.isArray(cfg.niche_keywords) ? cfg.niche_keywords : [],
          avoid: Array.isArray(cfg.niche_avoid) ? cfg.niche_avoid : [],
          examples: Array.isArray(cfg.niche_examples) ? cfg.niche_examples : [],
        }
      } catch (e) { console.error(`[Warmup] config load failed:`, e) }
    }

    // DB path — Python пише результат напряму (Варіант Б)
    const dbPath = path.join(app.getPath('userData'), 'reels-generator.db')

    if (engine === 'v2') {
      console.log(`[Warmup] #${session.id} engine=v2, niche=${niche.description ? 'configured' : 'NONE'}`)
      result = await runAdbOp(serial, pyFetch('/android/warmup-v2', {
        method: 'POST',
        body: {
          serial: serial,
          duration_seconds: session.duration_min * 60,
          proxy: settings?.androidProxy || null,
          use_ai: !!session.use_ai,
          niche_description: niche.description,
          niche_keywords: niche.keywords,
          niche_avoid: niche.avoid,
          niche_examples: niche.examples,
          // Direct DB write (Варіант Б) — Python пише сам якщо Electron crashed
          session_id: session.id,
          db_path: dbPath,
          engine: 'v2',
        },
        timeout: session.duration_min * 60 * 1000 + 180000,  // +3хв для AI vision
      }))
    } else {
      // v1 (з AI) або manual (без AI) — обидва через scroll-reels
      const useAi = engine === 'v1'
      console.log(`[Warmup] #${session.id} engine=${engine}, AI=${useAi}`)
      result = await runAdbOp(serial, pyFetch('/android/scroll-reels', {
        method: 'POST',
        body: {
          serial: serial,
          duration_seconds: session.duration_min * 60,
          like_probability: session.like_prob_pct / 100,
          proxy: settings?.androidProxy || null,
          use_ai: useAi,
          claude_api_key: '',
          niche_description: useAi ? niche.description : '',
          niche_keywords: useAi ? niche.keywords : [],
          niche_avoid: useAi ? niche.avoid : [],
          niche_examples: useAi ? niche.examples : [],
          // Direct DB write (Варіант Б) — Python пише результат сам
          session_id: session.id,
          db_path: dbPath,
          engine: engine,
        },
        timeout: session.duration_min * 60 * 1000 + 300000,  // +5хв буфер на unlock/dialogs
      }))
    }
    console.log(`[Warmup] #${session.id} [${engine}] ${result.ok ? 'OK' : 'FAIL'} reels=${result.reels_watched} likes=${result.likes_given} saves=${result.saves_given || 0}`)
  } catch (e) {
    result = { ok: false, error: String(e.message || e) }
    console.error(`[Warmup] #${session.id} error:`, e.message || e)
  } finally {
    warmupRunning = false
  }

  const finishedAt = new Date().toISOString()
  const ai = result?.ai_stats || {}
  const updateData = {
    status: result?.ok ? 'done' : 'failed',
    finished_at: finishedAt,
    reels_watched: result?.reels_watched || 0,
    likes_given: result?.likes_given || 0,
    saves_given: result?.saves_given || 0,
    error: result?.ok ? null : (result?.error || 'unknown'),
    ai_decisions: result?.ai_decisions ? JSON.stringify(result.ai_decisions) : null,
    ai_input_tokens: ai.input_tokens || 0,
    ai_output_tokens: ai.output_tokens || 0,
    ai_cache_read_tokens: ai.cache_read_tokens || 0,
    ai_cost_usd: ai.cost_usd_if_api || 0,
    ai_calls: ai.calls || 0,
    engine: engine,
  }
  // Race guard: якщо Python напряму записав результат у БД (Варіант Б) — не перезаписуємо
  // помилкою від pyFetch timeout. Перевіряємо актуальний status.
  try {
    const fresh = db.getWarmupSession(session.id)
    if (fresh && fresh.finished_at && fresh.status === 'done' && !result?.ok) {
      console.log(`[Warmup] #${session.id} Python вже записав 'done' — не перезаписуємо Electron timeout'ом`)
    } else {
      db.updateWarmupSession(session.id, updateData)
    }
  } catch (e) {
    db.updateWarmupSession(session.id, updateData)
  }

  BrowserWindow.getAllWindows().forEach(win =>
    win.webContents.send('warmup:finished', { id: session.id })
  )
}

setInterval(runWarmupScheduler, 60 * 1000)

// ===== THREADS AUTO-SCHEDULER (plan-based, per-device lock) =====

// Set активних device_id що зараз виконують Threads сесію
// (per-device serialization — НЕ запускати 2 сесії на одному device одночасно)
const runningThreadsDeviceIds = new Set()

// Генерує план Threads-сесій для діапазону дат
// config: { sessionsPerDay, activeHourStart, activeHourEnd, durationMin, durationMax,
//           likeProbMin, likeProbMax, aiPrompt, serial, accountId, deviceId }
// dateRange: { startDate: 'YYYY-MM-DD', endDate: 'YYYY-MM-DD' } (inclusive)
function generateThreadsPlan(config, dateRange, existingTimes = []) {
  const sessions = []
  const start = new Date(dateRange.startDate + 'T00:00:00')
  const end = new Date(dateRange.endDate + 'T00:00:00')
  if (isNaN(start.getTime()) || isNaN(end.getTime())) return sessions
  if (!config.accountId || !config.deviceId) return sessions

  const sessionsPerDay = Math.max(1, Math.min(12, Number(config.sessionsPerDay) || 3))
  const activeStart = Math.max(0, Math.min(23, Number(config.activeHourStart) ?? 9))
  const activeEnd = Math.max(0, Math.min(24, Number(config.activeHourEnd) ?? 22))
  const durationMin = Math.max(1, Number(config.durationMin) || 5)
  const durationMax = Math.max(durationMin, Number(config.durationMax) || 15)
  // likeProbMin/likeProbMax як percent (0..100) — convertимо в 0..1
  const likeProbMinPct = Math.max(0, Math.min(100, Number(config.likeProbMin) ?? 20))
  const likeProbMaxPct = Math.max(likeProbMinPct, Math.min(100, Number(config.likeProbMax) ?? 40))

  // existingTimes — масив ms timestamp'ів вже запланованих сесій (щоб уникнути stack within 5 min)
  const reservedMs = [...existingTimes]
  const MIN_GAP_MS = 5 * 60 * 1000

  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const windowMinutes = (activeEnd - activeStart) * 60
    if (windowMinutes <= 0) continue
    const bucketSize = windowMinutes / sessionsPerDay

    for (let i = 0; i < sessionsPerDay; i++) {
      const bucketStart = activeStart * 60 + i * bucketSize
      const bucketEnd = bucketStart + bucketSize
      const safeStart = bucketStart + Math.min(5, bucketSize * 0.1)
      const safeEnd = bucketEnd - Math.min(5, bucketSize * 0.1)

      // Спробувати до 5 разів знайти час що не stackає в 5 хв з іншою сесією
      let when = null
      for (let attempt = 0; attempt < 5; attempt++) {
        const minuteOfDay = _randInt(Math.floor(safeStart), Math.floor(safeEnd))
        const hour = Math.floor(minuteOfDay / 60)
        const minute = minuteOfDay % 60
        const candidate = new Date(d)
        candidate.setHours(hour, minute, 0, 0)
        const candidateMs = candidate.getTime()

        const tooClose = reservedMs.some(t => Math.abs(t - candidateMs) < MIN_GAP_MS)
        if (!tooClose) { when = candidate; break }
      }
      if (!when) continue

      // Пропускаємо сесії у минулому
      if (when.getTime() < Date.now()) continue

      const duration = _randInt(durationMin, durationMax)
      const likeProbPct = _randInt(likeProbMinPct, likeProbMaxPct)
      const likeProb = likeProbPct / 100

      reservedMs.push(when.getTime())
      sessions.push({
        account_id: config.accountId,
        device_id: config.deviceId,
        scheduled_at: when.toISOString(),
        duration_min: duration,
        like_prob: likeProb,
        ai_prompt: config.aiPrompt || null,
      })
    }
  }
  return sessions
}

async function runThreadsScheduler() {
  // 1) Orphan cleanup: позначаємо застряглі 'running' як failed якщо minutes > duration + 10
  try {
    const all = db.getThreadsSessions() || []
    const stuck = all.filter(s => s.status === 'running')
    const now = Date.now()
    for (const s of stuck) {
      const startedAt = s.started_at ? new Date(s.started_at).getTime() : now
      const elapsedMin = (now - startedAt) / 60000
      const durationMin = s.duration_min || 10
      if (elapsedMin > durationMin + 10) {
        db.updateThreadsSession(s.id, {
          status: 'failed',
          completed_at: new Date().toISOString(),
          error: `Orphaned - stuck in running ${elapsedMin.toFixed(0)}min`,
        })
        runningThreadsDeviceIds.delete(s.device_id)
        console.log(`[Threads] cleaned orphan #${s.id} (elapsed ${elapsedMin.toFixed(1)}min)`)
        BrowserWindow.getAllWindows().forEach(w =>
          w.webContents.send('threads:finished', { id: s.id })
        )
      }
    }
  } catch (e) { console.error('[Threads] orphan cleanup fail:', e) }

  // 2) Pick planned sessions due now
  let due = []
  try {
    due = db.getPlannedThreadsSessions(new Date().toISOString()) || []
  } catch (e) { console.error('[Threads] poll fail:', e); return }
  if (!due.length) return

  // 3) Process per-device — skip if device already running
  for (const session of due) {
    if (runningThreadsDeviceIds.has(session.device_id)) continue

    runningThreadsDeviceIds.add(session.device_id)
    // Запускаємо без await — паралельно по різних девайсах
    _runThreadsSession(session).catch(e => {
      console.error(`[Threads] #${session.id} unexpected:`, e)
      runningThreadsDeviceIds.delete(session.device_id)
    })
  }
}

async function _runThreadsSession(session) {
  const sessionId = session.id
  const deviceId = session.device_id
  const serial = session.device_serial || ''

  const startedAt = new Date().toISOString()
  db.updateThreadsSession(sessionId, { status: 'running', started_at: startedAt })
  const durationMin = session.duration_min || 10
  const likePct = Math.round((session.like_prob || 0) * 100)
  console.log(`[Threads] starting session #${sessionId}: ${durationMin}min, like=${likePct}%, account=${session.account_username || session.account_id}`)

  BrowserWindow.getAllWindows().forEach(w =>
    w.webContents.send('threads:started', { id: sessionId })
  )

  let result = null
  try {
    if (!serial) throw new Error('Device serial empty')

    // Якщо це Wi-Fi serial — ensure connection
    const isWifi = serial && /^\d+\.\d+\.\d+\.\d+:\d+$/.test(serial)
    let actualSerial = serial
    if (isWifi) {
      actualSerial = await ensureFreshSerial(serial)
      const ensure = await pyFetch('/android/ensure-wifi', {
        method: 'POST',
        body: { saved_host: actualSerial },
        timeout: 20000,
      })
      if (!ensure.ok) {
        setWifiState(actualSerial, { status: ensure.need_usb ? 'lost' : 'reconnecting', lastError: ensure.error })
        throw new Error(`WiFi connect failed: ${ensure.error || 'unknown'}`)
      }
      if (ensure.host && ensure.host !== actualSerial) actualSerial = ensure.host
      setWifiState(actualSerial, { status: 'connected', host: actualSerial, method: ensure.method, lastError: null })
    }

    const durationSec = durationMin * 60
    result = await runAdbOp(actualSerial, pyFetch('/threads/scroll-comment', {
      method: 'POST',
      body: {
        serial: actualSerial,
        duration_sec: durationSec,
        like_prob: session.like_prob,
        ai_prompt: session.ai_prompt || null,
        account_id: session.account_id,
      },
      timeout: (durationSec + 120) * 1000,
    }))
    console.log(`[Threads] #${sessionId} ${result?.ok ? 'OK' : 'FAIL'} viewed=${result?.viewed || 0} commented=${result?.commented || 0} liked=${result?.liked || 0}`)
  } catch (e) {
    result = { ok: false, error: String(e?.message || e) }
    console.error(`[Threads] #${sessionId} error:`, e?.message || e)
  } finally {
    runningThreadsDeviceIds.delete(deviceId)
  }

  const completedAt = new Date().toISOString()
  const update = {
    status: result?.ok ? 'done' : 'failed',
    completed_at: completedAt,
    viewed: result?.viewed ?? null,
    commented: result?.commented ?? null,
    liked: result?.liked ?? null,
    error: result?.ok ? null : (result?.error || 'unknown'),
  }
  try { db.updateThreadsSession(sessionId, update) }
  catch (e) { console.error(`[Threads] #${sessionId} DB write fail:`, e) }

  BrowserWindow.getAllWindows().forEach(w =>
    w.webContents.send('threads:finished', { id: sessionId })
  )
}

setInterval(runThreadsScheduler, 60 * 1000)

// ===== WI-FI ADB KEEP-ALIVE + AUTO-RECOVERY =====

// Per-device wifi/adb state: { [serial]: { status, lastCheck, method, lastError } }
// status: 'connected' | 'busy' | 'lost' | 'reconnecting' | 'recovering' | 'unknown'
let wifiAdbState = {}

function setWifiState(serial, patch) {
  if (!serial) return
  const prev = wifiAdbState[serial] || {}
  wifiAdbState = {
    ...wifiAdbState,
    [serial]: { ...prev, ...patch, lastCheck: new Date().toISOString() },
  }
  BrowserWindow.getAllWindows().forEach(win =>
    win.webContents.send('wifi-adb:status', wifiAdbState)
  )
}

// Auto-rediscover: якщо WiFi serial не відповідає, шукаємо телефон у мережі за збереженим MAC,
// оновлюємо DB і повертаємо новий serial. Це робить app immune до DHCP-зміни IP.
async function ensureFreshSerial(serial) {
  if (!serial || !/^\d+\.\d+\.\d+\.\d+:\d+$/.test(serial)) return serial

  // Quick ping — якщо живий, нічого не робимо
  let ping
  try {
    ping = await pyFetch('/android/ping-device', {
      method: 'POST', body: { host: serial }, timeout: 5000,
    })
  } catch { ping = { ok: false } }
  if (ping?.ok) return serial

  // Шукаємо device з MAC у DB
  const dev = db.getDeviceBySerial(serial)
  if (!dev || !dev.wifi_mac) {
    console.log(`[ensureFreshSerial] ${serial} dead, нема MAC у DB — rediscover пропущений`)
    return serial
  }

  console.log(`[ensureFreshSerial] ${serial} dead, шукаю по MAC ${dev.wifi_mac}…`)
  let r
  try {
    r = await pyFetch('/android/rediscover-by-mac', {
      method: 'POST', body: { wifi_mac: dev.wifi_mac }, timeout: 30000,
    })
  } catch (e) {
    console.error('[ensureFreshSerial] rediscover error:', e.message || e)
    return serial
  }

  if (r?.ok && r.wifi_host && r.wifi_host !== serial) {
    console.log(`[ensureFreshSerial] Знайдено новий IP: ${serial} → ${r.wifi_host}`)
    try {
      db.updateDevice(dev.id, { serial: r.wifi_host, wifi_host: r.wifi_host })
    } catch (e) {
      console.error('[ensureFreshSerial] DB update fail:', e.message)
    }
    return r.wifi_host
  }

  console.log(`[ensureFreshSerial] MAC ${dev.wifi_mac} не знайдено в мережі`)
  return serial
}

// Обгортка для android операцій — оновлює wifi status тільки на основі реальних викликів.
// Замість background ping: під час операції = busy, успіх = connected, ADB fail = lost.
const ADB_ERROR_RE = /(adb|connection refused|offline|not found|unreachable|timeout|host is down|wifi|tcp|cannot connect)/i
async function runAdbOp(serial, opPromise) {
  if (serial) setWifiState(serial, { status: 'busy', lastError: null })
  try {
    const r = await opPromise
    if (serial) {
      if (r?.ok) {
        setWifiState(serial, { status: 'connected', method: 'op-success', lastError: null })
      } else if (r?.error && ADB_ERROR_RE.test(String(r.error))) {
        setWifiState(serial, { status: 'lost', lastError: String(r.error) })
      } else {
        // Не-ADB помилка (наприклад UI element не знайдено) — пристрій живий
        setWifiState(serial, { status: 'connected', method: 'op-success', lastError: null })
      }
    }
    return r
  } catch (e) {
    const msg = String(e?.message || e)
    if (serial) {
      if (ADB_ERROR_RE.test(msg)) {
        setWifiState(serial, { status: 'lost', lastError: msg })
      } else {
        setWifiState(serial, { status: 'connected' })
      }
    }
    throw e
  }
}

async function wifiHeartbeat({ serial, notify = false, fullRecovery = false } = {}) {
  // Якщо serial не вказаний — fallback на warmupSchedule.serial (legacy)
  if (!serial) {
    try {
      const settings = await getSettings()
      serial = settings?.warmupSchedule?.serial
    } catch {}
  }
  if (!serial || !/^\d+\.\d+\.\d+\.\d+:\d+$/.test(serial)) return
  try {
    const prevStatus = wifiAdbState[serial]?.status

    // Швидкий ping: реальна перевірка чи пристрій відповідає
    const ping = await pyFetch('/android/ping-device', {
      method: 'POST',
      body: { host: serial },
      timeout: 8000,
    })

    if (ping.ok) {
      setWifiState(serial, { status: 'connected', host: serial, method: 'ping', lastError: null })
      return
    }

    // Пристрій не відповідає на старому IP. Спробуємо MAC rediscover.
    const dev = db.getDeviceBySerial(serial)
    if (dev?.wifi_mac) {
      const re = await pyFetch('/android/rediscover-by-mac', {
        method: 'POST', body: { wifi_mac: dev.wifi_mac }, timeout: 30000,
      }).catch(e => ({ ok: false, error: String(e?.message || e) }))
      if (re?.ok && re.wifi_host) {
        const newHost = re.wifi_host
        if (newHost !== serial) {
          try { db.updateDevice(dev.id, { serial: newHost, wifi_host: newHost }) }
          catch (e) { console.error('[wifiHeartbeat] DB update fail:', e.message) }
        }
        setWifiState(newHost, { status: 'connected', host: newHost, method: 'mac-rediscover', lastError: null })
        return
      }
    }

    // Якщо fullRecovery або статус раніше був OK — пробуємо ensure-wifi
    if (!fullRecovery && prevStatus !== 'connected') {
      const state = ping.state || 'unknown'
      if (state === 'missing' || state === 'offline') {
        setWifiState(serial, { status: 'lost', lastError: ping.error || `adb state=${state}` })
      } else {
        setWifiState(serial, { status: 'reconnecting', lastError: ping.error })
      }
      return
    }

    // Full recovery: пробуємо ensure-wifi (mDNS + USB fallback)
    const r = await pyFetch('/android/ensure-wifi', {
      method: 'POST',
      body: { saved_host: serial },
      timeout: 25000,
    })

    if (r.ok) {
      const newHost = r.host || serial
      if (r.host && r.host !== serial) {
        try {
          const settings = await getSettings()
          await saveSettings({ ...settings, warmupSchedule: { ...(settings.warmupSchedule || {}), serial: newHost } })
        } catch {}
      }
      setWifiState(newHost, { status: 'connected', host: newHost, method: r.method, lastError: null })
      if (notify && prevStatus !== 'connected' && r.method === 'usb-recovery') {
        try { tray?.displayBalloon?.({ title: 'Reels Generator', content: `✅ Wi-Fi ADB відновлено через USB: ${newHost}` }) } catch {}
      }
    } else if (r.need_usb) {
      setWifiState(serial, { status: 'lost', lastError: r.error })
      if (notify && prevStatus !== 'lost') {
        try { tray?.displayBalloon?.({ title: 'Reels Generator', content: '📱 Wi-Fi ADB втрачено — підключи USB на 5 сек' }) } catch {}
      }
    } else {
      setWifiState(serial, { status: 'reconnecting', lastError: r.error })
    }
  } catch (e) {
    console.error('[WifiHeartbeat] error:', e.message || e)
    setWifiState(serial, { status: 'reconnecting', lastError: String(e.message || e) })
  }
}

// Background heartbeat вимкнено — щоб не навантажувати ноутбук періодичним adb ping.
// Status оновлюється тільки коли:
//   1. Користувач натискає Reconnect button (IPC: wifi-adb:checkNow)
//   2. Реальна операція android (post, warmup, scroll-reels) провалюється з ADB error
//      → setWifiState({ status: 'lost' }) викликається з catch'у тієї операції
//   3. Реальна операція успішна → setWifiState({ status: 'connected' })

ipcMain.handle('wifi-adb:getStatus', () => wifiAdbState)
ipcMain.handle('wifi-adb:checkNow',  (_, serial) =>
  wifiHeartbeat({ serial, notify: true, fullRecovery: true }).then(() => wifiAdbState))

// ===== IPC: WARMUP =====

ipcMain.handle('warmup:generatePlan', async (_, config, dateRange, replace) => {
  // Збагачуємо config deviceId з account.device_id
  if (config.accountId && !config.deviceId) {
    const allAccounts = db.getAllAccounts()
    const acc = allAccounts.find(a => a.id === config.accountId)
    if (acc?.device_id) config.deviceId = acc.device_id
  }

  if (replace) {
    db.deleteWarmupSessionsPending(config.accountId || null)
  }
  const sessions = generateWarmupPlan(config, dateRange)
  if (sessions.length === 0) return { ok: true, count: 0, sessions: [] }
  db.addWarmupSessionsBatch(sessions)
  return {
    ok: true,
    count: sessions.length,
    sessions: db.getWarmupSessions(dateRange.startDate + 'T00:00:00', dateRange.endDate + 'T23:59:59'),
  }
})

ipcMain.handle('warmup:getSessions', (_, fromIso, toIso) => db.getWarmupSessions(fromIso, toIso))
ipcMain.handle('warmup:getSession', (_, id) => db.getWarmupSession(id))
ipcMain.handle('warmup:deleteSession', (_, id) => db.deleteWarmupSession(id))
ipcMain.handle('warmup:deletePending', () => db.deleteWarmupSessionsPending())
ipcMain.handle('warmup:getStats', (_, fromIso, toIso) => db.getWarmupStats(fromIso, toIso))

ipcMain.handle('warmup:triggerNow', async (_, deviceId, accountId) => {
  // Беремо найближчу pending з фільтром по device/account якщо задано.
  // Якщо обидва null → fallback до глобального (старе поведінка).
  const all = db.getWarmupSessions()
  let pending = all.filter(s => s.status === 'pending')
  if (deviceId) pending = pending.filter(s => s.device_id === deviceId)
  if (accountId) pending = pending.filter(s => s.account_id === accountId)
  if (pending.length === 0) {
    const scope = deviceId ? `для пристрою #${deviceId}` : accountId ? `для акаунта #${accountId}` : ''
    return { ok: false, error: `Немає запланованих сесій ${scope}`.trim() }
  }
  // Сортуємо за scheduled_at щоб взяти саме найближчу
  pending.sort((a, b) => new Date(a.scheduled_at) - new Date(b.scheduled_at))
  const earliest = pending[0]
  db.updateWarmupSession(earliest.id, { scheduled_at: new Date(Date.now() - 1000).toISOString() })
  return { ok: true, id: earliest.id, account_id: earliest.account_id, device_id: earliest.device_id }
})

// ===== IPC: THREADS PLAN =====

ipcMain.handle('threads:generatePlan', async (_, config, dateRange, replace) => {
  if (!config || !dateRange) return { ok: false, error: 'config or dateRange missing' }
  if (!config.accountId) return { ok: false, error: 'accountId required' }

  // Збагачуємо config deviceId з account.device_id якщо не передано
  if (!config.deviceId) {
    const allAccounts = db.getAllAccounts()
    const acc = allAccounts.find(a => a.id === config.accountId)
    if (acc?.device_id) config.deviceId = acc.device_id
  }
  if (!config.deviceId) return { ok: false, error: 'Account has no device bound' }

  const fromIso = dateRange.startDate + 'T00:00:00'
  const toIso = dateRange.endDate + 'T23:59:59'

  if (replace) {
    db.deleteThreadsSessions({
      accountId: config.accountId,
      dateFrom: fromIso,
      dateTo: toIso,
      onlyPlanned: true,
    })
  }

  // Збираємо вже існуючі timestamp'и щоб уникнути stack within 5 min
  const existing = db.getThreadsSessions({
    accountId: config.accountId,
    dateFrom: fromIso,
    dateTo: toIso,
  })
  const existingTimes = existing
    .filter(s => s.status === 'planned' || s.status === 'running')
    .map(s => new Date(s.scheduled_at).getTime())

  const sessions = generateThreadsPlan(config, dateRange, existingTimes)
  if (sessions.length === 0) return { ok: true, count: 0, sessions: [] }
  db.addThreadsSessionsBatch(sessions)

  return {
    ok: true,
    count: sessions.length,
    sessions: db.getThreadsSessions({
      accountId: config.accountId,
      dateFrom: fromIso,
      dateTo: toIso,
    }),
  }
})

ipcMain.handle('threads:getPlan', (_, accountId, dateFrom, dateTo) =>
  db.getThreadsSessions({ accountId, dateFrom, dateTo })
)

ipcMain.handle('threads:cancelSession', (_, sessionId) => {
  if (!sessionId) return { ok: false, error: 'sessionId required' }
  const row = db.cancelThreadsSession(sessionId)
  return { ok: true, session: row }
})

ipcMain.handle('threads:deletePlan', (_, accountId, dateFrom, dateTo, onlyPlanned) => {
  const count = db.deleteThreadsSessions({
    accountId,
    dateFrom,
    dateTo,
    onlyPlanned: onlyPlanned !== false,
  })
  return { ok: true, count }
})

// ===== ENV =====
ipcMain.handle('app:getEnv', (_, key) => process.env[key] || '')
ipcMain.handle('app:getTempAudioDir', () => {
  const path = require('path')
  const fs   = require('fs')
  const dir  = path.join(app.getPath('temp'), 'reels-generator', 'audio')
  if (!fs.existsSync(dir)) return null
  // На Windows defaultPath треба передавати як шлях до файлу, не папки
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.mp3'))
  if (files.length > 0) return path.join(dir, files[0])
  return dir
})

// ===== DIALOG =====

const { dialog } = require('electron')

ipcMain.handle('dialog:openFile', async (_, options) => {
  const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
  const result = await dialog.showOpenDialog(win, options)
  if (result.canceled) return null
  return result.filePaths[0]
})

// ===== APP LIFECYCLE =====

app.whenReady().then(async () => {
  startPython()
  try { await waitForPython() } catch (e) { console.error('Python failed to start:', e.message) }
  createWindow()
  try { createTray() } catch (e) { console.error('[Tray] create failed:', e) }

  // Cleanup orphaned 'running' sessions (від попереднього запуску що крашнувся).
  // Використовуємо час старту + duration_min щоб відрізнити:
  //   - Якщо elapsed < duration + 2хв → ймовірно НЕ завершилась (Electron crashed) → failed
  //   - Якщо elapsed > duration + 2хв → Python ймовірно завершив успішно → recover як 'done'
  //     (точні лічильники з Python log не парсимо — позначимо err='recovered')
  try {
    const stuck = db.getWarmupSessions().filter(s => s.status === 'running')
    if (stuck.length > 0) {
      console.log(`[Startup] cleaning up ${stuck.length} orphaned running sessions`)
      const nowIso = new Date().toISOString()
      const now = Date.now()
      stuck.forEach(s => {
        const startedAt = s.started_at ? new Date(s.started_at).getTime() : now
        const elapsedMin = (now - startedAt) / 60000
        const durationMin = s.duration_min || 5
        const overdue = elapsedMin > durationMin + 2

        if (overdue) {
          // Ймовірно Python завершив, Electron був кривий
          db.updateWarmupSession(s.id, {
            status: 'done',
            finished_at: nowIso,
            error: 'Recovered from Electron crash — точні лічильники втрачено',
          })
          console.log(`[Startup] #${s.id} recovered as 'done' (elapsed ${elapsedMin.toFixed(1)}min > ${durationMin}min)`)
        } else {
          // Сесія ще не встигла завершитися → справжній crash
          db.updateWarmupSession(s.id, {
            status: 'failed',
            finished_at: nowIso,
            error: 'Electron crashed/restarted during session',
          })
          console.log(`[Startup] #${s.id} marked failed (crashed mid-session)`)
        }
      })
    }
  } catch (e) { console.error('[Startup] orphan cleanup failed:', e) }

  // Wi-Fi ADB heartbeat вимкнено — статус оновлюється тільки реальними операціями
  // або при натисканні Reconnect button. Початково = 'unknown'.

  // Якщо стартували прихованими (--hidden аргумент від автозапуску) — ховаємо вікно
  if (process.argv.includes('--hidden')) {
    mainWindow?.hide()
  }
})

// window-all-closed НЕ квітує: вікно ховається у трей, планувальник продовжує працювати
app.on('window-all-closed', () => {
  // навмисно порожньо — tray тримає процес живим
})

app.on('before-quit', () => {
  isQuitting = true
  stopPython()
  if (tray) { try { tray.destroy() } catch {} tray = null }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
  else mainWindow?.show()
})

// ===== IPC: TRAY / AUTOSTART =====

ipcMain.handle('app:hideToTray', () => { mainWindow?.hide(); return true })
ipcMain.handle('app:showWindow', () => { createWindow(); mainWindow?.show(); mainWindow?.focus(); return true })
ipcMain.handle('app:quit',       () => { isQuitting = true; app.quit() })

ipcMain.handle('app:getAutostart', () => {
  const s = app.getLoginItemSettings({ path: process.execPath })
  return { enabled: !!s.openAtLogin }
})

ipcMain.handle('app:setAutostart', (_, enabled) => {
  app.setLoginItemSettings({
    openAtLogin: !!enabled,
    path: process.execPath,
    args: ['--hidden'],
  })
  return { ok: true, enabled: !!enabled }
})
