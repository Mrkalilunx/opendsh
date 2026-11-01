// 设置页：session 一行一条，加号追加、减号删除、整池可重新生成

const state = { ids: [] }

const el = (id) => document.getElementById(id)

function says(text, tone = '') {
  const node = el('sessstate')
  if (!node) return
  node.textContent = text
  node.dataset.tone = tone
}

function makerow(id) {
  const row = document.createElement('li')
  row.className = 'keyrow'

  const code = document.createElement('code')
  code.className = 'keytext'
  code.textContent = id
  code.title = id

  const minus = document.createElement('button')
  minus.type = 'button'
  minus.className = 'keyact'
  minus.textContent = '−'
  minus.title = '删除'
  minus.setAttribute('aria-label', '删除这个 session')
  minus.addEventListener('click', () => drop(id))

  row.append(code, minus)
  return row
}

// 列表下方常驻一行虚线空位，点加号追加一个（放在滚动区外，始终可见）
function ghost() {
  const row = document.createElement('div')
  row.className = 'keyrow keyghost'
  row.tabIndex = 0
  row.setAttribute('role', 'button')
  row.setAttribute('aria-label', '追加一个 session')

  const label = document.createElement('span')
  label.className = 'keyaddtext'
  label.textContent = '添加 session'

  const plus = document.createElement('button')
  plus.type = 'button'
  plus.className = 'keyact keyact-plus'
  plus.textContent = '+'
  plus.tabIndex = -1
  plus.setAttribute('aria-hidden', 'true')

  row.append(label, plus)

  const go = () => append()
  row.addEventListener('click', go)
  row.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' && ev.key !== ' ') return
    ev.preventDefault()
    go()
  })
  return row
}

function paint(doc) {
  state.ids = doc.ids || []
  const list = el('sessrows')
  if (!list) return
  const top = list.scrollTop
  list.innerHTML = ''
  for (const id of state.ids) list.appendChild(makerow(id))
  list.scrollTop = top

  const note = el('sessnote')
  if (note) note.textContent = `池 ${doc.size} 个 · 当前第 ${doc.cursor + 1} 个`
}

async function post(body) {
  const res = await fetch('/__sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const doc = await res.json()
  if (!res.ok) throw new Error(doc.error || `HTTP ${res.status}`)
  return doc
}

async function load() {
  try {
    const res = await fetch('/__sessions', { cache: 'no-store' })
    const doc = await res.json()
    if (!res.ok) throw new Error(doc.error || `HTTP ${res.status}`)
    paint(doc)
    says('')
  } catch (err) {
    // 读失败就把占位行撤了，别让骨架一直转着像还在等
    el('sessrows')?.replaceChildren()
    says(`读取失败：${err.message}`, 'bad')
  }
}

async function drop(id) {
  const ids = state.ids.filter((item) => item !== id)
  if (!ids.length) return says('至少要保留一个 session', 'bad')
  try {
    const doc = await post({ ids })
    paint(doc)
    says('')
  } catch (err) {
    says(`删除失败：${err.message}`, 'bad')
  }
}

async function append() {
  try {
    const doc = await post({ action: 'append' })
    paint(doc)
    says('')
    const list = el('sessrows')
    if (list) list.scrollTop = list.scrollHeight
  } catch (err) {
    says(`添加失败：${err.message}`, 'bad')
  }
}

async function reset() {
  try {
    const doc = await post({})
    paint(doc)
    says('')
  } catch (err) {
    says(`生成失败：${err.message}`, 'bad')
  }
}

export function mountsessionedit() {
  if (!el('sessrows')) return
  el('sessrows').after(ghost())
  el('sessreset').addEventListener('click', reset)
  return load()
}
