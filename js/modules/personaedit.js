// 设置页人设库：只管增删改，用哪张在对话页挑，这里点行不切换

const state = { items: [] }

const el = (id) => document.getElementById(id)

function says(text, tone = '') {
  const node = el('personastate')
  if (!node) return
  node.textContent = text
  node.dataset.tone = tone
}

function syncnote() {
  const note = el('personanote')
  if (!note) return
  note.textContent = state.items.length ? `${state.items.length} 张` : '还没有人设'
}

function one(text) {
  return String(text || '').replace(/\s+/g, ' ').trim()
}

// 卡片主体：首行摘要 + 编辑 + 删除，行本身不响应点击
function makerow(item) {
  const row = document.createElement('li')
  row.className = 'keyrow personarow'
  row.title = item.text

  const text = document.createElement('span')
  text.className = 'personatext'
  text.textContent = one(item.text)

  const edit = document.createElement('button')
  edit.type = 'button'
  edit.className = 'keyact'
  edit.title = '编辑'
  edit.setAttribute('aria-label', '编辑人设')
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
  minus.setAttribute('aria-label', '删除这个人设')
  minus.addEventListener('click', (ev) => {
    ev.stopPropagation()
    askremove(row, item)
  })

  row.append(text, edit, minus)
  return row
}

// 就地编辑：卡片原地撑成竖排，textarea + 保存/取消
function editerow(row, item) {
  row.classList.add('personaedit')
  row.removeAttribute('tabindex')

  const area = document.createElement('textarea')
  area.className = 'field-input'
  area.rows = 3
  area.maxLength = 2000
  area.value = item ? item.text : ''
  area.placeholder = '写一段人设，比如：你是大肥鱼，陪人闲聊，答话简短口语'
  area.setAttribute('aria-label', '人设内容')

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
    const body = area.value.trim()
    if (!body) {
      says('人设内容不能为空', 'bad')
      area.focus()
      return
    }
    if (item) save({ action: 'update', id: item.id, text: body })
    else save({ action: 'create', text: body }, true)
  })

  acts.append(no, yes)
  row.replaceChildren(area, acts)
  area.focus()
  area.setSelectionRange(area.value.length, area.value.length)
}

// 删除前原地变成确认行，不弹系统对话框
function askremove(row, item) {
  row.classList.remove('personaedit')
  row.removeAttribute('tabindex')

  const text = document.createElement('span')
  text.className = 'keyconfirm'
  text.textContent = '删除这张人设？'

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
    save({ action: 'delete', id: item.id })
  })

  row.replaceChildren(text, no, yes)
}

// 列表下方常驻虚线空位，点加号新建一张（在滚动区外，始终可见）
function ghost() {
  const row = document.createElement('div')
  row.className = 'keyrow keyghost'
  row.tabIndex = 0
  row.setAttribute('role', 'button')
  row.setAttribute('aria-label', '新增人设')

  const label = document.createElement('span')
  label.className = 'keyaddtext'
  label.textContent = '添加人设'

  const plus = document.createElement('button')
  plus.type = 'button'
  plus.className = 'keyact keyact-plus'
  plus.textContent = '+'
  plus.tabIndex = -1
  plus.setAttribute('aria-hidden', 'true')

  row.append(label, plus)

  const go = () => {
    const list = el('personarows')
    // 已有卡片在编辑就回到它，不叠第二个编辑框
    const busy = list.querySelector('.personaedit textarea')
    if (busy) {
      busy.focus()
      return
    }
    const card = document.createElement('li')
    card.className = 'keyrow personarow personaedit'
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
  if (doc) {
    state.items = doc.items || []
  }
  const list = el('personarows')
  if (!list) return
  const top = list.scrollTop
  list.innerHTML = ''
  for (const item of state.items) list.appendChild(makerow(item))
  list.scrollTop = top
  syncnote()
  // 对话页收到这个事件就重新读一遍人设，删掉正在用的那张它会自动回落到内置人设
  document.dispatchEvent(new CustomEvent('persona:change', { detail: { text: String(doc?.text || '') } }))
}

async function request(body) {
  const res = await fetch('/__personas', {
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
      const list = el('personarows')
      if (list) list.scrollTop = list.scrollHeight
    }
  } catch (err) {
    says(`保存失败：${err.message}`, 'bad')
    paint()
  }
}

async function load() {
  try {
    const res = await fetch('/__personas', { cache: 'no-store' })
    const doc = await res.json()
    if (!res.ok) throw new Error(doc.error || `HTTP ${res.status}`)
    paint(doc)
    says('')
  } catch (err) {
    // 读失败就把占位行撤了，别让骨架一直转着像还在等
    el('personarows')?.replaceChildren()
    says(`读取失败：${err.message}`, 'bad')
  }
}

export function mountpersona() {
  const list = el('personarows')
  if (!list) return
  list.setAttribute('role', 'group')
  list.after(ghost())
  return load()
}
