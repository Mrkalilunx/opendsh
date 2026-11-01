// 底部详情面板的开关：关的时候先播退场再真正藏起来，直接 hidden 太生硬
// 同一块面板短时间内重复开关时靠序号作废旧计时器，避免退场把刚开的又藏了

const SHUT = 200

let seq = 0

const calm = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

// 打开：清掉退场标记，序号一换，挂着的退场计时就失效了
export function opensheet(node) {
  if (!node) return
  seq += 1
  node.__shutid = seq
  // 退场还没播完就又打开了：CSS 入场动画不会重播，这里补一段淡入把衔接补上
  if (node.dataset.shut) {
    delete node.dataset.shut
    node.hidden = false
    if (calm() || typeof node.animate !== 'function') return
    node.animate([{ opacity: 0.7 }, { opacity: 1 }], { duration: 140, easing: 'ease-out' })
    const panel = node.firstElementChild
    if (panel && typeof panel.animate === 'function') {
      panel.animate([{ transform: 'translateY(6%)' }, { transform: 'none' }], {
        duration: 160,
        easing: 'cubic-bezier(0.32, 0.72, 0, 1)',
      })
    }
    return
  }
  delete node.dataset.shut
  node.hidden = false
}

// 关闭：播完退场再藏，收尾回调里可以继续做别的
export function shutsheet(node, then) {
  if (!node || node.hidden) return
  // 系统要求少动效就立刻收，不留空等
  if (calm()) {
    node.hidden = true
    delete node.dataset.shut
    if (then) then()
    return
  }
  seq += 1
  const id = seq
  node.__shutid = id
  node.dataset.shut = '1'
  setTimeout(() => {
    if (node.__shutid !== id) return
    node.hidden = true
    delete node.dataset.shut
    if (then) then()
  }, SHUT)
}
