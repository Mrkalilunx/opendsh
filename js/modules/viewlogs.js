// 日志页：历史走 /__logs，实时走 /__logs/stream，切到本页才连

import { daykey, today, mountdaypick } from './daypick.js'
import { mountreqs, reqsetactive } from './viewreqs.js'
import { procsetactive, mountproc } from './procview.js'

const state = {
  items: [],
  level: 'all',
  day: '',
  total: 0,
  active: false,
  auto: true,
  source: null,
}

const el = (id) => document.getElementById(id)

const labels = { info: '信息', warn: '警告', error: '错误' }

// 日期下拉是共用件，日志页和调试页用同一份样式与交互
let picker = null

// 当前分栏：run 运行日志 / req 请求记录 / proc 进程
let pane = 'run'

// 历史拉取条数跟设置里的「日志最大显示条数」联动，读不到就按默认值走
let logshow = 500

function applysettings(settings) {
  const n = Number(settings && settings.logshow)
  logshow = Number.isFinite(n) && n >= 50 ? Math.min(2000, Math.round(n)) : 500
}

function clock(at) {
  const d = new Date(at)
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, '0'))
    .join(':')
}

// 连接状态：文案和颜色一起换，颜色区分在线、断线、失败
function setstate(text, tone) {
  const node = el('logstate')
  if (!node) return
  node.textContent = text
  node.dataset.tone = tone
}

function makerow(item) {
  const li = document.createElement('li')
  li.className = `logrow logrow-${item.level}`

  const time = document.createElement('span')
  time.className = 'logtime'
  time.textContent = clock(item.at)

  const level = document.createElement('span')
  level.className = `loglevel loglevel-${item.level}`
  level.textContent = labels[item.level] || item.level

  const msg = document.createElement('span')
  msg.className = 'logmsg'
  msg.textContent = item.msg

  li.append(time, level, msg)
  return li
}

const match = (item) => state.level === 'all' || item.level === state.level

function near() {
  const list = el('loglist')
  if (!list) return true
  return list.scrollTop + list.clientHeight >= list.scrollHeight - 24
}

// 停在历史里就把「回到最新」按钮亮出来，滑到底自动收起
function jumpbtn() {
  const btn = el('logjump')
  if (!btn) return
  btn.hidden = state.auto || !state.items.some(match)
}

function tail() {
  const list = el('loglist')
  if (!list) return
  if (state.auto) list.scrollTop = list.scrollHeight
  jumpbtn()
}

function tolatest() {
  state.auto = true
  tail()
}

function count() {
  const list = el('loglist')
  // 按实际渲染出来的行数统计，筛选掉的条目不参与计数
  const shown = list ? list.children.length : 0
  const total = Math.max(state.total, state.items.length)
  const badge = el('logcount')
  if (badge && pane === 'run') badge.textContent = shown === total ? String(total) : `${shown}/${total}`
  const empty = el('logempty')
  if (empty) {
    empty.hidden = shown > 0
    // 有日志但被筛掉时说明是筛选造成的空，不是真的没日志
    empty.textContent = total > 0 ? '该级别暂无记录' : '这一天没有日志'
  }
  jumpbtn()
}

function paint() {
  const list = el('loglist')
  if (!list) return
  list.innerHTML = ''
  const frag = document.createDocumentFragment()
  for (const item of state.items) if (match(item)) frag.appendChild(makerow(item))
  list.appendChild(frag)
  count()
  tail()
}

function append(item) {
  // 只在看今天时接收实时日志，翻历史那天不能被新日志搅乱
  if (daykey(item.at) !== state.day) return
  const list = el('loglist')
  state.items.push(item)
  state.total += 1
  // 上限等于设置里的显示条数，实时追加再多也不会超出这个量
  const over = state.items.length - logshow
  if (over > 0) {
    state.items.splice(0, over)
    // 数据丢了行也得跟着丢，否则 DOM 会比条目越滚越大
    if (state.level === 'all' && list) {
      for (let i = 0; i < over && list.firstChild; i += 1) list.removeChild(list.firstChild)
    } else {
      // 有筛选时行数和条目数对不上，重新整表画一次最省心
      paint()
      return
    }
  }
  if (match(item) && list) {
    list.appendChild(makerow(item))
    tail()
  }
  count()
}

async function load() {
  // 每次进日志页都先同步一次设置，改了显示条数不用刷新页面
  try {
    const cfg = await fetch('/__settings', { cache: 'no-store' })
    const doc = await cfg.json()
    applysettings(doc.settings)
  } catch {
    // 读不到就沿用上次的值
  }
  const day = state.day || today()
  state.day = day
  if (picker) picker.setlabel(day)
  try {
    const res = await fetch(`/__logs?day=${day}&limit=${logshow}`, { cache: 'no-store' })
    const doc = await res.json()
    state.items = Array.isArray(doc.logs) ? doc.logs : []
    state.total = Number(doc.total) || state.items.length
    state.auto = true
    // 库没连上时后端退回内存缓冲，这里给个提示，免得以为历史丢了
    if (doc.fallback) setstate('日志库未连接，只显示内存缓冲', 'warn')
    paint()
  } catch (err) {
    setstate(`读取失败：${err.message}`, 'bad')
  }
}

