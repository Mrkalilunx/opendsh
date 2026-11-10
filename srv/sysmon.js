// 系统监控：GPU、频率、内存直接读 sysfs 和 proc，CPU 占用与进程走 Shizuku 远程 shell
// 远程一次要一秒多，结果短时缓存，页面轮询不会每次都等

import { readFile, readdir } from 'node:fs/promises'
import { connect as tlsconnect } from 'node:tls'
import * as logstore from './logstore.js'
import * as adbshell from './adbshell.js'
import { endpoint } from './upstream.js'
import { forced } from './overrides.js'

// 强制开关转成布尔：强制失败不管真实结果都算挂，强制正常都算通
function force(id, real) {
  const mode = forced(id)
  if (mode === 'fail') return false
  if (mode === 'ok') return true
  return Boolean(real)
}

const ttl = 2500
const cache = { at: 0, data: null, pending: null, failedat: 0 }

let kgsl = null
let gputemp = null

async function readtext(file) {
  try {
    return (await readFile(file, 'utf8')).trim()
  } catch {
    return ''
  }
}

// 不同机型的 soc 目录名不一样，按后缀找一次就记住
async function kgslpath() {
  if (kgsl !== null) return kgsl
  // 类路径不用列目录，高通机型基本都能直接读
  const direct = '/sys/class/kgsl/kgsl-3d0/gpubusy'
  if (await readtext(direct)) {
    kgsl = direct
    return kgsl
  }
  try {
    const dirs = await readdir('/sys/devices/platform/soc')
    const hit = dirs.find((d) => d.endsWith('kgsl-3d0'))
    kgsl = hit ? `/sys/devices/platform/soc/${hit}/kgsl/kgsl-3d0/gpubusy` : ''
  } catch {
    kgsl = ''
  }
  return kgsl
}

// gpubusy 给的是「上次读取到现在」的忙时与总时长（微秒），读一次就清空
async function gpubusy() {
  const file = await kgslpath()
  if (!file) return null
  const raw = await readtext(file)
  const [busy, total] = raw.split(/\s+/).map(Number)
  if (!Number.isFinite(total) || total <= 0) return 0
  return Math.max(0, Math.min(100, (busy / total) * 100))
}

// GPU 温度在 thermal_zone 里，类型名带 gpu，各机型编号不同，按类型找
async function gputempc() {
  if (gputemp) {
    const v = await readtext(gputemp)
    const n = Number(v)
    if (Number.isFinite(n) && n > 0) return n / 1000
  }
  try {
    const dirs = await readdir('/sys/class/thermal')
    for (const dir of dirs) {
      if (!dir.startsWith('thermal_zone')) continue
      const base = `/sys/class/thermal/${dir}`
      const type = await readtext(`${base}/type`)
      if (!/gpu/i.test(type)) continue
      const temp = Number(await readtext(`${base}/temp`))
      if (!Number.isFinite(temp) || temp <= 0) continue
      gputemp = `${base}/temp`
      return temp / 1000
    }
  } catch {
    // 没有温度节点就算了，不影响其它指标
  }
  return null
}

async function gpuinfo() {
  const [pct, temp, model] = await Promise.all([
    gpubusy(),
    gputempc(),
    readtext('/sys/kernel/gpu/gpu_model'),
  ])
  return { pct, temp, model: model || '' }
}

// 每核当前频率，拿不到就沿用同簇上一颗的值
async function cpufreq() {
  const out = []
  let last = null
  for (let i = 0; i < 8; i += 1) {
    const v = Number(await readtext(`/sys/devices/system/cpu/cpu${i}/cpufreq/scaling_cur_freq`))
    if (Number.isFinite(v) && v > 0) last = Math.round(v / 1000)
    out.push(last)
  }
  return out
}

async function meminfo() {
  const raw = await readtext('/proc/meminfo')
  const pick = (key) => {
    const m = raw.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'))
    return m ? Number(m[1]) * 1024 : 0
  }
  const total = pick('MemTotal')
  const free = pick('MemAvailable')
  const swapTotal = pick('SwapTotal')
  const swapFree = pick('SwapFree')
  return {
    total,
    used: Math.max(0, total - free),
    swapTotal,
    swapused: Math.max(0, swapTotal - swapFree),
  }
}

