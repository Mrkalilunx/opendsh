// 出口切换：额度按 (IP, session) 两个维度计数，只换 session 没用
// 同一个 IP 上等多久都不会恢复，必须换到另一个出口才有意义
// 没有代理池时关开一次移动数据，让运营商重新分配 IP
// so: 只在额度 429 且设置里开了自动切换时调用，平时不动网络

import { execFile } from 'node:child_process'
import * as log from './logbus.js'
import { lookup } from './egressip.js'

const AD = 'ad'
// 关数据后压一会儿再开：压太短运营商来不及回收会话，拿回来的还是同一个 IP
// 实测 0.7 秒就够，再长纯属空等
const holdms = 700
// 网络恢复实测在 3 到 5 秒之间，留点余量到 8 秒，再长就是白等
const recoverms = 8000
// 轮询间隔：探测不通时是瞬间返回的，间隔要短才追得上网络刚恢复那一瞬
// 实测 50ms 比 150ms 平均快 0.3 到 0.5 秒，空转成本可以忽略
const pollms = 50
// 单次探测超时：网络没通时要尽快放弃好进下一轮
// 4 秒会让每轮空转都卡满，1.2 秒足够，因为通的时候实测都在 0.7 秒内
const probeipms = 1200

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
// 切换过程中只等几秒，超时压短，免得一个卡住的服务把整轮拖死
async function nowip(timeoutms = probeipms, fast = false) {
  try {
    return await lookup(null, timeoutms, fast)
  } catch {
    return ''
  }
}

// 关开一次移动数据换出口 IP，返回新 IP；换不到就返回空串
// 调用方拿到空串就说明这次没换成功，别当成成功继续重试
// force 为真时跳过冷却：同一个请求内连续换几次是必要的
export async function switchip(force = false) {
  if (busy) return busy
  if (!force && Date.now() - lastat < coolms) return ''
  busy = (async () => {
    try {
      // 读旧 IP 和关开数据互不依赖，一起发出去，省掉一次串行往返
      // 旧 IP 用完整模式多试几个端点，它是比较基准，不能取空
      const beforep = nowip(3000, false)
      // 权限自检、查飞行模式、关数据、压一会儿、开数据，全部塞进一次 ad 调用
      // 每次 ad 往返要 0.4 到 0.7 秒，拆成四五次就是两秒多，纯属白花
      // 飞行模式开着时数据是被强制关掉的，先解开再走关开数据这条路
      // 没权限时脚本会卡到超时，所以先在远程侧判掉，立刻返回
      const script = [
        "if id 2>/dev/null | grep -q 'uid=2000'; then",
        'am=$(cmd connectivity airplane-mode)',
        'case "$am" in *enabled*) cmd connectivity airplane-mode disable; sleep 1;; esac',
        `svc data disable; sleep ${holdms / 1000}; svc data enable`,
        'echo "SWITCHED:$am"',
        'else',
        'echo NOPERM',
        'fi',
      ].join('\n')
      log.info('出口切换：关开一次移动数据换 IP')
      const t0 = Date.now()
      const res = await run(script, 25000)
      // ad 不传退出码，只看输出里的标记
      if (!res.out.includes('SWITCHED:')) {
        if (res.out.includes('NOPERM')) {
          log.warn('出口切换：没有 adb 权限，无法自动换 IP')
        } else {
          log.warn(`出口切换：关开数据失败（${res.err.slice(0, 60) || 'ad 超时'}）`)
        }
        return ''
      }
      const before = await beforep
      // 网络恢复期间高频轮询，拿到新 IP 立刻收手
      // 探测失败是瞬间返回的，必须自己加间隔，否则几百次空转
      // 切换前就读不到 IP 的话（本来就断网），拿到任意地址就算恢复
      // 这里只看地址变没变，不比地址族：CF 那个端点是双栈的
      // Bun 每次走 IPv4 还是 IPv6 不确定，同出口也可能报出另一族
      // 换出口到底成没成，真正的依据是重试后还收不收 429
      while (Date.now() - t0 < recoverms) {
        const now = await nowip(probeipms, true)
        if (now && (!before || now !== before)) {
          lastat = Date.now()
          log.info(`出口切换：${before || '未知'} → ${now}，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
          return now
        }
        await new Promise((r) => setTimeout(r, pollms))
      }
      log.warn(`出口切换：${recoverms / 1000} 秒内没拿到新 IP，放弃`)
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