// 主题色：只换强调色与底色，选完立刻生效，存在本机浏览器

const themekey = 'dsh:theme'
const themes = ['blue', 'violet', 'cyan', 'green', 'amber', 'rose', 'slate']
const names = {
  blue: '蓝色',
  violet: '紫色',
  cyan: '青色',
  green: '绿色',
  amber: '琥珀',
  rose: '玫红',
  slate: '石墨',
}

const el = (id) => document.getElementById(id)

// 换主题时给整站补一段短过渡，首屏那次不加，否则会看到底色从蓝渐变过去
let themeTimer = 0

function fadecolor() {
  const root = document.documentElement
  root.classList.add('themeing')
  clearTimeout(themeTimer)
  themeTimer = setTimeout(() => root.classList.remove('themeing'), 260)
}

// 状态栏底色跟着当前底色走，深浅色切换后也要重刷一次
function paintmeta() {
  const meta = document.querySelector('meta[name="theme-color"]')
  if (!meta) return
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()
  meta.content = bg || '#f7f8ff'
}

function normalize(name) {
  return themes.includes(name) ? name : 'blue'
}

function apply(name, animate = true) {
  const pick = normalize(name)
  // 先挂类再改变量，过渡才会从旧颜色走到新颜色
  // 中间读一次布局，让浏览器先把「有过渡」这件事算进样式，否则同帧改值可能直接跳
  if (animate) {
    fadecolor()
    void document.documentElement.offsetWidth
  }
  document.documentElement.dataset.theme = pick
  try {
    localStorage.setItem(themekey, pick)
  } catch {
    // 隐私模式写不进去，本次照样生效
  }
  for (const btn of document.querySelectorAll('.swatch')) {
    btn.setAttribute('aria-checked', String(btn.dataset.theme === pick))
  }
  const note = el('themenote')
  if (note) note.textContent = names[pick]
  paintmeta()
}

function saved() {
  try {
    return normalize(localStorage.getItem(themekey) || 'blue')
  } catch {
    return 'blue'
  }
}

// 深色模式只分亮暗两档，跟着系统走一次，之后按用户点过的为准
const modekey = 'dsh:mode'

function modename() {
  return document.documentElement.dataset.mode === 'dark' ? 'dark' : 'light'
}

function paintscheme(mode) {
  const dark = mode === 'dark'
  document.documentElement.dataset.mode = dark ? 'dark' : 'light'
  const btn = el('modebtn')
  if (btn) {
    // 图标已经按模式切了，文字提示也跟着说清楚点下去会变成什么
    const tip = dark ? '切换浅色模式' : '切换深色模式'
    btn.setAttribute('aria-pressed', String(dark))
    btn.setAttribute('aria-label', tip)
    btn.title = tip
  }
  paintmeta()
}

function applymode(mode, save = true) {
  const dark = mode === 'dark'
  // 首次挂载不补过渡，否则刷新页面会看到底色从浅渐变到深
  if (save) {
    fadecolor()
    void document.documentElement.offsetWidth
  }
  paintscheme(dark ? 'dark' : 'light')
  if (!save) return
  try {
    localStorage.setItem(modekey, modename())
  } catch {
    // 存不了就只管这一次，下次仍按系统
  }
}

function savedmode() {
  try {
    const one = localStorage.getItem(modekey)
    if (one === 'dark' || one === 'light') return one
  } catch {
    // 读不到就当没设过
  }
  try {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

function mountmode() {
  applymode(savedmode(), false)
  const btn = el('modebtn')
  if (btn) btn.addEventListener('click', () => applymode(modename() === 'dark' ? 'light' : 'dark'))
}

export function mounttheme() {
  const box = el('swatches')
  if (box) {
    for (const btn of box.querySelectorAll('.swatch')) {
      btn.addEventListener('click', () => apply(btn.dataset.theme))
    }
  }
  apply(saved(), false)
  mountmode()
  window.addEventListener('pageshow', () => paintmeta())
}
