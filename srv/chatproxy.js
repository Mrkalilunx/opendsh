// OpenAI 兼容端点：请求翻译、流式转发、错误映射，全部按 OpenAI schema 拼

import { randomBytes } from 'node:crypto'
import {
  APIError, BadRequest, defaultmodel, openstream, buildbody, iterchunks,
  listmodels, loadtemplate, normusage, retryafter,
} from './upstream.js'
import { getsettings } from './settings.js'
import * as log from './logbus.js'
import * as reqlog from './reqstore.js'
import { verifykey } from './apikey.js'
import { listmap, resolvemodel } from './modelmap.js'
import { unwrapcalls, gatecalls, argcalls, needmap, missnote, rebridge, mutecalls, mutepush, aliasnames, unalias, namesnote, buildremap } from './toolbridge.js'

// 撞到不存在的工具时最多重问几次，防止模型死磕
const maxtries = 2
// 重问用尽后还有一次兜底：这一轮禁掉工具调用，逼它用文字回答
const forcemsg = '系统限制：本轮工具调用不可用，请直接用文字回答用户刚才的问题。'

const fingerprint = 'fp_opencode'
const passthrough = [
  'temperature', 'top_p', 'stop', 'presence_penalty', 'frequency_penalty', 'seed',
  'user', 'response_format', 'logit_bias', 'logprobs', 'top_logprobs',
  'parallel_tool_calls', 'reasoning_effort', 'service_tier', 'metadata', 'store',
]
const roles = new Set(['system', 'developer', 'user', 'assistant', 'tool', 'function'])

let known = new Set()

export function setmodels(ids) {
  known = new Set(ids)
}

export function pickmodel(requested) {
  // 配了映射就按映射走，目标名即使不在缓存列表里也照发
  const mapped = requested ? resolvemodel(requested) : ''
  if (mapped) return mapped
  const fallback = getsettings().defaultmodel || defaultmodel
  if (!requested) return fallback
  if (!known.size || known.has(requested)) return requested
  return fallback
}

const callid = () => 'call_' + randomBytes(12).toString('hex')

// ---- 响应工具

function send(res, status, obj, extra = {}) {
  const body = JSON.stringify(obj)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'cache-control': 'no-store',
    ...extra,
  })
  res.end(body)
}

function fail(res, status, message, type = 'invalid_request_error', param = null, code = null, retry = null) {
  send(res, status, { error: { message, type, param, code } }, retry ? { 'retry-after': retry } : {})
}

function unauthorized(res) {
  log.warn('拒绝请求：缺少或错误的 API key')
  return fail(res, 401, 'API key 无效，请带上 Authorization: Bearer sk-...', 'invalid_request_error', null, 'invalid_api_key')
}

function upstreamfail(res, exc) {
  const status = exc.status || 502
  let message = String(exc)
  let utype = ''
  try {
    const err = (JSON.parse(exc.body) || {}).error || {}
    message = err.message || message
    utype = err.type || ''
  } catch {
    // 上游不是 JSON，保留原文
  }

  let type = 'api_error'
  let code = null
  if (status === 429) {
    type = 'rate_limit_error'
    code = utype === 'FreeUsageLimitError' ? 'free_usage_limit' : 'rate_limit_exceeded'
  } else if (status === 401) {
    code = 'invalid_api_key'
  } else if (status === 404) {
    code = 'model_not_found'
  } else if (status >= 400 && status < 500) {
    code = 'invalid_request_error'
  }

  if (exc.hint) message = `${message} — ${exc.hint}`
  fail(res, status, message, type, null, code, status === 429 ? retryafter() : exc.retryAfter)
}

// ---- 请求翻译

function normalizemessages(raw) {
  const out = []
  raw.forEach((m, i) => {
    if (!m || typeof m !== 'object' || Array.isArray(m)) {
      throw new BadRequest(`messages[${i}] 必须是对象`, `messages[${i}]`)
    }
    let role = m.role
    if (!roles.has(role)) throw new BadRequest(`messages[${i}].role 不合法: ${role}`, `messages[${i}].role`)
    if (role === 'developer') role = 'system'

    let content = m.content
    if (content === undefined || content === null) {
      content = m.tool_calls ? null : ''
    } else if (typeof content !== 'string' && !Array.isArray(content)) {
      throw new BadRequest(`messages[${i}].content 必须是字符串或数组`, `messages[${i}].content`)
    }

    const item = { role, content }
    if (m.name) item.name = m.name
    if (m.tool_calls) item.tool_calls = m.tool_calls
    if (m.tool_call_id) item.tool_call_id = m.tool_call_id
    out.push(item)
  })
  return out
}

async function translate(req) {
  const messages = req.messages
  if (!Array.isArray(messages) || !messages.length) throw new BadRequest('messages 必须是非空数组', 'messages')
  const msgs = normalizemessages(messages)


  if (req.n !== undefined && req.n !== null && req.n !== 1) {
    throw new BadRequest('本代理只支持 n=1', 'n', 'unsupported_value')
  }

  const params = {}
  for (const key of passthrough) {
    if (req[key] !== undefined && req[key] !== null) params[key] = req[key]
  }
  if (req.max_tokens !== undefined && req.max_tokens !== null) params.max_completion_tokens = req.max_tokens
  if (req.max_completion_tokens !== undefined && req.max_completion_tokens !== null) {
    params.max_completion_tokens = req.max_completion_tokens
  }

  // 设置里的默认采样参数只补客户端没给的，-1 / 0 表示不覆盖
  const s = getsettings()
  const temp = Number(s.temp)
  const maxtok = Number(s.maxtok)
  if (temp >= 0 && params.temperature === undefined) params.temperature = temp
  if (maxtok > 0 && params.max_completion_tokens === undefined) params.max_completion_tokens = maxtok

  // 模板那 12 个必须发出去，否则上游直接报错；抑制模式只影响能否被调用
  // 客户端 tools 追加在这 12 个之后，超出名额的折成清单加一个转发工具
  // 客户端工具与模板重名时给客户端那个改名，否则两边会互相顶掉
  const tpl = await loadtemplate()
  const base = tpl.tools || []
  const tplnames = new Set(base.map((t) => (t.function || {}).name))
  let alias = new Map()
  let remap = new Map()
  // 客户端工具改名后的完整清单，闸门核对必填参数时要用，得提到外层
  let clientlist = []

  // 抑制模式与客户端有没有带 tools 无关，模板那 12 个一律不许被调用
  // 客户端自己的同名工具已经改名成 c_xxx 发上去了，所以这里拦原名字不会误伤它
  // 入口决定抑制与否：默认入口 /v1 始终抑制，直通入口 /raw/v1 始终不抑制
  // 两个入口都会显式带上 __mute，所以这里不看设置，设置只管 /raw/v1 开不开
  const muteon = req.__mute === undefined ? true : req.__mute
  const mute = muteon ? new Set(tplnames) : new Set()

  if (Array.isArray(req.tools) && req.tools.length && s.tools) {
    const taken = new Set(tplnames)
    const renamed = aliasnames(req.tools.filter((t) => t && t.function), taken)
    alias = renamed.map
    clientlist = renamed.list
    // 客户端的工具能顶上被抑制的模板工具时，调用直接改派过去
    remap = buildremap(mute, renamed.list)
    if (remap.size) {
      const pairs = [...remap.entries()].map(([from, one]) => `${from}→${one.name}`).join('、')
      log.info(`工具改派：${pairs}`)
    }
  }

  const t = {
    msgs,
    requested: req.model || '',
    params,
    mute,
    alias,
    remap,
    base,
    tplnames,
    clientlist,
    notes: [],
    allow: new Set(),
    need: new Map(),
    ns: req.__ns instanceof Map ? req.__ns : new Map(),
  }
  plan(t)
  return t
}

