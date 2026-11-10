// 自动拉起 MariaDB：代理重启后 3306 没开就自己 spawn 一个 mariadbd-safe
// 拉起来最多等一会儿，超时交给上层降级成只进内存，不把主服务拖死

import { spawn } from 'node:child_process'
import { mkdir, readdir, stat } from 'node:fs/promises'
import { connect } from 'node:net'
import path from 'node:path'
import { datadir as getdatadir, dbconf } from './paths.js'

const prefix = process.env.PREFIX || '/data/data/com.termux/files/usr'

// 同一时间只允许一个拉起流程，多个调用共用同一次等待
let booting = null

// 端口探活：连上就算活着，超时和拒绝都按没起来算
export function probe(host = '127.0.0.1', port = 3306, waitms = 800) {
  return new Promise((resolve) => {
    const sock = connect({ host, port })
    let done = false
    const finish = (ok) => {
      if (done) return
      done = true
      sock.destroy()
      resolve(ok)
    }
    sock.setTimeout(waitms)
    sock.once('connect', () => finish(true))
    sock.once('timeout', () => finish(false))
    sock.once('error', () => finish(false))
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 数据目录算不算已经初始化：有 mysql 子目录并且里面有文件就认
// so: 只看目录存在不够，mariadbd-safe 自己也会建空目录，判成已初始化就永远起不来
async function ready(datadir) {
  try {
    const list = await readdir(path.join(datadir, 'mysql'))
    return list.length > 0
  } catch {
    return false
  }
}

// 首次运行：数据目录是空的就地把系统表装上，省掉「先手动跑一遍初始化」这步
// 不传 --basedir：Termux 的包会把前缀和默认值重复拼一遍，拼出不存在的路径
// root 走 normal 认证，这样默认的空密码配置能直接从 TCP 连进来
// so: 默认认证是 unix_socket，用 TCP 连会报 1698，表现和「密码不对」一样难查
async function install(datadir) {
  const bin = path.join(prefix, 'bin', 'mariadb-install-db')
  try {
    await stat(bin)
  } catch {
    console.error(`[mysql] 找不到 ${bin}，无法建库`)
    return false
  }
  await mkdir(datadir, { recursive: true })
  console.log(`[mysql] 数据目录为空，正在初始化 ${datadir}`)
  const rc = await new Promise((resolve) => {
    const child = spawn(
      bin,
      ['--no-defaults', `--datadir=${datadir}`, '--auth-root-authentication-method=normal', '--skip-test-db'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let err = ''
    child.stderr.on('data', (d) => {
      err += d
    })
    // 正常输出会刷屏，不往外抛，只留失败时的最后几行
    child.stdout.on('data', () => {})
    child.on('error', () => resolve(-1))
    child.on('close', (code) => {
      if (code !== 0) console.error(`[mysql] 初始化失败：${err.trim().split('\n').slice(-3).join(' / ')}`)
      resolve(code === null ? -1 : code)
    })
  })
  if (rc !== 0) return false
  console.log('[mysql] 初始化完成')
  return true
}

async function boot(host, port, waitms) {
  const bin = path.join(prefix, 'bin', 'mariadbd-safe')
  const datadir = getdatadir()
  // 数据目录没初始化过就先装系统表，否则 mariadbd 起来也会立刻退出
  if (!(await ready(datadir))) {
    const ok = await install(datadir)
    if (!ok) {
      console.error(`[mysql] 数据目录不可用：${datadir}`)
      return false
    }
  }
  try {
    // socket 与 pid 都按数据目录分开放
    // so: 默认 socket 是全局固定的 /var/run/mysqld.sock，同机第二个实例会撞车直接 abort
    //     平时只会跑一个实例，但测试与换端口场景会踩到，分开没有代价
    spawn(
      bin,
      [
        `--datadir=${datadir}`,
        `--port=${port}`,
        `--bind-address=${host}`,
        `--socket=${path.join(datadir, 'mysqld.sock')}`,
        `--pid-file=${path.join(datadir, 'mysqld.pid')}`,
      ],
      { detached: true, stdio: 'ignore' },
    ).unref()
  } catch (err) {
    console.error(`[mysql] 拉起失败：${err.message}`)
    return false
  }
  console.log(`[mysql] ${host}:${port} 没开，已拉起 mariadbd-safe，等待就绪`)

  const deadline = Date.now() + waitms
  while (Date.now() < deadline) {
    await sleep(400)
    if (await probe(host, port, 500)) {
      console.log(`[mysql] 已就绪 ${host}:${port}`)
      return true
    }
  }
  console.error(`[mysql] 等待 ${Math.round(waitms / 1000)} 秒仍没起来`)
  return false
}

// 保证库在跑：已在跑直接返回，正在拉就复用它，没拉过才开一次
export async function ensuremysql(cfg = {}) {
  let host = cfg.host
  let port = Number(cfg.port) || 0
  if (!host || !port) {
    // 没传配置时按设置里那套连接参数取主机和端口，端口对不上等于白拉
    const saved = await dbconf()
    host = host || saved.host
    port = port || Number(saved.port)
  }
  host = host || '127.0.0.1'
  port = port || 3306
  if (await probe(host, port)) return true
  // 本机已经有库在别的端口跑着就别再拉一个，同一个数据目录起两份会锁死甚至写坏
  if (port !== 3306 && (host === '127.0.0.1' || host === 'localhost') && (await probe(host, 3306))) {
    console.error(`[mysql] 3306 上已有库在跑，不再按 ${port} 另起一份`)
    return false
  }
  if (!booting) {
    booting = boot(host, port, 30000).finally(() => {
      booting = null
    })
  }
  return booting
}

// 定时探活：库被别人关掉时，这里能自己再拉起来，不依赖有没有新日志进来
export function startwatch(intervalms = 60000) {
  const tick = () => {
    ensuremysql().catch(() => {})
  }
  tick()
  const timer = setInterval(tick, intervalms)
  // 只是看门狗，不该把进程钉住
  if (timer.unref) timer.unref()
  return timer
}
