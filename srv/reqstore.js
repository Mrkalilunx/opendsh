// 代理请求记录：每次转发进出一条，含请求头、收发原文（超长截断），永久落库
// 和运行日志共用同一个 MySQL 连接与库，表分开

import { init } from './logstore.js'
import { daykey } from './daykey.js'
import { normusage } from './upstream.js'

// 单段正文最多留这么多字节，流式响应会非常大，只留开头够排查
const maxbody = 32 * 1024
// 连不上不永久停用，冷却后再试；库被拉起来后请求记录能自己恢复
let conn = null
let retryat = 0
const retryms = 30000

const subs = new Set()

function cut(text, size = maxbody) {
  const s = String(text || '')
  if (Buffer.byteLength(s, 'utf8') <= size) return s
  // 按字节切会把中文或多字节字符切成半个，解码时丢弃尾巴那几个坏字节
  const buf = Buffer.from(s, 'utf8').subarray(0, size)
  return new TextDecoder('utf-8').decode(buf).replace(/\uFFFD+$/, '')
}

export function sourceof(reqhead) {
  let ua = ''
  try {
    const head = typeof reqhead === 'string' ? JSON.parse(reqhead) : reqhead
    if (head && typeof head === 'object') {
      for (const [key, value] of Object.entries(head)) {
        if (key.toLowerCase() === 'user-agent') ua = String(value || '')
      }
    }
  } catch {
    // 头不是合法 JSON 就按其他算
  }
  const low = ua.toLowerCase()
  if (low.includes('opencode')) return 'opencode'
  if (low.includes('codex')) return 'codex'
  if (low.includes('astrbot')) return 'astrbot'
  if (low.includes('mozilla') || low.includes('chrome') || low.includes('safari')) return 'web'
  if (/^(curl|wget|python|node|bun|httpie|go-http|okhttp)/.test(low)) return 'script'
  return 'other'
}

