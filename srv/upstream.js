// 上游客户端：出站结构补齐、fetch 转发、429 换 session/出口、SSE 解析

import { nextsid, resetpool, nextproxy, attempts, proxies } from './sessions.js'
import { switchip, switching, waitidle } from './egressswitch.js'
import { getsettings } from './settings.js'
import * as log from './logbus.js'

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

// 门禁三件套：env 块、read 工具、stream=true
// 这三样是上游认死的最小结构，实测缺任一项就回 429，且正文伪装成额度耗尽
// 其余内容上游一概不看，所以出站只保证这三样，不再背 26KB 模板

// env 块必须同时有这两个字段，字段名区分大小写，值是啥都行
const envtag = /<env>([\s\S]*?)<\/env>/
const envneed = [/Working directory:/, /Platform:/]

// 平台名跟随实际运行环境，Termux 下 process.platform 就是 android
function platform() {
  return process.platform === 'android' ? 'android' : process.platform
}

// 带上真实工作目录，客户端自己有 env 时用它的，没有才用这份兜底
export function envblock() {
  return `<env>\n  Working directory: ${process.cwd()}\n  Platform: ${platform()}\n</env>`
}

// 块存在且两个字段都在才算合格，空标签和只写一行的都不算
function hasenv(text) {
  const hit = envtag.exec(String(text || ''))
  if (!hit) return false
  return envneed.every((re) => re.test(hit[1]))
}

// 只有 system 与 developer 算数，写在 user 消息里上游不认
function findenv(msgs) {
  for (const m of msgs) {
    if (!m || (m.role !== 'system' && m.role !== 'developer')) continue
    if (hasenv(m.content)) return true
  }
  return false
}

// 门禁唯一凭据就是 read 这个名字，上游只校验 function.name
// 所以出站这份凭据故意去掉 type 字段、描述、参数，只留一个名字
// 去掉 type 是关键：带 type 时它就是一条合法工具，模型会把它当工具解析并报给用户；
// 不带 type 模型就认不出来，实测「你有哪些工具」跑 3 模型 x 2 轮一次都没列过它
// 门禁那边照样过，连发 4 次全是 200
function readtool() {
  return { function: { name: 'read' } }
}

// 每次返回新对象，调用方改了也不会污染下一次
export function basetools() {
  return [readtool()]
}

// 出站不再拼模板 system：客户端自带合格 env 时一个字都不加
// 客户端没带（或带的不合格）才由 enforcegate 补一条最小 env
export function buildbody(messages, model, params = {}) {
  const body = {
    model,
    messages,
    ...params,
    stream: true,
    stream_options: { include_usage: true },
  }
  return enforcegate(body).body
}

// 出站自检：缺 env 块就补一条 system，缺 read 就补一个工具，stream 必须为真
// 上游拿这三样当门禁，缺任一项回伪装成额度耗尽的 429
// 这是代理自己的责任，不能指望调用方补齐，更不能把错误转给用户
// 每次改动都留一条日志写明改了什么，下次再出 429 直接翻日志就能看出是不是这里动过
export function enforcegate(body) {
  const fixed = []
  const msgs = Array.isArray(body.messages) ? body.messages : []
  // 客户端自己带合格 env 时一个字都不加，opencode 这类客户端本来就带
  if (!findenv(msgs)) {
    body.messages = [{ role: 'system', content: envblock() }, ...msgs]
    fixed.push('补 env 块')
  }
  // 客户端自带 read 就什么都不用补：门禁要的就是名字，它自己已经满足了
  // 没带才补一份隐形凭据，那份不带 type 字段，模型认不出它是工具
  const have = Array.isArray(body.tools) ? body.tools : []
  const hasread = have.some((t) => t && t.function && t.function.name === 'read')
  if (!hasread) {
    body.tools = [...have, ...basetools()]
    fixed.push(`补 read 凭据 ${have.length}→${body.tools.length}`)
  }
  // stream=false 即使结构完整也回 429，这条不能交给调用方决定
  if (body.stream !== true) {
    body.stream = true
    fixed.push('改 stream=true')
  }
  if (!body.stream_options || body.stream_options.include_usage !== true) {
    body.stream_options = { ...(body.stream_options || {}), include_usage: true }
  }
  // 标题生成这类请求的 system 里写着「绝不使用工具」，而门禁又要求必须带 read 凭据
  // 两者并存时上游判成自相矛盾，直接回 429，正文还伪装成额度耗尽，极易误判成要换出口
  // 凭据不能删，删了门禁一样挂，所以删的是那句声明，语义上这类请求本来也不用工具
  const left = stripnotools(body.messages)
  if (left) fixed.push(`去冲突句=${left}`)
  if (fixed.length) log.warn(`出站自检：${fixed.join('，')}`)
  return { body, fixed }
}

