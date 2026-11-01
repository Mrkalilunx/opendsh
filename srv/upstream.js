// 上游客户端：模板拼接、fetch 转发、429 换 session/出口、SSE 解析

import { readFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { nextsid, resetpool, nextproxy, attempts } from './sessions.js'
import { getsettings } from './settings.js'
import * as log from './logbus.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const template = path.join(here, '..', 'res', 'ocask-body.json')

export const endpoint = 'https://opencode.ai/inference/openai/v1/chat/completions'
export const modelsendpoint = 'https://opencode.ai/inference/v1/models'
// 门禁按 user-agent 认客户端，带 latest 段的旧写法会被当成非官方客户端直接 429
// 只认 opencode/<版本> 或 opencode/<版本>/<客户端>，改动前先用 /raw/v1 实发一次确认
export const useragent = 'opencode/2.0.22/cli'
export const defaultmodel = process.env.model || 'deepseek-v4.1-flash-free'

// 429 回给客户端的冷却秒数，设置页可调
export function retryafter() {
  const sec = Number(getsettings().retryafter)
  return String(Number.isFinite(sec) && sec > 0 ? Math.round(sec) : 10)
}

export class APIError extends Error {
  constructor(status, body, retryAfter = null, hint = null) {
    super(`HTTP ${status}: ${String(body).slice(0, 300)}`)
    this.status = status
    this.body = body
    this.retryAfter = retryAfter
    this.hint = hint
  }
}

export class BadRequest extends Error {
  constructor(message, param = null, code = null) {
    super(message)
    this.param = param
    this.code = code
  }
}

// 模板每次按 mtime 判断是否重读，改完文件不用重启
let cache = null
let stamp = 0

export async function loadtemplate() {
  const st = await stat(template)
  if (cache && st.mtimeMs === stamp) return cache
  cache = JSON.parse(await readFile(template, 'utf8'))
  stamp = st.mtimeMs
  return cache
}

// 模板的 system prompt 与 12 个 tools 是门禁硬要求，调用方消息只往后排
export async function buildbody(messages, model, params = {}) {
  const tpl = await loadtemplate()
  const system = tpl.messages.find((m) => m.role === 'system').content
  const body = {
    ...tpl,
    model,
    messages: [{ role: 'system', content: system }, ...messages],
    ...params,
    stream: true,
    stream_options: { include_usage: true },
  }
  return body
}

function headers(sid) {
  return {
    'user-agent': useragent,
    'content-type': 'application/json',
    // 四个 session 头是门禁的一部分，值必须一致
    'x-opencode-session': sid,
    'x-opencode-session-id': sid,
    'x-session-affinity': sid,
    'x-session-id': sid,
  }
}

export async function openstream(body, signal) {
  let last = null
  let reset = false
  const max = attempts()
  const settings = getsettings()

  for (let i = 0; i < max; i += 1) {
    const sid = nextsid()
    const proxy = settings.proxypool ? nextproxy() : null
    const ctrl = new AbortController()
    const timer = setTimeout(
      () => ctrl.abort(new Error('上游超时')),
      Math.max(1000, Number(settings.timeoutms) || 30000),
    )
    if (signal) signal.addEventListener('abort', () => ctrl.abort(signal.reason), { once: true })

    const opts = {
      method: 'POST',
      headers: headers(sid),
      body: JSON.stringify(body),
      signal: ctrl.signal,
    }
    if (proxy) opts.proxy = proxy

    let res
    try {
      res = await fetch(endpoint, opts)
    } catch (err) {
      clearTimeout(timer)
      last = new APIError(0, `请求失败: ${err.message}`)
      log.warn(`上游连接失败：${err.message}`)
      continue
    }
    clearTimeout(timer)

    if (res.status === 200) return res

    const text = await res.text()
    const err = new APIError(res.status, text, res.headers.get('retry-after'))
    last = err
    log.warn(`上游返回 ${res.status}：${text.slice(0, 160)}`)
    // 只有免费额度类 429 值得换出口，门禁 429 换 IP 也没用
    if (res.status !== 429 || !text.includes('FreeUsageLimitError')) throw err
    if (!reset) {
      resetpool()
      reset = true
    }
  }

  if (last && String(last.body).includes('FreeUsageLimitError')) {
    last.hint = attempts() > 1
      ? `代理池 ${attempts()} 个出口都到限额了：换一批新代理，或开关移动数据换 IP 后重试`
      : '免费额度已用尽：开关一次移动数据或飞行模式换出口 IP 后重试，session 池已自动换新'
  }
  throw last || new APIError(0, '没有可用的出口')
}

// 把上游 SSE 解成一个个 JSON 对象，跳过 [DONE]
export async function* iterchunks(res) {
  const decoder = new TextDecoder()
  let buf = ''
  for await (const part of res.body) {
    buf += decoder.decode(part, { stream: true })
    let nl
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line.startsWith('data: ')) continue
      const payload = line.slice(6)
      if (payload === '[DONE]') continue
      try {
        yield JSON.parse(payload)
      } catch {
        // 半行或非 JSON，丢掉
      }
    }
  }
}

let modelscache = null
let modelsat = 0

// fresh 为真时跳过缓存，自检要的是此刻上游真的回得来
export async function listmodels(fresh = false) {
  const ttl = Math.max(5, Number(getsettings().modelcache) || 60) * 1000
  if (!fresh && modelscache && Date.now() - modelsat < ttl) return modelscache
  let res
  try {
    res = await fetch(modelsendpoint, { headers: { 'user-agent': useragent } })
  } catch (err) {
    throw new APIError(0, `请求失败: ${err.message}`)
  }
  if (res.status !== 200) throw new APIError(res.status, await res.text())
  const doc = await res.json()
  modelscache = Array.isArray(doc) ? doc : doc.data || []
  modelsat = Date.now()
  return modelscache
}

export function normusage(usage) {
  if (!usage) {
    return {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      prompt_tokens_details: { cached_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 0 },
    }
  }
  return {
    prompt_tokens: usage.prompt_tokens || 0,
    completion_tokens: usage.completion_tokens || 0,
    total_tokens: usage.total_tokens || 0,
    prompt_tokens_details: { cached_tokens: (usage.prompt_tokens_details || {}).cached_tokens || 0 },
    completion_tokens_details: { reasoning_tokens: (usage.completion_tokens_details || {}).reasoning_tokens || 0 },
  }
}
