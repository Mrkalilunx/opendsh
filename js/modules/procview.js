// 进程分栏：卡片按资源占用排，点卡片弹详情，详情里两步确认后结束进程

import { opensheet, shutsheet } from '../lib/sheet.js'
import { setflash } from '../lib/flash.js'

const el = (id) => document.getElementById(id)

const state = {
  active: false,
  timer: 0,
  busy: false,
  items: [],
  total: 0,
  // 排序依据：cpu 占用或 rss 内存，desc 为真时大的在前
  sortkey: 'cpu',
  desc: true,
  // 详情面板里正在看的 pid，0 表示没开
  openpid: 0,
  saytimer: 0,
}

// 这些进程一 kill 要么界面没了，要么代理直接瘫，卡片上标一下
const critical = /bun serve\.js|mariadbd|opencode serve/

// 状态字母换成人话，跟 top 的读法一致
const states = {
  R: '运行',
  S: '休眠',
  D: '不可中断',
  T: '暂停',
  Z: '僵尸',
  I: '空闲',
}

const units = ['B', 'KB', 'MB', 'GB']

// 字节换单位，跟日志管理那边同一个口径
function size(n) {
  let v = Number(n) || 0
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

// 占用小的时候留一位小数，过十就取整，卡片宽度才稳
function percent(v) {
  const n = Number(v) || 0
  return n >= 10 ? `${Math.round(n)}%` : `${n.toFixed(1)}%`
}

// 秒数说成人话，详情里标运行时长
function span(sec) {
  const n = Math.max(0, Math.round(Number(sec) || 0))
  if (n >= 86400) return `${Math.floor(n / 86400)} 天 ${Math.floor((n % 86400) / 3600)} 小时`
  if (n >= 3600) return `${Math.floor(n / 3600)} 小时 ${Math.floor((n % 3600) / 60)} 分`
  if (n >= 60) return `${Math.floor(n / 60)} 分 ${n % 60} 秒`
  return `${n} 秒`
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

// 标题右边的总数，跟日志页共用同一个计数位
function count(total) {
  const node = el('logcount')
  if (node) setflash(node, String(total))
}

// 结果提示借状态那一行显示，两秒多后自己退回刷新提示
function say(text, tone = 'live') {
  const node = el('logstate')
  if (!node) return
  node.textContent = text
  node.dataset.tone = tone
  clearTimeout(state.saytimer)
  state.saytimer = setTimeout(() => {
    if (!state.active) return
    node.textContent = '每 3 秒刷新'
    node.dataset.tone = 'live'
  }, 2600)
}

// 按当前依据排序，值相同的用另一项兜底，顺序才不来回跳
function sorted() {
  const key = state.sortkey
  const dir = state.desc ? -1 : 1
  return [...state.items].sort((a, b) => {
    const main = (Number(a[key]) || 0) - (Number(b[key]) || 0)
    const tie = (Number(a.rss) || 0) - (Number(b.rss) || 0)
    return (main !== 0 ? main : tie) * dir
  })
}

// 一张卡片：命令行、pid、cpu、内存、线程数
function card(it) {
  const li = document.createElement('li')
  li.className = 'proccard'
  li.dataset.pid = String(it.pid)
  li.tabIndex = 0
  li.title = `${it.cmd} · ${it.threads} 线程 · 状态 ${states[it.state] || it.state}`

  const head = document.createElement('span')
  head.className = 'pchead'

  const cmd = document.createElement('span')
  cmd.className = 'pccmd'
  cmd.textContent = it.cmd
  head.append(cmd)

  if (critical.test(it.cmd)) {
    const flag = document.createElement('span')
    flag.className = 'pcflag'
    flag.textContent = '关键'
    head.append(flag)
  }

  const meta = document.createElement('span')
  meta.className = 'pcmeta'

  const pid = document.createElement('span')
  pid.textContent = it.pid

  const cpu = document.createElement('span')
  cpu.className = 'pccpu'
  cpu.textContent = percent(it.cpu)

  meta.append(pid, cpu)

  // 第二行放内存和线程数，卡片窄的时候也不会挤成一团
  const more = document.createElement('span')
  more.className = 'pcmeta'

  const mem = document.createElement('span')
  mem.className = 'pcmem'
  mem.textContent = size(it.rss)

  const threads = document.createElement('span')
  threads.className = 'pcthreads'
  threads.textContent = `${it.threads} 线程`

  more.append(mem, threads)
  li.append(head, meta, more)
  li.__item = it

  li.addEventListener('click', () => open(it.pid))
  li.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' && ev.key !== ' ') return
    ev.preventDefault()
    open(it.pid)
  })
  return li
}

