// 日志管理：放在设置 › 日志，运行日志和请求记录各管各的
// 查询页只管看，破坏性动作全收在这里，避免在日志页误点

import { dayfull } from './daypick.js'

const el = (id) => document.getElementById(id)

const units = ['B', 'KB', 'MB', 'GB']

// 两套数据同构，只是接口前缀和元素 id 不同
const sections = [
  {
    name: '运行日志',
    api: '/__logs',
    stat: ['logstatdays', 'logstatrows', 'logstatbytes'],
    list: 'logdaylist',
    clearall: 'logclearall',
    empty: '还没有日志',
    unit: '条',
  },
  {
    name: '请求记录',
    api: '/__requests',
    stat: ['reqstatdays', 'reqstatrows', 'reqstatbytes'],
    list: 'reqdaylist',
    clearall: 'reqclearall',
    empty: '还没有请求记录',
    unit: '条',
  },
]

// 字节数换成人看的单位，过百就不留小数，省得数字太长把格子撑开
function bytesize(n) {
  if (!n) return '0 B'
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

function say(text, tone = '') {
  const node = el('logadminstate')
  if (!node) return
  node.textContent = text
  node.dataset.tone = tone
}

async function loadstat(sec) {
  const [daynode, rownode, bytenode] = sec.stat.map(el)
  try {
    const res = await fetch(`${sec.api}?stat=1`, { cache: 'no-store' })
    const doc = await res.json()
    if (doc.error) throw new Error(doc.error)
    daynode.textContent = String(doc.days)
    rownode.textContent = doc.rows >= 10000 ? `${(doc.rows / 10000).toFixed(1)} 万` : String(doc.rows)
    bytenode.textContent = bytesize(doc.bytes)
  } catch (err) {
    // 读失败也给零值，位上照样有数，跟正常读到时版式一样
    daynode.textContent = '0'
    rownode.textContent = '0'
    bytenode.textContent = '0 B'
    say(`${sec.name}概况读取失败：${err.message}`, 'bad')
  }
}

// 一天一行，跟 key 列表一个套路：点减号原地变确认，不弹系统对话框
function makerow(sec, it) {
  const row = document.createElement('li')
  row.className = 'keyrow logdayrow'

  const name = document.createElement('span')
  name.className = 'logdaydate'
  name.textContent = dayfull(it.day)

  const num = document.createElement('span')
  num.className = 'logdaynum'
  num.textContent = `${it.n} ${sec.unit}`

  const minus = document.createElement('button')
  minus.type = 'button'
  minus.className = 'keyact'
  minus.textContent = '−'
  minus.title = '删除这一天'
  minus.setAttribute('aria-label', `删除 ${it.day} 的${sec.name}`)
  minus.addEventListener('click', () => askremove(sec, row, it))

  row.append(name, num, minus)
  return row
}

function askremove(sec, row, it) {
  const text = document.createElement('span')
  text.className = 'keyconfirm'
  text.textContent = `删除 ${dayfull(it.day)} 的 ${it.n} ${sec.unit}？`

  const no = document.createElement('button')
  no.type = 'button'
  no.className = 'btn btn-small'
  no.textContent = '取消'
  no.addEventListener('click', () => loaddays(sec))

  const yes = document.createElement('button')
  yes.type = 'button'
  yes.className = 'btn btn-small btn-danger'
  yes.textContent = '删除'
  yes.addEventListener('click', () => remove(sec, it.day))

  row.replaceChildren(text, no, yes)
}

function render(sec, days) {
  const list = el(sec.list)
  if (!list) return
  list.innerHTML = ''
  if (!days.length) {
    const empty = document.createElement('li')
    empty.className = 'logdayempty'
    empty.textContent = sec.empty
    list.appendChild(empty)
    return
  }
  for (const it of days) list.appendChild(makerow(sec, it))
}

async function loaddays(sec) {
  try {
    const res = await fetch(`${sec.api}?days=365`, { cache: 'no-store' })
    const doc = await res.json()
    if (doc.error) throw new Error(doc.error)
    render(sec, Array.isArray(doc.days) ? doc.days : [])
  } catch (err) {
    render(sec, [])
    say(`${sec.name}列表读取失败：${err.message}`, 'bad')
  }
}

// 概况和按天列表一起刷，删完不用手动再点刷新
async function refresh() {
  for (const sec of sections) await Promise.all([loadstat(sec), loaddays(sec)])
}

async function remove(sec, day) {
  const url = day ? `${sec.api}?day=${day}` : sec.api
  try {
    const res = await fetch(url, { method: 'DELETE' })
    const doc = await res.json()
    if (doc.error) throw new Error(doc.error)
    say(day ? `已删除 ${day} 的${sec.name}` : `已清空全部${sec.name}`, 'ok')
    await Promise.all([loadstat(sec), loaddays(sec)])
    // 日志页可能正开着对应分栏，通知它按当前日期重拉
    document.dispatchEvent(new CustomEvent('logs:cleared'))
  } catch (err) {
    say(`删除失败：${err.message}`, 'bad')
  }
}

// 清空全部要按两次：第一次装上引信，4 秒不动自己解除
function arm(btn, action) {
  if (!btn) return
  const label = btn.textContent
  let timer = 0
  btn.addEventListener('click', async () => {
    if (btn.dataset.armed === '1') {
      clearTimeout(timer)
      btn.dataset.armed = ''
      btn.textContent = label
      btn.disabled = true
      try {
        await action()
      } finally {
        btn.disabled = false
      }
      return
    }
    btn.dataset.armed = '1'
    btn.textContent = '再点一次'
    timer = setTimeout(() => {
      btn.dataset.armed = ''
      btn.textContent = label
    }, 4000)
  })
}

export function mountlogadmin() {
  if (!el('logstatdays')) return

  for (const sec of sections) arm(el(sec.clearall), () => remove(sec, ''))

  // 进设置页就先刷一次，切分类回来也能看到最新数字
  document.addEventListener('view:change', (ev) => {
    if (ev.detail && ev.detail.name === 'settings') refresh()
  })

  // 调试页灌过日志，概况和按天列表跟着变
  document.addEventListener('logs:seeded', () => {
    if (document.documentElement.dataset.view === 'settings') refresh()
  })

  return refresh()
}
