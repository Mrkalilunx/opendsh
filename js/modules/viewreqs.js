// 请求记录页：按天列代理转发的请求，点开看请求头、请求体和响应原文

import { daykey, today } from './daypick.js'
import { opensheet, shutsheet } from '../lib/sheet.js'
import { setflash } from '../lib/flash.js'

const el = (id) => document.getElementById(id)

const state = {
  day: '',
  active: false,
  items: [],
  total: 0,
  counts: { all: 0 },
  filter: 'all',
  limit: 200,
  source: null,
  openid: '',
}

function clock(at) {
  const d = new Date(at)
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, '0'))
    .join(':')
}

function stamp(at) {
  const d = new Date(at)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${clock(at)}`
}

// 耗时短的按毫秒给，长请求按秒给，一眼能分出快慢
function dur(ms) {
  const n = Number(ms) || 0
  return n < 1000 ? `${n}ms` : `${(n / 1000).toFixed(2)}s`
}

function tone(status) {
  const n = Number(status) || 0
  if (!n || n >= 500) return 'bad'
  if (n >= 400) return 'warn'
  return 'ok'
}

function setstate(text, toneName) {
  const node = el('logstate')
  if (!node) return
  node.textContent = text
  node.dataset.tone = toneName
}

function count(shown, total) {
  const node = el('logcount')
  if (!node) return
  // 条数变了闪一下，新请求进来时不用盯着数字也能察觉
  setflash(node, shown === total ? String(total) : `${shown}/${total}`)
}

// 来源的显示名，键要与后端 sourceof() 的返回值一致
const srclabel = {
  opencode: 'opencode',
  codex: 'codex',
  astrbot: 'astrbot',
  web: '网页',
  script: '脚本',
  other: '其他',
}

function makerow(item) {
  const li = document.createElement('li')
  li.className = 'reqrow'
  li.dataset.id = String(item.id)
  li.tabIndex = 0

  const stat = document.createElement('span')
  stat.className = 'reqstat'
  stat.dataset.tone = tone(item.status)
  // 状态码固定三位，没有值时补 000，列宽不会因为缺值变窄
  stat.textContent = String(item.status || 0).padStart(3, '0')

  const time = document.createElement('span')
  time.className = 'reqtime'
  time.textContent = clock(item.at)

  const ms = document.createElement('span')
  ms.className = 'reqms'
  ms.textContent = dur(item.ms)

  const src = document.createElement('span')
  src.className = 'reqsrc'
  src.dataset.source = item.source || 'other'
  src.textContent = srclabel[item.source] || '其他'

  const model = document.createElement('span')
  model.className = 'reqmodel'
  model.textContent = item.model || item.path

  li.append(stat, time, ms, src, model)
  return li
}

function paint() {
  const list = el('reqlist')
  if (!list) return
  list.innerHTML = ''
  const frag = document.createDocumentFragment()
  // 全部行都从上往下依次刷入，整页一次性重绘时能看清是从头铺下来的
  // 步长按总行数收放：不管多少行，整轮动画都压在 0.9 秒内结束
  // 拖太久的话后面的行会长时间保持透明，看着像列表缺了一大块
  const total = state.items.length
  const step = total > 1 ? Math.min(22, Math.max(2, Math.floor(900 / total))) : 0
  state.items.forEach((item, index) => {
    const row = makerow(item)
    if (step) row.style.setProperty('--delay', `${index * step}ms`)
    else row.dataset.static = '1'
    // 正在看详情的那条保持高亮，切日期重绘后也接得上
    if (state.openid && String(item.id) === state.openid) row.setAttribute('aria-current', 'true')
    frag.appendChild(row)
  })
  list.appendChild(frag)
  const empty = el('reqempty')
  if (empty) {
    empty.hidden = state.items.length > 0
    empty.textContent = state.filter !== 'all'
      ? `这一天没有 ${srclabel[state.filter] || '其他'} 的请求`
      : '这一天没有请求记录'
  }
  if (state.active) count(state.items.length, Math.max(state.total, state.items.length))
}

async function load() {
  const day = state.day || today()
  state.day = day
  try {
    const src = state.filter && state.filter !== 'all' ? `&source=${encodeURIComponent(state.filter)}` : ''
    const res = await fetch(`/__requests?day=${day}&limit=${state.limit}${src}`, { cache: 'no-store' })
    const doc = await res.json()
    state.items = Array.isArray(doc.list) ? doc.list : []
    state.total = Number(doc.total) || state.items.length
    state.counts = doc.counts && typeof doc.counts === 'object' ? doc.counts : { all: state.items.length }
    paintchips()
    paint()
    if (doc.fallback) setstate('日志库未连接，请求记录读不到', 'warn')
  } catch (err) {
    // 读失败就把占位行撤了，别让骨架一直转着像还在等
    el('reqlist')?.replaceChildren()
    setstate(`读取失败：${err.message}`, 'bad')
  }
}

// 筛选按钮上带当天的条数，一眼看出哪家最多；没有记录的那档置灰
// 名字和数字分两个 span，数字右对齐，几个按钮的位数不会左右跳
function paintchips() {
  for (const chip of document.querySelectorAll('.reqchips .chip[data-source]')) {
    const key = chip.dataset.source
    const n = Number(state.counts[key]) || 0
    const label = key === 'all' ? '全部' : srclabel[key] || '其他'
    const name = document.createElement('span')
    name.className = 'reqchipname'
    name.textContent = label
    const num = document.createElement('span')
    num.className = 'reqchipnum'
    num.textContent = n ? String(n) : '0'
    chip.replaceChildren(name, num)
    chip.setAttribute('aria-pressed', String(state.filter === key))
    chip.disabled = key !== 'all' && n === 0
  }
}

// 实时推送只补当天的新请求，翻历史那天不受影响
function append(item) {
  if (daykey(item.at) !== state.day) return
  // 条数统计照旧累加，筛掉了当前来源就不往列表里塞
  const key = item.source || 'other'
  state.counts.all = (Number(state.counts.all) || 0) + 1
  state.counts[key] = (Number(state.counts[key]) || 0) + 1
  paintchips()
  if (state.filter !== 'all' && state.filter !== key) return
  const list = el('reqlist')
  state.items.unshift(item)
  state.total += 1
  const over = state.items.length - state.limit
  if (over > 0) state.items.splice(-over)
  const empty = el('reqempty')
  if (empty) empty.hidden = true
  if (list) {
    if (over > 0 && list.lastChild) list.removeChild(list.lastChild)
    const row = makerow(item)
    // 新到的那条落下来，短暂亮一下底色，一眼看到是哪条
    row.dataset.fresh = '1'
    // 摘标记的同时挂上 static，不然底下的 rowin 会接班重播一次淡入，看着闪一下
    row.addEventListener('animationend', () => {
      delete row.dataset.fresh
      row.dataset.static = '1'
    }, { once: true })
    list.insertBefore(row, list.firstChild)
  }
  if (state.active) count(state.items.length, Math.max(state.total, state.items.length))
}

function connect() {
  if (state.source || !state.active) return
  const es = new EventSource('/__requests/stream')
  es.addEventListener('open', () => {
    if (state.active) setstate('实时接收中', 'live')
  })
  es.addEventListener('error', () => {
    if (state.active) setstate('连接断开，正在重连…', 'bad')
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
}

// 流式响应是 data: 行拼起来的，逐行展开；普通 JSON 整段格式化
function pretty(text) {
  const raw = String(text || '')
  if (!raw) return ''
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    // 不是单份 JSON，按行看
  }
  return raw
    .split('\n')
    .map((line) => {
      if (!line.startsWith('data:')) return line
      const payload = line.slice(5).trim()
      if (!payload || payload === '[DONE]') return line
      try {
        return `data: ${JSON.stringify(JSON.parse(payload), null, 2)}`
      } catch {
        return line
      }
    })
    .join('\n')
}

function section(title, text, hint) {
  const box = document.createElement('section')
  box.className = 'reqsec'

  const head = document.createElement('h3')
  head.className = 'reqsec-title'
  head.textContent = title

  if (hint) {
    const note = document.createElement('span')
    note.className = 'reqsec-note'
    note.textContent = hint
    head.appendChild(note)
  }

  const pre = document.createElement('pre')
  pre.className = 'reqcode'
  pre.textContent = text || '(空)'

  box.append(head, pre)
  return box
}

function rendersheet(doc) {
  const meta = el('reqmeta')
  if (meta) {
    meta.innerHTML = ''
    const bit = (text, toneName) => {
      const span = document.createElement('span')
      span.className = 'reqchip'
      if (toneName) span.dataset.tone = toneName
      span.textContent = text
      return span
    }
    meta.append(
      bit(doc.method, ''),
      bit(String(doc.status), tone(doc.status)),
      bit(dur(doc.ms), ''),
      bit(srclabel[doc.source] || '其他', ''),
    )
    // 模型名放最后，宽度不够就省略，不折行
    if (doc.model) {
      const model = bit(doc.model, '')
      model.className = 'reqchip reqchip-model'
      model.title = doc.model
      meta.appendChild(model)
    }
  }

  // 时间挪到标题旁边，省出一行标签的位置
  const st = el('reqstamp')
  if (st) st.textContent = stamp(doc.at)

  const body = el('reqbody')
  if (!body) return
  body.innerHTML = ''
  // 体积按字节算，中文一个字三字节，按字符数会低估到看不出来
  const bytes = (text) => {
    const raw = String(text || '')
    if (!raw) return 0
    return new TextEncoder().encode(raw).length
  }
  // 完整就报体积，不完整才提示截断，两个状态互斥，不叠字
  // 走去重路径的额外标出来，方便确认这条是不是复用公共上下文存的
  const sizehint = (text, full, stored, tag) => {
    const n = bytes(text)
    if (!n) return ''
    const shown = `${(n / 1024).toFixed(1)} KB`
    const bits = [shown]
    if (full === false) bits.push('已截断')
    if (tag) bits.push(tag)
    return bits.join(' · ')
  }
  // 三段内容错开落下，数据一次填进来时不至于整块硬闪
  const secs = [
    section('请求头', pretty(doc.reqhead)),
    section('请求体', pretty(doc.reqbody), sizehint(doc.reqbody, doc.reqfull, doc.reqsize, doc.dedup ? '去重' : '')),
    section('响应体', pretty(doc.respbody), sizehint(doc.respbody, doc.respfull, doc.respsize, '')),
  ]
  secs.forEach((one, index) => one.style.setProperty('--delay', `${index * 45}ms`))
  body.append(...secs)
}

let openedat = 0

async function open(id) {
  const sheet = el('reqsheet')
  if (!sheet) return
  openedat = Date.now()
  state.openid = String(id)
  resetarm(el('reqdel'))
  el('reqtitle').textContent = `请求 #${id}`
  const metanode = el('reqmeta')
  metanode.textContent = '读取中…'
  // 读取要等一会儿，挂个扫光让等待有反馈
  metanode.dataset.busy = '1'
  const st = el('reqstamp')
  if (st) st.textContent = ''
  el('reqbody').innerHTML = ''
  markrow()
  // 入场动画只在元素从 display:none 变回来时重播
  // 换一条再点开时就靠这一步重头播，否则只有第一次展开有动效
  delete sheet.dataset.shut
  sheet.hidden = true
  void sheet.offsetWidth
  opensheet(sheet)
  try {
    const res = await fetch(`/__requests?id=${id}`, { cache: 'no-store' })
    const doc = await res.json()
    if (doc.error) throw new Error(doc.error)
    rendersheet(doc)
  } catch (err) {
    metanode.textContent = `读取失败：${err.message}`
  } finally {
    delete metanode.dataset.busy
  }
}

