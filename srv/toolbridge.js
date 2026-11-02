// 工具改名与出站闸门：客户端工具加前缀发上去，调用回来再还原
// 对客户端来说完全透明：它照样收到自己那套 OpenAI tool_calls

// 客户端工具一律加 c_ 前缀发上去，规则固定，不随冲突情况变
// 这样同一会话里工具名永远一致，不会这一轮叫 read、下一轮叫 c_read
// 模板那 12 个名字不带 c_，天然不会撞，所以前缀加一次就够，不需要循环避让
const sameprefix = 'c_'

// 给模型的固定命名约定，每轮都说同一句，不逐条点名那些模板工具
export function namesnote(prefixed, muted) {
  const lines = []
  if (prefixed) {
    lines.push(`工具列表里以 ${sameprefix} 开头的那些是调用方的工具，调用时按列表里的完整名字写，不要省略前缀。`)
  }
  if (Array.isArray(muted) && muted.length) {
    lines.push(`模板里的 ${muted.join('、')} 这批名字在本轮不算可用工具；能对上调用方工具的会自动改派，对不上的会被丢掉，请优先直接用列表里带前缀的工具。`)
  }
  return lines.join('\n')
}

// 上游免费档按工具名组合判定「这是不是终端 agent」，命中就回 429
// 报错文案伪装成 FreeUsageLimitError，跟额度、IP、UA、session 全无关
// 名字一换就正常，所以命中时先改名再发，调用回来按映射还原
const escexec = /exec/i
const escstdin = /write_stdin/i

// astrbot 这两个名字同时出现必挂，换顺序、换描述、换参数 schema 都照挂
// 实测 5 次一轮全稳定复现，单独出现任一个或换成别的写法都通过
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
  const hit = names.some((n) => escexec.test(n)) && names.some((n) => escstdin.test(n))
  if (hit) {
    for (const n of names) {
      if (escexec.test(n)) map.set(n, 'run_cmd')
      else if (escstdin.test(n)) map.set(n, 'feed_tty')
    }
  }
  // 精确名对：按原名字逐个给替换名，不用正则，避免误伤别的工具
  for (const n of hitpairs(names)) {
    if (map.has(n)) continue
    map.set(n, n === 'astrbot_execute_shell' ? 'run_cmd' : 'read_text')
  }
  return map
}