// 客户端工具全量直发，不再按名额折叠
function plan(t) {
  if (t.clientlist.length) t.params.tools = [...t.base, ...t.clientlist]
  t.notes = []
  // 命名约定每轮都一样，避免同一会话里工具名忽然变
  const naming = namesnote(t.alias.size > 0, [...t.mute])
  if (naming) t.notes.push(naming)
  // 闸门看的是「拆桥前」的名字，也就是上游那一侧的写法：
  // c_xxx 的直接工具、以及模板那 12 个
  // 模板名字即使在抑制模式也先放行，交给 mutecalls 去吐提示，不在这里提前拦
  t.allow = new Set([...t.alias.keys(), ...t.tplnames])
  // 必填参数表按出站那一侧的名字算：改名后的 c_xxx、模板原名
  t.need = needmap([t.base, t.clientlist])
  // 历史里的 tool_calls 也要跟着换成带前缀的形式，重复调用是幂等的
  rebridge(t.msgs, t.alias)
}

// 提示语单独拼在消息前面，这样重问时能整段换掉，不用去 msgs 里抠
function wire(t) {
  return [...t.notes.map((one) => ({ role: 'system', content: one })), ...t.msgs]
}

async function collect(res) {
  const content = []
  const reasoning = []
  const calls = new Map()
  let usage = null
  let finish = null
  const logprobs = []

  for await (const data of iterchunks(res)) {
    if (data.usage) usage = data.usage
    for (const ch of data.choices || []) {
      const delta = ch.delta || {}
      if (delta.content) content.push(delta.content)
      if (delta.reasoning_content) reasoning.push(delta.reasoning_content)
      for (const tc of delta.tool_calls || []) {
        const i = tc.index || 0
        if (!calls.has(i)) calls.set(i, { id: null, type: 'function', function: { name: '', arguments: '' } })
        const slot = calls.get(i)
        if (tc.id) slot.id = tc.id
        const fn = tc.function || {}
        if (fn.name) slot.function.name = fn.name
        if (fn.arguments) slot.function.arguments += fn.arguments
      }
      const lp = ch.logprobs
      if (lp && Array.isArray(lp.content)) logprobs.push(...lp.content)
      if (ch.finish_reason) finish = ch.finish_reason
    }
  }

  const toolcalls = [...calls.keys()].sort((a, b) => a - b).map((i) => calls.get(i))
  for (const c of toolcalls) if (!c.id) c.id = callid()

  return {
    text: content.join(''),
    reasoning: reasoning.join(''),
    toolcalls,
    usage,
    finish: finish || (toolcalls.length ? 'tool_calls' : 'stop'),
    logprobs,
  }
}

// ---- SSE 输出

function ssehead(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'close',
    'access-control-allow-origin': '*',
    'x-accel-buffering': 'no',
  })
}

const packet = (obj) => `data: ${JSON.stringify(obj)}\n\n`

// ---- 路由

// 请求体先整段读出来，既能给解析用，也能原样留档
async function drain(req) {
  const parts = []
  for await (const part of req) parts.push(part)
  return Buffer.concat(parts).toString('utf8')
}

// 包一层响应写入，把真正发回去的内容留一份，超长的流式响应只留开头
function tap(req, res, url, raw) {
  const headers = { ...req.headers }
  delete headers.authorization
  delete headers.cookie

  const rec = {
    at: Date.now(),
    method: req.method,
    path: req.__path || url.pathname,
    model: '',
    reqhead: JSON.stringify(headers, null, 2),
    reqbody: raw,
    respbody: '',
    status: 0,
    ms: 0,
  }
  try {
    const doc = JSON.parse(raw)
    if (doc && typeof doc.model === 'string') rec.model = doc.model
  } catch {
    // 请求体不是 JSON 就让它空着，正文照样留档
  }

  const chunks = []
  let size = 0
  const keep = (chunk) => {
    if (!chunk || size >= 32 * 1024) return
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    chunks.push(buf)
    size += buf.length
  }

  const write = res.write.bind(res)
  const end = res.end.bind(res)
  res.write = (chunk, ...rest) => {
    keep(chunk)
    return write(chunk, ...rest)
  }
  res.end = (chunk, ...rest) => {
    keep(chunk)
    rec.status = res.statusCode || 0
    rec.ms = Date.now() - rec.at
    rec.respbody = Buffer.concat(chunks).subarray(0, 32 * 1024).toString('utf8')
    // 各处理函数把上游 usage 挂在 res 上，这里统一带走
    rec.usage = res.__usage || null
    reqlog.emit(rec)
    return end(chunk, ...rest)
  }
  return rec
}

