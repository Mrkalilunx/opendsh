// 设置页模型映射：左边客户端报的名字，右边上游真名，一行一条，加号新增

const state = { items: [] }

const el = (id) => document.getElementById(id)

function says(text, tone = '') {
  const node = el('mapstate')
  if (!node) return
  node.textContent = text
  node.dataset.tone = tone
}

function syncnote() {
  const note = el('mapnote')
  if (!note) return
  note.textContent = state.items.length ? `${state.items.length} 条映射` : '没有映射'
}

// 卡片主体：原名 → 上游名，右侧编辑和删除
function makerow(item) {
  const row = document.createElement('li')
  row.className = 'keyrow maprow'
  row.title = `${item.from} → ${item.to}`

  const from = document.createElement('span')
  from.className = 'mapname mapfrom'
  from.textContent = item.from

  const arrow = document.createElement('span')
  arrow.className = 'maparrow'
  arrow.textContent = '→'
  arrow.setAttribute('aria-hidden', 'true')

  const to = document.createElement('span')
  to.className = 'mapname mapto'
  to.textContent = item.to

  const edit = document.createElement('button')
  edit.type = 'button'
  edit.className = 'keyact'
  edit.title = '编辑'
  edit.setAttribute('aria-label', '编辑这条映射')
  edit.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L20 8l-4-4L4 16v4z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>'
  edit.addEventListener('click', (ev) => {
    ev.stopPropagation()
    editerow(row, item)
  })

  const minus = document.createElement('button')
  minus.type = 'button'
  minus.className = 'keyact'
  minus.textContent = '−'
  minus.title = '删除'
  minus.setAttribute('aria-label', '删除这条映射')
  minus.addEventListener('click', (ev) => {
    ev.stopPropagation()
    askremove(row, item)
  })

  row.append(from, arrow, to, edit, minus)
  return row
}

// 就地编辑：两个输入框竖排，保存时原名也能改
function editerow(row, item) {
  row.classList.add('personaedit')
  row.removeAttribute('title')

  const from = document.createElement('input')
  from.className = 'field-input'
  from.type = 'text'
  from.spellcheck = false
  from.value = item ? item.from : ''
  from.placeholder = '客户端报的模型名，比如 gpt-5-codex'
  from.setAttribute('aria-label', '客户端模型名')

  const to = document.createElement('input')
  to.className = 'field-input'
  to.type = 'text'
  to.spellcheck = false
  to.value = item ? item.to : ''
  to.placeholder = '上游真名，比如 deepseek-v4.1-flash-free'
  to.setAttribute('aria-label', '上游模型名')

  const acts = document.createElement('div')
  acts.className = 'personaacts'

  const no = document.createElement('button')
  no.type = 'button'
  no.className = 'btn btn-small'
  no.textContent = '取消'
  no.addEventListener('click', () => paint())

  const yes = document.createElement('button')
  yes.type = 'button'
  yes.className = 'btn btn-small btn-main'
  yes.textContent = '保存'
  yes.addEventListener('click', () => {
    const a = from.value.trim()
    const b = to.value.trim()
    if (!a || !b) {
      says('两个模型名都要填', 'bad')
      ;(a ? to : from).focus()
      return
    }
    if (item) save({ action: 'update', from: item.from, nextfrom: a, to: b })
    else save({ action: 'create', from: a, to: b }, true)
  })

  acts.append(no, yes)
  row.replaceChildren(from, to, acts)
  from.focus()
  from.setSelectionRange(from.value.length, from.value.length)
}

// 删除前原地变成确认行，不弹系统对话框
function askremove(row, item) {
  row.classList.remove('personaedit')

  const text = document.createElement('span')
  text.className = 'keyconfirm'
  text.textContent = `删除 ${item.from} 这条映射？`

  const no = document.createElement('button')
  no.type = 'button'
  no.className = 'btn btn-small'
  no.textContent = '取消'
  no.addEventListener('click', (ev) => {
    ev.stopPropagation()
    paint()
  })

  const yes = document.createElement('button')
  yes.type = 'button'
  yes.className = 'btn btn-small btn-danger'
  yes.textContent = '删除'
  yes.addEventListener('click', (ev) => {
    ev.stopPropagation()
    save({ action: 'delete', from: item.from })
  })

  row.replaceChildren(text, no, yes)
}

// 列表下方常驻虚线空位，点加号新建一条（在滚动区外，始终可见）
function ghost() {
  const row = document.createElement('div')
  row.className = 'keyrow keyghost'
  row.tabIndex = 0
  row.setAttribute('role', 'button')
  row.setAttribute('aria-label', '新增模型映射')

  const label = document.createElement('span')
  label.className = 'keyaddtext'
  label.textContent = '添加映射'

  const plus = document.createElement('button')
  plus.type = 'button'
  plus.className = 'keyact keyact-plus'
  plus.textContent = '+'
  plus.tabIndex = -1
  plus.setAttribute('aria-hidden', 'true')

  row.append(label, plus)

  const go = () => {
    const list = el('maprows')
    const busy = list.querySelector('.personaedit input')
    if (busy) {
      busy.focus()
      return
    }
    const card = document.createElement('li')
    card.className = 'keyrow maprow personaedit'
    list.appendChild(card)
    editerow(card, null)
    card.scrollIntoView({ block: 'nearest' })
  }
  row.addEventListener('click', go)
  row.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' && ev.key !== ' ') return
    ev.preventDefault()
    go()
  })
  return row
}

function paint(doc) {
  if (doc) state.items = Array.isArray(doc.items) ? doc.items : []
  const list = el('maprows')
  if (!list) return
  const top = list.scrollTop
  list.innerHTML = ''
  for (const item of state.items) list.appendChild(makerow(item))
  list.scrollTop = top
  syncnote()
}

async function request(body) {
  const res = await fetch('/__modelmap', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const doc = await res.json()
  if (!res.ok) throw new Error(doc.error || `HTTP ${res.status}`)
  return doc
}

async function save(body, scrollend = false) {
  try {
    const doc = await request(body)
    paint(doc)
    says('')
    if (scrollend) {
      const list = el('maprows')
      if (list) list.scrollTop = list.scrollHeight
    }
  } catch (err) {
    says(`保存失败：${err.message}`, 'bad')
    paint()
  }
}

async function load() {
  try {
    const res = await fetch('/__modelmap', { cache: 'no-store' })
    const doc = await res.json()
    if (!res.ok) throw new Error(doc.error || `HTTP ${res.status}`)
    paint(doc)
    says('')
  } catch (err) {
    // 读失败就把占位行撤了，别让骨架一直转着像还在等
    el('maprows')?.replaceChildren()
    says(`读取失败：${err.message}`, 'bad')
  }
}

export function mountmap() {
  const list = el('maprows')
  if (!list) return
  list.setAttribute('role', 'group')
  list.after(ghost())
  return load()
}