// 只看 Termux 自己名下的进程，系统里其它应用读不到 cmdline
async function services() {
  const want = [
    { key: 'dsh', name: 'dsh 服务', re: /bun serve\.js/ },
    { key: 'db', name: 'MariaDB', re: /mariadbd --basedir/ },
  ]
  const found = new Map()
  try {
    const pids = (await readdir('/proc')).filter((n) => /^\d+$/.test(n))
    for (const pid of pids) {
      const cmd = await readtext(`/proc/${pid}/cmdline`)
      if (!cmd) continue
      const line = cmd.replace(/\0/g, ' ').trim()
      for (const it of want) {
        if (!found.has(it.key) && it.re.test(line)) found.set(it.key, Number(pid))
      }
    }
  } catch {
    // 读不到就都当作没在跑，页面显示未知
  }
  // Shizuku 是别的应用的进程，看不了 cmdline，只能拿远程 shell 通不通来判断
  return [
    ...want.map((it) => ({ key: it.key, name: it.name, pid: found.get(it.key) || 0, run: found.has(it.key) })),
    { key: 'shizuku', name: 'Shizuku', pid: 0, run: false },
    { key: 'up', name: '上游代理', pid: 0, run: false },
  ]
}

// 上游探活：只做 DNS + TCP + TLS 握手，不发 HTTP 请求
// 这样只看链路通不通，跟额度、限流、模型是否可用都无关
// 60 秒内复用结果，别让 6 秒一轮的监控反复握手
let upat = 0
let upok = false
let uppending = null

const uphost = new URL(endpoint).hostname

function probeupstream() {
  return new Promise((resolve) => {
    let done = false
    let sock = null
    const finish = (ok) => {
      if (done) return
      done = true
      upok = ok
      upat = Date.now()
      if (sock) sock.destroy()
      resolve(ok)
    }
    try {
      sock = tlsconnect({ host: uphost, port: 443, servername: uphost, timeout: 4000 }, () => finish(true))
    } catch {
      finish(false)
      return
    }
    sock.once('timeout', () => finish(false))
    sock.once('error', () => finish(false))
  })
}

// 握手要一秒多，监控卡不等它，先把上一次的结果给出去，探完下一轮自然就更新了
function upstreamok() {
  if (Date.now() - upat >= 60000 && !uppending) {
    uppending = probeupstream().finally(() => {
      uppending = null
    })
  }
  return upok
}

// 库的真实连通性 + 版本库名这些信息，主页数据库那一块用
// 库没起来时 ensuremysql 可能等十几秒，这里卡个上限，别把监控卡拖住
function within(promise, ms, fallback) {
  return Promise.race([promise, new Promise((r) => setTimeout(() => r(fallback), ms))])
}

async function dbinfo() {
  const cfg = (await logstore.target()) || {}
  const base = { host: cfg.host || '', port: Number(cfg.port) || 0 }
  try {
    if (!(await within(logstore.ping(), 1500, false))) return { ok: false, ...base }
    const brief = await within(logstore.brief(), 1500, null)
    if (!brief) return { ok: false, ...base }
    return { ok: true, ...base, ...brief }
  } catch {
    return { ok: false, ...base }
  }
}

// 判定依据是输出里那两个采样标记都在，不看退出码
// top 偶尔会返回非零但数据完整，反过来也一样，只有标记齐全才说明两段都采到了
async function runad(script, timeout = 6000) {
  const res = await adbshell.run(script, timeout)
  return { ok: res.out.includes('@B'), out: res.out, err: res.err }
}

const script = [
  'c(){ head -1 /proc/stat; grep "^cpu[0-9]" /proc/stat; }',
  'echo @A; c',
  'echo @T; top -b -n 2 -d 0.3 -m 6',
  'echo @B; c',
  'echo @L; cat /proc/loadavg; cut -d. -f1 /proc/uptime',
].join('; ')

function cpuline(line) {
  const f = line.trim().split(/\s+/).slice(1).map(Number)
  const total = f.reduce((a, b) => a + b, 0)
  const idle = (f[3] || 0) + (f[4] || 0)
  return { total, idle }
}

