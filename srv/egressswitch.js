// 出口切换：额度按 (IP, session) 两个维度计数，只换 session 没用
// 同一个 IP 上等多久都不会恢复，必须换到另一个出口才有意义
// 没有代理池时关开一次移动数据，让运营商重新分配 IP
// so: 只在额度 429 且设置里开了自动切换时调用，平时不动网络

import { execFile } from 'node:child_process'
import * as log from './logbus.js'
import { lookup } from './egressip.js'

const AD = 'ad'
// 数据关掉后网络要重新注册，等它拿到地址再往下走
const regwait = [1500, 2500, 3500, 5000, 7000, 9000]
// 关数据后压住几秒：关得太快运营商来不及回收会话，拿回来的还是同一个 IP
const holdms = 5000

function run(script, timeout = 20000) {
  return new Promise((resolve) => {
    execFile(AD, ['-c', script], { timeout }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || err?.message || '') })
    })
  })
}

let busy = null
let lastat = 0
// 同一批请求里连续切几次是正常的：每次换完仍可能撞上限额
// 冷却只挡不同请求之间的重复切换，避免多个并发请求一起折腾网络
const coolms = 60000

// 读当前出口 IP，拿不到就返回空串
async function nowip() {
  try {
    return await lookup()
  } catch {
    return ''
  }
}

// 能不能自动换 IP：ad 通不通决定，问一次要一秒多，缓存一会儿
let probedat = 0
let probeok = false
const probems = 30000

export async function available() {
  if (Date.now() - probedat < probems) return probeok
  const res = await run('id', 8000)
  probedat = Date.now()
  probeok = res.ok && res.out.includes('uid=2000')
  if (!probeok) log.warn(`出口切换：ad 不可用，无法自动换 IP（${res.err.slice(0, 60) || '没有 adb 权限'}）`)
  return probeok
}

// 关开一次移动数据换出口 IP，返回新 IP；换不到就返回空串
// 调用方拿到空串就说明这次没换成功，别当成成功继续重试
// force 为真时跳过冷却：同一个请求内连续换几次是必要的
export async function switchip(force = false) {
  if (busy) return busy
  if (!force && Date.now() - lastat < coolms) return ''
  busy = (async () => {
    try {
      if (!(await available())) return ''
      const before = await nowip()
      // 飞行模式开着的时候数据是被强制关掉的，先解开再走关开数据这条路
      const state = await run('cmd connectivity airplane-mode')
      if (/enabled/.test(state.out) && !/disabled/.test(state.out)) {
        log.warn('出口切换：设备在飞行模式，先关掉再继续')
        await run('cmd connectivity airplane-mode disable')
        await new Promise((r) => setTimeout(r, holdms))
      }
      log.info('出口切换：关开一次移动数据换 IP')
      await run('svc data disable')
      await new Promise((r) => setTimeout(r, holdms))
      await run('svc data enable')
      // 等网络恢复，期间反复探 IP，变了就收手
      for (const wait of regwait) {
        await new Promise((r) => setTimeout(r, wait))
        const now = await nowip()
        if (!now) continue
        if (now === before) {
          log.warn(`出口切换：IP 仍是 ${now}，运营商没有重新分配`)
          return ''
        }
        lastat = Date.now()
        log.info(`出口切换：${before || '未知'} → ${now}`)
        return now
      }
      log.warn('出口切换：等不到网络恢复')
      return ''
    } catch (err) {
      log.warn(`出口切换失败：${(err && err.message) || err}`)
      return ''
    } finally {
      busy = null
    }
  })()
  return busy
}

// 管理页用：能不能切、上次什么时候切的
export function status() {
  return { busy: Boolean(busy), lastat, coolms }
}