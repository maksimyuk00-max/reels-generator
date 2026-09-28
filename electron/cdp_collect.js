// CDP-збір короткокодів рілсів із ЗАЛОГІНЕНОГО Edge через DOM.
// Навігація — через CDP Page.navigate (зовнішня, не ламає контекст),
// збір — окремим evaluate. НЕ ходить в Instagram API (400/429).
const http = require('http')
const DEFAULT_PORT = 9223

function getTabs(port) {
  return new Promise((res, rej) => {
    http.get(`http://127.0.0.1:${port}/json`, (r) => {
      let d = ''
      r.on('data', (c) => (d += c))
      r.on('end', () => { try { res(JSON.parse(d)) } catch (e) { rej(e) } })
    }).on('error', rej)
  })
}

function cdpRaw(wsUrl) {
  return new Promise((resolve, reject) => {
    let ws
    try { ws = new WebSocket(wsUrl) } catch (e) { return reject(new Error('WS ' + e.message)) }
    let id = 0
    const pending = {}
    const send = (m, p) => new Promise((res) => { const i = ++id; pending[i] = res; ws.send(JSON.stringify({ id: i, method: m, params: p || {} })) })
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending[m.id]) { pending[m.id](m); delete pending[m.id] } }
    ws.onerror = (e) => reject(new Error('WSerr ' + e.message))
    ws.onopen = () => resolve({ send, close: () => { try { ws.close() } catch (e) {} } })
  })
}

async function findIgTab() {
  let tabs
  for (let i = 0; i < 15; i++) {
    tabs = await getTabs(DEFAULT_PORT)
    const p = (tabs || []).find((t) => t.type === 'page' && t.url && /instagram\.com/.test(t.url))
    if (p) return p
    await new Promise((r) => setTimeout(r, 700))
  }
  const dbg = (tabs || []).map((t) => t.type + ':' + (t.url || '').slice(0, 30)).join(' | ')
  throw new Error('Нема інстаграм-вкладки. Таби=[' + dbg.slice(0, 250) + ']')
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

// Навігація через CDP Page.navigate — не ламає evaluate контекст.
async function navigate(wsUrl, url, settleMs) {
  const c = await cdpRaw(wsUrl)
  await c.send('Page.navigate', { url })
  await sleep(settleMs || 8000)
  // дочекатись повного load
  try { await c.send('Page.enable'); } catch (e) {}
  c.close()
}

async function evaluate(wsUrl, js) {
  const c = await cdpRaw(wsUrl)
  const res = await c.send('Runtime.evaluate', { expression: js, returnByValue: true, awaitPromise: true })
  c.close()
  const v = res.result && res.result.result ? res.result.result.value : undefined
  return v
}

const COLLECT = `Array.from(document.querySelectorAll('a[href*="/reel/"]')).map(function(a){return a.getAttribute('href');})`

async function collectReelsFromDom(username, opts = {}) {
  const maxCodes = opts.amount || 200
  const page = await findIgTab()
  const url = page.webSocketDebuggerUrl
  const union = new Set()
  const unionAdd = (hrefs) => { (hrefs || []).forEach((x) => { const m = /\/(?:reel)\/([A-Za-z0-9_-]+)/.exec(x); if (m) union.add(m[1]) }) }

  // 1) головна сітка профілю (стабільно тримає /reel/ лінки)
  await navigate(url, `https://www.instagram.com/${username}/`, 9000)
  unionAdd(await evaluate(url, COLLECT))

  // 2) вкладка /reels/: навігація + скрол + збір партій
  await navigate(url, `https://www.instagram.com/${username}/reels/`, 10000)
  let emptyStreak = 0
  for (let i = 0; i < 30; i++) {
    const batch = await evaluate(url, `(function(){var h=${COLLECT};var s=typeof window!=='undefined'?window.scrollY:0;var y=s, bh=document.body?document.body.scrollHeight:-1; if(y<bh)window.scrollBy(0,700); return h;})()`)
    // маємо скролити й читати в окремих кроках; скрол зробимо окремо
    unionAdd(batch)
    const before = union.size
    await evaluate(url, `window.scrollBy(0,700); true`)
    await sleep(2000)
    const after = await evaluate(url, COLLECT)
    unionAdd(after)
    if (after.length === 0) emptyStreak++; else emptyStreak = 0
    if (emptyStreak >= 6) break
    if (union.size >= maxCodes) break
  }
  const arr = Array.from(union).slice(0, maxCodes)
  return arr
}

module.exports = { collectReelsFromDom, navigate, evaluate, findIgTab, getTabs, DEFAULT_PORT }
