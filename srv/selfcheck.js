// 服务自检：调试页一键把链路各段探一遍，逐段给出结果和耗时
// 每段各自卡超时，上游卡住也不会让整页干等

import { connect as tlsconnect } from 'node:tls'
import { writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import * as logstore from './logstore.js'
import { listmodels, basetools, envblock, enforcegate, endpoint } from './upstream.js'
import { forced, describe as forcednote } from './overrides.js'
import { statedir as getstatedir } from './paths.js'

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
      name: '出站门禁',
      async detail() {
        // 自检要验的是此刻真发出去的东西，直接按出站那套现算，不再读模板文件
        // 凭据不带 type 字段，客户端没带 read 时才补，客户端自带就一个字不加
        const one = basetools()
        if (one.length !== 1) throw new Error(`应为 1 个工具，实际 ${one.length} 个`)
        if (!one[0].function || one[0].function.name !== 'read') throw new Error('工具名不是 read')
        if (one[0].type) throw new Error('凭据不该带 type 字段，带了模型会当成可用工具')
        const env = envblock()
        if (!/Working directory:/.test(env) || !/Platform:/.test(env)) throw new Error('env 块字段不全')
        const { body, fixed } = enforcegate({
          messages: [{ role: 'system', content: env }, { role: 'user', content: 'probe' }],
          tools: [],
          stream: false,
        })
        const names = (body.tools || []).map((t) => (t.function || {}).name)
        if (!names.includes('read')) throw new Error('零工具时没补上 read 凭据')
        // 客户端自己带了 read 时不能再补一份，否则同名两条会打架
        const own = enforcegate({
          messages: [{ role: 'system', content: env }, { role: 'user', content: 'probe' }],
          tools: [{ type: 'function', function: { name: 'read', description: '客户端自带的' } }],
          stream: true,
        })
        const ownnames = (own.body.tools || []).map((t) => (t.function || {}).name)
        if (ownnames.filter((n) => n === 'read').length !== 1) throw new Error('客户端自带 read 时不该再补一份')
        // 标题生成形态：system 里写着绝不使用工具，凭据又必须带，两者并存上游回 429
        // 这条回归点曾经在重构里被整段删掉，线上表现为标题生成全部失败
        const ttl = enforcegate({
          messages: [
            { role: 'system', content: env },
            { role: 'system', content: 'You are a title generator.\n<rules>\n- Never use tools\n</rules>' },
            { role: 'user', content: 'probe' },
          ],
          tools: [],
          stream: true,
        })
        const kept = ttl.body.messages[1].content
        if (/never\s+use\s+tools/i.test(kept)) throw new Error('标题生成的冲突句没被剔除，会导致 429')
        if (!/title generator/.test(kept)) throw new Error('剔除冲突句时误删了其余内容')
        // 客户端把自己的 env 和标题提示词放在同一条 system 里时，那条就是第 0 条
        // 早期实现从第 1 条开始扫，正好漏掉这种最常见的形态
        const inline = enforcegate({
          messages: [
            { role: 'system', content: `${env}\nYou are a title generator.\n<rules>\n- Never use tools\n</rules>` },
            { role: 'user', content: 'probe' },
          ],
          tools: [],
          stream: true,
        })
        if (/never\s+use\s+tools/i.test(inline.body.messages[0].content)) {
          throw new Error('env 与标题提示词同条时没剔除冲突句')
        }
        if (body.stream !== true) throw new Error('stream 没被改真')
        return `env 块 + read 凭据 · 零工具自检补 ${fixed.length} 项 · ${env.length} 字`
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
