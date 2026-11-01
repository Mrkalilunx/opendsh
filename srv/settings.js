// 运行期设置：落盘到 ~/.local/share/dsh/settings.json，保存后立即生效，不用重启
// 这份文件固定在默认数据根，不跟「状态目录」设置走，否则改完目录下次就找不到自己

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(os.homedir(), '.local', 'share', 'dsh')
const file = path.join(root, 'settings.json')
// 老版本住在仓库里，升级后第一次启动从这里读一次
const legacy = path.join(here, '.state', 'settings.json')

// 每项声明取值范围，前端设置页按同一份 schema 渲染
export const spec = {
  defaultmodel: { type: 'string', max: 120 },
  retries: { type: 'number', min: 0, max: 10, step: 1 },
  timeoutms: { type: 'number', min: 5000, max: 120000, step: 1000 },
  sessionpool: { type: 'number', min: 1, max: 100, step: 1 },
  proxypool: { type: 'boolean' },
  keyauth: { type: 'boolean' },
  logshow: { type: 'number', min: 50, max: 2000, step: 50 },
  retryafter: { type: 'number', min: 1, max: 120, step: 1 },
  modelcache: { type: 'number', min: 5, max: 600, step: 5 },
  temp: { type: 'number', min: -1, max: 2, step: 0.1 },
  maxtok: { type: 'number', min: 0, max: 32000, step: 128 },
  tools: { type: 'boolean' },
  toolbridge: { type: 'boolean' },
  toolbudget: { type: 'number', min: 12, max: 64, step: 1 },
  rawentry: { type: 'boolean' },
  responses: { type: 'boolean' },
  statedir: { type: 'string', max: 300, optional: true },
  dbhost: { type: 'string', max: 120, optional: true },
  dbport: { type: 'number', min: 0, max: 65535, step: 1 },
  dbuser: { type: 'string', max: 64, optional: true },
  dbpass: { type: 'string', max: 200, optional: true },
  dbname: { type: 'string', max: 64, optional: true },
  dbdatadir: { type: 'string', max: 300, optional: true },
  forceoff: { type: 'string', max: 200, optional: true },
  forceon: { type: 'string', max: 200, optional: true },
}

const fallback = {
  defaultmodel: process.env.model || 'deepseek-v4.1-flash-free',
  retries: Math.max(0, Number(process.env.attempts || 0)),
  timeoutms: 30000,
  sessionpool: Math.max(1, Number(process.env.sessions || 20)),
  proxypool: true,
  keyauth: false,
  logshow: 500,
  retryafter: 10,
  modelcache: 60,
  temp: -1,
  maxtok: 0,
  tools: true,
  toolbridge: true,
  toolbudget: 15,
  rawentry: true,
  responses: true,
  // 空字符串表示用默认：状态目录 srv/.state，数据库 127.0.0.1:3306
  statedir: '',
  dbhost: '',
  dbport: 0,
  dbuser: '',
  dbpass: '',
  dbname: '',
  dbdatadir: '',
  forceoff: '',
  forceon: '',
}

let current = { ...fallback }

export function defaults() {
  return { ...fallback }
}

export function getsettings() {
  return current
}

export function schema() {
  return spec
}

function clamp(input) {
  const out = { ...fallback }
  for (const [key, rule] of Object.entries(spec)) {
    const value = input[key]
    // 旧配置文件里没有新键时不能当成 false / 0，否则新增的默认值会被抹掉
    if (value === undefined || value === null) continue
    if (rule.type === 'boolean') {
      out[key] = Boolean(value)
      continue
    }
    if (rule.type === 'string') {
      if (typeof value !== 'string') continue
      const text = value.trim()
      // optional 的项允许清空，表示回落到默认值
      if (!text && !rule.optional) continue
      out[key] = text.slice(0, rule.max)
      continue
    }
    const num = Number(value)
    if (!Number.isFinite(num)) continue
    const fixed = Math.min(rule.max, Math.max(rule.min, num))
    const step = Number(rule.step) || 0
    if (step > 0 && step < 1) {
      const digits = Math.max(0, String(step).split('.')[1]?.length || 0)
      out[key] = Number(fixed.toFixed(digits))
    } else {
      out[key] = Math.round(fixed)
    }
  }
  return out
}

async function persist(next) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(next, null, 2) + '\n', 'utf8')
  current = next
  return current
}

export async function loadsettings() {
  // 先读新位置，读不到再读老位置，读到了就顺手搬过去
  for (const src of [file, legacy]) {
    try {
      const raw = await readFile(src, 'utf8')
      current = clamp({ ...fallback, ...JSON.parse(raw) })
      if (src !== file) await persist(current)
      return current
    } catch {
      // 这一处没有就试下一处
    }
  }
  current = { ...fallback }
  return current
}

export async function updatesettings(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('设置必须是 JSON 对象')
  const unknown = Object.keys(patch).filter((key) => !(key in spec))
  if (unknown.length) throw new Error(`未知设置项：${unknown.join('、')}`)
  const next = clamp({ ...current, ...patch })
  return persist(next)
}

export async function resetsettings() {
  return persist({ ...fallback })
}

export function describe(settings) {
  const retry = Number(settings.retries) > 0 ? settings.retries : '跟随出口池'
  const temp = Number(settings.temp) >= 0 ? settings.temp : '跟随请求'
  const tok = Number(settings.maxtok) > 0 ? settings.maxtok : '跟随请求'
  return `默认模型 ${settings.defaultmodel} · 重试 ${retry} · 超时 ${settings.timeoutms}ms · 池 ${settings.sessionpool} · 温度 ${temp} · 上限 ${tok} · Responses ${settings.responses ? '开' : '关'}`
}
