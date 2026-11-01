// 主页监控：端口、服务、CPU/GPU/内存、数据库，进首页才轮询

import { setflash } from '../lib/flash.js'

const el = (id) => document.getElementById(id)

const state = { timer: null, busy: false }

function pct(n) {
  const v = Number(n)
  if (!Number.isFinite(v)) return '0%'
  return `${Math.round(v)}%`
}

function gb(n) {
  return `${(Number(n) / 1073741824).toFixed(1)}G`
}

// 数据库占用给个短记法，格子里放不下完整字节数
function bytes(n) {
  const units = ['B', 'KB', 'MB', 'GB']
  let v = Number(n) || 0
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)}${units[i]}`
}

function up(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h ? `${h} 小时 ${m} 分` : `${m} 分`
}

function clock(at) {
  const d = new Date(at)
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, '0'))
    .join(':')
}

function fillbar(node, value) {
  const fill = node && node.firstElementChild
  if (!fill) return
  const v = Math.max(0, Math.min(100, Number(value) || 0))
  fill.style.width = `${v}%`
}

// 每核一根竖条，条数按核数补齐，颜色交给 CSS
function fillcores(cores, freq) {
  const box = el('syscores')
  if (!box) return
  const n = Array.isArray(cores) && cores.length ? cores.length : 8
  while (box.children.length < n) box.appendChild(document.createElement('i'))
  while (box.children.length > n) box.lastChild.remove()

  for (let i = 0; i < n; i += 1) {
    const bar = box.children[i]
    const v = Math.max(0, Math.min(100, Number(cores && cores[i]) || 0))
    bar.style.setProperty('--v', `${v}%`)
    const mhz = freq && freq[i] ? `${freq[i]}MHz` : ''
    bar.title = `cpu${i} · ${Math.round(v)}%${mhz ? ` · ${mhz}` : ''}`
  }
}

// 相邻同频的核合并成一段，最后就是「1.8G / 2.4G / 2.5G」这种簇描述
function freqtext(freq) {
  if (!Array.isArray(freq) || !freq.length) return ''
  const seg = []
  for (const f of freq) {
    if (!f) continue
    if (!seg.length || seg[seg.length - 1] !== f) seg.push(f)
  }
  return seg.map((f) => `${(f / 1000).toFixed(1)}G`).join(' / ')
}

function rendersvc(list) {
  const box = el('syssvc')
  if (!box) return
  box.innerHTML = ''
  for (const item of list || []) {
    const span = document.createElement('span')
    span.className = 'svc'
    span.dataset.run = String(Boolean(item.run))
    span.textContent = item.name
    span.title = item.pid ? `运行中 · PID ${item.pid}` : item.run ? '已连接' : '连接失败'
    box.appendChild(span)
  }
}

// 支持的接口：能不能用完全跟着设置走，关掉的那条灰着并写明去哪儿开
// 开着但上游链路不通的标红，脖子以上能用、脖子以下断了的区别一目了然
function renderapis(list, up) {
  const box = el('apilist')
  if (!box) return
  const rows = Array.isArray(list) ? list : []
  box.replaceChildren()

  let usable = 0
  for (const api of rows) {
    const on = Boolean(api.on)
    // health 是本地回包，不依赖上游；其余都要过上游那道关
    const needup = api.path !== '/health'
    const state = !on ? 'false' : needup && up === false ? 'broken' : 'true'
    if (state === 'true') usable += 1

    const li = document.createElement('li')
    li.className = 'apirow'
    li.dataset.on = state
    if (state === 'false' && api.hint) li.title = `需开启：${api.hint}`
    if (state === 'broken') li.title = '上游链路不通，开了也用不了'

    const dot = document.createElement('span')
    dot.className = 'apidot'
    dot.setAttribute('aria-hidden', 'true')

    const line = document.createElement('span')
    line.className = 'apiline'

    const method = document.createElement('span')
    method.className = 'apimethod'
    method.textContent = api.method || 'GET'

    const path = document.createElement('span')
    path.className = 'apipath'
    path.textContent = api.path

    line.append(method, path)

    const note = document.createElement('span')
    note.className = 'apinote'
    if (state === 'false') note.textContent = `未开启 · ${api.hint || '去设置里打开'}`
    else if (state === 'broken') note.textContent = '上游不通，暂时用不了'
    else note.textContent = api.note || ''

    li.append(dot, line, note)
    box.appendChild(li)
  }

  const badge = el('apicount')
  if (badge) badge.textContent = rows.length ? `${usable} / ${rows.length} 可用` : '0 / 0 可用'
}

function render(doc) {
  el('sysport').textContent = String(doc.port || 0)
  el('sysaddr').textContent = `http://127.0.0.1:${doc.port || 0}`

  // CPU：总占用给数字，每核给竖条，频率挂在竖条的悬停提示里
  if (doc.cpu) {
    setflash(el('syscpu'), pct(doc.cpu.pct))
    fillcores(doc.cpu.cores, doc.freq)
    const text = freqtext(doc.freq)
    el('syscpunote').textContent = `${doc.cpu.cores.length} 核${text ? ` · ${text}` : ''}`
  } else {
    el('syscpu').textContent = '0%'
    fillcores([], doc.freq)
    el('syscpunote').textContent = 'Shizuku 未连接，读不到每核占用'
  }

  // GPU：占用靠 gpubusy，温度在 thermal_zone 里，频率这台机器读不到
  const gpuct = doc.gpu.pct === null || doc.gpu.pct === undefined ? '0%' : pct(doc.gpu.pct)
  setflash(el('sysgpu'), gpuct)
  fillbar(el('sysgpubar'), doc.gpu.pct)
  const gpunote = [doc.gpu.model, doc.gpu.temp ? `${doc.gpu.temp.toFixed(0)}°C` : ''].filter(Boolean).join(' · ')
  el('sysgpunote').textContent = gpunote || '0°C'

  // 内存：物理内存已用和总量，百分比走同一根条
  const mem = doc.mem || {}
  setflash(el('sysmem'), `${gb(mem.used)} / ${gb(mem.total)}`)
  fillbar(el('sysmembar'), mem.total ? Math.round((mem.used / mem.total) * 1000) / 10 : 0)

  // 数据库：连上了才显示版本库名这些，断开就整块标红
  const db = doc.db || {}
  el('sysdb').dataset.ok = String(Boolean(db.ok))
  // 连不上也给零值占位，不摆横线，版面和连上时一样齐
  el('sysdbver').textContent = db.ok ? db.version || '0.0.0' : '0.0.0'
  el('sysdbaddr').textContent = `${db.host || '0.0.0.0'}:${db.port || 0}`
  el('sysdbname').textContent = db.name || 'dsh'
  el('sysdbtables').textContent = String(db.tables || 0)
  el('sysdbbytes').textContent = bytes(db.bytes)

  rendersvc(doc.services)
  // 上游状态在服务行里已经算过一次，这里直接复用，别重复判断
  const upstream = (doc.services || []).find((it) => it.key === 'up')
  renderapis(doc.apis, upstream ? Boolean(upstream.run) : undefined)

  const tail = doc.adb ? `开机 ${up(doc.uptime)}` : 'CPU 需要 Shizuku'
  el('sysnote').textContent = `更新于 ${clock(doc.at || Date.now())} · ${tail}`
}

async function pull() {
  if (state.busy) return
  state.busy = true
  try {
    const res = await fetch('/__sys', { cache: 'no-store' })
    const doc = await res.json()
    if (doc.error) throw new Error(doc.error)
    render(doc)
  } catch (err) {
    // 读失败就把骨架撤了，留着转只会让人以为还在加载
    el('syssvc')?.replaceChildren()
    el('apilist')?.replaceChildren()
    el('sysnote').textContent = `读取失败：${err.message}`
  } finally {
    state.busy = false
  }
}

function start() {
  if (state.timer) return
  pull()
  // ad 每次要一秒多，六秒一轮既跟得上又不至于一直占着设备
  state.timer = setInterval(pull, 6000)
}

function stop() {
  if (!state.timer) return
  clearInterval(state.timer)
  state.timer = null
}

export function mounthomemon() {
  if (!el('syscard')) return
  document.addEventListener('view:change', (ev) => {
    const name = ev.detail && ev.detail.name
    if (name === 'home') start()
    else stop()
  })
  if (document.documentElement.dataset.view === 'home') start()
}
