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
  // 额度耗尽时自动关开数据换 IP：需要 adb 权限，默认关闭，免得擅自断网
  autoswitch: { type: 'boolean' },
  // 自动换 IP 的最多次数：换一次能恢复就够，换不到就早点返回
  freeretries: { type: 'number', min: 0, max: 30, step: 1 },
  freeretryms: { type: 'number', min: 1000, max: 60000, step: 1000 },
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
  useragent: { type: 'string', max: 200, optional: true },
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
  // 额度耗尽自动关开数据换 IP，默认关闭：会短暂断网，不该擅自动
  autoswitch: false,
  // 换出口的次数：关开一次数据实测约 10 秒，默认只换一次，还不行就直接返回
  freeretries: 1,
  freeretryms: 5000,
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
  // 空表示用代码里的默认值：opencode/<版本>/<客户端>，不带 latest 段
  // 上游按这个串认客户端，改坏了会直接 429，设置页可以一键试出能用的写法
  useragent: '',
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
    // 只认真实的真假值：Boolean("false") 是 true，认不出的值宁可保持默认
    // 前端复选框传的是真布尔，这里主要挡手写 JSON 和旧配置文件
    if (rule.type === 'boolean') {
      if (typeof value === 'boolean') {
        out[key] = value
        continue
      }
      if (value === 1 || value === 'true' || value === '1') {
        out[key] = true
        continue
      }
      if (value === 0 || value === 'false' || value === '0') {
        out[key] = false
        continue
      }
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
  const free = Number(settings.freeretries) > 0
    ? `${settings.freeretries}次/每次${Number(settings.freeretryms) / 1000}秒`
    : '关'
  const auto = settings.autoswitch ? '自动换IP开' : '自动换IP关'
  return `默认模型 ${settings.defaultmodel} · 重试 ${retry} · 额度重试 ${free} · ${auto} · 超时 ${settings.timeoutms}ms · 池 ${settings.sessionpool} · 温度 ${temp} · 上限 ${tok} · Responses ${settings.responses ? '开' : '关'}`
}
