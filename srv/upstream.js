// 上游客户端：模板拼接、fetch 转发、429 换 session/出口、SSE 解析

import { readFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { nextsid, resetpool, nextproxy, attempts } from './sessions.js'
import { getsettings } from './settings.js'
import * as log from './logbus.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const template = path.join(here, '..', 'res', 'ocask-body.json')

// 上游地址允许用环境变量改，端到端自测时指向本地桩，线上不设就还是官方地址
const base = String(process.env.upstream || 'https://opencode.ai/inference').replace(/\/+$/, '')
export const endpoint = `${base}/openai/v1/chat/completions`
export const modelsendpoint = `${base}/v1/models`
// 门禁按 user-agent 认客户端，实测能过的是 opencode/<版本> 与 opencode/latest/<版本> 这两类
// 只剩 opencode/latest 或光秃秃的 opencode 会被判成非官方客户端，回 429 且文案伪装成额度问题
// 默认值优先；只有默认值被上游拒过，才换成探测到的写法
export const defaultuseragent = 'opencode/latest/2.0.22/cli'

// 默认值被拒后才记下来的替代写法，平时一直是空的
let fallbackua = ''
let defaultbad = false
let autoing = null

// 当前该用的 UA：设置填了优先，其次默认值，最后才是探测到的替代写法
// 这里绝不能顺手去探测，探测本身要发一次真请求，会打乱调用方的重试节奏
export function useragent() {
  const want = String(getsettings().useragent || '').trim()
  if (want) return want
  if (defaultbad && fallbackua) return fallbackua
  return defaultuseragent
}

// 上游以门禁为由拒了（文案伪装成额度问题），就在后台试一遍候选写法
// 默认值已经确认不通时不再重复探，免得真额度用完时白白消耗请求
export function kickautouseragent() {
  if (autoing || defaultbad) return autoing
  autoing = (async () => {
    try {
      const found = await finduseragent()
      if (!found.ok) {
        log.warn('UA 自动探测：候选写法全部不通，继续用默认值')
        return
      }
      if (found.ua === defaultuseragent) {
        log.info('UA 自动探测：默认写法可用')
        return
      }
      fallbackua = found.ua
      defaultbad = true
      log.info(`UA 自动探测：默认写法不通，改用 ${fallbackua}`)
    } catch (err) {
      log.warn(`UA 自动探测失败：${(err && err.message) || err}`)
    } finally {
      autoing = null
    }
  })()
  return autoing
}

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
    'user-agent': useragent(),
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
  // 额度 429 换 session 重试不占 retries 名额：retries=0 且没有出口池时
  // attempts() 只有 1，重建了 session 池却没机会再试，白白把 429 抛给客户端
  // 所以命中免费额度 429 后单独再给一次机会，只给一次，避免来回撞
  let spare = true
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
    // 429 的两种原因正文一模一样：真额度用完，和 UA 形态没过门禁
    // 分不出来就顺手在后台探一次候选写法，只探一次，探到能用的下次请求自动换
    if (res.status === 429) kickautouseragent()
    // 只有免费额度类 429 值得换出口，门禁 429 换 IP 也没用
    if (res.status !== 429 || !text.includes('FreeUsageLimitError')) throw err
    if (!reset) {
      resetpool()
      reset = true
    }
    // 池子重置后补一次机会，否则 retries=0 时循环已经到头
    if (i === max - 1 && spare) {
      spare = false
      i -= 1
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
    res = await fetch(modelsendpoint, { headers: { 'user-agent': useragent() } })
  } catch (err) {
    throw new APIError(0, `请求失败: ${err.message}`)
  }
  if (res.status !== 200) throw new APIError(res.status, await res.text())
  const doc = await res.json()
  modelscache = Array.isArray(doc) ? doc : doc.data || []
  modelsat = Date.now()
  return modelscache
}

// 候选写法：门禁认 opencode/<版本> 与 opencode/latest/<版本>，可再带一个客户端段
// 排在前面的优先，自测按这个顺序挨个试，第一个通过的就用
export function uacandidates() {
  const ver = '2.0.22'
  return [
    `opencode/latest/${ver}/cli`,
    `opencode/${ver}/cli`,
    `opencode/latest/${ver}`,
    `opencode/${ver}`,
    `opencode/latest`,
    `opencode`,
  ]
}

// 用指定 UA 打一次最小的 chat 请求，只看能不能过门禁
// 模型列表接口对 UA 不设防，拿它试会全部通过，所以必须打 chat 端点
// 请求压到最短：一句招呼、不写太多字，只为拿状态码
export async function probeuseragent(ua, timeoutms = 20000) {
  const want = String(ua || '').trim()
  if (!want) return { ua: '', ok: false, status: 0, detail: 'UA 不能填空' }
  const sid = nextsid()
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), Math.max(2000, Number(timeoutms) || 20000))
  const body = await buildbody(
    [{ role: 'user', content: '只回一个字：好' }],
    defaultmodel,
    { max_tokens: 8, temperature: 0 },
  )
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'user-agent': want,
        'content-type': 'application/json',
        'x-opencode-session': sid,
        'x-opencode-session-id': sid,
        'x-session-affinity': sid,
        'x-session-id': sid,
      },
      body: JSON.stringify(body),
      signal: ac.signal,
    })
    if (res.status === 200) {
      // 200 之后不读流，直接把连接丢掉，省额度
      try {
        await res.body?.cancel()
      } catch {
        // 取消失败无所谓，状态码已经拿到了
      }
      return { ua: want, ok: true, status: 200, detail: '可用，已通过门禁' }
    }
    const text = await res.text()
    return { ua: want, ok: false, status: res.status, detail: `HTTP ${res.status}：${text.slice(0, 200)}` }
  } catch (err) {
    const why = err && err.name === 'AbortError' ? '超时' : `请求失败: ${(err && err.message) || err}`
    return { ua: want, ok: false, status: 0, detail: why }
  } finally {
    clearTimeout(timer)
  }
}

// 按候选顺序挨个试，返回第一个能通的
// 设置页点一下就能知道当前该填什么，不用自己猜
export async function finduseragent() {
  const tried = []
  for (const ua of uacandidates()) {
    const one = await probeuseragent(ua)
    tried.push(one)
    if (one.ok) return { ua: one.ua, ok: true, tried }
  }
  return { ua: '', ok: false, tried }
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