function close() {
  const sheet = el('reqsheet')
  const wasopen = state.openid
  state.openid = ''
  resetarm(el('reqdel'))
  // 高亮等面板收完再摘，退场过程中那行还是亮的，位置接得上
  if (sheet) shutsheet(sheet, () => wasopen && markrow())
}

// 删除类按钮统一两段式：第一下改成确认文案，四秒内再点才真的执行
function arm(btn, warlabel, act) {
  if (!btn) return
  if (btn.dataset.armed === '1') {
    clearTimeout(Number(btn.dataset.timer) || 0)
    btn.dataset.armed = ''
    btn.textContent = btn.dataset.idle || warlabel
    act()
    return
  }
  btn.dataset.armed = '1'
  btn.dataset.idle = btn.textContent
  btn.textContent = warlabel
  btn.dataset.timer = String(
    setTimeout(() => {
      btn.dataset.armed = ''
      btn.textContent = btn.dataset.idle
    }, 4000),
  )
}

function resetarm(btn) {
  if (!btn || btn.dataset.armed !== '1') return
  clearTimeout(Number(btn.dataset.timer) || 0)
  btn.dataset.armed = ''
  btn.textContent = btn.dataset.idle || '删除'
}

// 正在看的那行标出来，列表里一眼能找回位置
function markrow() {
  const list = el('reqlist')
  if (!list) return
  for (const row of list.querySelectorAll('.reqrow')) {
    if (state.openid && row.dataset.id === state.openid) row.setAttribute('aria-current', 'true')
    else row.removeAttribute('aria-current')
  }
}

