// 上游客户端：模板拼接、fetch 转发、429 换 session/出口、SSE 解析

import { readFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { nextsid, resetpool, nextproxy, attempts, proxies } from './sessions.js'
import { switchip } from './egressswitch.js'
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
// 上次探测的时间与结论：真额度用完时探测必然全灭，不能每来一次 429 就整轮重探
// 一轮探测就是 6 次真实请求，额度紧张时能把一次调用放大成几十次
let probeat = 0
let probefail = 0
// 探测失败的冷却时间：一次 429 风暴里最多探一轮，过后再允许重探
const probecool = 60000

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
  // 刚探过一轮且全灭，冷却期内不再探：额度真的用完时探多少次都是同样结果
  if (probefail > 0 && Date.now() - probeat < probecool) return null
  autoing = (async () => {
    try {
      const found = await finduseragent()
      probeat = Date.now()
      if (!found.ok) {
        // 全灭只说明现在过不去，未必是 UA 的锅，冷却后允许再探
        probefail += 1
        log.warn(`UA 自动探测：候选写法全部不通，继续用默认值，${probecool / 1000} 秒内不再重探`)
        return
      }
      probefail = 0
      if (found.ua === defaultuseragent) {
        log.info('UA 自动探测：默认写法可用')
        return
      }
      fallbackua = found.ua
      defaultbad = true
      log.info(`UA 自动探测：默认写法不通，改用 ${fallbackua}`)
    } catch (err) {
      probeat = Date.now()
      probefail += 1
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

// 免费额度 429 的专用重试：额度按 (IP, session) 双维度计数
// 只换 session 或只换 IP 都无效，必须两边一起换才有意义
// 所以在同一个出口上原地等待重试是白费，必须换到另一个出口再试
function freeretry() {
  const s = getsettings()
  const times = Math.max(0, Math.min(30, Math.trunc(Number(s.freeretries))))
  const waitms = Math.max(1000, Math.min(60000, Math.trunc(Number(s.freeretryms)) || 5000))
  return { times, waitms }
}

// 隔一段时间再试，等待期间客户端断开就提前返回，不空等满整段
function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) return resolve()
    const done = () => {
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    if (signal) signal.addEventListener('abort', done, { once: true })
  })
}

export async function openstream(body, signal) {
  let last = null
  let reset = false
  const max = attempts()
  // 免费额度 429 自己计数，不走 retries 名额，用尽才把最后一次的错误抛出去
  let freetry = 0
  // 普通重试额度用完就停，免费额度的重试不占它，所以单独放行
  let plain = 0
  const settings = getsettings()
  const free = freeretry()

  // 用 while 而不是 for：免费额度那次重试要原地再来一遍，不消耗普通重试次数
  while (plain < max) {
    // 客户端已经断开就别再发起下一轮了
    if (signal && signal.aborted) break
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
      // 连不上算普通重试，避免一直重连
      plain += 1
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
    // 免费额度用尽：换新 session 池，再换一个出口
    // 额度按 (IP, session) 双维度计数，只换一边都不算换
    if (freetry < free.times) {
      freetry += 1
      // 有代理池就换下一个出口，没池子就开关飞行模式换 IP
      if (proxies.length) {
        log.info(`免费额度 429，第 ${freetry}/${free.times} 次重试，${free.waitms / 1000} 秒后换下一个出口`)
        await sleep(free.waitms, signal)
      } else {
        log.info(`免费额度 429，第 ${freetry}/${free.times} 次重试，开关飞行模式换出口 IP`)
        // 同一个请求内连续换几次是正常的：换完仍可能撞上限额
        // 换不到新 IP 就到此为止，同一个 IP 再试多少次都是同一结果
        const ip = await switchip(true)
        if (!ip) {
          log.warn('免费额度 429：出口 IP 换不动，停止重试')
          plain = max
          break
        }
        await sleep(free.waitms, signal)
      }
      // 这一轮不算普通重试，原地再来一遍
      continue
    }
    // 免费额度重试用尽，这个 429 已经没有可恢复的余地，直接抛出去
    plain = max
  }

  if (last && String(last.body).includes('FreeUsageLimitError')) {
    const tried = freetry > 0
      ? `已换 ${freetry} 次出口仍未恢复`
      : '未开启重试'
    // 额度按 IP 计数，同一个 IP 上等多久都不会恢复，只能换出口
    last.hint = proxies.length
      ? `额度按 IP 计数：代理池 ${proxies.length} 个出口都到限额了，${tried}，换一批新代理或开关移动数据换 IP 后重试`
      : `额度按 IP 计数：本机出口已到限额，${tried}，开关一次移动数据或飞行模式换出口 IP 后重试`
  }
  throw last || new APIError(0, '没有可用的出口')
}

// 把上游 SSE 解成一个个 JSON 对象，跳过 [DONE]
export async function* iterchunks(res) {
  const decoder = new TextDecoder()
  let buf = ''

  // SSE 允许 data: 后面不带空格，也允许流结束时最后一行没有换行
  // 这两种情况都见过，按规范逐行取字段才不会把内容静默丢掉
  function* lines() {
    let nl
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).replace(/\r$/, '')
      buf = buf.slice(nl + 1)
      if (line.startsWith('data:')) yield line.slice(5).trim()
    }
  }

  for await (const part of res.body) {
    buf += decoder.decode(part, { stream: true })
    for (const payload of lines()) {
      if (!payload || payload === '[DONE]') continue
      try {
        yield JSON.parse(payload)
      } catch {
        // 半行或非 JSON，丢掉
      }
    }
  }
  // 收尾再冲一次：末尾没有换行时最后那条还留在 buf 里
  buf += decoder.decode()
  const tail = buf.replace(/\r$/, '')
  if (tail.startsWith('data:')) {
    const payload = tail.slice(5).trim()
    if (payload && payload !== '[DONE]') {
      try {
        yield JSON.parse(payload)
      } catch {
        // 残缺的尾巴丢掉
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

// 上游给的用量字段未必是数字：见过字符串、null、负数
// 直接原样用会让整条请求记录写库失败，排查时连请求体都一起丢了，所以这里统一洗成非负整数
function tok(v) {
  const n = Math.trunc(Number(v))
  return Number.isFinite(n) && n > 0 ? n : 0
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
  const prompt = tok(usage.prompt_tokens)
  const completion = tok(usage.completion_tokens)
  // 上游偶尔不给 total 或给的数对不上，按两项之和兜底，统计才不会漏
  const total = Math.max(tok(usage.total_tokens), prompt + completion)
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total,
    prompt_tokens_details: { cached_tokens: tok((usage.prompt_tokens_details || {}).cached_tokens) },
    completion_tokens_details: { reasoning_tokens: tok((usage.completion_tokens_details || {}).reasoning_tokens) },
  }
}
