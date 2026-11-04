// 上游客户端：模板拼接、fetch 转发、429 换 session/出口、SSE 解析

import { readFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { nextsid, resetpool, nextproxy, attempts, proxies } from './sessions.js'
import { switchip, switching, waitidle } from './egressswitch.js'
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

// 出站自检：模板 system 与 12 个工具必须在，缺了就当场补齐再发
// 上游拿这两项当门禁，缺任一项会回一个伪装成额度耗尽的 429
// 这是代理自己的责任，绝不能指望调用方补齐，更不能把错误转给用户
// 每次改动都留一条日志写明改了什么，下次再出 429 直接翻日志就能看出是不是这里动过
export async function enforcegate(body) {
  const tpl = await loadtemplate()
  const system = tpl.messages.find((m) => m.role === 'system').content
  const tools = Array.isArray(tpl.tools) ? tpl.tools : []
  const fixed = []
  const msgs = Array.isArray(body.messages) ? body.messages : []
  // 模板 system 必须排在最前，调用方自带的 system 往后顺延，两条 system 上游是接受的
  if (!msgs.length || msgs[0].role !== 'system' || msgs[0].content !== system) {
    body.messages = [{ role: 'system', content: system }, ...msgs]
    fixed.push('补模板 system')
  }
  // 调用方声明「不要用工具」时，带着工具定义发上去会被上游判成自相矛盾而回 429
  // 标题生成这类请求就是这种形态：system 里写着 Never use tools，工具表却是满的
  // 工具表不能删（删了门禁必挂），删的是那句声明，语义上工具本来也不该被调用
  const cut = stripnotools(body.messages)
  if (cut.length) fixed.push(`剔除冲突句 ${cut.length} 行${showlines(cut)}`)
  // 工具表必须以模板这 12 个整体排在最前且保持原顺序，客户端工具排在后面
  // 缺哪个补哪个会把顺序打乱，这里直接按模板顺序重建，已存在的同名工具用模板那份
  const have = Array.isArray(body.tools) ? body.tools : []
  const same = have.length >= tools.length && tools.every((t, i) => have[i] && have[i].function && have[i].function.name === t.function.name)
  if (!same) {
    const rest = have.filter((t) => t && t.function && !tools.some((x) => x.function.name === t.function.name))
    body.tools = [...tools, ...rest]
    fixed.push(`工具表 ${have.length}→${body.tools.length}`)
  }
  if (fixed.length) log.warn(`出站自检：${fixed.join('，')}`)
  return body
}

// 把剔除的行拼成日志里的短摘要，最多给两行，每行截断到 40 字
// 不这样记的话日志里只剩一个数字，下次排查还得重新二分定位
function showlines(lines) {
  if (!lines.length) return ''
  const one = lines.slice(0, 2).map((s) => {
    const t = s.trim().replace(/\s+/g, ' ')
    return t.length > 40 ? `${t.slice(0, 40)}…` : t
  })
  const more = lines.length > 2 ? ` 等${lines.length}行` : ''
  return `「${one.join(' / ')}」${more}`
}

// 调用方 system 里「禁止使用工具」这类句子与满编工具表冲突，逐句剔除
// 只动调用方自己带的那几条 system，模板那条一个字都不能改
// 正则收窄到否定词直接修饰 use/call/avoid/no 这几种写法，避免误伤 Do not guess tool names 这类
// 返回值是被剔除的原始行，留给日志说明到底删了什么
const notoolre = /\b(?:never|do not|don'?t|must not|should not)\s+(?:use|call|invoke)\b[^.\n]{0,20}\btools?\b|\bno tools?\b|\bavoid\s+tools?\b/i

function stripnotools(msgs) {
  const cut = []
  for (let i = 1; i < msgs.length; i += 1) {
    const m = msgs[i]
    if (!m || m.role !== 'system' || typeof m.content !== 'string') continue
    if (!notoolre.test(m.content)) continue
    // 按行拆开，只丢掉命中的行，其余内容原样保留
    const lines = m.content.split('\n')
    const kept = []
    for (const one of lines) {
      if (notoolre.test(one)) cut.push(one)
      else kept.push(one)
    }
    if (kept.length !== lines.length) m.content = kept.join('\n')
  }
  return cut
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

// 门禁类 429 与真额度 429 的区别看 Retry-After
// 真额度给的是到当天额度重置的秒数，实测七万多秒，且固定落在当天 UTC 零点重置
// 门禁类几百毫秒就返回，实测不带这么长的值
// 只有明确拿到小于一小时的 Retry-After 才判门禁，拿不到就按额度类走
// 这样上游将来改行为时最多退回原来的换 IP 逻辑，不会把真额度误判成门禁而少换一次出口
function isgatelimit(retryAfter, text) {
  if (!String(text).includes('FreeUsageLimitError')) return false
  const sec = Number(retryAfter)
  if (!Number.isFinite(sec) || sec <= 0) return false
  return sec < 3600
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
  // 记下这次失败是不是门禁类，收尾时给提示用
  let gatehit = false
  const settings = getsettings()
  const free = freeretry()

  // 出站前先自检一次：门禁要的模板 system 与 12 个工具缺了就补齐
  // 补齐发生在这里而不是调用方，任何入口都绕不过去
  body = await enforcegate(body)

  // 用 while 而不是 for：免费额度那次重试要原地再来一遍，不消耗普通重试次数
  while (plain < max) {
    // 客户端已经断开就别再发起下一轮了
    if (signal && signal.aborted) break
    // 别处正在换出口时网络是断的，先等它换完再发，否则必然连不上
    // 这一等就是原来那些秒级 502 的来源，等完直接发就不必报错
    if (switching()) await waitidle()
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
    const ra = res.headers.get('retry-after')
    const err = new APIError(res.status, text, ra)
    last = err
    // 429 的两种原因正文一模一样：真额度用完，和门禁没过
    // 用 Retry-After 分：额度类给的是几万秒（等到当天额度重置），门禁类几百毫秒就返回且不带这么长的值
    // 分不出来的老办法是顺手探一次 UA，保留，但只在额度类才探
    if (res.status === 429) kickautouseragent()
    if (res.status !== 429) {
      log.warn(`上游返回 ${res.status}：${text.slice(0, 160)}`)
      throw err
    }
    // 429 一定要把判据写进日志，否则下次看到 429 还得重新猜是额度还是门禁
    const gate = isgatelimit(ra, text)
    log.warn(`上游返回 429，按 ${ra ? `Retry-After=${ra}s` : '无 Retry-After'} 判为${gate ? '门禁类' : `额度类（约 ${Math.round(Number(ra) / 3600)} 小时后重置）`}：${text.slice(0, 160)}`)
    if (!text.includes('FreeUsageLimitError')) throw err
    if (!reset) {
      resetpool()
      reset = true
    }
    // 门禁类 429：正文自检已经补过 system 与 tools，仍被拒说明是别的形态问题
    // 换 IP 对门禁无效，换多少次都是同一结果，白断网还会连带一片 502
    // 所以这类只在本地重建一次请求体重试，不碰网络
    if (gate) {
      gatehit = true
      log.warn('门禁类 429：不换出口，本地重建请求体重试')
      plain += 1
      body = await enforcegate(body)
      continue
    }
    // 免费额度用尽：额度按 (IP, session) 双维度计数，只换 session 不算换
    // 同一个出口上等多久都不会恢复，所以这里的重试一律是「换出口」
    const autoswitch = Boolean(settings.autoswitch)
    // 有代理池就走代理轮换，不需要 adb
    if (proxies.length && freetry < free.times) {
      freetry += 1
      log.info(`免费额度 429，第 ${freetry}/${free.times} 次重试，${free.waitms / 1000} 秒后换下一个出口`)
      await sleep(free.waitms, signal)
      continue
    }
    // 没代理池只能换本机出口，这要 adb 权限，且必须在设置里开过
    if (autoswitch && !proxies.length && freetry < free.times) {
      freetry += 1
      log.info(`免费额度 429，第 ${freetry}/${free.times} 次重试，关开移动数据换出口 IP`)
      // 同一个请求内连续换几次是正常的：换完仍可能撞上限额
      // 换不到新 IP 就到此为止，同一个 IP 再试多少次都是同一结果
      // switchip 内部已经等到网络恢复并拿到新 IP，不必再额外等间隔
      const ip = await switchip(freetry === 1)
      if (!ip) {
        log.warn('免费额度 429：出口 IP 换不动，停止重试')
        plain = max
        break
      }
      continue
    }
    // 没开自动换 IP，或者换的次数用完了：这个 429 没有可恢复的余地
    plain = max
  }

  if (last && String(last.body).includes('FreeUsageLimitError')) {
    const autoswitch = Boolean(settings.autoswitch)
    let tried
    if (gatehit) tried = '代理已在本地重建请求重试'
    else if (freetry > 0) tried = `代理已自动换过 ${freetry} 次出口`
    else if (!autoswitch && !proxies.length) tried = '自动换出口未开启'
    else tried = '未进行重试'
    // 提示只说明代理这边发生了什么，不要求用户改设置或手动折腾网络
    // 上游额度按出口 IP 计数，代理自己换出口是本职工作，失败原因写清楚即可
    if (proxies.length) {
      last.hint = `上游免费额度已用尽（按出口 IP 计数），代理池 ${proxies.length} 个出口均已到达限额，${tried}`
    } else if (!autoswitch) {
      last.hint = `上游免费额度已用尽（按出口 IP 计数），${tried}，可在设置里开启「额度耗尽自动换 IP」由代理自行换出口`
    } else {
      last.hint = `上游免费额度已用尽（按出口 IP 计数），${tried} 仍未恢复`
    }
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