// 删掉一条后本地先摘掉，不整页重拉，实时流照常往下走
function droprow(id) {
  const list = el('reqlist')
  const row = list && list.querySelector(`.reqrow[data-id="${id}"]`)
  // 删掉的行先淡出去再摘，直接消失看着像手滑
  if (row) {
    row.dataset.gone = '1'
    setTimeout(() => row.remove(), 160)
  }
  const gone = state.items.find((it) => String(it.id) === String(id))
  state.items = state.items.filter((it) => String(it.id) !== String(id))
  state.total = Math.max(0, state.total - 1)
  // 删掉的那条要从来源计数里扣掉，按钮上的数字才对得上
  if (gone) {
    const key = gone.source || 'other'
    state.counts.all = Math.max(0, (Number(state.counts.all) || 0) - 1)
    state.counts[key] = Math.max(0, (Number(state.counts[key]) || 0) - 1)
    paintchips()
  }
  const empty = el('reqempty')
  if (empty) empty.hidden = state.items.length > 0
  if (state.active) count(state.items.length, Math.max(state.total, state.items.length))
}

async function del(id) {
  try {
    const res = await fetch(`/__requests?id=${id}`, { method: 'DELETE', cache: 'no-store' })
    const doc = await res.json()
    if (doc.error) throw new Error(doc.error)
    droprow(id)
    close()
  } catch (err) {
    el('reqmeta').textContent = `删除失败：${err.message}`
  }
}

