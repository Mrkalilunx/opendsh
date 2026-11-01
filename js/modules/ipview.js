// 主页：查询出口 IP，可经代理池出网

const el = (id) => document.getElementById(id)

async function query() {
  const value = el('ipval')
  const btn = el('ipbtn')
  if (!value || !btn) return

  // 查的过程中保持地址的形状，只靠扫光表示还在跑，不换成一段文字
  value.textContent = '0.0.0.0'
  value.title = '查询中'
  // 查询要等一秒多，挂个扫光让等待有反馈
  value.dataset.busy = '1'
  btn.disabled = true

  try {
    const res = await fetch('/__ip?proxy=1', { cache: 'no-store' })
    const doc = await res.json()
    if (!res.ok) throw new Error(doc.error || `HTTP ${res.status}`)
    value.textContent = doc.ip
    value.title = doc.via === 'direct' ? '直连出口' : `经代理 ${doc.via}`
  } catch (err) {
    value.textContent = '0.0.0.0'
    value.title = `查询失败：${err.message}`
  } finally {
    delete value.dataset.busy
    btn.disabled = false
  }
}

export function mountip() {
  if (!el('ipval')) return
  el('ipbtn').addEventListener('click', query)
  query()
}
