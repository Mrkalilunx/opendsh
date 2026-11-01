// 路由：hash 切页，切页时广播 view:change

const views = ['home', 'chat', 'settings', 'logs', 'usage']

function parse() {
  const raw = location.hash.replace(/^#\/?/, '').trim()
  return views.includes(raw) ? raw : 'home'
}

// 页签指示块：量出当前页签的宽高和位置，交给 CSS 过渡滑过去
// 首帧只定位不滑动，位置落定后才挂 tabglider-on 开过渡
function glide(nav) {
  const bar = nav.querySelector('.tabglider')
  const cur = nav.querySelector('.tab[aria-current="page"]')
  if (!bar || !cur) return
  // 页签被弹到第二行或还没排版时量不到宽度，跳过等下一轮
  if (!cur.offsetWidth) return
  // 指示块绝对定位在滚动容器里，位置是内容坐标，得减掉已滚动的距离才对得上
  bar.style.width = `${cur.offsetWidth}px`
  bar.style.height = `${cur.offsetHeight}px`
  bar.style.transform = `translate(${cur.offsetLeft - nav.scrollLeft}px, ${cur.offsetTop}px)`
  if (!nav.classList.contains('tabglider-on')) {
    requestAnimationFrame(() => nav.classList.add('tabglider-on'))
  }
}

// 窄屏页签放不全时，切页要把选中的那个滑进可视区
// 用 scrollTo 只滚这一条，不用 scrollIntoView，后者会把整个页面一起滚
function reveal(nav, cur) {
  if (!cur || !nav.clientWidth) return
  const left = cur.offsetLeft
  const right = left + cur.offsetWidth
  const view = nav.scrollLeft
  if (left < view) nav.scrollTo({ left: Math.max(0, left - 4), behavior: 'smooth' })
  else if (right > view + nav.clientWidth) {
    nav.scrollTo({ left: right - nav.clientWidth + 4, behavior: 'smooth' })
  }
}

// 每次切页重挂一次入场动画：先摘类，读一次布局让浏览器认账，再挂回去
function enter(node) {
  node.classList.remove('view-in')
  void node.offsetWidth
  node.classList.add('view-in')
}

function show(name) {
  for (const view of views) {
    const node = document.getElementById(`view-${view}`)
    if (!node) continue
    const on = view === name
    node.hidden = !on
    if (on) enter(node)
  }
  for (const tab of document.querySelectorAll('.tab')) {
    tab.setAttribute('aria-current', tab.dataset.view === name ? 'page' : 'false')
  }
  document.documentElement.dataset.view = name
  const nav = document.querySelector('.tabs')
  if (nav) {
    reveal(nav, nav.querySelector('.tab[aria-current="page"]'))
    glide(nav)
  }
  document.dispatchEvent(new CustomEvent('view:change', { detail: { name } }))
}

export function mountrouter() {
  window.addEventListener('hashchange', () => show(parse()))
  // 屏幕旋转、字号缩放都会改变页签宽度，重新量一次并直接对齐
  window.addEventListener('resize', () => {
    const nav = document.querySelector('.tabs')
    if (!nav) return
    nav.classList.remove('tabglider-on')
    glide(nav)
  })
  // 手指横向滑页签时指示块要跟手，这段期间先关过渡，停手一会儿再开
  const nav = document.querySelector('.tabs')
  if (nav) {
    let timer = 0
    nav.addEventListener(
      'scroll',
      () => {
        nav.classList.remove('tabglider-on')
        glide(nav)
        clearTimeout(timer)
        timer = setTimeout(() => nav.classList.add('tabglider-on'), 140)
      },
      { passive: true },
    )
  }
  show(parse())
}
