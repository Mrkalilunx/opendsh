// 设置页：sk 校验开关，key 一行一条，加号新增、减号删除

const state = { keys: [] }

const el = (id) => document.getElementById(id)

function says(text, tone = '') {
  const node = el('keystate')
  if (!node) return
  node.textContent = text
  node.dataset.tone = tone
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    let ok = true
    try {
      ok = document.execCommand('copy')
    } catch {
      ok = false
    }
    area.remove()
    return ok
  }
}

// 一行一条：key 文本占满剩余宽度，超长省略，不换行
function makerow(item) {
  const row = document.createElement('li')
  row.className = 'keyrow'

  const code = document.createElement('code')
  code.className = 'keytext'
  code.textContent = item.key
  code.addEventListener('click', async () => {
    const ok = await copy(item.key)
    code.textContent = ok ? '已复制' : '复制失败'
    setTimeout(() => {
      if (code.isConnected) code.textContent = item.key
    }, 1200)
  })

  const minus = document.createElement('button')
  minus.type = 'button'
  minus.className = 'keyact'
  minus.textContent = '−'
  minus.title = '删除'
  minus.setAttribute('aria-label', '删除这个 key')
  minus.addEventListener('click', () => askremove(row, item))

  row.append(code, minus)
  return row
}

// 删除前原地变成确认行，不弹系统对话框
function askremove(row, item) {
  const text = document.createElement('span')
  text.className = 'keyconfirm'
  text.textContent = '确定删除这个 key？'

  const no = document.createElement('button')
  no.type = 'button'
  no.className = 'btn btn-small'
  no.textContent = '取消'
  no.addEventListener('click', () => render(state.keys))

  const yes = document.createElement('button')
  yes.type = 'button'
  yes.className = 'btn btn-small btn-danger'
  yes.textContent = '删除'
  yes.addEventListener('click', () => remove(item))

  row.replaceChildren(text, no, yes)
}

// 列表下方常驻一行虚线空位，点加号生成（放在滚动区外，始终可见）
function ghost() {
  const row = document.createElement('div')
  row.className = 'keyrow keyghost'
  row.tabIndex = 0
  row.setAttribute('role', 'button')
  row.setAttribute('aria-label', '生成新 key')

  const label = document.createElement('span')
  label.className = 'keyaddtext'
  label.textContent = '添加 key'

  const plus = document.createElement('button')
  plus.type = 'button'
  plus.className = 'keyact keyact-plus'
  plus.textContent = '+'
  plus.tabIndex = -1
  plus.setAttribute('aria-hidden', 'true')

  row.append(label, plus)

  const go = () => create()
  row.addEventListener('click', go)
  row.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' && ev.key !== ' ') return
    ev.preventDefault()
    go()
  })
  return row
}

function render(keys) {
  state.keys = keys
  const list = el('keylist')
  if (!list) return
  const top = list.scrollTop
  list.innerHTML = ''
  for (const item of keys) list.appendChild(makerow(item))
  list.scrollTop = top
}

async function load() {
  try {
    const res = await fetch('/__keys', { cache: 'no-store' })
    const doc = await res.json()
    if (!res.ok) throw new Error(doc.error || `HTTP ${res.status}`)
    render(doc.keys || [])
    says('')
  } catch (err) {
    says(`读取失败：${err.message}`, 'bad')
  }
}

async function create() {
  try {
    const res = await fetch('/__keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'create' }),
    })
    const doc = await res.json()
    if (!res.ok) throw new Error(doc.error || `HTTP ${res.status}`)
    render(doc.keys || [])
    says('')
    const list = el('keylist')
    if (list) list.scrollTop = list.scrollHeight
  } catch (err) {
    says(`生成失败：${err.message}`, 'bad')
  }
}

async function remove(item) {
  try {
    const res = await fetch('/__keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'delete', id: item.id }),
    })
    const doc = await res.json()
    if (!res.ok) throw new Error(doc.error || `HTTP ${res.status}`)
    render(doc.keys || [])
    says('')
  } catch (err) {
    says(`删除失败：${err.message}`, 'bad')
    render(state.keys)
  }
}

export function mountkeymanage() {
  if (!el('keylist')) return
  el('keylist').after(ghost())
  return load()
}