// 老卡上新数据：只改会变的几项，节点不重建，读数的闪动就不会被打断
function refresh(node, it) {
  node.__item = it
  node.title = `${it.cmd} · ${it.threads} 线程 · 状态 ${states[it.state] || it.state}`
  const cpu = node.querySelector('.pccpu')
  if (cpu && cpu.textContent !== percent(it.cpu)) cpu.textContent = percent(it.cpu)
  const mem = node.querySelector('.pcmem')
  if (mem && mem.textContent !== size(it.rss)) mem.textContent = size(it.rss)
  const threads = node.querySelector('.pcthreads')
  const th = `${it.threads} 线程`
  if (threads && threads.textContent !== th) threads.textContent = th
}

function paint() {
  const list = el('proclist')
  if (!list) return
  const rows = sorted()
  const old = new Map()
  for (const node of [...list.children]) {
    // 占位卡没有 pid，真数据到了先整张摘掉，不能让它一直躺在那儿
    if (!node.dataset.pid) {
      list.removeChild(node)
      continue
    }
    old.set(node.dataset.pid, node)
  }
  // 重排前记下位置，排完让换位的卡片滑过去，不然每次刷新都是硬跳
  const pos = new Map()
  for (const [pid, node] of old) pos.set(pid, node.getBoundingClientRect())
  const keep = new Set()
  // 按新顺序逐张对：有的就地改，没有的新建，最后把剩下的摘掉
  for (const it of rows) {
    const pid = String(it.pid)
    const node = old.get(pid)
    keep.add(pid)
    if (node) {
      refresh(node, it)
      list.appendChild(node)
      continue
    }
    const fresh = card(it)
    fresh.dataset.fresh = '1'
    // 动画播完就摘标记，否则下次重排还会重播
    fresh.addEventListener('animationend', () => delete fresh.dataset.fresh, { once: true })
    list.appendChild(fresh)
  }
  for (const [pid, node] of old) {
    if (keep.has(pid)) continue
    node.dataset.gone = '1'
    setTimeout(() => node.remove(), 180)
  }
  // 位置变了的那几张按旧位置反向偏移，再放回去，过渡一出就是平滑滑动
  for (const [pid, node] of old) {
    if (!keep.has(pid)) continue
    const was = pos.get(pid)
    if (!was) continue
    const now = node.getBoundingClientRect()
    const dx = was.left - now.left
    const dy = was.top - now.top
    if (Math.abs(dx) < 2 && Math.abs(dy) < 2) continue
    // 老浏览器没有 animate、或者系统要少动效，就直接换位
    if (typeof node.animate !== 'function') continue
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) continue
    node.animate(
      [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }],
      { duration: 240, easing: 'cubic-bezier(0.22, 0.61, 0.36, 1)' },
    )
  }
  // 重排后把高亮补回去，正在看详情的那张卡一直亮着
  markcard(state.openpid)
  const empty = el('procempty')
  if (empty) {
    empty.hidden = rows.length > 0
    empty.textContent = '没有读到 Termux 的进程'
  }
  count(state.total || rows.length)
}

