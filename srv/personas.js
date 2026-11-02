// 人设卡片库：设置页只管增删改，用哪张由对话页选择，没选就不带人设

import { randomBytes } from 'node:crypto'
import { readstate, savestate } from './paths.js'

const maxtext = 2000

let items = []
let active = ''

async function persist() {
  await savestate('personas.json', { active, items })
}

export async function loadpersonas() {
  try {
    const doc = JSON.parse(await readstate('personas.json'))
    const list = Array.isArray(doc) ? doc : doc.items
    items = (Array.isArray(list) ? list : [])
      .filter((item) => item && typeof item.id === 'string' && typeof item.text === 'string')
      .map((item) => ({ id: item.id, text: item.text.slice(0, maxtext) }))
    active = items.some((item) => item.id === doc.active) ? doc.active : ''
  } catch {
    items = []
    active = ''
  }
  return listpersonas()
}

export function listpersonas() {
  const hit = items.find((item) => item.id === active)
  return { items: items.map((item) => ({ ...item })), active, text: hit ? hit.text : '' }
}

function clean(text) {
  const body = String(text || '').replace(/\r\n?/g, '\n').trim()
  if (!body) throw new Error('人设内容不能为空')
  return body.slice(0, maxtext)
}

export async function createpersona(text) {
  // 新加的卡不自动启用，对话页没挑过就是默认不带人设
  const item = { id: 'pe_' + randomBytes(4).toString('hex'), text: clean(text) }
  items.push(item)
  await persist()
  return item
}

export async function updatepersona(id, text) {
  const item = items.find((one) => one.id === String(id))
  if (!item) throw new Error('没有这个人设')
  item.text = clean(text)
  await persist()
  return item
}

export async function deletepersona(id) {
  const key = String(id)
  if (!items.some((item) => item.id === key)) throw new Error('没有这个人设')
  items = items.filter((item) => item.id !== key)
  // 删掉正在用的那张就回到内置人设，不自动替用户换一张
  if (active === key) active = ''
  await persist()
  return listpersonas()
}

// 只有对话页会调这个：传空字符串表示这次不带人设，回落到内置人设
export async function selectpersona(id) {
  const key = String(id || '')
  if (key && !items.some((item) => item.id === key)) throw new Error('没有这个人设')
  active = key
  await persist()
  return listpersonas()
}
