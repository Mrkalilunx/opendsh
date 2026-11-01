// API Key 管理：sk- 随机生成、删除、Bearer 校验，落盘到状态目录的 keys.json

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { getsettings } from './settings.js'
import { readstate, savestate } from './paths.js'

let items = []

async function persist() {
  await savestate('keys.json', items)
}

export async function loadkeys() {
  try {
    const doc = JSON.parse(await readstate('keys.json'))
    items = Array.isArray(doc)
      ? doc.filter((item) => item && typeof item.key === 'string' && typeof item.id === 'string')
      : []
  } catch {
    items = []
  }
  return items
}

export function listkeys() {
  return items.map((item) => ({ ...item }))
}

export async function createkey(note = '') {
  const item = {
    id: randomBytes(4).toString('hex'),
    key: 'sk-' + randomBytes(32).toString('hex'),
    created: Date.now(),
    note: String(note || '').trim().slice(0, 60),
  }
  items.push(item)
  await persist()
  return item
}

export async function deletekey(id) {
  const before = items.length
  items = items.filter((item) => item.id !== String(id))
  if (items.length === before) throw new Error('没有这个 key')
  await persist()
  return items.length
}

function same(left, right) {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export function needskey() {
  return Boolean(getsettings().keyauth)
}

// 校验 Authorization: Bearer sk-...，未启用校验时一律放行
export function verifykey(header) {
  if (!needskey()) return true
  if (!items.length) return false
  const match = /^Bearer\s+(.+)$/i.exec(String(header || '').trim())
  if (!match) return false
  const token = match[1].trim()
  return items.some((item) => same(item.key, token))
}
