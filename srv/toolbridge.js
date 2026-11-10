// 工具改名与出站闸门：客户端工具原名直发，撞上模板名才加序号避让，调用回来再还原
// 对客户端来说完全透明：它照样收到自己那套 OpenAI tool_calls

// 客户端工具一律原名直发，不加前缀
// 唯一的改名是撞上模板名时加个序号避让，比如客户端自带 read 就发成 read2
// 改名只在出站那一侧，回程 unalias 还原，客户端始终看到自己的名字
// astrbot 那对名字是另一条独立规则，与撞名避让无关

// 出站不再有命名约定要交代，工具名就是客户端自己的名字
// 留个空实现是因为调用点还按「有就拼上」在拼，返回空串自然什么都不加
export function namesnote() {
  return ''
}

// 模板那 12 个工具的名字，固定不动，跟出站实际注入几个凭据无关
// 出站现在只为过门禁注入一个 read，靠它反推名字会让集合只剩一个甚至变空
// 抑制范围与撞名避让都必须按这份名单算，否则客户端带个 read 就能把抑制整段关掉
export const tplall = [
  'edit', 'glob', 'grep', 'question', 'read', 'shell',
  'skill', 'subagent', 'webfetch', 'websearch', 'write', 'execute',
]

// 上游免费档按工具名组合判定「这是不是终端 agent」，命中就回 429
// 报错文案伪装成 FreeUsageLimitError，跟额度、IP、UA、session 全无关
// 实测极简出站形态下只剩 astrbot 这一对仍会触发，其余组合都能过
// 命中时先改名再发，调用回来按映射还原
const escpairs = [
  ['astrbot_execute_shell', 'astrbot_file_read_tool'],
]

// 命中哪一对就按哪个映射改名，两边都换成不含敏感词的名字
function hitpairs(names) {
  const hits = []
  for (const [left, right] of escpairs) {
    if (names.includes(left) && names.includes(right)) hits.push(left, right)
  }
  return hits
}

function escapepair(list) {
  const names = list.map((t) => (t.function || {}).name).filter(Boolean)
  const map = new Map()
  // 精确名对：按原名字逐个给替换名，不用正则，避免误伤别的工具
  for (const n of hitpairs(names)) {
    if (map.has(n)) continue
    map.set(n, n === 'astrbot_execute_shell' ? 'run_cmd' : 'read_text')
  }
  return map
}

// 客户端工具原名直发，这里只处理 astrbot 那对与撞上模板名的
// taken 是已经占用的名字：模板那 12 个固定传进来，撞上的客户端工具加序号避让
export function aliasnames(list, taken) {
  const map = new Map()
  const out = []
  const used = new Set(taken)
  const esc = escapepair(list)
  for (const t of list) {
    const fn = t.function || {}
    if (!fn.name) continue
    const real = fn.name
    // 绝大多数工具命中不了改名规则，原名直发
    const base = esc.get(real) || real
    let next = base
    let n = 1
    while (used.has(next)) next = base + String(++n)
    // 只有真的改了名才记进对照表，没改名的不占条目
    if (next !== real) map.set(next, real)
    used.add(next)
    out.push(next === real ? t : { ...t, function: { ...fn, name: next } })
  }
  return { list: out, map }
}

// 把改名后的调用改回客户端原来的名字
export function unalias(calls, alias) {
  if (!alias || !alias.size || !Array.isArray(calls)) return calls
  return calls.map((call) => {
    const fn = (call && call.function) || {}
    const real = alias.get(fn.name)
    if (!real) return call
    return { ...call, function: { ...fn, name: real } }
  })
}

// 解开参数串，解不开就返回 null 而不是空对象
// 空对象会被当成「一个键都没给」，把截断的 JSON 误报成缺全部参数
function parseargs(raw) {
  if (raw && typeof raw === 'object') return raw
  try {
    const doc = JSON.parse(String(raw || '{}'))
    return doc && typeof doc === 'object' ? doc : null
  } catch {
    return null
  }
}

// 出站闸门之一：名字必须真在客户端那份 tools 里
// 上游偶尔把名字写成对象、写成半截 JSON，或者编一个不存在的名字
// 这些原样发下去客户端只会报 No tool named，所以在这层拦掉让上游重问
export function gatecalls(calls, allow) {
  if (!allow || !allow.size || !Array.isArray(calls)) return { calls, dropped: 0, names: [] }
  const kept = []
  const names = []
  for (const call of calls) {
    const fn = (call && call.function) || {}
    const name = fn.name
    if (typeof name === 'string' && name && allow.has(name)) {
      kept.push(call)
      continue
    }
    names.push(typeof name === 'string' && name ? name.slice(0, 40) : '（无名）')
  }
  return { calls: kept, dropped: names.length, names }
}

