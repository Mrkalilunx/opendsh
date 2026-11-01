// 强制状态：把某一段假装成失败或假装成正常，只为看页面表现
// so: 存在设置里，刷新和换 device 都保留，清空后立刻回到真实探测

const el = (id) => document.getElementById(id)

let tokens = []
let off = new Set()
let on = new Set()

function split(text) {
  const all = new Set()
  for (const one of String(text || '').split(/[,，\s]+/)) {
    const id = one.trim().toLowerCase()
    if (id) all.add(id)
  }
  return all
}

function say(text, tone = '') {
  const node = el('fakestate')
  if (!node) return
  node.textContent = text
  node.dataset.tone = tone
}

// 某一段当前被强制成什么：auto 不干预、fail 强制失败、ok 强制正常
function modeof(id) {
  if (off.has(id)) return 'fail'
  if (on.has(id)) return 'ok'
  return 'auto'
}

async function send() {
  const body = {
    forceoff: [...off].join(','),
    forceon: [...on].join(','),
  }
  try {
    const res = await fetch('/__settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const doc = await res.json()
    if (!res.ok) throw new Error(doc.error || `HTTP ${res.status}`)
    document.dispatchEvent(new CustomEvent('settings:change', { detail: doc.settings }))
    paint()
    say('已生效', 'ok')
  } catch (err) {
    say(`保存失败：${err.message}`, 'bad')
  }
}

function pick(id, mode) {
  off.delete(id)
  on.delete(id)
  if (mode === 'fail') off.add(id)
  if (mode === 'ok') on.add(id)
  send()
}

function buttons(id, now) {
  const box = document.createElement('span')
  box.className = 'fakepick'
  for (const [mode, label] of [['auto', '自动'], ['fail', '失败'], ['ok', '正常']]) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'fakebtn'
    btn.textContent = label
    btn.dataset.mode = mode
    btn.dataset.on = String(mode === now)
    btn.setAttribute('aria-pressed', String(mode === now))
    btn.addEventListener('click', () => pick(id, mode))
    box.append(btn)
  }
  return box
}

function paint() {
  const list = el('fakerows')
  if (!list) return
  if (!tokens.length) {
    list.replaceChildren()
    return
  }
  list.replaceChildren(
    ...tokens.map((it) => {
      const li = document.createElement('li')
      li.className = 'fakerow'
      li.dataset.mode = modeof(it.id)

      const name = document.createElement('span')
      name.className = 'fakename'
      name.textContent = it.label

      li.append(name, buttons(it.id, modeof(it.id)))
      return li
    }),
  )
}

function load(settings) {
  off = split(settings.forceoff)
  on = split(settings.forceon)
  paint()
}

export function mountfakeforce() {
  if (!el('fakerows')) return

  el('fakeclear')?.addEventListener('click', () => {
    off = new Set()
    on = new Set()
    send()
  })

  // 面板可以先不显示，数据照拉，等调试分类露头时已经齐了
  fetch('/__settings', { cache: 'no-store' })
    .then((res) => res.json())
    .then((doc) => {
      tokens = Array.isArray(doc.fakes) ? doc.fakes : []
      load(doc.settings || {})
    })
    .catch(() => {
      say('读取失败，稍后自己刷一下页面', 'bad')
    })

  document.addEventListener('settings:change', (ev) => {
    if (ev.detail) load(ev.detail)
  })
}
