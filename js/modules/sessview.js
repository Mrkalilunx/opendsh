// 主页：显示当前 session，刷新即重建整池

const el = (id) => document.getElementById(id)

function paint(doc) {
  const current = doc.ids && doc.cursor >= 0 ? doc.ids[doc.cursor] : ''
  const value = el('sessval')
  if (!value) return
  // session 很长，换新的时闪一下提醒变了
  // 没有现成 id 时给个同形状的零值，宽度和真实值一样，不塌
  value.textContent = current || 'ses_000000000000000000000000'
  value.title = current || ''
}

async function load() {
  try {
    const res = await fetch('/__sessions', { cache: 'no-store' })
    const doc = await res.json()
    if (!res.ok) throw new Error(doc.error || `HTTP ${res.status}`)
    paint(doc)
  } catch (err) {
    el('sessval').textContent = 'ses_000000000000000000000000'
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
    el('sessval').textContent = 'ses_000000000000000000000000'
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
