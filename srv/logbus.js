// 运行日志：内存环形缓冲给 SSE 实时推送，落库交给 logstore 永久保存

import * as store from './logstore.js'
import { daykey } from './daykey.js'

// 环形缓冲只给实时推送兜底，容量按条数和字节预算自己伸缩，不需要人工设置
const ringmax = 2000
const ringbytes = 2 * 1024 * 1024

const ring = []
const subs = new Set()
let seq = 0
let used = 0

// 一条日志的大致内存占用：字符串按 UTF-16 算两字节，再加对象本身的固定开销
function weigh(item) {
  return 64 + item.msg.length * 2
}

function emit(level, msg) {
  const item = { id: ++seq, at: Date.now(), level, msg: String(msg) }
  ring.push(item)
  used += weigh(item)
  while (ring.length > ringmax || used > ringbytes) {
    used -= weigh(ring[0])
    ring.shift()
  }
  // 落库是异步的，写不进去也不影响实时推送
  store.append(item)
  for (const fn of subs) {
    try {
      fn(item)
    } catch {
      // 单个订阅者出错不影响其余连接
    }
  }
  return item
}

export function info(msg) {
  const item = emit('info', msg)
  console.log(`[info] ${item.msg}`)
  return item
}

export function warn(msg) {
  const item = emit('warn', msg)
  console.log(`[warn] ${item.msg}`)
  return item
}

export function error(msg) {
  const item = emit('error', msg)
  console.log(`[error] ${item.msg}`)
  return item
}

export function recent(limit = 200) {
  const num = Math.max(1, Math.min(2000, Number(limit) || 200))
  return ring.slice(-num)
}

export function clearlog() {
  ring.length = 0
  return ring
}

export function subscribe(fn) {
  subs.add(fn)
  return () => subs.delete(fn)
}

export function total() {
  return seq
}

// 调试用：往指定日期灌 n 条示例日志
// 灌今天走 emit，实时页能立刻看到；灌历史日期直接落库，不进内存缓冲也不推 SSE
export async function seed(n, day) {
  const count = Math.max(1, Math.min(2000, Number(n) || 1))
  const today = daykey(Date.now())
  const target = /^\d{4}-\d{2}-\d{2}$/.test(String(day || '')) ? String(day) : today

  if (target === today) {
    for (let i = 1; i <= count; i += 1) {
      emit(levelof(i), `测试日志 ${i}/${count} · 验证长列表滚动、换行对齐和级别配色`)
    }
  } else {
    // 一天之内按比例铺开时间戳，日志列表看起来才像正常产生的
    const base = new Date(`${target}T00:00:00`).getTime()
    for (let i = 1; i <= count; i += 1) {
      store.append({
        at: base + Math.floor((i / count) * 86399000),
        level: levelof(i),
        msg: `测试日志 ${i}/${count} · ${target} · 验证长列表滚动、换行对齐和级别配色`,
      })
    }
  }

  // 写完再统计，否则回给前端的数字比库里的少一截
  await store.flushnow()
  const page = await store.query({ day: target, limit: 1 })
  return { seeded: count, kept: page.total, day: target }
}

// 掺一点警告和错误，级别配色也能一起验
function levelof(i) {
  if (i % 29 === 0) return 'error'
  if (i % 17 === 0) return 'warn'
  return 'info'
}