export async function handle(req, res, url) {
  const path = url.pathname

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'content-length': '0',
    })
    return res.end()
  }

  if (req.method === 'GET' && (path === '/health' || path === '/v1/health')) {
    return send(res, 200, { status: 'ok', default_model: getsettings().defaultmodel || defaultmodel, models: known.size })
  }

  if (req.method === 'GET' && (path === '/v1/models' || path === '/models')) {
    log.info(`models 请求 ${url.pathname}${url.search} ua=${req.headers['user-agent'] || ''}`)
    return models(res, url)
  }

  if (req.method === 'GET' && (path.startsWith('/v1/models/') || path.startsWith('/models/'))) {
    const id = decodeURIComponent(path.replace(/^\/v1\/models\//, '').replace(/^\/models\//, ''))
    return one(res, id)
  }

  if (req.method === 'POST' && (path === '/v1/chat/completions' || path === '/chat/completions')) {
    const raw = await drain(req)
    req.__raw = raw
    req.__rec = tap(req, res, url, raw)
    if (!verifykey(req.headers.authorization)) return unauthorized(res)
    return chat(req, res)
  }

  if (req.method === 'POST' && (path === '/v1/completions' || path === '/completions')) {
    const raw = await drain(req)
    req.__raw = raw
    req.__rec = tap(req, res, url, raw)
    if (!verifykey(req.headers.authorization)) return unauthorized(res)
    return completions(req, res)
  }

  if (req.method === 'POST' && (path === '/v1/responses' || path === '/responses')) {
    const raw = await drain(req)
    req.__raw = raw
    req.__rec = tap(req, res, url, raw)
    if (!verifykey(req.headers.authorization)) return unauthorized(res)
    return responses(req, res)
  }

  fail(res, 404, `Unknown path: ${path}`, 'invalid_request_error', null, 'unknown_url')
}

async function models(res) {
  let list
  try {
    list = await listmodels()
  } catch (err) {
    return upstreamfail(res, err)
  }
  const seen = new Set(list.map((m) => m.id))
  // 映射表左边是客户端会直接报的名字，也让它出现在列表里，客户端按名字校验时不会说找不到
  const extra = listmap().items
    .filter((one) => !seen.has(one.from))
    .map((one) => ({ id: one.from, object: 'model', created: 0, owned_by: 'dsh' }))
  // 上游给的 name、capabilities、limit、cost 这些原样带出去，别在中间拦掉
  send(res, 200, { object: 'list', data: [...list.map((m) => ({ ...m, object: 'model' })), ...extra] })
}

async function one(res, id) {
  let list
  try {
    list = await listmodels()
  } catch (err) {
    return upstreamfail(res, err)
  }
  const found = list.find((m) => m.id === id)
  if (!found) {
    // 映射表里的客户端名字也算存在，返回一条合成记录而不是 404
    if (resolvemodel(id)) {
      return send(res, 200, { id, object: 'model', created: 0, owned_by: 'dsh' })
    }
    return fail(res, 404, `The model '${id}' does not exist.`, 'invalid_request_error', 'model', 'model_not_found')
  }
  send(res, 200, { ...found, object: 'model' })
}

async function readjson(req) {
  const raw = typeof req.__raw === 'string' ? req.__raw : await drain(req)
  if (!raw.trim()) throw new BadRequest('请求体为空', 'body')
  let doc
  try {
    doc = JSON.parse(raw)
  } catch {
    throw new BadRequest('请求体不是合法 JSON', 'body')
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new BadRequest('请求体必须是 JSON 对象', 'body')
  }
  return doc
}

async function chat(req, res) {
  let body
  let t
  try {
    body = await readjson(req)
    // 入口策略跟着请求体走，translate 只拿到 body 这一个参数
    body.__mute = req.__mute
    body.__entry = req.__entry
    t = await translate(body)
  } catch (err) {
    if (err instanceof BadRequest) return fail(res, 400, err.message, 'invalid_request_error', err.param, err.code)
    throw err
  }

  const model = pickmodel(t.requested)
  if (req.__rec) req.__rec.model = model
  const ac = new AbortController()
  req.on('close', () => ac.abort())

  // 每次重问都要拿最新的 t.msgs 重建请求体，抑制时会把提示追加进去
  const open = async () => openstream(await buildbody(wire(t), model, t.params), ac.signal)

  const includeusage = Boolean((body.stream_options || {}).include_usage)
  log.info(`chat model=${model} 入口=${req.__entry || 'main'} stream=${Boolean(body.stream)}${t.mute.size ? ' 抑制模板工具' : ''}`)
  if (body.stream) return streamchat(res, t, open, model, includeusage)

  // 非流式同样要重问：撞到不存在的工具就当作没发生，加一句提醒再问
  let r = null
  let picked = null
  let attempt = 0
  let forced = false
  while (true) {
    let up
    try {
      up = await open()
    } catch (err) {
      if (err instanceof APIError) return upstreamfail(res, err)
      throw err
    }
    r = await collect(up)
    // 先按上游名字抑制，再还原改名，否则客户端的 c_read 会被还原成 read 而误杀
    const unwrapped = unwrapcalls(r.toolcalls)
    const gated = gatecalls(unwrapped.calls, t.allow)
    const raw = mutecalls(gated.calls, t.mute, t.remap)
    // 参数闸门排在抑制之后：被抑制的模板工具该报不可用，不该报缺参数
    const arged = argcalls(raw.calls, t.need)
    const dropped = unwrapped.dropped + gated.dropped + raw.dropped + arged.dropped
    const names = [...unwrapped.names, ...gated.names, ...raw.names, ...arged.names]
    picked = { calls: unalias(arged.calls, t.alias), dropped, names, invalid: badnames(unwrapped, gated), missing: [...(unwrapped.argless || []), ...(arged.missing || [])] }
    // 全部被吞掉、且这一轮没正文，才值得重问；有正文或还有其他可用结果就别重来
    if (picked.dropped > 0 && !picked.calls.length && !r.text) {
      if (attempt < maxtries) {
        attempt++
        log.info(`工具抑制：吞掉 ${picked.dropped} 个调用（${picked.names.join(',')}），第 ${attempt} 次重申`)
        t.msgs = [...t.msgs, { role: 'system', content: mutepush(attempt, hintfor(t.alias, picked.names, t.remap, picked.invalid, picked.missing), picked.missing && picked.missing.length) }]
        continue
      }
      if (!forced) {
        forced = true
        forcelast(t)
        log.info(`工具抑制：重问用尽，改成禁工具再问一次`)
        continue
      }
    }
    break
  }

  // 被吞光的调用不能再留 tool_calls 收尾，否则客户端会一直等一个不会来的工具结果
  const allmuted = picked.dropped > 0 && !picked.calls.length
  const message = {
    role: 'assistant',
    content: r.text || (picked.calls.length ? null : allmuted ? mutetext() : ''),
    refusal: null,
    annotations: [],
  }
  if (picked.calls.length) message.tool_calls = picked.calls
  if (r.reasoning) message.reasoning_content = r.reasoning

  // 用量挂在 res 上给 tap 带走，写库和回给客户端用同一份
  res.__usage = r.usage
  send(res, 200, {
    id: 'chatcmpl-' + randomBytes(12).toString('hex'),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    system_fingerprint: fingerprint,
    choices: [{
      index: 0,
      message,
      logprobs: r.logprobs.length ? { content: r.logprobs, refusal: null } : null,
      finish_reason: allmuted ? 'stop' : r.finish,
    }],
    usage: normusage(r.usage),
  })
}

// 重问用尽还是只有被吞掉的工具调用时，最后一轮直接禁掉工具，逼模型用文字回答
function forcelast(t) {
  t.params.tool_choice = 'none'
  t.msgs = [...t.msgs, { role: 'system', content: forcemsg }]
}

// 闸门拦下的名字里，参数不全的那些名字是对的，不算「名字不存在」
// 两类别混在一起，否则提示会自相矛盾：一边说缺参数，一边说这工具根本不存在
function badnames(unwrapped, gated) {
  const soft = new Set()
  for (const one of unwrapped.argless || []) soft.add(one.name)
  const list = [...(unwrapped.names || []), ...(gated.names || [])]
  return list.filter((n) => !soft.has(n))
}

// 被吞掉的恰好是客户端也有同名工具时，告诉模型正确的替代名字
function hintfor(alias, names, remap, invalid, missing) {
  const bad = new Set(invalid || [])
  const tips = []
  const unknown = []
  // 名字为空、桥没开这类占位符不是名字本身，单独说一句就够
  let nameless = false
  for (const n of names) {
    if (!n) {
      nameless = true
      continue
    }
    // 闸门拦下的名字在 tools 列表里根本不存在，别去猜它想调什么，直接让它照抄
    if (bad.has(n)) {
      if (n === '（无名）' || n === '（桥未启用）') {
        nameless = true
        continue
      }
      unknown.push(n)
      continue
    }
    const moved = remap && remap.get(n)
    if (moved) {
      tips.push(`${n} 可以改用 ${moved.name} 用命令实现`)
      continue
    }
    for (const [up, real] of alias) if (real === n) tips.push(`${n} 应该写成 ${up}`)
  }
  const parts = []
  if (nameless) parts.push('有调用没把工具名写对，名字要原样照抄 tools 列表里的。')
  // 参数缺键是另一种错，得说清缺哪几个，否则模型下一轮还会漏
  const lack = missnote(missing)
  if (lack) parts.push(lack)
  if (unknown.length) parts.push(`名字要原样照抄 tools 列表里的，${[...new Set(unknown)].slice(0, 3).join('、')} 根本不存在。`)
  const uniq = [...new Set(tips)].slice(0, 4)
  if (uniq.length) parts.push(`可以改用：${uniq.join('；')}。`)
  return parts.join('')
}

// 名字可能是分段到的，第一段只是某个合法名的前缀，这种不能当成错名字拦掉
function knownname(one, allow) {
  if (allow.has(one)) return true
  for (const n of allow) if (n.startsWith(one)) return true
  return false
}

// 全部被吞掉时不能给客户端留个空气泡，给一句中性的话，不点任何工具名
function mutetext() {
  return '这次没能给出有效回答，请换个说法或补充点信息再试。'
}

async function streamchat(res, t, open, model, includeusage) {
  const id = 'chatcmpl-' + randomBytes(12).toString('hex')
  const created = Math.floor(Date.now() / 1000)

  const chunk = (delta, finish = null, logprobs = undefined) => {
    res.write(packet({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      system_fingerprint: fingerprint,
      choices: [{ index: 0, delta, logprobs, finish_reason: finish }],
    }))
  }

  // 工具桥和抑制都要求先攒齐 tool_calls，不能边收边吐
  // 攒完再判断：被吞掉的调用当没发生过，重新问一次，让模型自己把这条路封死
  let outcome = null
  let attempt = 0
  let forced = false
  let usage = null
  let finish = null
  let sawtool = false
  let said = false
  let sentrole = false

  while (true) {
    // 每一轮都现取：抑制模式下这几个值可能被重问逻辑改写
    const mute = t.mute
    const alias = t.alias
    // 抑制开着时要攒齐 tool_calls 才能吞
    const holdcalls = Boolean(mute && mute.size)
    let up
    try {
      up = await open()
    } catch (err) {
      if (err instanceof APIError) {
        // 还没吐过任何东西，可以正常回错误；吐过了就只能安静收尾
        if (!sentrole) return upstreamfail(res, err)
        log.warn(`重问时上游失败：${err.message}`)
        if (!said) chunk({ content: mutetext() })
        chunk({}, 'stop')
        res.write('data: [DONE]\n\n')
        return res.end()
      }
      throw err
    }
    if (!sentrole) {
      // 拿到上游连接后再开 SSE，否则前面失败时状态码已经发出去了，改不了
      ssehead(res)
      chunk({ role: 'assistant', content: '' })
      sentrole = true
    }

    const held = new Map()
    // 边收边发那条路也要记这一轮见过哪些 index，重问时得清空
    const seen = new Set()
    const badidx = new Set()
    // 名字比参数晚到时先把这段攒着，等真名字到了再一起发
    const early = new Map()
    const latebad = []
    let usage0 = null
    let finish0 = null
    let sawtool0 = false
    // 这一轮有没有真吐出去正文，吐过了就不能整轮作废重问
    said = false

    try {
      for await (const data of iterchunks(up)) {
        if (data.usage) usage0 = data.usage
        for (const ch of data.choices || []) {
          const delta = ch.delta || {}
          const out = {}
          if (delta.content) {
            out.content = delta.content
            said = true
          }
          if (delta.reasoning_content) out.reasoning_content = delta.reasoning_content

          if (holdcalls && delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const i = tc.index || 0
              if (!held.has(i)) held.set(i, { id: null, type: 'function', function: { name: '', arguments: '' } })
              const slot = held.get(i)
              if (tc.id) slot.id = tc.id
              const fn = tc.function || {}
              if (fn.name) slot.function.name = fn.name
              if (fn.arguments) slot.function.arguments += fn.arguments
            }
            sawtool0 = true
          } else if (!holdcalls) {
            const parts = []
            for (const tc of delta.tool_calls || []) {
              const i = tc.index || 0
              const fn = tc.function || {}
              if (badidx.has(i)) continue
              if (!seen.has(i)) {
                const buf = early.get(i) || { id: null, name: '', args: '' }
                if (tc.id) buf.id = tc.id
                if (fn.name) buf.name += fn.name
                if (fn.arguments) buf.args += fn.arguments
                const one = buf.name
                // 名字还没收全就先攒着：空名字发出去，后面那个真名字就绕过闸门了
                // 只是某个合法名的前缀也一样，等拼完再发，顺便把改名还原掉
                if (!one || (t.allow && t.allow.size && !t.allow.has(one) && knownname(one, t.allow))) {
                  early.set(i, buf)
                  continue
                }
                early.delete(i)
                // 这条路是边收边发，名字发错了收不回来，所以发之前就得拦住
                if (t.allow && t.allow.size && !t.allow.has(one)) {
                  badidx.add(i)
                  latebad.push(one.slice(0, 40))
                  continue
                }
                seen.add(i)
                sawtool0 = true
                parts.push({
                  index: i,
                  id: buf.id || callid(),
                  type: 'function',
                  function: { name: alias.get(one) || one, arguments: buf.args },
                })
              } else {
                const part = { index: i, function: {} }
                if (fn.name) part.function.name = fn.name
                if (fn.arguments) part.function.arguments = fn.arguments
                if (Object.keys(part.function).length) parts.push(part)
              }
            }
            if (parts.length) out.tool_calls = parts
          }

          const lp = ch.logprobs
          if (Object.keys(out).length || lp) chunk(out, null, lp)
          if (ch.finish_reason) finish0 = ch.finish_reason
        }
      }
    } catch (err) {
      // 客户端先断开就安静收场
      if (err.name === 'AbortError') return res.end()
      throw err
    }

    let calls = []
    let dropped = 0
    let names = []
    let invalid = []
    let missing = []
    if (held.size) {
      calls = [...held.keys()].sort((a, b) => a - b).map((i) => held.get(i))
      for (const c of calls) if (!c.id) c.id = callid()
      // 先按上游名字抑制，再还原改名，否则客户端的 c_read 会被还原成 read 而误杀
      const unwrapped = unwrapcalls(calls)
      const gated = gatecalls(unwrapped.calls, t.allow)
      const raw = mutecalls(gated.calls, t.mute, t.remap)
      // 参数闸门排在抑制之后：被抑制的模板工具该报不可用，不该报缺参数
      const arged = argcalls(raw.calls, t.need)
      calls = unalias(arged.calls, t.alias)
      dropped = unwrapped.dropped + gated.dropped + raw.dropped + arged.dropped
      names = [...unwrapped.names, ...gated.names, ...raw.names, ...arged.names]
      invalid = badnames(unwrapped, gated)
      missing = [...(unwrapped.argless || []), ...(arged.missing || [])]
    }
    if (latebad.length) {
      dropped += latebad.length
      names = [...names, ...latebad]
      invalid = [...invalid, ...latebad]
    }
    // 名字从头到尾没到，这轮就当没调过，让它重来
    for (const buf of early.values()) {
      if (!buf.id && !buf.args) continue
      dropped++
      names.push('')
    }

    // 撞到不存在的工具就当成没发生过，重新问一次，语气一轮比一轮重
    // 但如果这一轮已经吐过正文，重问会重复输出，只能就地吞掉收尾
    if (dropped > 0 && !said) {
      if (attempt < maxtries) {
        attempt++
        log.info(`工具抑制：吞掉 ${dropped} 个调用（${names.join(',')}），第 ${attempt} 次重申`)
        t.msgs = [...t.msgs, { role: 'system', content: mutepush(attempt, hintfor(alias, names, t.remap, invalid, missing), missing && missing.length) }]
        continue
      }
      if (!forced) {
        forced = true
        forcelast(t)
        log.info('工具抑制：重问用尽，改成禁工具再问一次')
        continue
      }
    }

    usage = usage0
    finish = finish0
    sawtool = sawtool0
    outcome = { calls, dropped }
    break
  }
  outcome.calls.forEach((c, i) => {
    chunk({ tool_calls: [{ index: i, id: c.id, type: 'function', function: c.function }] })
  })
  res.__usage = usage

  const allmuted = outcome.dropped > 0 && !outcome.calls.length
  // 全被吞掉又一句正文都没有，补一句中性的话，别让客户端拿到空气泡
  if (allmuted && !said) chunk({ content: mutetext() })

  // 全被吞掉时上游给的 finish 是 tool_calls，这里得改回 stop，否则客户端会等一个永远不来的工具结果
  chunk({}, allmuted ? 'stop' : finish || (sawtool ? 'tool_calls' : 'stop'))

  if (includeusage) {
    res.write(packet({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      system_fingerprint: fingerprint,
      choices: [],
      usage: normusage(usage),
    }))
  }

  res.write('data: [DONE]\n\n')
  res.end()
}

