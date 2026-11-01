// 模型映射表：客户端报上来的名字换成上游真名，没配就按原样走
// 挂在 Codex 那栏，客户端写死 gpt-5 之类也能落到本代理认识的模型

import { readstate, savestate } from './paths.js'

const maxname = 120

let items = []

async function persist() {
  await savestate('modelmap.json', { items })
}

function clean(name) {
  const text = String(name || '').trim()
  if (!text) throw new Error('模型名不能为空')
  if (/\s/.test(text)) throw new Error('模型名不能带空格')
  return text.slice(0, maxname)
}

export async function loadmodelmap() {
  try {
    const doc = JSON.parse(await readstate('modelmap.json'))
    const list = Array.isArray(doc) ? doc : doc.items
    items = (Array.isArray(list) ? list : [])
      .filter((one) => one && typeof one.from === 'string' && typeof one.to === 'string')
      .map((one) => ({ from: one.from.slice(0, maxname), to: one.to.slice(0, maxname) }))
  } catch {
    items = []
  }
  return listmap()
}

export function listmap() {
  return { items: items.map((one) => ({ ...one })) }
}

// 查不到就回空串，调用方按没配处理
export function resolvemodel(name) {
  const key = String(name || '').trim()
  if (!key) return ''
  const hit = items.find((one) => one.from === key)
  return hit ? hit.to : ''
}

export async function createmap(from, to) {
  const src = clean(from)
  const dst = clean(to)
  if (items.some((one) => one.from === src)) throw new Error('这个模型名已经有映射了')
  items.push({ from: src, to: dst })
  await persist()
  return { from: src, to: dst }
}

// 改的时候 from 也可以改，但改名不能撞上别的行
export async function updatemap(from, nextfrom, nextto) {
  const key = String(from || '').trim()
  const hit = items.find((one) => one.from === key)
  if (!hit) throw new Error('没有这条映射')
  const src = clean(nextfrom)
  const dst = clean(nextto)
  if (src !== key && items.some((one) => one.from === src)) throw new Error('这个模型名已经有映射了')
  hit.from = src
  hit.to = dst
  await persist()
  return { ...hit }
}

export async function deletemap(from) {
  const key = String(from || '').trim()
  if (!items.some((one) => one.from === key)) throw new Error('没有这条映射')
  items = items.filter((one) => one.from !== key)
  await persist()
  return listmap()
}
