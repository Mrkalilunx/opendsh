// 舞台模块：维护热重载状态指示，入场动效交给 CSS

const statusbox = () => document.querySelector('.meta')
const statustext = () => document.getElementById('status')

const texts = {
  online: '热重载已连接',
  offline: '热重载断开，正在重连…',
  idle: '正在连接热重载…',
}

function setstate(online, text) {
  const box = statusbox()
  const label = statustext()
  if (box) box.dataset.online = String(online)
  if (label) label.textContent = text || texts[online ? 'online' : 'offline']
}

export function mounthero() {
  // 服务端注入的客户端脚本会派发 live:state 事件
  document.addEventListener('live:state', (ev) => {
    const { online, text } = ev.detail || {}
    setstate(Boolean(online), text)
  })

  // 注入脚本可能在模块加载前就发过事件，进来先补读一次最新状态
  const now = window.__live
  if (now) setstate(Boolean(now.online), now.text)
  else setstate(false, texts.idle)
}
