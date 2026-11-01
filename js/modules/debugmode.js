// 调试分类：三连击主页徽标开启，入口挂在设置页的二级菜单里

const dbgkey = 'dsh:debug'

import { daykey, today, mountdaypick } from './daypick.js'

const el = (id) => document.getElementById(id)

// 灌入目标日期，默认今天，由日期下拉改动
let dbgday = today()

function read() {
  try {
    return localStorage.getItem(dbgkey) === '1'
  } catch {
    return false
  }
}

function write(on) {
  try {
    localStorage.setItem(dbgkey, on ? '1' : '0')
  } catch {
    // 隐私模式写不进去，本次照样生效
  }
}

// 输入框取值：非数字回落到默认值，超出范围夹到边界，再写回去对齐显示
function num(id, min, max, fallback) {
  const node = el(id)
  const raw = Number(node && node.value)
  const fixed = Math.max(min, Math.min(max, Number.isFinite(raw) && raw > 0 ? raw : fallback))
  if (node) node.value = String(fixed)
  return fixed
}

function tip(text) {
  const node = el('dbgstate')
  if (node) node.textContent = text
}

// 开关只管「调试」这个二级分类露不露头，面板显隐由设置页自己的分区逻辑负责
function paint(on) {
  const btn = el('setdebug')
  if (btn) btn.hidden = !on
  document.documentElement.dataset.debug = on ? '1' : '0'
  if (!on && btn && btn.getAttribute('aria-pressed') === 'true') {
    // 关掉时正停在调试分类，退回模型分类，免得留在看不见的面板上
    document.querySelector('.subnav-item[data-sec="model"]')?.click()
  }
}

async function seed() {
  const count = num('dbgcount', 1, 2000, 1000)
  const day = dbgday || today()
  try {
    const res = await fetch(`/__logs/seed?n=${count}&day=${day}`, { method: 'POST', cache: 'no-store' })
    const doc = await res.json()
    if (doc.error) throw new Error(doc.error)
    tip(`已往 ${doc.day} 灌入 ${doc.seeded} 条，该天现存 ${doc.kept} 条`)
    // 告诉日志页数据落在哪天，切过去时直接看到刚灌的这批
    document.dispatchEvent(new CustomEvent('logs:seeded', { detail: { day: doc.day } }))
  } catch (err) {
    tip(`生成失败：${err.message}`)
  }
}

export function mountdebug() {
  const badge = el('herobtn')
  if (!badge) return

  let hits = 0
  let timer = 0
  // 三连击：两次之间超过 500ms 就重新计数，避免日常误触
  badge.addEventListener('click', () => {
    hits += 1
    clearTimeout(timer)
    if (hits >= 3) {
      hits = 0
      const on = document.documentElement.dataset.debug !== '1'
      write(on)
      paint(on)
      if (on) {
        // 开起来后直接送到设置页的调试分类，不用自己找
        location.hash = '#/settings'
        setTimeout(() => el('setdebug')?.click(), 0)
      }
      return
    }
    timer = setTimeout(() => {
      hits = 0
    }, 500)
  })

  el('dbggen')?.addEventListener('click', seed)

  // 灌入日期用共用下拉：既能选已存在的日子，也能选最近两周的空日期来造数据
  mountdaypick({
    btn: 'dbgdaybtn',
    drawer: 'dbgdaydrawer',
    label: 'dbgdaylabel',
    current: () => dbgday,
    source: async () => {
      const list = []
      // 最近 14 天全部铺上，没日志的日子也能选
      for (let i = 0; i < 14; i += 1) {
        list.push({ day: daykey(Date.now() - i * 86400000), n: 0 })
      }
      try {
        const res = await fetch('/__logs?days=90', { cache: 'no-store' })
        const doc = await res.json()
        const held = new Map((doc.days || []).map((it) => [it.day, it.n]))
        for (const it of list) it.n = held.get(it.day) || 0
        // 更早的历史日子补在后面，方便往老日期补数据
        for (const [day, n] of held) {
          if (!list.some((it) => it.day === day)) list.push({ day, n })
        }
      } catch {
        // 拉不到就只给最近两周，照样能灌
      }
      return list
    },
    after: (day) => {
      dbgday = day
    },
  })

  const on = read()
  paint(on)
}