// 只认实测会触发的那一种写法：never use tools 连写
// Do not use tools、Never use any tools、Never call tools 都实测 200，不碰
// 范围收窄是为了少改调用方原文：多匹配一种写法就多一次无必要的改写
const notoolre = /\bnever\s+use\s+tools\b/i

// 扫描所有 system，不跳过第 0 条
// 早期版本从第 1 条开始，是因为模板 system 固定排在最前且一个字都不能改
// 模板已经删掉，第 0 条现在很可能就是调用方自己的 system，跳过它就漏掉标题提示词
// 代理补进去的 env 块里没有这个句子，扫到也无害
function stripnotools(msgs) {
  let n = 0
  for (let i = 0; i < msgs.length; i += 1) {
    const m = msgs[i]
    // developer 与 system 在门禁里同等对待，两者都要扫
    if (!m || (m.role !== 'system' && m.role !== 'developer') || typeof m.content !== 'string') continue
    if (!notoolre.test(m.content)) continue
    const lines = m.content.split('\n')
    const kept = lines.filter((one) => !notoolre.test(one))
    if (kept.length === lines.length) continue
    n += lines.length - kept.length
    m.content = kept.join('\n')
  }
  return n
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

// 429 的两种原因正文和响应头完全一样，Retry-After 都是到 UTC 零点的秒数
// 实测门禁类 429 的 Retry-After 也在 6 万秒量级，所以没法靠它分
// 能分的是出站请求本身的形态，两种都算门禁类：
// 一是三样门禁项还有缺项，二是这一轮刚刚补过结构还没重发过
// 三样都在且补完重发仍被拒，那只剩额度一种解释，换出口才有意义
function stillbroken(body) {
  const msgs = Array.isArray(body.messages) ? body.messages : []
  if (!findenv(msgs)) return '缺 env 块'
  const tools = Array.isArray(body.tools) ? body.tools : []
  if (!tools.some((t) => t && t.function && t.function.name === 'read')) return '缺 read 工具'
  if (body.stream !== true) return 'stream 不为真'
  return ''
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
  // 本轮是否补过结构还没重发过：补过就还没排除门禁，不能直接当额度换出口
  let fixednow = false
  // 门禁分支用掉几次，只给一次机会，避免结构无误的请求反复空转
  let gatetry = 0
  const settings = getsettings()
  const free = freeretry()

  // 出站前先自检一次：env 块、read 工具、stream 三样缺了就补齐
  // 补齐发生在这里而不是调用方，任何入口都绕不过去
  const first = enforcegate(body)
  body = first.body
  fixednow = first.fixed.length > 0

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
    if (res.status === 429) kickautouseragent()
    if (res.status !== 429) {
      log.warn(`上游返回 ${res.status}：${text.slice(0, 160)}`)
      throw err
    }
    // 429 要判清是门禁还是额度，判据和结论都写进日志
    // 正文两边一模一样，只能看请求本身有没有问题：
    // 三样门禁项还有缺项，或者本轮刚补过结构还没重发，都算门禁类
    // 三样齐全且补完重发过了，那就是额度真用完，换出口才有用
    // 门禁分支只给一次机会：补过一轮还不行，说明补正救不回来，按额度处理
    const broken = stillbroken(body)
    const gate = Boolean(broken) || (fixednow && gatetry < 1)
    const why = broken ? `出站仍有问题（${broken}）` : gate ? '本轮刚补过结构' : '出站结构齐全'
    log.warn(`上游返回 429，判为${gate ? '门禁类' : `额度类（约 ${Math.round(Number(ra) / 3600)} 小时后重置）`}，依据：${why}，Retry-After=${ra || '无'}：${text.slice(0, 160)}`)
    if (!text.includes('FreeUsageLimitError')) throw err
    if (!reset) {
      resetpool()
      reset = true
    }
    // 门禁类：换 IP 无效，换多少次都是同一结果，白断网还会连带一片 502
    // 所以只在本地重建一次请求体重发，不碰网络
    // 这次重发不占普通重试名额：它换的是请求结构，不是碰运气
    if (gate && gatetry < 1) {
      gatetry += 1
      gatehit = true
      fixednow = false
      log.warn('门禁类 429：不换出口，本地重建请求体重发')
      const again = enforcegate(body)
      body = again.body
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
    if (gatehit) tried = '代理已按门禁结构补齐并重发'
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