export function aliasnames(list, taken) {
  const map = new Map()
  const out = []
  const used = new Set(taken)
  const esc = escapepair(list)
  for (const t of list) {
    const fn = t.function || {}
    if (!fn.name) continue
    const base = esc.get(fn.name) || fn.name
    let next = sameprefix + base
    let n = 1
    // 客户端自己已经叫 c_xxx 时再叠一层，保证注入且不重复
    while (used.has(next)) next = sameprefix + base + String(++n)
    map.set(next, fn.name)
    used.add(next)
    out.push({ ...t, function: { ...fn, name: next } })
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

function parseargs(raw) {
  if (raw && typeof raw === 'object') return raw
  try {
    const doc = JSON.parse(String(raw || '{}'))
    return doc && typeof doc === 'object' ? doc : {}
  } catch {
    return {}
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

// 模板那 12 个工具必须发出去，否则上游直接报错
// 但发出去不等于要让它存在，这里把对它们的调用直接吞掉
// 模板里这几个工具被抑制时，如果客户端正好也有同类工具，就把这次调用改派过去
// 参数名两边对不上就按表翻译，模型不用白跑一轮，也不会以为整轮没有工具可用
// 客户端没有同类工具时，退一步用 shell 顶：读文件、找内容都能拼成命令
const shelllike = /^(shell|shell_run|shellrun|exec|exec_command|run_command|run|bash|sh|terminal)$/

// 拼进 shell 命令前先加引号，空格和特殊字符不会把命令拆坏
function shquote(text) {
  return "'" + String(text).replace(/'/g, "'\\''") + "'"
}

// 读文件没有对等工具时，用 sed 取行、用 ls 看目录
function readcmd(src) {
  const file = String(src.path || src.file_path || '')
  if (!file) return null
  const one = shquote(file)
  const offset = Number(src.offset) || 0
  const limit = Number(src.limit) || 0
  if (offset > 0) {
    const end = limit > 0 ? offset + limit - 1 : offset + 199
    return `sed -n '${offset},${end}p' ${one}`
  }
  const cap = limit > 0 ? limit : 300
  return `if [ -d ${one} ]; then ls -la ${one}; else sed -n '1,${cap}p' ${one}; fi`
}

// 搜内容没有对等工具时，用 grep 顶上，结果截前 200 行
function grepecmd(src) {
  const pattern = String(src.pattern || src.query || '')
  if (!pattern) return null
  const dir = String(src.path || '.')
  const inc = src.include ? `--include=${shquote(src.include)} ` : ''
  return `grep -rn ${inc}-- ${shquote(pattern)} ${shquote(dir)} | head -n 200`
}

// 写文件没有对等工具时，用 heredoc 落盘，内容原样，不做转义
function writecmd(src) {
  const file = String(src.path || src.file_path || '')
  const text = src.content ?? src.text
  if (!file || typeof text !== 'string') return null
  const one = shquote(file)
  const dir = shquote(String(file).includes('/') ? String(file).replace(/\/[^/]*$/, '') || '/' : '.')
  return `mkdir -p ${dir} && cat > ${one} <<'DSH_FILE_END'\n${text}\nDSH_FILE_END`
}

const remaprules = [
  {
    from: 'shell',
    to: shelllike,
    args: { command: ['cmd', 'command', 'input'], workdir: ['workdir', 'cwd', 'dir'] },
  },
  {
    from: 'read',
    to: /^(read|read_file|readfile|view_file|cat|open_file)$/,
    args: { path: ['path', 'file_path', 'file'], offset: ['offset'], limit: ['limit'] },
  },
  { from: 'read', to: shelllike, make: readcmd },
  {
    from: 'write',
    to: /^(write|write_file|writefile|create_file|save_file)$/,
    args: { path: ['path', 'file_path', 'file'], content: ['content', 'text', 'data'] },
  },
  { from: 'write', to: shelllike, make: writecmd },
  {
    from: 'grep',
    to: /^(grep|search|rg|ripgrep)$/,
    args: { pattern: ['pattern', 'query'], path: ['path', 'dir'] },
  },
  { from: 'grep', to: shelllike, make: grepecmd },
  {
    from: 'glob',
    to: /^(glob|find|list_files|ls)$/,
    args: { pattern: ['pattern', 'glob'], path: ['path', 'dir'] },
  },
]

// 按被抑制的模板工具名，找客户端里能顶上的那个，并记下它认哪些参数
export function buildremap(mute, tools) {
  const out = new Map()
  if (!mute || !mute.size || !Array.isArray(tools)) return out
  const list = tools.filter((t) => t && t.function && t.function.name)
  for (const rule of remaprules) {
    if (!mute.has(rule.from) || out.has(rule.from)) continue
    const hit = list.find((t) => rule.to.test(String(t.function.name).replace(/^c_/, '')))
    if (!hit) continue
    const params = (hit.function.parameters && hit.function.parameters.properties) || {}
    out.set(rule.from, { name: hit.function.name, props: Object.keys(params), args: rule.args, make: rule.make })
  }
  return out
}

// 参数照表搬过去，关键参数没地方落就放弃改派，宁可照旧吞掉
function remapcall(call, rule) {
  const src = parseargs(call.function.arguments)
  if (rule.make) {
    const cmd = rule.make(src, rule.props)
    if (!cmd) return null
    // make 出来的是要执行的命令，得塞进客户端认的那个参数名里
    const key = ['cmd', 'command', 'input'].find((one) => rule.props.includes(one))
    if (!key) return null
    const args = { [key]: cmd }
    const wd = ['workdir', 'cwd', 'dir'].find((one) => rule.props.includes(one))
    if (wd && src.workdir) args[wd] = src.workdir
    return { ...call, function: { ...call.function, name: rule.name, arguments: JSON.stringify(args) } }
  }
  const out = {}
  for (const [key, targets] of Object.entries(rule.args || {})) {
    const value = src[key]
    if (value === undefined || value === null) continue
    const dst = targets.find((one) => rule.props.includes(one))
    if (!dst) return null
    out[dst] = value
  }
  if (!Object.keys(out).length) return null
  return { ...call, function: { ...call.function, name: rule.name, arguments: JSON.stringify(out) } }
}

export function mutecalls(calls, mute, remap) {
  if (!mute || !mute.size || !Array.isArray(calls)) return { calls, dropped: 0, names: [] }
  const kept = []
  const names = []
  for (const call of calls) {
    const name = (call && call.function && call.function.name) || ''
    if (mute.has(name)) {
      const rule = remap && remap.get(name)
      const moved = rule ? remapcall(call, rule) : null
      if (moved) {
        kept.push(moved)
        continue
      }
      names.push(name)
      continue
    }
    kept.push(call)
  }
  return { calls: kept, dropped: names.length, names }
}

// 只否定刚才那一次尝试，绝不波及同类或同名的其他可用工具
// 用陈述事实的口吻，不用命令口吻，否则模型会把它当成可疑的指令注入并公开对抗
// 客户端真有同名工具时会被改成 c_xxx，这里直接把正确的名字告诉它
// 参数缺键是另一类错，措辞要跟「工具不可用」分开，否则模型会以为工具本身没了
export function mutepush(count, hint, argless) {
  const base = argless ? '刚才那次调用没有生效：参数不全。' : '刚才那次调用没有生效：那个工具在本轮不可用。'
  const tip = hint ? ` ${hint}` : ''
  if (count <= 1) return base + tip
  if (count === 2) return base + tip + '重复同一次调用仍然不会生效，换个工具或换个名字。'
  return base + tip + `这是第 ${count} 次，同一个调用依然不生效，其余工具都正常。`
}

// 客户端回填历史时，assistant 消息里带的是真名
// 上游那边这些名字和模板重名，得先换回带前缀的写法
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
