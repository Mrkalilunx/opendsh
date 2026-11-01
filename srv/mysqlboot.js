// 自动拉起 MariaDB：代理重启后 3306 没开就自己 spawn 一个 mariadbd-safe
// 拉起来最多等一会儿，超时交给上层降级成只进内存，不把主服务拖死

import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
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

async function boot(host, port, waitms) {
  const bin = path.join(prefix, 'bin', 'mariadbd-safe')
  const datadir = getdatadir()
  // 数据目录不存在就没法起库，提前说清楚，免得干等三十秒
  try {
    await stat(datadir)
  } catch {
    console.error(`[mysql] 数据目录不存在：${datadir}`)
    return false
  }
  try {
    spawn(bin, [`--datadir=${datadir}`, `--port=${port}`, `--bind-address=${host}`], {
      detached: true,
      stdio: 'ignore',
    }).unref()
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