async function completions(req, res) {
  let body
  try {
    body = await readjson(req)
  } catch (err) {
    if (err instanceof BadRequest) return fail(res, 400, err.message, 'invalid_request_error', err.param, err.code)
    throw err
  }

  let prompt = body.prompt
  if (Array.isArray(prompt)) prompt = prompt.map(String).join('\n')
  if (prompt === undefined || prompt === null) prompt = ''
  if (typeof prompt !== 'string') {
    return fail(res, 400, 'prompt 必须是字符串或字符串数组', 'invalid_request_error', 'prompt')
  }
  if (body.n !== undefined && body.n !== null && body.n !== 1) {
    return fail(res, 400, '本代理只支持 n=1', 'invalid_request_error', 'n', 'unsupported_value')
  }

  const params = {}
  for (const key of ['temperature', 'top_p', 'stop', 'presence_penalty', 'frequency_penalty', 'seed', 'user']) {
    if (body[key] !== undefined && body[key] !== null) params[key] = body[key]
  }
  if (body.max_tokens !== undefined && body.max_tokens !== null) params.max_completion_tokens = body.max_tokens

  const model = pickmodel(body.model)
  if (req.__rec) req.__rec.model = model
  let up
  try {
    up = await openstream(await buildbody([{ role: 'user', content: prompt }], model, params))
  } catch (err) {
    if (err instanceof APIError) return upstreamfail(res, err)
    throw err
  }

  const includeusage = Boolean((body.stream_options || {}).include_usage)
  if (body.stream) return streamtext(res, up, model, includeusage)

  const r = await collect(up)
  res.__usage = r.usage
  send(res, 200, {
    id: 'cmpl-' + randomBytes(12).toString('hex'),
    object: 'text_completion',
    created: Math.floor(Date.now() / 1000),
    model,
    system_fingerprint: fingerprint,
    choices: [{ text: r.text, index: 0, logprobs: null, finish_reason: r.finish }],
    usage: normusage(r.usage),
  })
}