async function pull() {
  if (state.busy) return
  // 页面在后台时不用白刷，回来那一轮自然就对齐了
  if (document.hidden) return
  state.busy = true
  try {
    const res = await fetch('/__proc', { cache: 'no-store' })
    const doc = await res.json()
    if (doc.error) throw new Error(doc.error)
    state.items = Array.isArray(doc.items) ? doc.items : []
    state.total = Number(doc.total) || state.items.length
    paint()
  } catch (err) {
    // 读失败就把占位卡撤了，留着转只会让人以为还在加载
    if (!state.items.length) el('proclist')?.replaceChildren()
    const empty = el('procempty')
    if (empty && !state.items.length) {
      empty.hidden = false
      empty.textContent = `读取失败：${err.message}`
    }
  } finally {
    state.busy = false
  }
}

// 详情里的一段：标题加内容，样式跟请求详情共用
function section(title, note, ...nodes) {
  const wrap = document.createElement('div')
  const head = document.createElement('div')
  head.className = 'reqsec-title'
  head.textContent = title
  if (note) {
    const tag = document.createElement('span')
    tag.className = 'reqsec-note'
    tag.textContent = note
    head.append(tag)
  }
  wrap.append(head, ...nodes)
  return wrap
}

// 键值表：左边标签，右边值，值长了自动换行
function info(pairs) {
  const dl = document.createElement('dl')
  dl.className = 'procinfo'
  for (const [key, value] of pairs) {
    const dt = document.createElement('dt')
    dt.textContent = key
    const dd = document.createElement('dd')
    // 空值给个中性占位，不留空单元格
    dd.textContent = value === '' || value === undefined || value === null ? '无' : String(value)
    dl.append(dt, dd)
  }
  return dl
}

function render(doc) {
  el('proctitle').textContent = doc.name
  const st = el('procstamp')
  if (st) st.textContent = doc.startedAt ? stamp(doc.startedAt) : ''

  const meta = el('procmeta')
  if (meta) {
    meta.replaceChildren()
    const bit = (text, toneName) => {
      const span = document.createElement('span')
      span.className = 'reqchip'
      if (toneName) span.dataset.tone = toneName
      span.textContent = text
      return span
    }
    meta.append(
      bit(`PID ${doc.pid}`),
      bit(states[doc.state] || doc.state, doc.state === 'R' ? 'ok' : ''),
      bit(percent(doc.cpu)),
      bit(size(doc.rss)),
    )
  }

  const body = el('procbody')
  if (!body) return
  body.replaceChildren()
  // 两段错开落下，数据一次填进来时不至于整块硬闪
  const secs = [
    section('命令行', '', Object.assign(document.createElement('pre'), {
      className: 'reqcode',
      textContent: doc.cmd,
    })),
    section('基本信息', '', info([
      ['PID', doc.pid],
      ['父进程', doc.ppid ? `${doc.ppid} ${doc.ppidname || ''}`.trim() : '0'],
      ['用户', `uid ${doc.uid}`],
      ['状态', `${states[doc.state] || doc.state} (${doc.state})`],
      ['线程数', doc.threads],
      ['运行时长', doc.age ? span(doc.age) : '0 秒'],
      ['可执行文件', doc.exe],
      ['工作目录', doc.cwd],
      ['打开文件', `${doc.fds} 个`],
    ])),
  ]
  secs.forEach((one, index) => one.style.setProperty('--delay', `${index * 60}ms`))
  body.append(...secs)
}

// 结束按钮两段式：第一下改成确认文案，四秒内再点才真的执行
function resetarm() {
  const btn = el('procdel')
  if (!btn) return
  clearTimeout(Number(btn.dataset.timer) || 0)
  btn.dataset.armed = ''
  btn.textContent = btn.dataset.idle || '结束'
}

function arm() {
  const btn = el('procdel')
  if (!btn || !state.openpid) return
  if (btn.dataset.armed === '1') {
    clearTimeout(Number(btn.dataset.timer) || 0)
    btn.dataset.armed = ''
    btn.textContent = btn.dataset.idle || '结束'
    kill(state.openpid)
    return
  }
  btn.dataset.armed = '1'
  btn.dataset.idle = btn.textContent
  btn.textContent = '确认结束'
  btn.dataset.timer = String(
    setTimeout(() => {
      btn.dataset.armed = ''
      btn.textContent = btn.dataset.idle || '结束'
    }, 4000),
  )
}

