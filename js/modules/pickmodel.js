// 模型切换：自绘抽屉，数据来自本地 /v1/models，选择记在 localStorage

const storekey = 'dsh:model'

const state = {
  models: [],
  open: false,
}

const el = (id) => document.getElementById(id)

function syncname(id) {
  el('pickname').textContent = id || '未选择模型'
}

function select(id) {
  const row = [...el('picklist').children].find((n) => n.dataset.id === id)
  if (!row) return
  for (const n of el('picklist').children) n.setAttribute('aria-selected', String(n === row))
  syncname(id)
  localStorage.setItem(storekey, id)
  close()
}

function open() {
  state.open = true
  el('drawer').hidden = false
  el('pickerbtn').setAttribute('aria-expanded', 'true')
  const current = [...el('picklist').children].find((n) => n.getAttribute('aria-selected') === 'true')
  if (current) current.focus()
}

function close() {
  state.open = false
  el('drawer').hidden = true
  el('pickerbtn').setAttribute('aria-expanded', 'false')
}

function toggle() {
  if (state.open) close()
  else open()
}

function render(ids, picked) {
  const list = el('picklist')
  list.innerHTML = ''
  el('pickcount').textContent = String(ids.length)

  for (const id of ids) {
    const row = document.createElement('button')
    row.type = 'button'
    row.className = 'picker-row'
    row.dataset.id = id
    row.setAttribute('role', 'option')
    row.setAttribute('aria-selected', String(id === picked))

    const name = document.createElement('span')
    name.className = 'picker-id'
    name.textContent = id
    row.appendChild(name)

    if (id.endsWith('-free')) {
      const tag = document.createElement('span')
      tag.className = 'picker-tag'
      tag.textContent = '免费'
      row.appendChild(tag)
    }

    const tick = document.createElement('span')
    tick.className = 'tick'
    tick.textContent = '✓'
    row.appendChild(tick)

    row.addEventListener('click', () => select(id))
    list.appendChild(row)
  }

  syncname(picked)
}

async function loadmodels() {
  const saved = localStorage.getItem(storekey) || ''
  try {
    const res = await fetch('/v1/models')
    const doc = await res.json()
    state.models = (doc.data || []).map((m) => m.id)
    if (!state.models.length) throw new Error('列表为空')
  } catch (err) {
    const row = document.createElement('button')
    row.type = 'button'
    row.className = 'picker-row'
    row.textContent = `模型列表不可用：${err.message}`
    row.disabled = true
    el('picklist').appendChild(row)
    syncname('加载失败')
    return
  }

  const prefer = 'deepseek-v4.1-flash-free'
  const picked = state.models.includes(saved) ? saved : (state.models.includes(prefer) ? prefer : state.models[0])
  render(state.models, picked)
  localStorage.setItem(storekey, picked)
}

export function mountpicker() {
  const btn = el('pickerbtn')
  if (!btn) return

  btn.addEventListener('click', toggle)

  document.addEventListener('click', (ev) => {
    if (!state.open) return
    if (el('picker').contains(ev.target)) return
    close()
  })

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && state.open) close()
  })

  loadmodels()
}