async function connect() {
  const db = await init()
  if (!db) throw new Error('日志库未连接')
  await db.unsafe(`
    CREATE TABLE IF NOT EXISTS requests (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      at BIGINT NOT NULL,
      day DATE NOT NULL,
      method VARCHAR(8) NOT NULL,
      path VARCHAR(160) NOT NULL,
      source VARCHAR(16) NOT NULL DEFAULT '',
      model VARCHAR(120) NOT NULL DEFAULT '',
      status INT NOT NULL DEFAULT 0,
      ms INT NOT NULL DEFAULT 0,
      reqhead MEDIUMTEXT,
      reqbody MEDIUMTEXT,
      respbody MEDIUMTEXT,
      PRIMARY KEY (id),
      KEY idx_day_at (day, at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)
  // 老库没有这几列，逐个补上；token 列是后加的，历史记录留 0
  const columns = [
    ["source VARCHAR(16) NOT NULL DEFAULT '' AFTER path"],
    ['ptok INT UNSIGNED NOT NULL DEFAULT 0 AFTER ms'],
    ['ctok INT UNSIGNED NOT NULL DEFAULT 0 AFTER ptok'],
    ['ttok INT UNSIGNED NOT NULL DEFAULT 0 AFTER ctok'],
    ['cachetok INT UNSIGNED NOT NULL DEFAULT 0 AFTER ttok'],
    ['reasontok INT UNSIGNED NOT NULL DEFAULT 0 AFTER cachetok'],
  ]
  for (const [def] of columns) {
    try {
      await db.unsafe(`ALTER TABLE requests ADD COLUMN IF NOT EXISTS ${def}`)
    } catch {
      // 列已存在或版本不认 IF NOT EXISTS，忽略
    }
  }
  await backfill(db)
  return db
}

// 回填只跑一次：老记录的 source 是空的，按存下来的 UA 补上
let backfilled = false

async function backfill(db) {
  if (backfilled) return
  backfilled = true
  try {
    const rows = await db.unsafe("SELECT id, reqhead FROM requests WHERE source = '' LIMIT 5000")
    if (!rows.length) return
    for (const r of rows) {
      await db.unsafe('UPDATE requests SET source = ? WHERE id = ?', [sourceof(r.reqhead), Number(r.id)])
    }
  } catch (err) {
    console.error(`[reqstore] 来源回填失败：${err.message}`)
  }
}

// 首条记录进来才连库，连不上就冷却一会儿，不阻塞代理本身
async function db() {
  if (conn) return conn
  if (Date.now() < retryat) return null
  try {
    conn = await connect()
    return conn
  } catch (err) {
    retryat = Date.now() + retryms
    console.error(`[reqstore] 连接 MySQL 失败，请求记录暂停 ${retryms / 1000} 秒：${err.message}`)
    return null
  }
}

// 写入报连接类错误时丢掉缓存，下次重新建连
function drop(err) {
  if (!/connect|closed|gone|ECONN|ETIMEDOUT|refused/i.test(err && err.message ? err.message : '')) return
  conn = null
  retryat = Date.now() + 5000
}

export function onreq(fn) {
  subs.add(fn)
  return () => subs.delete(fn)
}

// 建表与补列都挂在首次连接上，用量统计也要先过这一关，否则查不到新列
export async function schema() {
  return db()
}

// 一条请求写完就推给实时订阅者，正文留在库里，推送只带摘要
export async function emit(rec) {
  // usage 上游不一定给，缺了统一记 0，查询那边不用再判空
  const use = normusage(rec.usage)
  const row = {
    at: rec.at,
    method: rec.method,
    path: rec.path,
    source: rec.source || sourceof(rec.reqhead),
    model: rec.model || '',
    status: rec.status || 0,
    ms: rec.ms || 0,
    ptok: use.prompt_tokens,
    ctok: use.completion_tokens,
    ttok: use.total_tokens,
    cachetok: use.prompt_tokens_details.cached_tokens,
    reasontok: use.completion_tokens_details.reasoning_tokens,
    reqhead: cut(rec.reqhead),
    reqbody: cut(rec.reqbody),
    respbody: cut(rec.respbody),
  }

  const conn = await db()
  if (!conn) return

  try {
    const res = await conn.unsafe(
      `INSERT INTO requests (at, day, method, path, source, model, status, ms, ptok, ctok, ttok, cachetok, reasontok, reqhead, reqbody, respbody)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.at, daykey(row.at), row.method, row.path, row.source, row.model, row.status, row.ms,
        row.ptok, row.ctok, row.ttok, row.cachetok, row.reasontok,
        row.reqhead, row.reqbody, row.respbody,
      ],
    )
    row.id = Number(res.lastInsertRowid) || 0
  } catch (err) {
    console.error(`[reqstore] 写入失败：${err.message}`)
    drop(err)
    return
  }

  const brief = {
    id: row.id,
    at: row.at,
    method: row.method,
    path: row.path,
    source: row.source,
    model: row.model,
    status: row.status,
    ms: row.ms,
    ttok: row.ttok,
  }
  for (const fn of subs) {
    try {
      fn(brief)
    } catch {
      // 单个订阅者出错不影响其余连接
    }
  }
}

