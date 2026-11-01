#!/usr/bin/env bun
// 开发服务器：静态文件 + 轮询热重载 + OpenAI 兼容代理，全部在 Bun 上跑
// 启动：bun serve.js        默认 http://127.0.0.1:25715

import http from 'node:http'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as chat from './srv/chatproxy.js'
import { listmodels } from './srv/upstream.js'
import { loadproxies, nextproxy, resetpool, setsids, addsid, snapshot as sessionsnapshot } from './srv/sessions.js'
import { lookup as lookupip } from './srv/egressip.js'
import { createkey, deletekey, listkeys, loadkeys } from './srv/apikey.js'
import {
  createpersona, deletepersona, listpersonas, loadpersonas, selectpersona, updatepersona,
} from './srv/personas.js'
import {
  createmap, deletemap, listmap, loadmodelmap, updatemap,
} from './srv/modelmap.js'
import * as log from './srv/logbus.js'
import * as store from './srv/logstore.js'
import * as reqstore from './srv/reqstore.js'
import * as sysmon from './srv/sysmon.js'
import * as selfcheck from './srv/selfcheck.js'
import * as procmon from './srv/procmon.js'
import * as apilist from './srv/apilist.js'
import * as usagestat from './srv/usagestat.js'
import { tokens } from './srv/overrides.js'
import { statedir as getstatedir, dataroot as getdataroot, datadir as getdatadir, expand } from './srv/paths.js'
import { pick } from './srv/entries.js'
import { startwatch } from './srv/mysqlboot.js'
import {
  defaults, describe, getsettings, loadsettings, resetsettings, schema, updatesettings,
} from './srv/settings.js'

const root = path.dirname(fileURLToPath(import.meta.url))
const port = Number(process.env.port || process.env.PORT || 25715)
const host = process.env.host || '0.0.0.0'

// 热重载监听范围，够用且不会被大文件拖慢
const watchdirs = ['.', 'css', 'js', 'js/modules', 'res', 'srv']
const ignored = /(^|\/)(\.|node_modules)/

const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
}

const livejs = `(() => {
  const emit = (online, text) => {
    // 这个脚本先于模块执行，事件可能比监听器早到，留一份状态给页面补读
    window.__live = { online, text }
    document.dispatchEvent(new CustomEvent('live:state', { detail: { online, text } }))
  }
  let es
  const connect = () => {
    es = new EventSource('/__events')
    es.addEventListener('open', () => emit(true, '热重载已连接'))
    es.addEventListener('error', () => emit(false, '热重载断开，正在重连…'))
    es.addEventListener('message', (ev) => {
      let data = {}
      try { data = JSON.parse(ev.data) } catch { return }
      if (data.kind !== 'reload') return
      const changed = (data.path || '').replace(/\\\\/g, '/')
      if (changed.endsWith('.css')) {
        let hit = false
        document.querySelectorAll('link[rel="stylesheet"]').forEach((link) => {
          const url = new URL(link.href)
          if (!url.pathname.endsWith('/' + changed.replace(/^\\/+/, ''))) return
          url.searchParams.set('t', Date.now())
          link.href = url.toString()
          hit = true
        })
        if (hit) { emit(true, '样式已热替换 · ' + changed); return }
      }
      location.reload()
    })
  }
  connect()
  window.addEventListener('beforeunload', () => es && es.close())
})()
`

const clients = new Set()

function head(res, code, extra) {
  res.writeHead(code, Object.assign({
    'cache-control': 'no-store',
    'x-reload': '1',
  }, extra))
}

function text(res, code, type, body) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body)
  head(res, code, { 'content-type': type, 'content-length': buf.length })
  res.end(buf)
}

function inject(html) {
  const tag = '<script src="/__live.js"></script>'
  if (html.includes(tag)) return html
  const i = html.lastIndexOf('</body>')
  return i === -1 ? html + tag : html.slice(0, i) + tag + '\n' + html.slice(i)
}

// ---- 静态与代理分发

