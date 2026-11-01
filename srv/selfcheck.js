// 服务自检：调试页一键把链路各段探一遍，逐段给出结果和耗时
// 每段各自卡超时，上游卡住也不会让整页干等

import { connect as tlsconnect } from 'node:tls'
import { writeFile, rm, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import * as logstore from './logstore.js'
import { listmodels, loadtemplate, endpoint } from './upstream.js'
import { forced, describe as forcednote } from './overrides.js'
import { statedir as getstatedir } from './paths.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const tplfile = path.join(here, '..', 'res', 'ocask-body.json')

// 单段最多等这么久，超时按失败算，不让一次自检拖成分把钟
const capms = 6000

// 秒数说成人话：够一小时报时分，够一分报分秒，不够就报秒
function span(sec) {
  const n = Math.max(0, Math.round(sec))
  if (n >= 3600) return `${Math.floor(n / 3600)} 小时 ${Math.floor((n % 3600) / 60)} 分`
  if (n >= 60) return `${Math.floor(n / 60)} 分 ${n % 60} 秒`
  return `${n} 秒`
}

// 字节数换单位，跟前端日志管理那边一样按 1024 进位
function size(n) {
  const units = ['B', 'KB', 'MB', 'GB']
  let v = Number(n) || 0
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

// 到点直接抛，结果由调用方按失败处理
function expire(ms) {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error(`${ms / 1000} 秒内没有响应`)), ms)
    if (timer && typeof timer.unref === 'function') timer.unref()
  })
}

// 只做 DNS + TCP + TLS 握手，不占额度也不受模型可用性影响
function handshake(host) {
  return new Promise((resolve, reject) => {
    let done = false
    let sock = null
    const finish = (err) => {
      if (done) return
      done = true
      if (sock) sock.destroy()
      if (err) reject(err)
      else resolve()
    }
    try {
      sock = tlsconnect({ host, port: 443, servername: host, timeout: 5000 }, () => finish(null))
    } catch (err) {
      finish(err)
      return
    }
    sock.once('timeout', () => finish(new Error('握手超时')))
    sock.once('error', (err) => finish(err))
  })
}

// 每段一个函数：正常返回一句说明，抛错就是这段不通过
function checks(port) {
  return [
    {
      key: 'svc',
      name: 'dsh 服务',
      async detail() {
        return `已运行 ${span(process.uptime())} · 端口 ${port}`
      },
    },
    {
      key: 'db',
      name: 'MariaDB',
      async detail() {
        if (!(await logstore.ping())) throw new Error('连不上，日志只进内存缓冲')
        const info = await logstore.brief()
        return `${info.version || '未知版本'} · 库 ${info.name || '—'} · ${info.tables} 张表 · ${size(info.bytes)}`
      },
    },
    {
      key: 'models',
      name: '上游模型',
      async detail() {
        // 绕过缓存，自检要的是此刻上游真的回得来
        const list = await listmodels(true)
        if (!list.length) throw new Error('上游返回空列表')
        return `${list.length} 个模型可用`
      },
    },
    {
      key: 'tls',
      name: '上游链路',
      async detail() {
        const host = new URL(endpoint).hostname
        await handshake(host)
        return `${host} 握手正常`
      },
    },
    {
      key: 'tpl',
      name: '模板工具',
      async detail() {
        const tpl = await loadtemplate()
        const n = (tpl.tools || []).length
        if (n !== 12) throw new Error(`只读到 ${n} 个工具，门禁要求 12 个`)
        const st = await stat(tplfile)
        return `${n} 个工具 · 模板 ${size(st.size)}`
      },
    },
    {
      key: 'disk',
      name: '状态目录',
      async detail() {
        const dir = getstatedir()
        const probe = path.join(dir, 'probe.tmp')
        await writeFile(probe, String(Date.now()))
        await rm(probe, { force: true })
        return `读写正常 · ${dir}`
      },
    },
  ]
}

// 跑一遍全部检查，失败的段带错误原文返回，前端统一标红
// 调试里的强制开关在这一层生效：强制失败的段直接判失败，强制正常的段跳过真实探测
export async function run(port) {
  const at = Date.now()
  const items = await Promise.all(
    checks(port).map(async (it) => {
      const start = Date.now()
      const force = forced(it.key)
      if (force === 'fail') {
        return { key: it.key, name: it.name, ok: false, ms: 0, detail: '调试强制失败', forced: true }
      }
      if (force === 'ok') {
        return { key: it.key, name: it.name, ok: true, ms: 0, detail: '调试强制正常，未实际探测', forced: true }
      }
      try {
        const detail = await Promise.race([it.detail(), expire(capms)])
        return { key: it.key, name: it.name, ok: true, ms: Date.now() - start, detail }
      } catch (err) {
        const msg = (err && err.message) || String(err)
        return { key: it.key, name: it.name, ok: false, ms: Date.now() - start, detail: msg }
      }
    }),
  )
  return { at, ms: Date.now() - at, ok: items.every((it) => it.ok), forced: forcednote(), items }
}