async function streamtext(res, up, model, includeusage) {
  const id = 'cmpl-' + randomBytes(12).toString('hex')
  const created = Math.floor(Date.now() / 1000)
  ssehead(res)

  const chunk = (text, finish = null) => {
    res.write(packet({
      id,
      object: 'text_completion',
      created,
      model,
      system_fingerprint: fingerprint,
      choices: [{ text, index: 0, logprobs: null, finish_reason: finish }],
    }))
  }

  let usage = null
  let finish = null
  try {
    for await (const data of iterchunks(up)) {
      if (data.usage) usage = data.usage
      for (const ch of data.choices || []) {
        const text = (ch.delta || {}).content
        if (text) chunk(text)
        if (ch.finish_reason) finish = ch.finish_reason
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') return res.end()
    throw err
  }

  chunk('', finish || 'stop')
  res.__usage = usage
  if (includeusage) {
    res.write(packet({
      id,
      object: 'text_completion',
      created,
      model,
      system_fingerprint: fingerprint,
      choices: [],
      usage: normusage(usage),
    }))
  }
  res.write('data: [DONE]\n\n')
  res.end()
}

// ---- Responses API

// 请求先压成 chat 那一套，网关、改名、抑制、工具桥全部复用，这里只管两头的形状

function respparts(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const out = []
  for (const part of content) {
    if (!part || typeof part !== 'object') continue
    const type = part.type || ''
    if (type === 'input_text' || type === 'output_text' || type === 'text' || type === 'summary_text') {
      out.push({ type: 'text', text: String(part.text || '') })
    } else if (type === 'input_image') {
      const url = typeof part.image_url === 'string' ? part.image_url : (part.image_url || {}).url
      if (url) out.push({ type: 'image_url', image_url: { url } })
    } else if (type === 'refusal') {
      out.push({ type: 'text', text: String(part.refusal || '') })
    }
  }
  // 全是文本就压回一个字符串，上游对这个形态最省事
  if (out.every((one) => one.type === 'text')) return out.map((one) => one.text).join('')
  return out
}

function respitems(input) {
  if (typeof input === 'string') return [{ role: 'user', content: input }]
  if (!Array.isArray(input)) throw new BadRequest('input 必须是字符串或数组', 'input')
  const out = []
  for (const item of input) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new BadRequest('input 的每一项必须是对象', 'input')
    const type = item.type || 'message'
    if (type === 'message') {
      const role = item.role === 'developer' ? 'system' : item.role
      if (!roles.has(role)) throw new BadRequest(`input 里的 role 不合法: ${item.role}`, 'input')
      out.push({ role, content: respparts(item.content) })
      continue
    }
    // 客户端把上一轮的工具调用和结果原样带回来时，翻成 chat 的历史消息
    if (type === 'function_call') {
      // 带命名空间的调用要还原成发上去时的扁平名字，否则历史里的工具名对不上
      const space = item.namespace
      const name = space && space !== defnamespace ? nswire(space, item.name || '') : (item.name || '')
      out.push({
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: item.call_id || item.id,
          type: 'function',
          function: { name, arguments: item.arguments || '{}' },
        }],
      })
      continue
    }
    if (type === 'function_call_output') {
      const body = item.output
      out.push({
        role: 'tool',
        tool_call_id: item.call_id || item.id,
        content: typeof body === 'string' ? body : JSON.stringify(body ?? ''),
      })
      continue
    }
    // reasoning 这类回放项对上游没意义，跳过不报错
  }
  return out
}

