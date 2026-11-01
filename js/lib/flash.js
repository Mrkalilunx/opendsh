// 数值更新时轻轻闪一下：只在内容真变了才播，轮询刷新没变化就不打扰

const DURATION = 520
// 同一个节点两秒半内只闪一次：六秒一轮的监控读数经常每次都在变，不节流会一直闪
const GAP = 2500

// 把文字写进节点，内容跟上次不一样才挂闪烁类
export function setflash(node, text) {
  if (!node) return
  const next = String(text ?? '')
  if (node.textContent === next) return
  node.textContent = next
  const now = Date.now()
  if (now - (node.__flashat || 0) < GAP) return
  node.__flashat = now
  // 先摘类并读一次布局，连续更新时动画才会重新开始
  node.classList.remove('valflash')
  void node.offsetWidth
  node.classList.add('valflash')
  clearTimeout(node.__flashtimer)
  node.__flashtimer = setTimeout(() => node.classList.remove('valflash'), DURATION)
}
