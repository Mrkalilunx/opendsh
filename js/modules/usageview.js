// 用量页：把 /__usage 的汇总画成几个数字、明细、每日柱状和两张排行
// 数据全由后端算好，这里只管排版，不再二次统计

const el = (id) => document.getElementById(id)

const state = { days: 7, busy: false, last: 0 }

// token 数字很大，过万换成 k / M，保留一位小数够看趋势
function human(n) {
  const v = Number(n) || 0
  if (v >= 100000000) return `${(v / 100000000).toFixed(2)} 亿`
  if (v >= 10000) return `${(v / 10000).toFixed(v >= 1000000 ? 0 : 1)} 万`
  return String(Math.round(v))
}

// 精确值放 title 里，概览看缩写，要核对时能看到原数
function exact(n) {
  return (Number(n) || 0).toLocaleString('zh-CN')
}

// 钱按美元算，小于一分钱的按分显示，免费的直接写免费
function cash(usd) {
  const v = Number(usd) || 0
  if (v <= 0) return '免费'
  if (v < 0.01) return `$${v.toFixed(4)}`
  if (v < 1) return `$${v.toFixed(3)}`
  return `$${v.toFixed(2)}`
}

function stamp(ms) {
  const d = new Date(ms)
  const pad = (v) => String(v).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function say(text, tone = '') {
  const node = el('usagenote')
  if (!node) return
  node.textContent = text
  node.dataset.tone = tone
}

// 数字从上一个值滚到新值，首屏也从 0 滚上来，不做「啪」一下直接落值
// 系统开了减弱动效、或者环境没有 rAF，就老老实实直接写值
const reduce = () =>
  typeof window !== 'undefined' &&
  window.matchMedia &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches

// 滚动时的单位按终点定死：跟着中间值换单位会在 9999 和 1.0 万之间来回跳
function unitfmt(target) {
  const t = Number(target) || 0
  if (t >= 100000000) return (v) => `${(v / 100000000).toFixed(2)} 亿`
  if (t >= 10000) return (v) => `${(v / 10000).toFixed(t >= 1000000 ? 0 : 1)} 万`
  return (v) => String(Math.round(v))
}

// 数值滚动：from 取上次画到哪，中途被打断也能从当前显示值接着滚
function roll(node, value, fmt, span = 700) {
  const to = Number(value) || 0
  if (!fmt) fmt = unitfmt(to)
  const from = Number(node.dataset.shown) || 0
  if (reduce() || typeof requestAnimationFrame !== 'function' || from === to) {
    node.__rollid = (node.__rollid || 0) + 1
    node.textContent = fmt(to)
    node.dataset.shown = String(to)
    return
  }
  // 上一轮还没滚完就又来了新值：作废旧那轮，否则两个循环抢着写同一个节点
  const id = (node.__rollid = (node.__rollid || 0) + 1)
  // 先把起点写上，不然第一帧还没到之前这里是空的，看起来像闪了一下
  node.textContent = fmt(from)
  const start = performance.now()
  const step = (now) => {
    if (node.__rollid !== id) return
    const t = Math.min(1, (now - start) / span)
    // 缓出，前段快后段稳，数字不会匀速爬
    const k = 1 - (1 - t) ** 3
    const tick = from + (to - from) * k
    node.textContent = fmt(tick)
    node.dataset.shown = String(tick)
    if (t < 1) requestAnimationFrame(step)
    else {
      node.textContent = fmt(to)
      node.dataset.shown = String(to)
    }
  }
  requestAnimationFrame(step)
}

// 百分比也按数滚，小数位固定住，宽度不会来回抽
function rollpct(node, value, digits = 1, suffix = '%') {
  if (!node) return
  roll(node, value, (v) => `${v.toFixed(digits)}${suffix}`, 620)
}

// 四个大数字：主值用缩写，副行给精确值或比例
function tile(val, note, value, extra = '') {
  const vnode = el(val)
  const nnode = el(note)
  if (vnode) {
    roll(vnode, value)
    vnode.title = exact(value)
  }
  if (nnode) nnode.textContent = extra
}

function paint(doc) {
  const total = doc.total || {}
  const range = doc.range || total
  const today = doc.today || {}
  const active = Number(doc.active) || 0

  // 区间名写进标题，切范围时抬头跟着变，不然数字变了看不出来是哪个区间
  const span = doc.days === 1 ? '今天' : `近 ${doc.days} 天`
  const rkey = el('usagerangekey')
  if (rkey) rkey.textContent = `${span}新增`
  const ckey = el('usagecallskey')
  if (ckey) ckey.textContent = `${span}请求`

  // 顶部主数字用新增量（新增输入 + 输出），含缓存的量放脚注
  // 直接摆 1280 万会让人以为真跑了这么多，实际大部分是重复前缀
  const q = doc.quality || {}
  const okcalls = Number(q.ok) || 0

  tile('usagetotal', 'usagetotalnote', range.newtotal, `含缓存 ${human(range.ttok)}`)
  tile('usagetoday', 'usagetodaynote', today.newtotal, `含缓存 ${human(today.ttok)}`)
  tile('usagecalls', 'usagecallsnote', range.calls, `${active} 天 · 成功 ${exact(okcalls)}`)

  // 花费挪到明细表里，三个大数字只留最该看的量
  const cost = doc.cost || {}
  const cnode = el('usagecost')
  if (cnode) {
    cnode.textContent = cash(cost.range)
    cnode.title = `今日 ${cash(cost.today)} · 累计 ${cash(cost.usd)}`
  }

  const pick = (id, value) => {
    const node = el(id)
    if (!node) return
    roll(node, value)
    node.title = exact(value)
  }
  pick('usagein', range.ptok)
  pick('usagenew', range.newtok)
  pick('usageout', range.ctok)
  pick('usagereason', range.reasontok)

  // 缓存命中率：命中量相对输入量，没有输入时给 0%
  const cachenode = el('usagecache')
  if (cachenode) {
    const all = Number(range.ptok) || 0
    const hit = Math.min(Number(range.cachetok) || 0, all)
    const rate = all ? (hit / all) * 100 : 0
    // 没有输入时给 0%，不留横线，格子宽度稳定
    rollpct(cachenode, all ? rate : 0, all && rate < 10 ? 2 : 1)
    cachenode.title = all ? `命中 ${exact(hit)} / 输入 ${exact(all)}` : '没有输入'
  }

  // 成功率与耗时：没有请求时也按零值给，横线看着像没加载出来
  const oknode = el('usageok')
  if (oknode) {
    const calls = Number(q.calls) || 0
    const rate = calls ? ((Number(q.ok) || 0) / calls) * 100 : 0
    rollpct(oknode, calls ? rate : 0, 0)
    oknode.dataset.tone = calls && rate < 90 ? 'bad' : ''
    oknode.title = calls ? `${exact(q.ok)} / ${exact(calls)} 次成功` : '没有请求'
  }
  const msnode = el('usagems')
  if (msnode) {
    const ms = Number(q.avgms) || 0
    if (ms) {
      // 毫秒按整数滚，超过一秒换成秒并保留两位，换挡时看不出跳变
      roll(msnode, ms, (v) => (v < 1000 ? `${Math.round(v)}ms` : `${(v / 1000).toFixed(2)}s`), 620)
    } else msnode.textContent = '0ms'
    msnode.title = ms ? `最慢 ${exact(q.maxms)} 毫秒` : '没有请求'
  }

  paintchart(doc.trend || [])
  paintlist('usagemodels', 'usagemodelsnote', doc.models || [], (one) => one.model)
  paintlist('usagesources', 'usagesourcesnote', doc.sources || [], (one) => labelof(one.source))
  say(`更新于 ${stamp(doc.at || Date.now())}`)
}

// 来源 id 换成给人看的中文名，后端只给 id
function labelof(id) {
  const map = {
    opencode: 'opencode',
    codex: 'codex',
    astrbot: 'astrbot',
    web: '网页',
    script: '脚本',
    other: '其他',
  }
  return map[id] || id || '其他'
}

// 每日柱状：按当天总量算高度，顶上标日期，悬停看细项
function paintchart(trend) {
  const box = el('usagechart')
  if (!box) return
  box.replaceChildren()
  if (!trend.length) {
    el('usagechartstate').textContent = '这段时间还没有记录'
    return
  }
  el('usagechartstate').textContent = ''

  // 柱高按新增量算，跟顶部卡片同一个口径；含缓存的量只放在悬停说明里
  const peak = trend.reduce((max, one) => Math.max(max, Number(one.newtotal) || 0), 0)
  trend.forEach((one, index) => {
    const col = document.createElement('div')
    col.className = 'usagecol'
    const total = Number(one.newtotal) || 0
    col.dataset.on = total > 0 ? '1' : '0'
    col.title = `${one.day}\n新增 ${exact(total)}（输入 ${exact(one.newtok)} + 输出 ${exact(one.ctok)}）\n含缓存共 ${exact(one.ttok)} · 命中 ${exact(one.cachetok)} · 请求 ${exact(one.calls)} 次`

    const bar = document.createElement('span')
    bar.className = 'usagebar'
    // 高度写进变量交给 keyframes，柱子从 0 长到目标值
    // 有量但太小的柱子给个最小高度，否则一条细线都看不见
    const ratio = peak > 0 ? total / peak : 0
    bar.style.setProperty('--h', total > 0 ? `${Math.max(3, Math.round(ratio * 100))}%` : '2px')
    bar.style.setProperty('--delay', `${index * 40}ms`)

    const num = document.createElement('span')
    num.className = 'usagebarnum'
    // 每天顶上的数也从 0 滚上去，跟柱子一起长，切范围能看出量怎么变
    if (total > 0) roll(num, total, null, 620)

    const day = document.createElement('span')
    day.className = 'usagebarday'
    // 只留月日，年份在这类视图里没意义还占宽
    day.textContent = String(one.day).slice(5)

    const wrap = document.createElement('span')
    wrap.className = 'usagebarwrap'
    wrap.append(num, bar)

    col.append(wrap, day)
    box.append(col)
  })
}

// 排行：每行左边名字，右边总量和占比条，条宽按第一名归一
function paintlist(id, noteid, list, nameof) {
  const box = el(id)
  if (!box) return
  box.replaceChildren()
  const note = el(noteid)
  if (!list.length) {
    if (note) note.textContent = '暂无记录'
    const li = document.createElement('li')
    li.className = 'usageempty'
    li.textContent = '这段时间还没有用量'
    box.append(li)
    return
  }
  const peak = list.reduce((max, one) => Math.max(max, Number(one.ttok) || 0), 0)
  const sum = list.reduce((all, one) => all + (Number(one.ttok) || 0), 0)
  const sumNew = list.reduce((all, one) => all + (Number(one.newtotal) || 0), 0)
  // 有请求但一个 token 都没有的，是 token 列上线之前的老记录，单独标出来别让人以为是 0 消耗
  const blind = list.filter((one) => !(Number(one.ttok) > 0) && Number(one.calls) > 0).length
  // 抬头只留两项数字，无数据的条数在列表底部单独说，挤在标题旁边会被截掉
  if (note) note.textContent = `新增 ${human(sumNew)} · 含缓存 ${human(sum)}`

  // 老记录最多摆这么几行，再多就只留一句提示，免得把有数据的挤没影
  const staleMax = 0
  let staleShown = 0

  list.forEach((one, index) => {
    const total = Number(one.ttok) || 0
    const stale = !(total > 0) && Number(one.calls) > 0
    if (stale && staleShown >= staleMax) return
    if (stale) staleShown += 1
    const li = document.createElement('li')
    li.className = 'usageline'
    li.style.setProperty('--delay', `${index * 45}ms`)
    if (stale) li.dataset.stale = '1'

    const name = document.createElement('span')
    name.className = 'usagelinename'
    name.textContent = nameof(one)
    name.title = nameof(one)

    const bar = document.createElement('span')
    bar.className = 'usagelinebar'
    const fill = document.createElement('i')
    const ratio = peak > 0 ? total / peak : 0
    fill.style.setProperty('--w', total > 0 ? `${Math.max(2, Math.round(ratio * 100))}%` : '0%')
    bar.append(fill)

    const num = document.createElement('span')
    num.className = 'usagelinenum'
    // 老记录没有 token，统一写 0，靠下面的说明区分「没数据」和「零消耗」
    if (stale) num.textContent = '0'
    else roll(num, total, null, 620)
    num.title = stale ? '这批请求早于 token 统计，上游没有回用量' : exact(total)

    const sub = document.createElement('span')
    sub.className = 'usagelinesub'
    if (stale) {
      sub.textContent = `${exact(one.calls)} 次 · 早于 token 统计，没有用量数据`
    } else {
      // 输入输出拆开看，缓存命中率决定实际花多少钱
      const hit =
        Number(one.ptok) > 0 ? Math.round((Number(one.cachetok) / Number(one.ptok)) * 100) : 0
      const parts = [
        `${exact(one.calls)} 次`,
        `入 ${human(one.ptok)}（新增 ${human(one.newtok)}）`,
        `出 ${human(one.ctok)}`,
      ]
      if (hit) parts.push(`缓存 ${hit}%`)
      if (one.usd) parts.push(cash(one.usd))
      sub.textContent = parts.join(' · ')
    }

    li.append(name, bar, num, sub)
    box.append(li)
  })

  // 被折叠掉的那批只留一句，点不了也不占高度
  const hidden = blind - staleShown
  if (hidden > 0) {
    const tail = document.createElement('li')
    tail.className = 'usageempty'
    tail.textContent = `另有 ${hidden} 项早于 token 统计，没有用量数据`
    box.append(tail)
  }
}

async function pull() {
  if (state.busy) return
  state.busy = true
  try {
    const res = await fetch(`/__usage?days=${state.days}`, { cache: 'no-store' })
    const doc = await res.json()
    if (doc.error) throw new Error(doc.error)
    state.last = doc.at || Date.now()
    paint(doc)
  } catch (err) {
    // 读失败就把骨架撤了，留着转只会让人以为还在加载
    el('usagechart')?.replaceChildren()
    el('usagemodels')?.replaceChildren()
    el('usagesources')?.replaceChildren()
    say(`读取失败：${err.message}`, 'bad')
  } finally {
    state.busy = false
  }
}

// 范围胶囊：选中项高亮，其余压暗，跟日志页筛选条一个手感
function paintchips() {
  for (const btn of document.querySelectorAll('#view-usage .usagerange .chip')) {
    btn.setAttribute('aria-pressed', String(Number(btn.dataset.days) === state.days))
  }
}

export function mountusage() {
  if (!el('usagechart')) return

  for (const btn of document.querySelectorAll('#view-usage .usagerange .chip')) {
    btn.addEventListener('click', () => {
      state.days = Number(btn.dataset.days) || 7
      paintchips()
      pull()
    })
  }
  paintchips()

  // 只在切到用量页时拉，别的页面不占带宽
  document.addEventListener('view:change', (ev) => {
    if (ev.detail && ev.detail.name === 'usage') pull()
  })

  if (document.documentElement.dataset.view === 'usage') pull()
}