export function mountreqs() {
  if (!el('logpane-req')) return

  // 来源筛选：点一下换一档，切回全部就清掉条件
  for (const chip of document.querySelectorAll('.reqchips .chip[data-source]')) {
    chip.addEventListener('click', () => {
      if (chip.disabled) return
      state.filter = chip.dataset.source
      paintchips()
      load()
    })
  }

  el('reqlist').addEventListener('click', (ev) => {
    const row = ev.target.closest('.reqrow')
    if (row) open(row.dataset.id)
  })

  // 键盘也能开，长列表里 Tab 过去按回车就行
  el('reqlist').addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' && ev.key !== ' ') return
    const row = ev.target.closest('.reqrow')
    if (!row) return
    ev.preventDefault()
    open(row.dataset.id)
  })

  el('reqclose').addEventListener('click', close)

  // 单条删除：先改成「确认删除」，再点一下才真删
  const delbtn = el('reqdel')
  if (delbtn) {
    delbtn.addEventListener('click', () => {
      if (!state.openid) return
      arm(delbtn, '确认删除', () => del(state.openid))
    })
  }

  // 点遮罩空白处关掉，点内容区不关
  el('reqsheet').addEventListener('click', (ev) => {
    // 手机上一次点按有时会补一发延迟的鼠标点击，落在刚弹出来的遮罩上就立刻关掉了
    if (Date.now() - openedat < 400) return
    if (ev.target === el('reqsheet')) close()
  })

  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return
    const sheet = el('reqsheet')
    if (sheet && !sheet.hidden) close()
  })
}

// 日志页切到这个分栏：按当前日期拉一次，并接上实时流
export function reqsetactive(active, day) {
  state.active = active
  if (day) state.day = day
  if (!active) {
    disconnect()
    close()
    return
  }
  load()
  connect()
}