let openedat = 0

// 正在看详情的那张卡标出来，列表每 3 秒重排也能一眼认出是哪个
function markcard(pid) {
  const list = el('proclist')
  if (!list) return
  for (const node of list.children) {
    if (pid && node.dataset.pid === String(pid)) node.setAttribute('aria-current', 'true')
    else node.removeAttribute('aria-current')
  }
}

async function open(pid) {
  const sheet = el('procsheet')
  if (!sheet) return
  openedat = Date.now()
  state.openpid = pid
  resetarm()
  el('proctitle').textContent = '进程详情'
  const st = el('procstamp')
  if (st) st.textContent = ''
  const meta = el('procmeta')
  if (meta) {
    meta.textContent = '读取中…'
    // 读取要等一会儿，挂个扫光让等待有反馈
    meta.dataset.busy = '1'
  }
  el('procbody').replaceChildren()
  markcard(pid)
  // 入场动画只在元素从 display:none 变回来时重播
  // 换一条再点开时就靠这一步重头播，否则只有第一次展开有动效
  delete sheet.dataset.shut
  sheet.hidden = true
  void sheet.offsetWidth
  opensheet(sheet)
  try {
    const res = await fetch(`/__proc?pid=${pid}`, { cache: 'no-store' })
    const doc = await res.json()
    if (doc.error) throw new Error(doc.error)
    render(doc)
  } catch (err) {
    if (meta) meta.textContent = `读取失败：${err.message}`
  } finally {
    if (meta) delete meta.dataset.busy
  }
}

function close() {
  const sheet = el('procsheet')
  const wasopen = state.openpid
  state.openpid = 0
  resetarm()
  // 高亮等面板收完再摘，退场过程中那张卡还是亮的
  if (sheet) shutsheet(sheet, () => wasopen && markcard(0))
}

async function kill(pid) {
  state.busy = true
  try {
    const res = await fetch('/__proc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pid }),
    })
    const doc = await res.json()
    if (doc.error) throw new Error(doc.error)
    state.items = state.items.filter((one) => one.pid !== pid)
    state.total = Math.max(0, state.total - 1)
    close()
    paint()
    say(`已结束 ${doc.name} (${doc.pid})，${doc.how}`)
  } catch (err) {
    close()
    say(`结束失败：${err.message}`, 'bad')
  } finally {
    state.busy = false
  }
}

// 排序按钮、卡片和详情面板都是页面固有的，事件挂一次就行
export function mountproc() {
  const list = el('proclist')
  if (!list) return

  for (const chip of document.querySelectorAll('.procbar .chip[data-sort]')) {
    chip.addEventListener('click', () => {
      state.sortkey = chip.dataset.sort
      for (const one of document.querySelectorAll('.procbar .chip[data-sort]')) {
        one.setAttribute('aria-pressed', String(one === chip))
      }
      paint()
    })
  }

  el('procorder')?.addEventListener('click', () => {
    state.desc = !state.desc
    el('procorder').textContent = state.desc ? '降序' : '升序'
    paint()
  })

  el('procdel')?.addEventListener('click', arm)
  el('procclose')?.addEventListener('click', close)

  // 点遮罩空白处关掉，点内容区不关；手机上的延迟点击刚弹开时不算
  el('procsheet')?.addEventListener('click', (ev) => {
    if (Date.now() - openedat < 400) return
    if (ev.target === el('procsheet')) close()
  })

  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return
    const sheet = el('procsheet')
    if (sheet && !sheet.hidden) close()
  })
}

// CPU 占用靠两次采样之间的滴答差算，间隔 3 秒既能看出波动又不会太吵
export function procsetactive(active) {
  state.active = active
  if (!active) {
    if (state.timer) {
      clearInterval(state.timer)
      state.timer = 0
    }
    close()
    return
  }
  pull()
  if (!state.timer) state.timer = setInterval(pull, 3000)
}
