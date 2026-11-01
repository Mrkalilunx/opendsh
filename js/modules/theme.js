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

// 首屏底色也要跟着换，不然状态栏和页面会分色
function paintmeta(name) {
  const meta = document.querySelector('meta[name="theme-color"]')
  if (!meta) return
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()
  meta.content = bg || '#f7f8ff'
}

function normalize(name) {
  return themes.includes(name) ? name : 'blue'
}

function apply(name) {
  const pick = normalize(name)
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
  paintmeta(pick)
}

function saved() {
  try {
    return normalize(localStorage.getItem(themekey) || 'blue')
  } catch {
    return 'blue'
  }
}

export function mounttheme() {
  const box = el('swatches')
  if (box) {
    for (const btn of box.querySelectorAll('.swatch')) {
      btn.addEventListener('click', () => apply(btn.dataset.theme))
    }
  }
  apply(saved())
  window.addEventListener('pageshow', () => paintmeta(saved()))
}
