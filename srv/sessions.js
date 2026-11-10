// session 池与出口轮换：上游按 (IP, session) 双维度计免费额度

import { randomInt } from 'node:crypto'
import { getsettings } from './settings.js'
import * as log from './logbus.js'

const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const poolsize = () => Math.max(1, Number(getsettings().sessionpool) || 20)

// 复刻应用的 Identifier.ascending("session")：毫秒*4096+同毫秒序号，取反后低 48 位
// 48 位超出 JS 32 位按位运算范围，必须用 BigInt，否则掩码会退化成 16 位
const mask48 = (1n << 48n) - 1n
let lastms = 0
let seq = 0

function newsid() {
  const ms = Date.now()
  if (ms !== lastms) {
    lastms = ms
    seq = 0
  }
  seq += 1
  const o = (~(BigInt(ms) * 4096n + BigInt(seq))) & mask48
  let tail = ''
  for (let i = 0; i < 14; i += 1) tail += alphabet[randomInt(alphabet.length)]
  return 'ses_' + o.toString(16).padStart(12, '0') + tail
}

const pool = []
let idx = 0

export function nextsid() {
  if (!pool.length) for (let i = 0; i < poolsize(); i += 1) pool.push(newsid())
  const sid = pool[idx % pool.length]
  idx += 1
  return sid
}

// 额度 429 时整池作废，避免继续撞已耗尽的 session
export function resetpool() {
  pool.length = 0
  for (let i = 0; i < poolsize(); i += 1) pool.push(newsid())
  idx = 0
}

// 出口池：OCASK_PROXIES 环境变量或 res/proxies.txt，每行一个
export const proxies = []
let pidx = 0

export function loadproxies(lines) {
  proxies.length = 0
  for (const raw of lines) {
    const line = String(raw).trim()
    if (!line || line.startsWith('#')) continue
    const item = line.includes('://') ? line : 'http://' + line
    if (!proxies.includes(item)) proxies.push(item)
  }
  if (proxies.length) log.info(`出口池 ${proxies.length} 个`)
}

export function nextproxy() {
  if (!proxies.length) return null
  const p = proxies[pidx % proxies.length]
  pidx += 1
  return p
}

export function attempts() {
  const want = Math.max(0, Number(getsettings().retries) || 0)
  // 池空时也要保底两次尝试：网络抖动是常态，一次打不通就放弃太脆
  // so: 原来池空算出 max(1, 0) = 1，任何瞬时 DNS 抖动都直接变成 502
  return want > 0 ? want : Math.max(2, proxies.length)
}

// 给管理页看的池快照，空池时按当前设置先填满
export function snapshot() {
  if (!pool.length) for (let i = 0; i < poolsize(); i += 1) pool.push(newsid())
  return {
    size: pool.length,
    cursor: pool.length ? idx % pool.length : -1,
    ids: [...pool],
  }
}

// 手动替换 session 列表，保存后从第一个开始轮换
export function setsids(list) {
  const next = []
  for (const raw of list) {
    const id = String(raw || '').trim()
    if (!id) continue
    if (id.length > 200) throw new Error('session id 过长')
    next.push(id)
  }
  if (!next.length) throw new Error('至少要保留一个 session id')
  if (next.length > 500) throw new Error('最多 500 个 session id')
  pool.length = 0
  pool.push(...next)
  idx = 0
  return snapshot()
}

// 追加一个随机 session，配合管理页的加号
export function addsid() {
  if (!pool.length) for (let i = 0; i < poolsize(); i += 1) pool.push(newsid())
  pool.push(newsid())
  return snapshot()
}
