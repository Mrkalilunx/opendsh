// 进程查看：只列 Termux 自己名下的进程，数据全从 /proc 读
// so: 别的应用的 cmdline 在 Termux 里读不到，硬列出来也是一片空名，干脆按 uid 过滤

import { readFile, readdir, readlink } from 'node:fs/promises'

// 当前 uid 就是 Termux 的应用沙箱号，只有自己的进程读得全
const selfuid = typeof process.getuid === 'function' ? process.getuid() : -1

// Android 的时钟滴答是 100Hz、页大小 4KiB，getconf 在 Termux 里拿不到，直接写死
const ticks = 100
const pagesize = 1 << 12

// 上一轮采样，用来算 CPU 占用：两轮之间的滴答差除以间隔
let previousticks = new Map()
let previousat = 0
// 最近一次列表的完整行，详情页直接取，省得再算一遍又算出个跳数
let latest = new Map()

// 符号链接读不出来就当没有，权限不够的进程本来也不让看
async function readlinktext(file) {
  try {
    return await readlink(file)
  } catch {
    return ''
  }
}

async function readtext(file) {
  try {
    return await readFile(file, 'utf8')
  } catch {
    return ''
  }
}

// status 里取名字、状态和 uid，uid 不是自己的直接跳过
function parse_status(text) {
  let name = ''
  let state = ''
  let uid = -1
  for (const line of text.split('\n')) {
    if (line.startsWith('Name:')) name = line.slice(5).trim()
    else if (line.startsWith('State:')) state = line.slice(6).trim().charAt(0)
    else if (line.startsWith('Uid:')) uid = Number(line.slice(4).trim().split(/\s+/)[0])
  }
  return { name, state, uid }
}

// stat 里 comm 带括号且可能含空格，先按最后一个右括号切开，后面的字段序号才数得准
function parse_stat(text) {
  const close = text.lastIndexOf(')')
  if (close < 0) return null
  const f = text.slice(close + 2).trim().split(/\s+/)
  return {
    // 字段 4 是父进程，14、15 是用户态和内核态滴答，20 是线程数，22 是启动时刻
    ppid: Number(f[1]) || 0,
    ticks: Number(f[11]) + Number(f[12]),
    threads: Number(f[17]) || 1,
    start: Number(f[19]) || 0,
    state: f[0] || '',
  }
}

// 命令行按 NUL 切开，太长截断，空的话退回 status 里的短名
function parse_cmd(text, fallback) {
  const args = text.split('\0').filter((it) => it !== '')
  const line = args.join(' ')
  if (!line) return fallback
  return line.length > 110 ? `${line.slice(0, 109)}…` : line
}

async function one(pid, now, elapsed) {
  const base = `/proc/${pid}`
  const st = parse_status(await readtext(`${base}/status`))
  if (st.uid !== selfuid) return null

  const stat = parse_stat(await readtext(`${base}/stat`))
  const statm = (await readtext(`${base}/statm`)).trim().split(/\s+/)
  const rss = (Number(statm[1]) || 0) * pagesize
  const total = stat ? stat.ticks : 0

  // 上一轮没有这条进程时不给数字，第一次采样本来也算不出来
  const was = previousticks.get(pid)
  const cpu = was === undefined || !elapsed || !stat
    ? 0
    : Math.max(0, ((total - was) / ticks / elapsed) * 100)

  return {
    pid: Number(pid),
    name: st.name,
    cmd: parse_cmd(await readtext(`${base}/cmdline`), st.name),
    state: (stat && stat.state) || st.state,
    threads: stat ? stat.threads : 1,
    cpu: Math.round(cpu * 10) / 10,
    rss,
    _ticks: total,
  }
}

// 结束进程：先礼后兵，SIGTERM 不退再 SIGKILL，两种情况都回报
async function waitgone(pid, ms) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    const st = parse_status(await readtext(`/proc/${pid}/status`))
    // 已经不是自己人了，或者只剩僵尸条目，都算退出
    if (st.uid !== selfuid || st.state === 'Z') return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
}