// Responses 的 tools 是扁平的，chat 那边要套一层 function
// codex 新版会把工具按命名空间分组，组内的函数工具才是真正能调的，这里一起展开
// 回程再由 respnsmap 把 namespace 拆回去，客户端才认得出这个调用
const defnamespace = 'functions'

// 命名空间里的工具展开成扁平名字，默认命名空间直接用原名
function nswire(ns, name) {
  if (ns === defnamespace) return name
  return String(ns).replace(/_+$/, '') + '__' + String(name).replace(/^_+/, '')
}

function respnsmap(list) {
  const out = new Map()
  if (!Array.isArray(list)) return out
  for (const one of list) {
    if (!one || one.type !== 'namespace' || !one.name) continue
    for (const sub of one.tools || []) {
      if (!sub || sub.type !== 'function' || !sub.name) continue
      out.set(nswire(one.name, sub.name), { namespace: one.name, name: sub.name })
    }
  }
  return out
}

// 模型偶尔只写子工具名，命名空间里唯一匹配时也认
function respns(ns, raw) {
  if (!ns || !ns.size) return null
  const hit = ns.get(raw)
  if (hit) return hit
  let found = null
  for (const one of ns.values()) {
    if (one.name !== raw) continue
    if (found) return null
    found = one
  }
  return found
}

function resptools(list) {
  const out = []
  for (const one of list) {
    if (!one || typeof one !== 'object') continue
    if (one.type === 'namespace' && one.name) {
      let skipped = 0
      for (const sub of one.tools || []) {
        if (!sub || sub.type !== 'function' || !sub.name) {
          skipped++
          continue
        }
        out.push({
          type: 'function',
          function: {
            name: nswire(one.name, sub.name),
            description: sub.description || '',
            parameters: sub.parameters || { type: 'object', properties: {} },
          },
        })
      }
      if (skipped) log.warn(`命名空间 ${one.name} 里有 ${skipped} 个非函数工具，跳过`)
      continue
    }
    if (one.type === 'function' && one.name) {
      out.push({
        type: 'function',
        function: {
          name: one.name,
          description: one.description || '',
          parameters: one.parameters || { type: 'object', properties: {} },
        },
      })
      continue
    }
    if (one.type === 'function' && one.function) {
      out.push(one)
      continue
    }
    // web_search 这类内置工具上游没有对应能力，跳过但要留痕
    log.warn(`忽略不支持的 tool 类型：${one.type}`)
  }
  return out
}