// 列表只带摘要，正文点开再看，几千条也不会把列表撑爆
export async function query(opts = {}) {
  const conn = await db()
  if (!conn) throw new Error('日志库未连接')
  const day = opts.day || daykey(Date.now())
  const limit = Math.max(1, Math.min(1000, Number(opts.limit) || 200))
  const offset = Math.max(0, Number(opts.offset) || 0)
  // 来源筛选：all 或不传表示不过滤
  const src = opts.source && opts.source !== 'all' ? String(opts.source).slice(0, 16) : ''
  const where = src ? 'WHERE day = ? AND source = ?' : 'WHERE day = ?'
  const args = src ? [day, src] : [day]

  const rows = await conn.unsafe(
    `SELECT id, at, method, path, source, model, status, ms
       FROM requests ${where} ORDER BY at DESC, id DESC LIMIT ? OFFSET ?`,
    [...args, limit, offset],
  )
  const counted = await conn.unsafe(`SELECT COUNT(*) AS n FROM requests ${where}`, args)
  const dist = await conn.unsafe(
    'SELECT source, COUNT(*) AS n FROM requests WHERE day = ? GROUP BY source',
    [day],
  )
  const counts = { all: 0 }
  for (const one of dist) {
    const key = one.source || 'other'
    const n = Number(one.n) || 0
    counts[key] = (counts[key] || 0) + n
    counts.all += n
  }
  return {
    day,
    source: src || 'all',
    total: Number(counted[0] && counted[0].n) || 0,
    counts,
    list: rows.map((r) => ({
      id: Number(r.id),
      at: Number(r.at),
      method: r.method,
      path: r.path,
      source: r.source || 'other',
      model: r.model,
      status: Number(r.status),
      ms: Number(r.ms),
    })),
  }
}

// 日期抽屉用：只列有请求记录的日子和当天的条数
export async function days(limit = 365) {
  const conn = await db()
  if (!conn) throw new Error('日志库未连接')
  const rows = await conn.unsafe(
    'SELECT day, COUNT(*) AS n FROM requests GROUP BY day ORDER BY day DESC LIMIT ?',
    [Math.max(1, Math.min(365, Number(limit) || 365))],
  )
  return rows.map((r) => ({
    day: r.day instanceof Date ? daykey(r.day.getTime()) : String(r.day).slice(0, 10),
    n: Number(r.n) || 0,
  }))
}

// 存储概况：天数、条数、占用字节，给设置页的请求记录管理用
export async function stat() {
  const conn = await db()
  if (!conn) throw new Error('日志库未连接')
  const rows = await conn.unsafe('SELECT COUNT(*) AS n, COUNT(DISTINCT day) AS d FROM requests')
  const size = await conn.unsafe(
    "SELECT COALESCE(data_length + index_length, 0) AS b FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'requests'",
  )
  return {
    rows: Number(rows[0] && rows[0].n) || 0,
    days: Number(rows[0] && rows[0].d) || 0,
    bytes: Number(size[0] && size[0].b) || 0,
  }
}

export async function detail(id) {
  const conn = await db()
  if (!conn) throw new Error('日志库未连接')
  const rows = await conn.unsafe(
    'SELECT id, at, day, method, path, source, model, status, ms, reqhead, reqbody, respbody FROM requests WHERE id = ?',
    [Number(id) || 0],
  )
  if (!rows.length) throw new Error('记录不存在')
  const r = rows[0]
  return {
    id: Number(r.id),
    at: Number(r.at),
    day: r.day instanceof Date ? daykey(r.day.getTime()) : String(r.day).slice(0, 10),
    method: r.method,
    path: r.path,
    source: r.source || 'other',
    model: r.model,
    status: Number(r.status),
    ms: Number(r.ms),
    reqhead: r.reqhead || '',
    reqbody: r.reqbody || '',
    respbody: r.respbody || '',
  }
}

export async function clear(day) {
  const conn = await db()
  if (!conn) throw new Error('日志库未连接')
  if (day) return conn.unsafe('DELETE FROM requests WHERE day = ?', [day])
  await conn.unsafe('DELETE FROM requests')
  try {
    await conn.unsafe('OPTIMIZE TABLE requests')
  } catch {
    // 回收失败不影响数据已经删掉
  }
  return null
}

// 删单条：详情面板里的删除走这里，不整表清空
export async function remove(id) {
  const conn = await db()
  if (!conn) throw new Error('日志库未连接')
  return conn.unsafe('DELETE FROM requests WHERE id = ?', [id])
}