async function route(req, res) {
  const url = new URL(req.url, 'http://localhost')
  const p = decodeURIComponent(url.pathname)

  if (p === '/__events') return events(req, res)
  if (p === '/__live.js') return text(res, 200, types['.js'], livejs)
  if (p === '/__logs') return logsroute(req, res, url)
  if (p === '/__logs/seed') return seedroute(req, res, url)
  if (p === '/__logs/stream') return logstream(req, res)
  if (p === '/__requests') return requestsroute(req, res, url)
  if (p === '/__requests/stream') return reqstream(req, res)
  if (p === '/__sys') return sysroute(req, res)
  if (p === '/__selfcheck') return checkroute(req, res)
  if (p === '/__proc') return procroute(req, res, url)
  if (p === '/__settings') return settingsroute(req, res)
  if (p === '/__usage') return usageroute(req, res, url)
  if (p === '/__sessions') return sessionsroute(req, res)
  if (p === '/__ip') return iproute(req, res, url)
  if (p === '/__keys') return keysroute(req, res)
  if (p === '/__personas') return personasroute(req, res)
  if (p === '/__modelmap') return maproute(req, res)

  // OpenAI 兼容端点：先认入口前缀，/raw/v1 走直通，剥掉前缀后按 /v1 处理
  const hit = pick(p)
  if (hit) {
    if (hit.entry.id === 'raw' && !getsettings().rawentry) return text(res, 404, types['.txt'], '404 not found')
    const clean = new URL(url.href)
    clean.pathname = hit.rest
    req.__entry = hit.entry.label
    req.__mute = hit.entry.mute
    req.__path = p
    return chat.handle(req, res, clean)
  }

  let file = p === '/' ? '/index.html' : p
  if (file === '/res/ocask-body.json' || file === '/res/proxies.txt') {
    return text(res, 403, types['.txt'], '403 forbidden')
  }
  // 隐藏目录一律不对外，用来放状态文件
  if (file.split('/').some((seg) => seg.startsWith('.'))) {
    return text(res, 404, types['.txt'], '404 not found')
  }

  const target = path.join(root, file)
  if (!target.startsWith(root + path.sep)) return text(res, 403, types['.txt'], '403 forbidden')

  let abs = target
  try {
    const st = await fsp.stat(abs)
    if (st.isDirectory()) abs = path.join(abs, 'index.html')
  } catch {
    return text(res, 404, types['.txt'], `404 not found: ${file}`)
  }

  let data
  try {
    data = await fsp.readFile(abs)
  } catch {
    return text(res, 404, types['.txt'], `404 not found: ${file}`)
  }

  const ext = path.extname(abs).toLowerCase()
  const type = types[ext] || 'application/octet-stream'
  if (ext === '.html') return text(res, 200, type, inject(data.toString('utf8')))

  head(res, 200, { 'content-type': type, 'content-length': data.length })
  res.end(req.method === 'HEAD' ? undefined : data)
}

