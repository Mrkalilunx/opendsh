// 工具桥：上游对 tools 数量有上限，模板那 12 个又不能动
// 所以把超出的客户端工具收成一段文字清单，再挂一个转发工具去调它们
// 对客户端来说完全透明：它照样收到自己那套 OpenAI tool_calls

const bridgename = '__call_tool'

// 客户端工具一律加 c_ 前缀发上去，规则固定，不随冲突情况变
// 这样同一会话里工具名永远一致，不会这一轮叫 read、下一轮叫 c_read
// 模板那 12 个名字不带 c_，天然不会撞，所以前缀加一次就够，不需要循环避让
const sameprefix = 'c_'

// 给模型的固定命名约定，每轮都说同一句，不逐条点名那些模板工具
export function namesnote(prefixed, bridged, muted) {
  const lines = []
  if (prefixed) {
    lines.push(`工具列表里以 ${sameprefix} 开头的那些是调用方的工具，调用时按列表里的完整名字写，不要省略前缀。`)
  }
  if (Array.isArray(muted) && muted.length) {
    lines.push(`模板里的 ${muted.join('、')} 这批名字在本轮不算可用工具；能对上调用方工具的会自动改派，对不上的会被丢掉，请优先直接用列表里带前缀的工具。`)
  }
  if (bridged) {
    lines.push(`清单里没列进工具列表的，统一通过 ${bridgename} 调用，name 填清单里给的名字。`)
  }
  return lines.join('\n')
}

// 上游免费档把「exec 系 + write_stdin」这对工具名当成终端 agent 在用，直接回 429
// 名字一换就正常，所以这一对同时出现时先改名再发，调用回来按映射还原
const escexec = /exec/i
const escstdin = /write_stdin/i

function escapepair(list) {
  const names = list.map((t) => (t.function || {}).name).filter(Boolean)
  const hit = names.some((n) => escexec.test(n)) && names.some((n) => escstdin.test(n))
  const map = new Map()
  if (!hit) return map
  for (const n of names) {
    if (escexec.test(n)) map.set(n, 'run_cmd')
    else if (escstdin.test(n)) map.set(n, 'feed_tty')
  }
  return map
}

export function aliasnames(list, taken) {
  const map = new Map()
  const out = []
  const used = new Set(taken)
  used.add(bridgename)
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

// 描述只留第一句，参数只留顶层键，够模型判断就行，别把上下文吃光
function brief(text, max) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  return flat.slice(0, max - 1) + '…'
}

function paramsbrief(fn) {
  const props = (fn.parameters && fn.parameters.properties) || {}
  const keys = Object.keys(props)
  if (!keys.length) return ''
  return keys.join(', ')
}

function catalog(extra) {
  const lines = ['你现在还能调用下面这些工具，但不在 tools 列表里，要经由 ' + bridgename + ' 转发。']
  lines.push(`调用方式：${bridgename}({ "name": "工具名", "arguments": { ...参数 } })`)
  lines.push('一次只能调一个，参数按下面列出的键给，不确定就别调。')
  lines.push('')
  for (const t of extra) {
    const fn = t.function || {}
    const args = paramsbrief(fn)
    lines.push(`- ${fn.name}: ${brief(fn.description, 120)}${args ? `（参数：${args}）` : ''}`)
  }
  return lines.join('\n')
}

function bridge() {
  return {
    type: 'function',
    function: {
      name: bridgename,
      description: '按名字调用清单里的工具，把工具名和参数原样传进来',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '要调用的工具名，必须来自清单' },
          arguments: { type: 'object', description: '这个工具的参数对象' },
        },
        required: ['name', 'arguments'],
      },
    },
  }
}

// 返回要发上去的 tools、要追加的说明文字、以及桥的名字映射
// 客户端工具装得下就原样放行，装不下才启用桥
export function plantools(clienttools, basecount, budget, enabled) {
  const base = Math.max(0, Number(basecount) || 0)
  const limit = Math.max(base, Number(budget) || 15)
  const slots = Math.max(0, limit - base)
  const list = Array.isArray(clienttools) ? clienttools.filter((t) => t && t.function && t.function.name) : []

  if (!list.length) return { extra: [], note: '', map: new Map(), active: false }
  if (!enabled || list.length <= slots) return { extra: list, note: '', map: new Map(), active: false }

  const keep = Math.max(0, slots - 1)
  const direct = list.slice(0, keep)
  const rest = list.slice(keep)
  const map = new Map()
  for (const t of rest) map.set(t.function.name, t)

  return {
    extra: [...direct, bridge()],
    note: catalog(rest),
    map,
    active: true,
  }
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

// 把桥调用拆回真正的工具名，参数原样序列化交给客户端
export function unwrapcalls(calls, map) {
  if (!map || !map.size || !Array.isArray(calls)) return calls
  const out = []
  for (const call of calls) {
    const name = call && call.function && call.function.name
    if (name !== bridgename) {
      out.push(call)
      continue
    }
    const args = parseargs(call.function.arguments)
    const real = String(args.name || '')
    const target = map.get(real)
    if (!target) {
      // 名字不在清单里，退化成一次普通调用，让客户端自己决定怎么处理
      out.push({
        ...call,
        function: { name: real || bridgename, arguments: JSON.stringify(args.arguments || {}) },
      })
      continue
    }
    out.push({
      id: call.id,
      type: 'function',
      function: { name: real, arguments: JSON.stringify(args.arguments || {}) },
    })
  }
  return out
}

export { bridgename }

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
export function mutepush(count, hint) {
  const base = '刚才那次调用没有生效：那个工具在本轮不可用。'
  const tip = hint ? ` ${hint}` : ''
  if (count <= 1) return base + tip
  if (count === 2) return base + tip + '重复同一次调用仍然不会生效，换个工具或换个名字。'
  return base + tip + `这是第 ${count} 次，同一个调用依然不生效，其余工具都正常。`
}

// 客户端回填历史时，assistant 消息里带的是真名
// 上游那边这些名字要么不在 tools 列表里、要么和模板重名，都得先换回去
export function rebridge(msgs, map, alias) {
  const back = new Map()
  if (alias && alias.size) for (const [up, real] of alias) back.set(real, up)
  if ((!map || !map.size) && !back.size) return msgs
  for (const m of msgs) {
    if (!m || m.role !== 'assistant' || !Array.isArray(m.tool_calls)) continue
    m.tool_calls = m.tool_calls.map((call) => {
      const fn = (call && call.function) || {}
      const real = back.get(fn.name) || fn.name
      if (map && map.has(real)) {
        const args = parseargs(fn.arguments)
        return {
          ...call,
          function: {
            name: bridgename,
            arguments: JSON.stringify({ name: real, arguments: args }),
          },
        }
      }
      if (!back.has(fn.name)) return call
      return { ...call, function: { ...fn, name: real } }
    })
  }
  return msgs
}