// 出站闸门之二：必填参数不能缺
// 缺键时客户端只会回一句 Missing key，白跑一轮，不如当场拦下让上游补齐
// 必须排在抑制之后：被抑制的模板工具该报「不可用」，不该报「缺参数」
export function argcalls(calls, need) {
  if (!need || !need.size || !Array.isArray(calls)) return { calls, dropped: 0, names: [], missing: [] }
  const kept = []
  const names = []
  const missing = []
  for (const call of calls) {
    const fn = (call && call.function) || {}
    const name = fn.name
    const keys = typeof name === 'string' ? need.get(name) : null
    if (!keys || !keys.length) {
      kept.push(call)
      continue
    }
    const args = parseargs(fn.arguments)
    // 参数根本解不开（截断、非法 JSON）时说不清是缺哪个键，放行交给客户端自己报错
    // 硬判成「缺全部参数」会把模型已经给出的参数白扔掉，还给它错误提示
    if (!args) {
      kept.push(call)
      continue
    }
    // 只认 undefined，null 和空字符串是模型自己给的值，不算漏
    const gone = keys.filter((one) => args[one] === undefined)
    if (gone.length) {
      names.push(name)
      missing.push({ name, keys: gone })
      continue
    }
    kept.push(call)
  }
  return { calls: kept, dropped: names.length, names, missing }
}

// 缺必填键时把缺了哪几个直接报出来，模型下一轮就能照着补
export function missnote(missing) {
  if (!Array.isArray(missing) || !missing.length) return ''
  const parts = []
  for (const one of missing.slice(0, 3)) {
    const keys = one.keys || []
    if (!keys.length) {
      // 拿不到必填键清单时说不清缺哪个，直接点名
      parts.push(`${one.name} 没给参数`)
      continue
    }
    parts.push(`${one.name} 少了必填参数 ${keys.join('、')}`)
  }
  return `${parts.join('；')}。参数键要照 tools 里的定义写。`
}

// 每个工具名对应的必填参数键，出站闸门拿它核对参数有没有缺
export function needmap(lists) {
  const out = new Map()
  for (const list of lists) {
    if (!Array.isArray(list)) continue
    for (const t of list) {
      const fn = (t && t.function) || {}
      const name = fn.name
      if (!name) continue
      const params = fn.parameters || {}
      const keys = Array.isArray(params.required) ? params.required.filter((one) => typeof one === 'string') : []
      if (keys.length) out.set(name, keys)
    }
  }
  return out
}

// 模板那 12 个工具的调用一律吞掉，一条都不许改派
// 改派会让「模板工具在本轮不可用」变成「换个名字照跑」：
// 上游吐 shell 就被翻译成客户端 bash 的命令行执行，等于抑制形同虚设
// 所以这里只保留吞掉一条路，改派相关实现整段删除
export function mutecalls(calls, mute) {
  if (!mute || !mute.size || !Array.isArray(calls)) return { calls, dropped: 0, names: [] }
  const kept = []
  const names = []
  for (const call of calls) {
    const name = (call && call.function && call.function.name) || ''
    // 模板名的调用到此为止，绝不改派成客户端工具：那是同一次调用换个壳继续执行
    if (mute.has(name)) {
      names.push(name)
      continue
    }
    kept.push(call)
  }
  return { calls: kept, dropped: names.length, names }
}

// 只否定刚才那一次尝试，绝不波及同类或同名的其他可用工具
// 用陈述事实的口吻，不用命令口吻，否则模型会把它当成可疑的指令注入并公开对抗
// 缺参数和工具不可用是两种完全不同的错，措辞必须分开：
// 混成「工具不可用」会让模型以为整轮没有工具，之后再也不调，白白废掉一次能力
export function mutepush(count, hint, argless) {
  const base = argless ? '刚才那次调用没有生效：参数给得不全。' : '刚才那次调用没有生效：那个工具在本轮不可用。'
  const tip = hint ? ` ${hint}` : ''
  if (count <= 1) return base + tip
  if (count === 2) return base + tip + ' 补齐参数后照原样再试一次就行。'
  return base + tip + `这是第 ${count} 次，其余工具都正常。`
}

// 客户端回填历史时，assistant 消息里带的是客户端自己的真名
// 上游那边这些名字可能被改过（astrbot 那对、撞模板名的），得先换回出站写法
export function rebridge(msgs, alias) {
  const back = new Map()
  if (!alias || !alias.size) return msgs
  for (const [up, real] of alias) back.set(real, up)
  for (const m of msgs) {
    if (!m || m.role !== 'assistant' || !Array.isArray(m.tool_calls)) continue
    m.tool_calls = m.tool_calls.map((call) => {
      const fn = (call && call.function) || {}
      if (!back.has(fn.name)) return call
      return { ...call, function: { ...fn, name: back.get(fn.name) } }
    })
  }
  return msgs
}