export async function kill(pid) {
  const n = Number(pid)
  if (!Number.isInteger(n) || n <= 1) throw new Error('PID 不合法')
  if (n === process.pid) throw new Error('不能结束 dsh 自己，界面就没了')
  const st = parse_status(await readtext(`/proc/${n}/status`))
  if (st.uid !== selfuid) throw new Error('这个进程不属于 Termux')
  if (st.state === 'Z') throw new Error('进程已经是僵尸，等父进程回收就行')
  try {
    process.kill(n, 'SIGTERM')
  } catch (err) {
    throw new Error(`发送 SIGTERM 失败：${err.message}`)
  }
  if (await waitgone(n, 800)) return { pid: n, name: st.name, how: 'SIGTERM' }
  try {
    process.kill(n, 'SIGKILL')
  } catch (err) {
    throw new Error(`发送 SIGKILL 失败：${err.message}`)
  }
  if (await waitgone(n, 800)) return { pid: n, name: st.name, how: 'SIGKILL' }
  throw new Error('两种信号都发了，进程还在')
}

// 列出所有属于 Termux 的进程，按 CPU 再按内存排，最多给 60 条
export async function list() {
  const now = Date.now()
  const elapsed = previousat ? Math.max(0.2, (now - previousat) / 1000) : 0

  let pids = []
  try {
    pids = (await readdir('/proc')).filter((n) => /^\d+$/.test(n))
  } catch {
    return { at: now, total: 0, items: [] }
  }

  const rows = (await Promise.all(pids.map((pid) => one(pid, now, elapsed)))).filter(Boolean)
  const next = new Map()
  for (const it of rows) next.set(String(it.pid), it._ticks)
  previousticks = next
  previousat = now
  latest = new Map(rows.map((it) => [it.pid, it]))

  rows.sort((a, b) => b.cpu - a.cpu || b.rss - a.rss)
  const items = rows.slice(0, 60).map(({ _ticks, ...it }) => it)
  return { at: now, total: rows.length, items }
}

// 单个进程的详情：命令行全文、父进程、可执行文件、工作目录、打开的文件数
export async function detail(pid) {
  const n = Number(pid)
  if (!Number.isInteger(n) || n <= 0) throw new Error('PID 不合法')
  const base = `/proc/${n}`
  const raw = await readtext(`${base}/status`)
  if (!raw) throw new Error('读不到这个进程，可能已退出或不属于 Termux')
  const st = parse_status(raw)
  if (st.uid !== selfuid) throw new Error('这个进程不属于 Termux')

  const stat = parse_stat(await readtext(`${base}/stat`))
  const args = (await readtext(`${base}/cmdline`)).split('\0').filter((it) => it !== '')
  const statm = (await readtext(`${base}/statm`)).trim().split(/\s+/)
  const known = latest.get(n) || {}

  // Android上 /proc/uptime 对普通应用是 EACCES，改用自己进程的启动时刻反推：
  // 目标年龄 = 自己已运行时长 + （自己启动滴答 - 目标启动滴答）
  let age = 0
  const ownstat = parse_stat(await readtext('/proc/self/stat'))
  if (stat && stat.start && ownstat && ownstat.start) {
    age = Math.max(0, process.uptime() + (ownstat.start - stat.start) / ticks)
  }

  let fds = 0
  try {
    fds = (await readdir(`${base}/fd`)).length
  } catch {
    // 读不到 fd 目录说明没权限，按 0 显示
  }

  const ppid = stat ? stat.ppid : 0
  const ppidname = ppid ? parse_status(await readtext(`/proc/${ppid}/status`)).name : ''

  return {
    pid: n,
    name: st.name,
    cmd: args.join(' ') || st.name,
    args,
    state: (stat && stat.state) || st.state,
    threads: stat ? stat.threads : 1,
    uid: st.uid,
    ppid,
    ppidname,
    cpu: Number(known.cpu) || 0,
    rss: (Number(statm[1]) || 0) * pagesize,
    exe: await readlinktext(`${base}/exe`),
    cwd: await readlinktext(`${base}/cwd`),
    fds,
    age: Math.round(age),
    startedAt: age ? Date.now() - Math.round(age * 1000) : 0,
  }
}
