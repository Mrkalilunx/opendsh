// 日期下拉：触发器做成输入框样式带下箭头，抽屉定高可滚，日志页和调试页共用

const el = (id) => document.getElementById(id)

const weeks = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

function pad(n) {
  return String(n).padStart(2, '0')
}

export function daykey(at) {
  const d = new Date(at)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function today() {
  return daykey(Date.now())
}

// 触发器上的短标签：今天写「今天」，其它写「月-日」，宽度稳定
export function daytext(day) {
  if (!day || day === today()) return '今天'
  return day.slice(5)
}

// 抽屉行里的完整标签：跨年时补上年份，本周内的补上星期几
export function dayfull(day) {
  if (!day || day === today()) return '今天'
  const at = new Date(`${day}T00:00:00`)
  const same = day.slice(0, 4) === today().slice(0, 4)
  const head = same ? day.slice(5) : day
  return `${head} ${weeks[at.getDay()] || ''}`.trim()
}

/**
 * 绑定一组触发器 + 抽屉
 * opts.btn / opts.drawer 元素 id
 * opts.label 触发器文字元素 id，不传就写按钮本身
 * opts.source 打开时拉取日期的异步函数，返回 [{ day, n }]
 * opts.current 取当前选中日期
 * opts.after 选中后的回调 (day) => void
 */
export function mountdaypick(opts) {
  const btn = el(opts.btn)
  const drawer = el(opts.drawer)
  if (!btn || !drawer) return null

  let busy = false

  function labelnode() {
    return opts.label ? el(opts.label) : btn
  }

  function setlabel(day) {
    const node = labelnode()
    if (node) node.textContent = daytext(day)
  }

  function close() {
    drawer.hidden = true
    btn.setAttribute('aria-expanded', 'false')
  }

  function open() {
    drawer.hidden = false
    btn.setAttribute('aria-expanded', 'true')
  }

  async function render() {
    const cur = opts.current()
    let list = []
    try {
      list = (await opts.source()) || []
    } catch {
      list = []
    }
    // 今天永远留一个入口，否则选了旧日子就回不去；再补上当前选中那天
    if (!list.some((it) => it.day === cur)) list.unshift({ day: cur, n: 0 })
    if (!list.some((it) => it.day === today())) list.unshift({ day: today(), n: 0 })

    drawer.innerHTML = ''
    for (const it of list) {
      const row = document.createElement('button')
      row.type = 'button'
      row.className = 'dayitem'
      row.setAttribute('role', 'option')
      row.setAttribute('aria-selected', String(it.day === cur))

      const name = document.createElement('span')
      name.className = 'dayitem-name'
      name.textContent = dayfull(it.day)

      const n = document.createElement('span')
      n.className = 'dayitem-n'
      n.textContent = it.n ? String(it.n) : '—'

      row.append(name, n)
      row.addEventListener('click', () => {
        close()
        setlabel(it.day)
        opts.after(it.day)
      })
      drawer.appendChild(row)
    }
  }

  async function toggle() {
    if (!drawer.hidden) {
      close()
      return
    }
    // 上次还没拉回来就先不开，避免连点堆出多个抽屉
    if (busy) return
    busy = true
    await render()
    busy = false
    open()
  }

  btn.addEventListener('click', toggle)

  // 点外面收起
  document.addEventListener('click', (ev) => {
    if (drawer.hidden) return
    if (drawer.contains(ev.target) || btn.contains(ev.target)) return
    close()
  })

  // Esc 收起
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !drawer.hidden) close()
  })

  setlabel(opts.current())
  return { setlabel, close, open }
}