function events(req, res) {
  head(res, 200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  res.write('retry: 1000\n\n')
  clients.add(res)
  req.on('close', () => clients.delete(res))
}

function broadcast(file) {
  const payload = `data: ${JSON.stringify({ kind: 'reload', path: file })}\n\n`
  for (const res of clients) {
    try {
      res.write(payload)
    } catch {
      clients.delete(res)
    }
  }
}

// ---- 设置与日志接口

async function readbody(req) {
  const parts = []
  for await (const part of req) parts.push(part)
  return Buffer.concat(parts).toString('utf8')
}

async function settingsroute(req, res) {
  if (req.method === 'GET') {
    return text(res, 200, types['.json'], JSON.stringify({
      settings: masked(getsettings()),
      schema: schema(),
      defaults: defaults(),
      fakes: tokens.map((it) => ({ ...it })),
      paths: await pathinfo(),
    }))
  }
  if (req.method !== 'POST') return text(res, 405, types['.txt'], '405 method not allowed')

  let doc
  try {
    doc = JSON.parse(await readbody(req))
  } catch {
    return text(res, 400, types['.json'], JSON.stringify({ error: '请求体不是合法 JSON' }))
  }

  try {
    const reset = Boolean(doc && doc.reset)
    const before = getsettings()
    // 目录填错就别存，存下去之后每次写状态文件都会失败
    // 只在真的改了目录时才探，改别的设置不必每次都建目录
    if (!reset && typeof doc.statedir === 'string') {
      const want = doc.statedir.trim() ? expand(doc.statedir) : getdataroot()
      if (want !== getstatedir() && !(await writable(want))) {
        return text(res, 400, types['.json'], JSON.stringify({ error: `目录写不进去：${want}` }))
      }
    }
    const next = reset ? await resetsettings() : await updatesettings(doc)
    if (reset) log.info('设置已恢复默认')
    else log.info(`设置已保存：${describe(next)}`)
    resetpool()
    // 库地址变了就把旧连接丢掉，下次写入按新参数重连
    if (dbmoved(before, next)) {
      store.drop()
      log.info('数据库地址已改，等待按新参数重连')
    }
    if (before.statedir !== next.statedir) {
      // 目录换了，内存里那份还是老目录读的，重新读一遍免得写回旧数据
      // 新目录写不进去就别重读，否则内存里那份会被清空，接着一存就把老数据覆盖掉
      if (await writable(getstatedir())) {
        await Promise.all([loadkeys(), loadpersonas(), loadmodelmap()])
        log.info(`状态目录改为 ${next.statedir || '默认'}`)
      } else {
        log.error(`状态目录 ${getstatedir()} 写不进去，仍用原来的数据`)
      }
    }
    if (before.dbdatadir !== next.dbdatadir) {
      log.info(`MariaDB 数据目录改为 ${next.dbdatadir || '默认'}，重启数据库后生效`)
    }
    return text(res, 200, types['.json'], JSON.stringify({ settings: masked(next), paths: await pathinfo() }))
  } catch (err) {
    return text(res, 400, types['.json'], JSON.stringify({ error: err.message }))
  }
}

// 用量页：按天、按模型、按来源汇总 token
async function usageroute(req, res, url) {
  if (req.method !== 'GET') return text(res, 405, types['.txt'], '405 method not allowed')
  try {
    const doc = await usagestat.summary({ days: url.searchParams.get('days') })
    return text(res, 200, types['.json'], JSON.stringify(doc))
  } catch (err) {
    return text(res, 503, types['.json'], JSON.stringify({ error: err.message }))
  }
}

// 对外回的设置把库密码抹掉，页面不需要看见原文，留空就表示不改
function masked(settings) {
  return { ...settings, dbpass: '' }
}

// 连接相关的那几项有一项变了就算库搬了
function dbmoved(before, next) {
  return ['dbhost', 'dbport', 'dbuser', 'dbpass', 'dbname'].some((key) => before[key] !== next[key])
}

// 设置页展示用：当前生效的数据目录和库连接，脱敏掉密码
async function pathinfo() {
  const conf = await store.target()
  const dir = getstatedir()
  const data = getdatadir()
  const root = getdataroot()
  return {
    root,
    statedir: dir,
    statedirdefault: root,
    statedirready: await writable(dir),
    datadir: data,
    datadefault: path.join(root, 'mysql'),
    datadirready: await writable(data, false),
    db: {
      host: (conf && conf.host) || '',
      port: Number(conf && conf.port) || 0,
      user: (conf && conf.user) || '',
      database: (conf && conf.database) || '',
      masked: conf && conf.password ? '******' : '',
    },
  }
}

// 目录能不能用：状态目录不存在就顺手建，再真写一个探针
// 数据库数据目录只做只读探测，不往库目录里乱写东西
async function writable(dir, create = true) {
  try {
    if (create) {
      const probe = path.join(dir, '.probe')
      await fsp.mkdir(dir, { recursive: true })
      await fsp.writeFile(probe, '1')
      await fsp.rm(probe, { force: true })
      return true
    }
    const st = await fsp.stat(dir)
    if (!st.isDirectory()) return false
    await fsp.access(dir, fs.constants.W_OK | fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

// 调试用：往指定日期灌 n 条示例日志，不传 day 就灌今天
function seedroute(req, res, url) {
  const n = Number(url.searchParams.get('n') || 100)
  const day = url.searchParams.get('day') || ''
  return log
    .seed(n, day)
    .then((stat) => text(res, 200, types['.json'], JSON.stringify(stat)))
    .catch((err) => text(res, 503, types['.json'], JSON.stringify({ error: err.message })))
}

async function logsroute(req, res, url) {
  const day = url.searchParams.get('day')
  if (req.method === 'DELETE') {
    // 传 day 只清那一天，不传才整表清
    // 只动运行日志，请求记录在设置页有自己的一块，互不牵连
    try {
      await store.clear(day)
    } catch (err) {
      return text(res, 503, types['.json'], JSON.stringify({ error: err.message }))
    }
    // 只有整表清空才连带清内存缓冲，清某一天不该影响正在推送的今天
    if (!day) log.clearlog()
    return text(res, 200, types['.json'], JSON.stringify({ logs: [], day }))
  }
  if (url.searchParams.get('stat')) {
    try {
      return text(res, 200, types['.json'], JSON.stringify(await store.stat()))
    } catch (err) {
      return text(res, 503, types['.json'], JSON.stringify({ error: err.message }))
    }
  }
  if (url.searchParams.get('days')) {
    try {
      return text(res, 200, types['.json'], JSON.stringify({ days: await store.days(url.searchParams.get('days')) }))
    } catch (err) {
      return text(res, 503, types['.json'], JSON.stringify({ error: err.message }))
    }
  }
  try {
    const page = await store.query({
      day,
      level: url.searchParams.get('level') || '',
      q: url.searchParams.get('q') || '',
      limit: url.searchParams.get('limit'),
      offset: url.searchParams.get('offset'),
    })
    return text(res, 200, types['.json'], JSON.stringify(page))
  } catch (err) {
    // 库挂了退回内存缓冲，日志页至少还能看今天
    const limit = Number(url.searchParams.get('limit') || 200)
    return text(res, 200, types['.json'], JSON.stringify({
      logs: log.recent(limit),
      total: log.total(),
      fallback: err.message,
    }))
  }
}

// 主页系统监控：端口、GPU、CPU、内存、进程、服务状态
async function sysroute(req, res) {
  try {
    const doc = await sysmon.snapshot(port)
    // 接口清单跟着设置走，合进监控快照里，设置一改下一轮轮询就跟着变色
    doc.apis = apilist.list()
    return text(res, 200, types['.json'], JSON.stringify(doc))
  } catch (err) {
    return text(res, 503, types['.json'], JSON.stringify({ error: err.message }))
  }
}

// 调试页的服务自检：一次把服务、库、上游、模板、状态目录全探一遍
async function checkroute(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return text(res, 405, types['.txt'], '405 method not allowed')
  try {
    return text(res, 200, types['.json'], JSON.stringify(await selfcheck.run(port)))
  } catch (err) {
    return text(res, 503, types['.json'], JSON.stringify({ error: err.message }))
  }
}

// 日志页的进程分栏：GET 列表或单条详情，POST 结束指定 pid
async function procroute(req, res, url) {
  if (req.method === 'GET') {
    const pid = url.searchParams.get('pid')
    try {
      if (pid) {
        const one = await procmon.detail(pid)
        return text(res, 200, types['.json'], JSON.stringify(one))
      }
      return text(res, 200, types['.json'], JSON.stringify(await procmon.list()))
    } catch (err) {
      return text(res, 404, types['.json'], JSON.stringify({ error: err.message }))
    }
  }
  if (req.method !== 'POST') return text(res, 405, types['.txt'], '405 method not allowed')

  let doc
  try {
    doc = JSON.parse(await readbody(req))
  } catch {
    return text(res, 400, types['.json'], JSON.stringify({ error: '请求体不是合法 JSON' }))
  }
  try {
    const done = await procmon.kill(doc && doc.pid)
    log.info(`已结束进程 ${done.name} (${done.pid})，${done.how}`)
    return text(res, 200, types['.json'], JSON.stringify(done))
  } catch (err) {
    return text(res, 400, types['.json'], JSON.stringify({ error: err.message }))
  }
}

// 代理请求记录：列表只给摘要，正文按 id 单独取，删哪天和日志一起走
async function requestsroute(req, res, url) {
  if (req.method === 'DELETE') {
    const id = url.searchParams.get('id')
    try {
      if (id) await reqstore.remove(id)
      else await reqstore.clear(url.searchParams.get('day'))
    } catch (err) {
      return text(res, 503, types['.json'], JSON.stringify({ error: err.message }))
    }
    return text(res, 200, types['.json'], JSON.stringify({ ok: true }))
  }
  const id = url.searchParams.get('id')
  if (id) {
    try {
      return text(res, 200, types['.json'], JSON.stringify(await reqstore.detail(id)))
    } catch (err) {
      return text(res, 404, types['.json'], JSON.stringify({ error: err.message }))
    }
  }
  if (url.searchParams.get('stat')) {
    try {
      return text(res, 200, types['.json'], JSON.stringify(await reqstore.stat()))
    } catch (err) {
      return text(res, 503, types['.json'], JSON.stringify({ error: err.message }))
    }
  }
  if (url.searchParams.get('days')) {
    try {
      return text(res, 200, types['.json'], JSON.stringify({ days: await reqstore.days(url.searchParams.get('days')) }))
    } catch (err) {
      return text(res, 503, types['.json'], JSON.stringify({ error: err.message }))
    }
  }
  try {
    const page = await reqstore.query({
      day: url.searchParams.get('day'),
      limit: url.searchParams.get('limit'),
      offset: url.searchParams.get('offset'),
      source: url.searchParams.get('source'),
    })
    return text(res, 200, types['.json'], JSON.stringify(page))
  } catch (err) {
    return text(res, 200, types['.json'], JSON.stringify({ day: url.searchParams.get('day'), total: 0, list: [], fallback: err.message }))
  }
}

function reqstream(req, res) {
  head(res, 200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  res.write('retry: 1000\n\n')
  const off = reqstore.onreq((item) => {
    try {
      res.write(`data: ${JSON.stringify(item)}\n\n`)
    } catch {
      // 连接已断，close 回调会清理
    }
  })
  const beat = setInterval(() => {
    try {
      res.write(': ping\n\n')
    } catch {
      // 写失败说明连接没了，等 close 清理
    }
  }, 15000)
  req.on('close', () => {
    clearInterval(beat)
    off()
  })
}

function logstream(req, res) {
  head(res, 200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  res.write('retry: 1000\n\n')
  const off = log.subscribe((item) => {
    try {
      res.write(`data: ${JSON.stringify(item)}\n\n`)
    } catch {
      // 连接已断，close 回调会清理
    }
  })
  const beat = setInterval(() => {
    try {
      res.write(': ping\n\n')
    } catch {
      // 写失败说明连接没了，等 close 清理
    }
  }, 15000)
  req.on('close', () => {
    clearInterval(beat)
    off()
  })
}

async function sessionsroute(req, res) {
  if (req.method === 'GET') {
    return text(res, 200, types['.json'], JSON.stringify({
      ...sessionsnapshot(),
      poolsize: getsettings().sessionpool,
    }))
  }
  if (req.method !== 'POST') return text(res, 405, types['.txt'], '405 method not allowed')

  let doc
  try {
    doc = JSON.parse(await readbody(req))
  } catch {
    return text(res, 400, types['.json'], JSON.stringify({ error: '请求体不是合法 JSON' }))
  }

  try {
    if (doc && doc.action === 'append') {
      const next = addsid()
      log.info(`session 已追加一个：${next.size} 个`)
      return text(res, 200, types['.json'], JSON.stringify(next))
    }
    if (doc && Array.isArray(doc.ids)) {
      const next = setsids(doc.ids)
      log.info(`session 列表已替换：${next.size} 个`)
      return text(res, 200, types['.json'], JSON.stringify(next))
    }
    resetpool()
    const next = sessionsnapshot()
    log.info(`session 池已重新生成：${next.size} 个`)
    return text(res, 200, types['.json'], JSON.stringify(next))
  } catch (err) {
    return text(res, 400, types['.json'], JSON.stringify({ error: err.message }))
  }
}

async function iproute(req, res, url) {
  const wantproxy = url.searchParams.get('proxy') === '1'
  const proxy = wantproxy && getsettings().proxypool ? nextproxy() : null
  try {
    const ip = await lookupip(proxy)
    log.info(`出口 IP ${ip}（${proxy ? '代理 ' + proxy : '直连'}）`)
    return text(res, 200, types['.json'], JSON.stringify({ ip, via: proxy || 'direct', at: Date.now() }))
  } catch (err) {
    log.warn(`出口 IP 查询失败：${err.message}`)
    return text(res, 502, types['.json'], JSON.stringify({ error: `查询失败：${err.message}` }))
  }
}

async function keysroute(req, res) {
  if (req.method === 'GET') {
    return text(res, 200, types['.json'], JSON.stringify({
      keys: listkeys(),
      auth: getsettings().keyauth,
    }))
  }
  if (req.method !== 'POST') return text(res, 405, types['.txt'], '405 method not allowed')

  let doc
  try {
    doc = JSON.parse(await readbody(req))
  } catch {
    return text(res, 400, types['.json'], JSON.stringify({ error: '请求体不是合法 JSON' }))
  }

  try {
    if (doc && doc.action === 'create') {
      const item = await createkey(doc.note)
      log.info(`已生成 API key ${item.id}`)
      return text(res, 200, types['.json'], JSON.stringify({ keys: listkeys(), created: item }))
    }
    if (doc && doc.action === 'delete') {
      await deletekey(doc.id)
      log.info(`已删除 API key ${doc.id}`)
      return text(res, 200, types['.json'], JSON.stringify({ keys: listkeys() }))
    }
    return text(res, 400, types['.json'], JSON.stringify({ error: 'action 只能是 create 或 delete' }))
  } catch (err) {
    return text(res, 400, types['.json'], JSON.stringify({ error: err.message }))
  }
}

async function personasroute(req, res) {
  if (req.method === 'GET') {
    return text(res, 200, types['.json'], JSON.stringify(listpersonas()))
  }
  if (req.method !== 'POST') return text(res, 405, types['.txt'], '405 method not allowed')

  let doc
  try {
    doc = JSON.parse(await readbody(req))
  } catch {
    return text(res, 400, types['.json'], JSON.stringify({ error: '请求体不是合法 JSON' }))
  }

  const action = String((doc && doc.action) || '')
  try {
    if (action === 'create') {
      const item = await createpersona(doc.text)
      log.info(`已新增人设 ${item.id}`)
      return text(res, 200, types['.json'], JSON.stringify({ ...listpersonas(), item }))
    }
    if (action === 'update') {
      const item = await updatepersona(doc.id, doc.text)
      log.info(`已修改人设 ${item.id}`)
      return text(res, 200, types['.json'], JSON.stringify({ ...listpersonas(), item }))
    }
    if (action === 'delete') {
      await deletepersona(doc.id)
      log.info(`已删除人设 ${doc.id}`)
      return text(res, 200, types['.json'], JSON.stringify(listpersonas()))
    }
    if (action === 'select') {
      return text(res, 200, types['.json'], JSON.stringify(await selectpersona(doc.id)))
    }
    return text(res, 400, types['.json'], JSON.stringify({ error: 'action 只能是 create / update / delete / select' }))
  } catch (err) {
    return text(res, 400, types['.json'], JSON.stringify({ error: err.message }))
  }
}

async function maproute(req, res) {
  if (req.method === 'GET') {
    return text(res, 200, types['.json'], JSON.stringify(listmap()))
  }
  if (req.method !== 'POST') return text(res, 405, types['.txt'], '405 method not allowed')

  let doc
  try {
    doc = JSON.parse(await readbody(req))
  } catch {
    return text(res, 400, types['.json'], JSON.stringify({ error: '请求体不是合法 JSON' }))
  }

  const action = String((doc && doc.action) || '')
  try {
    if (action === 'create') {
      const item = await createmap(doc.from, doc.to)
      log.info(`已新增模型映射 ${item.from} → ${item.to}`)
      return text(res, 200, types['.json'], JSON.stringify({ ...listmap(), item }))
    }
    if (action === 'update') {
      const item = await updatemap(doc.from, doc.nextfrom, doc.to)
      log.info(`已修改模型映射 ${item.from} → ${item.to}`)
      return text(res, 200, types['.json'], JSON.stringify({ ...listmap(), item }))
    }
    if (action === 'delete') {
      await deletemap(doc.from)
      log.info(`已删除模型映射 ${doc.from}`)
      return text(res, 200, types['.json'], JSON.stringify(listmap()))
    }
    return text(res, 400, types['.json'], JSON.stringify({ error: 'action 只能是 create / update / delete' }))
  } catch (err) {
    return text(res, 400, types['.json'], JSON.stringify({ error: err.message }))
  }
}

// ---- 轮询监听：Bun 递归 watch 在部分平台不可靠，自己扫 mtime 更稳

const snapshot = new Map()

async function scan() {
  const next = new Map()
  for (const dir of watchdirs) {
    const abs = path.join(root, dir)
    let items
    try {
      items = await fsp.readdir(abs, { withFileTypes: true })
    } catch {
      continue
    }
    for (const it of items) {
      if (!it.isFile()) continue
      const rel = dir === '.' ? it.name : `${dir}/${it.name}`
      if (ignored.test(rel)) continue
      try {
        const st = await fsp.stat(path.join(abs, it.name))
        next.set(rel, `${st.mtimeMs}:${st.size}`)
      } catch {
        // 文件刚被删，忽略
      }
    }
  }
  return next
}

async function poll() {
  const next = await scan()
  if (snapshot.size) {
    for (const [file, sig] of next) {
      if (snapshot.get(file) !== sig) {
        log.info(`reload ${file}`)
        broadcast(file)
        break
      }
    }
    for (const file of snapshot.keys()) {
      if (!next.has(file)) {
        log.info(`reload 删除 ${file}`)
        broadcast(file)
        break
      }
    }
  }
  snapshot.clear()
  for (const [k, v] of next) snapshot.set(k, v)
  setTimeout(poll, 400)
}

// ---- 启动

const server = http.createServer((req, res) => {
  route(req, res).catch((err) => {
    log.error(err && err.stack ? err.stack : String(err))
    if (!res.headersSent) text(res, 500, types['.txt'], '500 internal error')
    else res.end()
  })
})

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') log.error(`端口 ${port} 被占用，先停掉占着它的进程再启动`)
  else log.error(err && err.stack ? err.stack : String(err))
  process.exit(1)
})

server.listen(port, host, async () => {
  await loadsettings()
  await loadkeys()
  await loadpersonas()
  await loadmodelmap()

  log.info(`serve http://127.0.0.1:${port}`)
  log.info(`root ${root}`)
  log.info(`proxy http://127.0.0.1:${port}/v1（OpenAI 兼容）`)
  log.info(`设置 ${describe(getsettings())}`)

  // 数据库不再靠手动开：启动时就拉一次，之后每分钟探活
  startwatch()

  const env = (process.env.OCASK_PROXIES || '').split(/[\s,]+/).filter(Boolean)
  try {
    const file = await fsp.readFile(path.join(root, 'res', 'proxies.txt'), 'utf8')
    env.push(...file.split('\n'))
  } catch {
    // 没有代理文件就用直连
  }
  loadproxies(env)
  if (!env.length) log.warn('出口直连（额度耗尽需换 IP 才能继续）')

  try {
    const list = await listmodels()
    chat.setmodels(list.map((m) => m.id))
    log.info(`模型 ${list.length} 个，默认 ${getsettings().defaultmodel}`)
  } catch (err) {
    log.warn(`模型拉取失败，模型名不做校验：${err.message}`)
  }

  await scan()
  setTimeout(poll, 400)
})

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log.info('bye')
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 300).unref()
  })
}