function respbody(body) {
  const messages = []
  if (typeof body.instructions === 'string' && body.instructions.trim()) {
    messages.push({ role: 'system', content: body.instructions })
  }
  messages.push(...respitems(body.input))
  if (!messages.length) throw new BadRequest('input 不能为空', 'input')

  const out = { messages, stream: Boolean(body.stream) }
  if (body.model) out.model = body.model
  if (body.max_output_tokens) out.max_completion_tokens = body.max_output_tokens
  for (const key of ['temperature', 'top_p', 'seed', 'stop', 'presence_penalty', 'frequency_penalty', 'parallel_tool_calls', 'user', 'response_format']) {
    if (body[key] !== undefined && body[key] !== null) out[key] = body[key]
  }
  if (Array.isArray(body.tools) && body.tools.length) {
    out.tools = resptools(body.tools)
    // 命名空间对照表随请求带着走，回程拼 function_call 时要用
    out.__ns = respnsmap(body.tools)
  }
  return out
}

const respid = (prefix) => prefix + randomBytes(12).toString('hex')

function respusage(usage) {
  const one = normusage(usage)
  return {
    input_tokens: one.prompt_tokens,
    input_tokens_details: { cached_tokens: one.prompt_tokens_details.cached_tokens },
    output_tokens: one.completion_tokens,
    output_tokens_details: { reasoning_tokens: one.completion_tokens_details.reasoning_tokens },
    total_tokens: one.total_tokens,
  }
}

function respmessage(id, text) {
  return {
    id,
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text, annotations: [], logprobs: [] }],
  }
}

function respcall(call, ns) {
  const hit = respns(ns, call.function.name)
  const item = {
    id: respid('fc_'),
    type: 'function_call',
    status: 'completed',
    call_id: call.id,
    name: hit ? hit.name : call.function.name,
    arguments: call.function.arguments || '{}',
  }
  // 默认命名空间不用写，codex 收到不带 namespace 的调用会自动归到 functions
  if (hit && hit.namespace !== defnamespace) item.namespace = hit.namespace
  return item
}

function respenvelope(meta, body, status, output, usage) {
  return {
    id: meta.id,
    object: 'response',
    created_at: meta.created,
    status,
    background: false,
    error: null,
    incomplete_details: null,
    instructions: typeof body.instructions === 'string' ? body.instructions : null,
    max_output_tokens: body.max_output_tokens ?? null,
    model: meta.model,
    output,
    parallel_tool_calls: body.parallel_tool_calls ?? true,
    previous_response_id: body.previous_response_id ?? null,
    reasoning: body.reasoning ?? null,
    service_tier: 'default',
    store: false,
    temperature: body.temperature ?? null,
    text: body.text ?? { format: { type: 'text' } },
    tool_choice: body.tool_choice ?? 'auto',
    tools: Array.isArray(body.tools) ? body.tools : [],
    top_p: body.top_p ?? null,
    truncation: 'disabled',
    usage: usage || null,
    user: body.user ?? null,
    metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : {},
  }
}

async function responses(req, res) {
  let body
  try {
    body = await readjson(req)
  } catch (err) {
    if (err instanceof BadRequest) return fail(res, 400, err.message, 'invalid_request_error', err.param, err.code)
    throw err
  }
  if (!getsettings().responses) {
    return fail(res, 404, 'Responses API 已关闭，去设置 › 网络 打开', 'invalid_request_error', null, 'responses_disabled')
  }

  let t
  try {
    const flat = respbody(body)
    // 同 chat：入口策略只能挂在请求体上传进去
    flat.__mute = req.__mute
    flat.__entry = req.__entry
    t = await translate(flat)
  } catch (err) {
    if (err instanceof BadRequest) return fail(res, 400, err.message, 'invalid_request_error', err.param, err.code)
    throw err
  }

  const model = pickmodel(t.requested)
  if (req.__rec) req.__rec.model = model
  const ac = new AbortController()
  req.on('close', () => ac.abort())
  // 每次重问都要拿最新的 t.msgs 重建请求体，抑制时会把提示追加进去
  const open = async () => openstream(await buildbody(wire(t), model, t.params), ac.signal)

  const meta = { id: respid('resp_'), created: Math.floor(Date.now() / 1000), model }
  const env = (status, output, usage) => respenvelope(meta, body, status, output, usage)
  log.info(`responses model=${model} 入口=${req.__entry || 'main'} stream=${Boolean(body.stream)}${t.mute.size ? ' 抑制模板工具' : ''}`)

  if (body.stream) return streamresponse(res, t, open, env)

  // 非流式跟 chat 一条路：模板工具被吞光又没正文时重问一次
  let r = null
  let picked = null
  let attempt = 0
  let forced = false
  while (true) {
    let up
    try {
      up = await open()
    } catch (err) {
      if (err instanceof APIError) return upstreamfail(res, err)
      throw err
    }
    r = await collect(up)
    const unwrapped = unwrapcalls(r.toolcalls)
    const gated = gatecalls(unwrapped.calls, t.allow)
    const raw = mutecalls(gated.calls, t.mute, t.remap)
    // 参数闸门排在抑制之后：被抑制的模板工具该报不可用，不该报缺参数
    const arged = argcalls(raw.calls, t.need)
    const dropped = unwrapped.dropped + gated.dropped + raw.dropped + arged.dropped
    const names = [...unwrapped.names, ...gated.names, ...raw.names, ...arged.names]
    picked = { calls: unalias(arged.calls, t.alias), dropped, names, invalid: badnames(unwrapped, gated), missing: [...(unwrapped.argless || []), ...(arged.missing || [])] }
    if (picked.dropped > 0 && !picked.calls.length && !r.text) {
      if (attempt < maxtries) {
        attempt++
        log.info(`工具抑制：吞掉 ${picked.dropped} 个调用（${picked.names.join(',')}），第 ${attempt} 次重申`)
        t.msgs = [...t.msgs, { role: 'system', content: mutepush(attempt, hintfor(t.alias, picked.names, t.remap, picked.invalid, picked.missing), picked.missing && picked.missing.length) }]
        continue
      }
      if (!forced) {
        forced = true
        forcelast(t)
        log.info('工具抑制：重问用尽，改成禁工具再问一次')
        continue
      }
    }
    break
  }

  const allmuted = picked.dropped > 0 && !picked.calls.length
  const text = r.text || (allmuted ? mutetext() : '')
  const output = []
  if (text) output.push(respmessage(respid('msg_'), text))
  for (const call of picked.calls) output.push(respcall(call, t.ns))

  res.__usage = r.usage
  send(res, 200, env('completed', output, respusage(r.usage)))
}

