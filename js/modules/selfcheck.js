// 调试页的服务自检：只认手动点按钮，不自动跑

const el = (id) => document.getElementById(id)

const state = { busy: false }

// 耗时短的按毫秒给，长的按秒给，跟请求记录那边一个口径
function cost(n) {
  const v = Number(n) || 0
  return v < 1000 ? `${v}ms` : `${(v / 1000).toFixed(2)}s`
}

function say(text, tone = '') {
  const node = el('chkstate')
  if (!node) return
  node.textContent = text
  node.dataset.tone = tone
}

// 一行一段：状态点、名称、说明、耗时
function makerow(item) {
  const li = document.createElement('li')
  li.className = 'chkrow'
  li.dataset.ok = item.ok ? '1' : '0'

  const dot = document.createElement('span')
  dot.className = 'chkdot'
  dot.dataset.ok = item.ok ? '1' : '0'
  dot.setAttribute('aria-hidden', 'true')

  const name = document.createElement('span')
  name.className = 'chkname'
  name.textContent = item.name

  const detail = document.createElement('span')
  detail.className = 'chkdetail'
  detail.textContent = item.detail || (item.ok ? '正常' : '失败')

  const ms = document.createElement('span')
  ms.className = 'chkms'
  ms.textContent = cost(item.ms)

  li.append(dot, name, detail, ms)
  return li
}

// 跑之前先把上一次的结果压暗，看得出正在重跑
function pending() {
  for (const row of el('chkrows')?.children || []) row.dataset.busy = '1'
}

function paint(items) {
  const list = el('chkrows')
  if (!list) return
  list.replaceChildren(...items.map(makerow))
}

async function run() {
  if (state.busy) return
  state.busy = true
  const btn = el('chkrun')
  if (btn) btn.disabled = true
  pending()
  say('正在自检…')
  try {
    const res = await fetch('/__selfcheck', { cache: 'no-store' })
    const doc = await res.json()
    if (doc.error) throw new Error(doc.error)
    paint(doc.items || [])
    const bad = (doc.items || []).filter((it) => !it.ok)
    const forced = doc.forced ? ` · ${doc.forced}` : ''
    if (bad.length) {
      say(`${bad.length} 项不通过：${bad.map((it) => it.name).join('、')} · 共 ${cost(doc.ms)}${forced}`, 'bad')
    } else {
      say(`${(doc.items || []).length} 项全部通过 · 共 ${cost(doc.ms)}${forced}`, 'ok')
    }
  } catch (err) {
    say(`自检失败：${err.message}`, 'bad')
  } finally {
    state.busy = false
    if (btn) btn.disabled = false
  }
}

// 自检只认手动点击，切到调试分类不再自动跑，免得一进设置就开始探上游
export function mountselfcheck() {
  if (!el('chkrows')) return
  el('chkrun')?.addEventListener('click', run)
  // 空着的时候给句话，不然一块空白不知道要等还是要点
  if (!el('chkrows').children.length) say('点「跑一遍」开始检查')
}
