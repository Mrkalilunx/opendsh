// 出口切换：额度按 (IP, session) 两个维度计数，只换 session 没用
// 同一个 IP 上等多久都不会恢复，必须换到另一个出口才有意义
// 没有代理池时用 ad 开关一次飞行模式，让运营商重新分配 IP
// so: 只在额度 429 时调用，平时不动网络，免得打断正在跑的请求

import { execFile } from 'node:child_process'
import * as log from './logbus.js'
import { lookup } from './egressip.js'

const AD = 'ad'
// 飞行模式关掉后网络要重新注册，等它拿到地址再往下走
const regwait = [1500, 2500, 3500, 5000, 7000, 9000]

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

// 开关一次飞行模式换出口 IP，返回新 IP；换不到就返回空串
// 调用方拿到空串就说明这次没换成功，别当成成功继续重试
// force 为真时跳过冷却：同一个请求内连续换几次是必要的
export async function switchip(force = false) {
  if (busy) return busy
  if (!force && Date.now() - lastat < coolms) return ''
  busy = (async () => {
    try {
      const before = await nowip()
      const state = await run('cmd connectivity airplane-mode')
      // 本来就在飞行模式就别再去开，开了也没法关
      if (/enabled/.test(state.out) && !/disabled/.test(state.out)) {
        log.warn('出口切换：设备已在飞行模式，先关掉再继续')
        await run('svc wifi disable 2>/dev/null; svc data enable 2>/dev/null')
        return ''
      }
      log.info('出口切换：开关一次飞行模式换 IP')
      await run('cmd connectivity airplane-mode enable')
      // 关得太快运营商可能来不及重新分配，压住几秒
      await new Promise((r) => setTimeout(r, 5000))
      await run('cmd connectivity airplane-mode disable')
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