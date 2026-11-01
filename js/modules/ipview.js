// 主页：查询出口 IP，可经代理池出网

const el = (id) => document.getElementById(id)

async function query() {
  const value = el('ipval')
  const btn = el('ipbtn')
  if (!value || !btn) return

  value.textContent = '查询中…'
  value.title = ''
  btn.disabled = true

  try {
    const res = await fetch('/__ip?proxy=1', { cache: 'no-store' })
    const doc = await res.json()
    if (!res.ok) throw new Error(doc.error || `HTTP ${res.status}`)
    value.textContent = doc.ip
    value.title = doc.via === 'direct' ? '直连出口' : `经代理 ${doc.via}`
  } catch (err) {
    value.textContent = '查询失败'
    value.title = err.message
  } finally {
    btn.disabled = false
  }
}

export function mountip() {
  if (!el('ipval')) return
  el('ipbtn').addEventListener('click', query)
  query()
}