function connect() {
  if (state.source || !state.active) return
  const es = new EventSource('/__logs/stream')
  es.addEventListener('open', () => {
    setstate('实时接收中', 'live')
  })
  es.addEventListener('error', () => {
    setstate('连接断开，正在重连…', 'bad')
  })
  es.addEventListener('message', (ev) => {
    try {
      append(JSON.parse(ev.data))
    } catch {
      // 半包或心跳，忽略
    }
  })
  state.source = es
}

function disconnect() {
  if (state.source) {
    state.source.close()
    state.source = null
  }
  setstate('未连接', 'idle')
}

function setlevel(level) {
  state.level = level
  for (const chip of document.querySelectorAll('.logchips .chip')) {
    chip.setAttribute('aria-pressed', String(chip.dataset.level === level))
  }
  paint()
}

// 分栏指示块和顶栏页签同一套做法：量出位置交给 CSS 滑过去
function glide() {
  const bar = el('logtabs')
  if (!bar) return
  const cur = bar.querySelector('.logtab[aria-selected="true"]')
  const glider = bar.querySelector('.tabglider')
  if (!cur || !glider || !cur.offsetWidth) return
  glider.style.width = `${cur.offsetWidth}px`
  glider.style.height = `${cur.offsetHeight}px`
  glider.style.transform = `translate(${cur.offsetLeft}px, ${cur.offsetTop}px)`
  if (!bar.classList.contains('tabglider-on')) {
    requestAnimationFrame(() => bar.classList.add('tabglider-on'))
  }
}

function setpane(name) {
  pane = name === 'req' ? 'req' : name === 'proc' ? 'proc' : 'run'
  const bar = el('logtabs')
  if (bar) {
    for (const tab of bar.querySelectorAll('.logtab')) {
      tab.setAttribute('aria-selected', String(tab.dataset.pane === pane))
    }
  }
  glide()
  const chips = document.querySelector('.logchips')
  if (chips) chips.hidden = pane !== 'run'
  // 请求记录换成来源筛选，级别筛选只对运行日志有意义
  const reqchips = document.querySelector('.reqchips')
  if (reqchips) reqchips.hidden = pane !== 'req'
  // 日期下拉只对日志和请求有意义，进程分栏用不上；工具条整块收起，免得留一条空边
  const tools = document.querySelector('.logbar')
  if (tools) tools.hidden = pane === 'proc'
  el('logpane-run').hidden = pane !== 'run'
  el('logpane-req').hidden = pane !== 'req'
  el('logpane-proc').hidden = pane !== 'proc'

  if (pane === 'req') {
    disconnect()
    procsetactive(false)
    reqsetactive(true, state.day || today())
  } else if (pane === 'proc') {
    disconnect()
    reqsetactive(false)
    procsetactive(true)
    setstate('每 3 秒刷新', 'live')
  } else {
    reqsetactive(false)
    procsetactive(false)
    load()
    connect()
  }
}

export function mountlogs() {
  if (!el('view-logs')) return

  mountreqs()
  mountproc()

  for (const chip of document.querySelectorAll('.logchips .chip')) {
    chip.addEventListener('click', () => setlevel(chip.dataset.level))
  }

  // 抽屉里只列有日志的日子，今天永远留一个入口
  picker = mountdaypick({
    btn: 'logdaybtn',
    drawer: 'logdaydrawer',
    label: 'logdaylabel',
    current: () => state.day || today(),
    // 请求记录分栏按请求表列日期，免得只看日志的日子
    source: async () => {
      const url = pane === 'req' ? '/__requests?days=365' : '/__logs?days=365'
      const res = await fetch(url, { cache: 'no-store' })
      const doc = await res.json()
      return Array.isArray(doc.days) ? doc.days : []
    },
    after: (day) => {
      state.day = day
      if (pane === 'req') reqsetactive(true, day)
      else if (pane === 'run') load()
    },
  })

  el('logjump').addEventListener('click', tolatest)

  el('loglist').addEventListener('scroll', () => {
    // 只在真实滚动时重新判定要不要吸附到底部，避免和 tail() 打架
    state.auto = near()
    jumpbtn()
  })

  for (const tab of document.querySelectorAll('.logtab')) {
    tab.addEventListener('click', () => setpane(tab.dataset.pane))
  }

  document.addEventListener('view:change', (ev) => {
    const name = ev.detail && ev.detail.name
    state.active = name === 'logs'
    if (state.active) {
      setpane(pane)
    } else {
      disconnect()
      reqsetactive(false)
      procsetactive(false)
    }
  })

  // 管理面板清空过日志，回来后按当前日期重新拉
  document.addEventListener('logs:cleared', () => {
    if (!state.active) return
    if (pane === 'req') reqsetactive(true, state.day || today())
    else if (pane === 'run') load()
  })

  // 调试页灌完日志：对齐到刚灌的那天，正在看就立刻重拉，不用手动刷新
  document.addEventListener('logs:seeded', (ev) => {
    const day = ev.detail && ev.detail.day
    if (!day) return
    state.day = day
    if (picker) picker.setlabel(day)
    if (!state.active) return
    if (pane === 'req') reqsetactive(true, day)
    else if (pane === 'run') load()
  })

  // 设置保存后立刻换上限，正在看日志时不用来回切页
  document.addEventListener('settings:change', (ev) => {
    applysettings(ev.detail)
  })
}
