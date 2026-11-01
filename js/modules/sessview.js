// 主页：显示当前 session，刷新即重建整池

const el = (id) => document.getElementById(id)

function paint(doc) {
  const current = doc.ids && doc.cursor >= 0 ? doc.ids[doc.cursor] : ''
  const value = el('sessval')
  if (!value) return
  value.textContent = current || '空'
  value.title = current || ''
}

async function load() {
  try {
    const res = await fetch('/__sessions', { cache: 'no-store' })
    const doc = await res.json()
    if (!res.ok) throw new Error(doc.error || `HTTP ${res.status}`)
    paint(doc)
  } catch (err) {
    el('sessval').textContent = '读取失败'
    el('sessval').title = err.message
  }
}

async function reset() {
  const btn = el('sessbtn')
  btn.disabled = true
  try {
    const res = await fetch('/__sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    const doc = await res.json()
    if (!res.ok) throw new Error(doc.error || `HTTP ${res.status}`)
    paint(doc)
    el('sessval').title = '已重新生成整池'
  } catch (err) {
    el('sessval').textContent = '刷新失败'
    el('sessval').title = err.message
  } finally {
    btn.disabled = false
  }
}

export function mountsess() {
  if (!el('sessval')) return
  el('sessbtn').addEventListener('click', reset)
  load()
}