function pct(a, b) {
  if (!a || !b) return null
  const dt = b.total - a.total
  if (dt <= 0) return null
  const di = b.idle - a.idle
  return Math.max(0, Math.min(100, ((dt - di) / dt) * 100))
}

// 一行进程：PID 用户 PR NI 虚拟 常驻 共享 状态 占用 内存 时间 名字
const prow = /^\s*(\d+)\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+[A-Z]\s+(\d+\.\d+)\s+(\d+\.\d+)\s+(\S+)\s+(.*)$/

function pros(block) {
  const lines = block.split('\n')
  let start = -1
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*PID\s+USER\s+/.test(lines[i])) start = i + 1
  }
  if (start < 0) return []
  const out = []
  for (const line of lines.slice(start)) {
    const m = line.match(prow)
    if (!m) continue
    const name = m[5].trim()
    // top 自己也会排在前面，监控列表里没有意义
    if (/^top -b/.test(name)) continue
    out.push({ pid: Number(m[1]), cpu: Number(m[2]), mem: Number(m[3]), name })
    if (out.length >= 6) break
  }
  return out
}

async function device() {
  const res = await runad(script)
  if (!res.ok) return null

  const parts = res.out.split(/^@([A-Z])\s*$/m)
  const map = new Map()
  for (let i = 1; i < parts.length; i += 2) map.set(parts[i], parts[i + 1] || '')

  const parse = (block) => {
    const lines = block.split('\n').filter((l) => /^cpu\d*\s/.test(l))
    const all = cpuline(lines[0] || 'cpu 0 0 0 0 0 0 0')
    const cores = lines.slice(1).map(cpuline)
    return { all, cores }
  }

  const a = parse(map.get('A') || '')
  const b = parse(map.get('B') || '')
  const cpupct = pct(a.all, b.all)
  const corepct = a.cores.map((c, i) => pct(c, b.cores[i] || c))

  const loadline = (map.get('L') || '').trim().split('\n')
  const loads = (loadline[0] || '').trim().split(/\s+/).slice(0, 3).map(Number)
  const uptime = Number(loadline[1]) || 0

  return {
    cpupct,
    corepct,
    loads,
    uptime,
    procs: pros(map.get('T') || ''),
  }
}

async function devinfo() {
  const now = Date.now()
  if (cache.data && now - cache.at < ttl) return cache.data
  // Shizuku 没开时远程调用要等超时，失败也缓存一会儿，别每轮都卡住
  if (!cache.data && now - cache.failedat < 10000) return null
  if (cache.pending) return cache.pending
  cache.pending = device()
    .then((data) => {
      if (data) {
        cache.data = data
        cache.at = Date.now()
      } else {
        cache.failedat = Date.now()
      }
      return data
    })
    .finally(() => {
      cache.pending = null
    })
  return cache.pending
}

export async function snapshot(port) {
  // 上游探活不等结果，先拿上一次的，握手在后台继续
  const up = upstreamok()
  const [gpu, freq, mem, list, dev, db] = await Promise.all([
    gpuinfo(),
    cpufreq(),
    meminfo(),
    services(),
    devinfo(),
    dbinfo(),
  ])

  // 库按真实连接算，Shizuku 按远程调用通不通，上游按探活结果，进程在不在只是参考
  // 调试里的强制开关盖在最外层：模拟某段挂掉或恢复正常，用来验证红绿状态
  const svc = list.map((it) => {
    if (it.key === 'db') return { ...it, run: force('db', db.ok) }
    if (it.key === 'shizuku') return { ...it, run: force('adb', Boolean(dev)) }
    if (it.key === 'up') return { ...it, run: force('tls', up) }
    if (it.key === 'dsh') return { ...it, run: force('svc', it.run) }
    return it
  })

  return {
    port,
    at: Date.now(),
    gpu,
    freq,
    mem,
    db,
    services: svc,
    cpu: dev && dev.cpupct !== null ? { pct: dev.cpupct, cores: dev.corepct, loads: dev.loads } : null,
    uptime: dev ? dev.uptime : 0,
    procs: dev ? dev.procs : [],
    adb: Boolean(dev),
  }
}