async function streamresponse(res, t, open, env) {
  let seq = 0
  // 事件名和 data.type 必须一致，客户端认后者拼类型
  const emit = (type, payload) => {
    res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload, sequence_number: seq++ })}\n\n`)
  }

  let opened = false
  let attempt = 0
  let forced = false
  let usage = null
  let said = false
  let msgid = ''
  let textbuf = ''
  let msgopen = false
  let outcome = null

  // 正文边收边吐；工具调用要先攒齐，抑制和工具桥都得看完整名字
  const openmsg = (index) => {
    msgid = respid('msg_')
    msgopen = true
    emit('response.output_item.added', {
      output_index: index,
      item: { id: msgid, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
    })
    emit('response.content_part.added', {
      item_id: msgid,
      output_index: index,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [], logprobs: [] },
    })
  }

  const closemsg = (index) => {
    const part = { type: 'output_text', text: textbuf, annotations: [], logprobs: [] }
    emit('response.output_text.done', { item_id: msgid, output_index: index, content_index: 0, text: textbuf })
    emit('response.content_part.done', { item_id: msgid, output_index: index, content_index: 0, part })
    emit('response.output_item.done', { output_index: index, item: respmessage(msgid, textbuf) })
    msgopen = false
  }

  while (true) {
    // 每轮现取，降级成桥后这几个值会换
    let up
    try {
      up = await open()
    } catch (err) {
      if (err instanceof APIError) {
        // 还没开流的话状态码还能改，开了流只能按失败收尾
        if (!opened) return upstreamfail(res, err)
        log.warn(`重问时上游失败：${err.message}`)
        if (msgopen) closemsg(0)
        emit('response.failed', { response: env('failed', [], respusage(null)) })
        return res.end()
      }
      throw err
    }

    if (!opened) {
      ssehead(res)
      const blank = env('in_progress', [], null)
      emit('response.created', { response: blank })
      emit('response.in_progress', { response: blank })
      opened = true
    }

    const held = new Map()
    let usage0 = null
    let sawtool = false
    said = false

    try {
      for await (const data of iterchunks(up)) {
        if (data.usage) usage0 = data.usage
        for (const ch of data.choices || []) {
          const delta = ch.delta || {}
          if (delta.content) {
            if (!msgopen) openmsg(0)
            textbuf += delta.content
            said = true
            emit('response.output_text.delta', {
              item_id: msgid,
              output_index: 0,
              content_index: 0,
              delta: delta.content,
              logprobs: [],
            })
          }
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const i = tc.index || 0
              if (!held.has(i)) held.set(i, { id: null, type: 'function', function: { name: '', arguments: '' } })
              const slot = held.get(i)
              if (tc.id) slot.id = tc.id
              const fn = tc.function || {}
              if (fn.name) slot.function.name = fn.name
              if (fn.arguments) slot.function.arguments += fn.arguments
            }
            sawtool = true
          }
        }
      }
    } catch (err) {
      if (err.name === 'AbortError') return res.end()
      throw err
    }

    let calls = []
    let dropped = 0
    let names = []
    let invalid = []
    let missing = []
    if (held.size) {
      calls = [...held.keys()].sort((a, b) => a - b).map((i) => held.get(i))
      for (const call of calls) if (!call.id) call.id = callid()
      const unwrapped = unwrapcalls(calls)
      const gated = gatecalls(unwrapped.calls, t.allow)
      const raw = mutecalls(gated.calls, t.mute, t.remap)
      // 参数闸门排在抑制之后：被抑制的模板工具该报不可用，不该报缺参数
      const arged = argcalls(raw.calls, t.need)
      calls = unalias(arged.calls, t.alias)
      dropped = unwrapped.dropped + gated.dropped + raw.dropped + arged.dropped
      names = [...unwrapped.names, ...gated.names, ...raw.names, ...arged.names]
      invalid = badnames(unwrapped, gated)
      missing = [...(unwrapped.argless || []), ...(arged.missing || [])]
    }

    // 这一轮还没吐正文才能整轮重问，吐过了就只能就地收尾
    if (dropped > 0 && !said) {
      if (attempt < maxtries) {
        attempt++
        log.info(`工具抑制：吞掉 ${dropped} 个调用（${names.join(',')}），第 ${attempt} 次重申`)
        t.msgs = [...t.msgs, { role: 'system', content: mutepush(attempt, hintfor(alias, names, t.remap, invalid, missing), missing && missing.length) }]
        continue
      }
      if (!forced) {
        forced = true
        forcelast(t)
        log.info('工具抑制：重问用尽，改成禁工具再问一次')
        continue
      }
    }

    usage = usage0
    outcome = { calls, dropped, sawtool }
    break
  }

  let index = 0
  if (msgopen) {
    closemsg(0)
    index = 1
  }
  const allmuted = outcome.dropped > 0 && !outcome.calls.length

  // 全被吞掉又一句正文都没有，补一句中性的话，别让客户端拿到空回复
  if (allmuted && !said) {
    openmsg(index)
    textbuf = mutetext()
    emit('response.output_text.delta', {
      item_id: msgid,
      output_index: index,
      content_index: 0,
      delta: textbuf,
      logprobs: [],
    })
    closemsg(index)
    index += 1
  }

  const output = []
  if (said || (allmuted && !said)) output.push(respmessage(msgid, textbuf))
  for (const call of outcome.calls) {
    const item = respcall(call, t.ns)
    const base = { id: item.id, type: 'function_call', status: 'in_progress', call_id: item.call_id, name: item.name, arguments: '' }
    if (item.namespace) base.namespace = item.namespace
    emit('response.output_item.added', { output_index: index, item: base })
    emit('response.function_call_arguments.delta', {
      item_id: item.id,
      output_index: index,
      delta: item.arguments,
    })
    emit('response.function_call_arguments.done', {
      item_id: item.id,
      output_index: index,
      arguments: item.arguments,
    })
    emit('response.output_item.done', { output_index: index, item })
    output.push(item)
    index += 1
  }

  emit('response.completed', { response: env('completed', output, respusage(usage)) })
  res.__usage = usage
  res.end()
}
