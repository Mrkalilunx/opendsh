// 代理请求记录：每次转发进出一条，含请求头、收发原文（全文压缩存），永久落库
// 和运行日志共用同一个 MySQL 连接与库，表分开

import {
  gzipSync,
  gunzipSync,
  brotliCompressSync,
  brotliDecompressSync,
  constants as zconst,
} from 'node:zlib'
import { createHash } from 'node:crypto'
import { init } from './logstore.js'
import { daykey } from './daykey.js'
import { normusage } from './upstream.js'

// 文本列只留开头这么多字节，方便直接用 SQL 瞄一眼，不做解析
// 完整内容另存压缩列，两列并存：文本列给人看，压缩列给程序取
const maxbody = 32 * 1024
// 单段正文最多存这么多原始字节，压缩后必须塞进一个数据包
// 超出部分只能丢，但会把原始长度记进 size 列，界面据此提示不完整
const maxstored = 16 * 1024 * 1024
// 去重块同样受单包上限约束，压完还得小于这个数才敢写
const blockmax = 16 * 1024 * 1024
// 小于这个字节数的块直接存原文，gzip 头尾的开销比省下来的还多
const rawkeep = 512
// 块引用格式版本，以后改布局靠它区分
// 版本 2 加了整段去重：请求没有 messages 时按整段内容存一份，标志位 bit1
const refver = 2
// 引用序列的固定头长度：版本 1 + 标志 1 + 条数 4 + 其余字段哈希 16 + tools 哈希 16
const refhead = 38
// 标志位：bit0 有 tools，bit1 整段去重（不用逐条消息）
const flagTool = 1
const flagWhole = 2
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

// 折成压缩列：空内容存 NULL，省掉一行行的空 blob
// 压不下去的原样存，只要 size 记对了，取的时候能分清是不是完整
function pack(text, size) {
  const buf = Buffer.from(String(text || ''), 'utf8')
  // 空内容也算完整，否则界面会把「没有内容」错标成「已截断」
  if (!buf.length) return { z: null, size: 0, full: 1 }
  // 超过单段上限的只压前半段，size 仍记真实长度，差多少一眼能看出来
  const head = buf.length > size ? buf.subarray(0, size) : buf
  const z = gzipSync(head, { level: 6 })
  return { z, size: buf.length, full: head.length === buf.length ? 1 : 0 }
}

// 取回正文：压缩列优先，没压缩列的老记录退回文本列
// 压缩列被截断过就解不开，这时退回文本预览，不让详情页整个报错
function unpack(z, text) {
  if (!z || !z.length) return String(text || '')
  try {
    return gunzipSync(Buffer.from(z)).toString('utf8')
  } catch {
    return String(text || '')
  }
}

// 响应体专用压缩：SSE 流文本里结构重复度高，brotli 比 gzip 再好一成多
// 实测 460MB 原文 gzip 25.7MB、brotli 22.4MB，解压只在看详情时发生，不占转发路径
// 编码记在 respenc 列，0 是 gzip 老数据，1 是 brotli
const brotliq = 5
function packresp(text, size) {
  const buf = Buffer.from(String(text || ''), 'utf8')
  if (!buf.length) return { z: null, size: 0, full: 1, enc: 0 }
  const head = buf.length > size ? buf.subarray(0, size) : buf
  const z = brotliCompressSync(head, {
    params: { [zconst.BROTLI_PARAM_QUALITY]: brotliq },
  })
  return { z, size: buf.length, full: head.length === buf.length ? 1 : 0, enc: 1 }
}

function unpackresp(z, text, enc) {
  if (!z || !z.length) return String(text || '')
  try {
    const buf = Buffer.from(z)
    if (Number(enc) === 1) return brotliDecompressSync(buf).toString('utf8')
    return gunzipSync(buf).toString('utf8')
  } catch {
    return String(text || '')
  }
}

// 内容哈希：128 位足够，实测上万条消息零碰撞，比存 32 字符省一半
function dig(buf) {
  return createHash('blake2b512').update(buf).digest().subarray(0, 16)
}

// 切块：请求是 OpenAI 格式时按 messages 逐条切，边界天然对齐
// 结构不符就返回 null，调用方退回整段 gzip，不硬套
function split(body) {
  let doc = null
  try {
    doc = JSON.parse(String(body || ''))
  } catch {
    return null
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null
  const list = doc.messages
  if (!Array.isArray(list) || !list.length) return null

  const parts = []
  for (const one of list) {
    let text = ''
    try {
      text = JSON.stringify(one)
    } catch {
      return null
    }
    if (!text) return null
    parts.push(Buffer.from(text, 'utf8'))
  }
  // 其余顶层字段单独成块，tools 也拆出来，它跨请求几乎不变
  // o 存原始键序，v 存键值，还原时按 o 走，拼出来的字段顺序和当初一致
  const order = Object.keys(doc)
  const rest = { ...doc }
  delete rest.messages
  delete rest.tools
  let restbuf = null
  try {
    restbuf = Buffer.from(JSON.stringify({ o: order, v: rest }), 'utf8')
  } catch {
    return null
  }
  let toolbuf = null
  if (doc.tools !== undefined) {
    try {
      toolbuf = Buffer.from(JSON.stringify(doc.tools), 'utf8')
    } catch {
      return null
    }
  }
  return { parts, restbuf, toolbuf }
}

// 拼引用序列：定长头 + 每条消息 16 字节哈希，顺序就是还原顺序
// 头里存 rest 和 tools 的哈希，flags 第 0 位表示有没有 tools
function linkrefs(parts, restbuf, toolbuf) {
  const head = Buffer.alloc(refhead)
  head[0] = refver
  head[1] = toolbuf ? flagTool : 0
  head.writeUInt32BE(parts.length, 2)
  dig(restbuf).copy(head, 6)
  if (toolbuf) dig(toolbuf).copy(head, 22)
  const tail = Buffer.concat(parts.map((one) => dig(one)))
  return Buffer.concat([head, tail])
}

// 整段去重：请求没有 messages 结构时，把整段内容当一个块存
// 33226 条实测只有 323 种不同内容，逐条存纯属浪费
// 头里 count 记 0，rest 位放整段哈希，取的时候直接当正文用
function linkwhole(buf) {
  const head = Buffer.alloc(refhead)
  head[0] = refver
  head[1] = flagWhole
  head.writeUInt32BE(0, 2)
  dig(buf).copy(head, 6)
  return head
}

// 解码引用序列，头不合法就返回 null，让调用方退回老路径
// so: 版本 1 的老引用没有整段模式，按原样解，不影响历史数据
function readrefs(buf) {
  if (!buf || !Buffer.isBuffer(buf) || buf.length < refhead) return null
  const ver = buf[0]
  if (ver !== 1 && ver !== refver) return null
  const flags = buf[1]
  const count = buf.readUInt32BE(2)
  if (buf.length !== refhead + count * 16) return null
  const rest = buf.subarray(6, 22).toString('hex')
  if ((flags & flagWhole) === flagWhole) {
    // 整段模式：没有逐条消息，rest 就是整段内容的哈希
    return { whole: rest, keys: [], rest: null, tool: null }
  }
  const tool = (flags & flagTool) === flagTool ? buf.subarray(22, 38).toString('hex') : null
  const keys = []
  for (let i = 0; i < count; i += 1) {
    const off = refhead + i * 16
    keys.push(buf.subarray(off, off + 16).toString('hex'))
  }
  return { keys, rest, tool }
}

// 写入去重块：先查已有哪些，缺的整批插入，已有的统一加引用
// 三次往返搞定，不按块逐条发，几百条消息也不会拖慢
async function putblocks(conn, bufs) {
  const uniq = new Map()
  for (const one of bufs) {
    const k = dig(one).toString('hex')
    if (!uniq.has(k)) uniq.set(k, one)
  }
  if (!uniq.size) return null

  // 按哈希排序：并发请求访问同一批行时顺序一致，不会互相咬死
  // 这是消除死锁的关键，顺序乱了就必然有交叉等待
  const keys = [...uniq.keys()].sort()
  const ph = keys.map(() => '?').join(',')
  const bins = keys.map((k) => Buffer.from(k, 'hex'))
  const have = await conn.unsafe(`SELECT hash FROM msgblock WHERE hash IN (${ph})`, bins)
  const known = new Set()
  for (const r of have) {
    known.add(Buffer.isBuffer(r.hash) ? r.hash.toString('hex') : String(r.hash))
  }

  // 缺的块：压不动的原样存，压得动的压完再存
  const fresh = []
  for (const k of keys) {
    if (known.has(k)) continue
    const one = uniq.get(k)
    const zipped = one.length >= rawkeep ? 1 : 0
    const body = zipped ? gzipSync(one, { level: 6 }) : one
    // 单块压完还超过单包上限，这条请求整体退回整段压缩，不硬塞
    if (body.length > blockmax) return null
    fresh.push([k, body, zipped, one.length])
  }
  if (fresh.length) {
    const marks = fresh.map(() => '(UNHEX(?), ?, ?, ?, 1, ?)').join(',')
    const args = []
    for (const [k, body, zipped, len] of fresh) {
      args.push(k, body, zipped, len, Date.now())
    }
    // 并发下别的请求可能刚好插了同一块，撞主键就改成加引用
    await retry(() => conn.unsafe(
      `INSERT INTO msgblock (hash, body, zipped, rawlen, refs, born) VALUES ${marks}
       ON DUPLICATE KEY UPDATE refs = refs + 1`,
      args,
    ))
  }
  const old = keys.filter((k) => known.has(k))
  if (old.length) {
    const ph2 = old.map(() => '?').join(',')
    await retry(() => conn.unsafe(
      `UPDATE msgblock SET refs = refs + 1 WHERE hash IN (${ph2})`,
      old.map((k) => Buffer.from(k, 'hex')),
    ))
  }
  return uniq
}

// 死锁是并发插入的正常现象，重放一次基本就好，不往上报错
// so: 排序已经把概率压得很低，这里只兜极少数撞车的
async function retry(fn) {
  let last = null
  for (let i = 0; i < 3; i += 1) {
    try {
      return await fn()
    } catch (err) {
      last = err
      if (!/deadlock|lock wait timeout/i.test(err && err.message ? err.message : '')) throw err
      await new Promise((one) => setTimeout(one, 20 * (i + 1)))
    }
  }
  throw last
}

// 取块还原成原请求：按引用顺序拼回 messages，其余字段放回原位
// 任何一块缺失都返回 null，调用方退回整段压缩，不吐半截
async function rebuild(conn, refs) {
  const need = refs.whole
    ? [refs.whole]
    : [...new Set([...refs.keys, refs.rest, refs.tool].filter(Boolean))]
  if (!need.length) return null
  const ph = need.map(() => '?').join(',')
  const rows = await conn.unsafe(
    `SELECT hash, body, zipped FROM msgblock WHERE hash IN (${ph})`,
    need.map((k) => Buffer.from(k, 'hex')),
  )
  const map = new Map()
  for (const r of rows) {
    const k = Buffer.isBuffer(r.hash) ? r.hash.toString('hex') : String(r.hash)
    let buf = Buffer.isBuffer(r.body) ? r.body : Buffer.from(r.body)
    if (Number(r.zipped) === 1) {
      try {
        buf = gunzipSync(buf)
      } catch {
        return null
      }
    }
    map.set(k, buf.toString('utf8'))
  }

  // 整段模式：块里存的就是完整正文，直接返回，不用再拼
  if (refs.whole) {
    const text = map.get(refs.whole)
    return text === undefined ? null : text
  }

  const resttext = map.get(refs.rest)
  if (resttext === undefined) return null
  let pack = null
  try {
    pack = JSON.parse(resttext)
  } catch {
    return null
  }
  if (!pack || !Array.isArray(pack.o) || !pack.v) return null

  const msgs = []
  for (const k of refs.keys) {
    const text = map.get(k)
    if (text === undefined) return null
    try {
      msgs.push(JSON.parse(text))
    } catch {
      return null
    }
  }
  let tools
  if (refs.tool) {
    const text = map.get(refs.tool)
    if (text === undefined) return null
    try {
      tools = JSON.parse(text)
    } catch {
      return null
    }
  }

  // 按原始键序回填，拼出来的字节顺序和当初发出去的一致
  const out = {}
  for (const k of pack.o) {
    if (k === 'messages') out.messages = msgs
    else if (k === 'tools') {
      if (tools !== undefined) out.tools = tools
    } else if (k in pack.v) out[k] = pack.v[k]
  }
  return JSON.stringify(out)
}

// 删记录时递减引用计数，减到 0 的块顺手清掉，不留孤儿
// 两趟搞定：先整体减，再把归零的删掉
async function dropblocks(conn, bufs) {
  const tally = new Map()
  for (const buf of bufs) {
    const refs = readrefs(buf)
    if (!refs) continue
    // 整段模式下 keys 为空，真正要减的是 whole 那一个
    const keys = refs.whole
      ? [refs.whole]
      : [...refs.keys, refs.rest, refs.tool].filter(Boolean)
    for (const k of new Set(keys)) tally.set(k, (tally.get(k) || 0) + 1)
  }
  if (!tally.size) return
  // 同样按哈希排序，和 putblocks 保持同一访问顺序
  const keys = [...tally.keys()].sort()
  // 分批走，单条语句参数别过千
  for (let i = 0; i < keys.length; i += 400) {
    const slice = keys.slice(i, i + 400)
    const ph = slice.map(() => '?').join(',')
    const bins = slice.map((k) => Buffer.from(k, 'hex'))
    try {
      await retry(() => conn.unsafe(`UPDATE msgblock SET refs = refs - 1 WHERE hash IN (${ph})`, bins))
      await retry(() => conn.unsafe(`DELETE FROM msgblock WHERE refs <= 0 AND hash IN (${ph})`, bins))
    } catch (err) {
      console.error(`[reqstore] 块回收失败：${err.message}`)
      return
    }
  }
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
      reqbodyz LONGBLOB,
      respbodyz LONGBLOB,
      reqsize BIGINT UNSIGNED NOT NULL DEFAULT 0,
      respsize BIGINT UNSIGNED NOT NULL DEFAULT 0,
      reqfull TINYINT NOT NULL DEFAULT 0,
      respfull TINYINT NOT NULL DEFAULT 0,
      msgrefs LONGBLOB,
      migrated TINYINT NOT NULL DEFAULT 0,
      respenc TINYINT NOT NULL DEFAULT 0,
      PRIMARY KEY (id),
      KEY idx_day_at (day, at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)
  // 去重块表：内容寻址，同一段内容只留一份，refs 记被几条请求引用
  // 引用计数减到 0 才删，删记录时同步递减，不清就永远不会回收
  await db.unsafe(`
    CREATE TABLE IF NOT EXISTS msgblock (
      hash BINARY(16) NOT NULL,
      body LONGBLOB NOT NULL,
      zipped TINYINT NOT NULL DEFAULT 0,
      rawlen INT UNSIGNED NOT NULL DEFAULT 0,
      refs INT NOT NULL DEFAULT 0,
      born BIGINT NOT NULL DEFAULT 0,
      PRIMARY KEY (hash)
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
    ['reqbodyz LONGBLOB AFTER respbody'],
    ['respbodyz LONGBLOB AFTER reqbodyz'],
    ['reqsize BIGINT UNSIGNED NOT NULL DEFAULT 0 AFTER respbodyz'],
    ['respsize BIGINT UNSIGNED NOT NULL DEFAULT 0 AFTER reqsize'],
    ['reqfull TINYINT NOT NULL DEFAULT 0 AFTER respsize'],
    ['respfull TINYINT NOT NULL DEFAULT 0 AFTER reqfull'],
    ['msgrefs LONGBLOB AFTER respfull'],
    ['migrated TINYINT NOT NULL DEFAULT 0 AFTER msgrefs'],
    ['respenc TINYINT NOT NULL DEFAULT 0 AFTER migrated'],
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
  const reqpack = pack(rec.reqbody, maxstored)
  const resppack = packresp(rec.respbody, maxstored)
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
    reqbodyz: reqpack.z,
    respbodyz: resppack.z,
    reqsize: reqpack.size,
    respsize: resppack.size,
    reqfull: reqpack.full,
    respfull: resppack.full,
    respenc: resppack.enc,
    msgrefs: null,
  }

  const conn = await db()
  if (!conn) return

  // 请求是 OpenAI 格式就走去重路径：公共上下文只存一份
  // 结构不符或块写不进单包时退回整段压缩，reqbodyz 照着填，不影响读取
  const parts = split(rec.reqbody)
  if (parts) {
    try {
      const bufs = [...parts.parts, parts.restbuf]
      if (parts.toolbuf) bufs.push(parts.toolbuf)
      const wrote = await putblocks(conn, bufs)
      if (wrote) {
        row.msgrefs = linkrefs(parts.parts, parts.restbuf, parts.toolbuf)
        // 去重成功后整段压缩列就不必再存，省一份空间
        row.reqbodyz = null
      }
    } catch (err) {
      console.error(`[reqstore] 去重写入失败，退回整段压缩：${err.message}`)
      row.msgrefs = null
      row.reqbodyz = reqpack.z
      drop(err)
    }
  } else {
    // 没有 messages 结构（responses、embeddings 之类）就整段当一个块
    // 实测这类请求的正文重复率 99%，整段去重比逐条压省得多
    try {
      const whole = Buffer.from(String(rec.reqbody || ''), 'utf8')
      if (whole.length) {
        const wrote = await putblocks(conn, [whole])
        if (wrote) {
          row.msgrefs = linkwhole(whole)
          row.reqbodyz = null
        }
      }
    } catch (err) {
      console.error(`[reqstore] 整段去重失败，退回整段压缩：${err.message}`)
      row.msgrefs = null
      row.reqbodyz = reqpack.z
      drop(err)
    }
  }

  try {
    const res = await conn.unsafe(
      `INSERT INTO requests (at, day, method, path, source, model, status, ms, ptok, ctok, ttok, cachetok, reasontok, reqhead, reqbody, respbody, reqbodyz, respbodyz, reqsize, respsize, reqfull, respfull, respenc, msgrefs, migrated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [
        row.at, daykey(row.at), row.method, row.path, row.source, row.model, row.status, row.ms,
        row.ptok, row.ctok, row.ttok, row.cachetok, row.reasontok,
        row.reqhead, row.reqbody, row.respbody,
        row.reqbodyz, row.respbodyz, row.reqsize, row.respsize, row.reqfull, row.respfull,
        row.respenc, row.msgrefs,
      ],
    )
    row.id = Number(res.lastInsertRowid) || 0
  } catch (err) {
    console.error(`[reqstore] 写入失败：${err.message}`)
    // 记录没落库，刚加的块引用白加了，得退回去，否则永远回收不掉
    if (row.msgrefs) await dropblocks(conn, [row.msgrefs])
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
  return brief
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
    'SELECT id, at, day, method, path, source, model, status, ms, reqhead, reqbody, respbody, reqbodyz, respbodyz, reqsize, respsize, reqfull, respfull, respenc, msgrefs FROM requests WHERE id = ?',
    [Number(id) || 0],
  )
  if (!rows.length) throw new Error('记录不存在')
  const r = rows[0]
  // 有引用序列就按块还原，这是新记录的正常路径
  // 还原失败（块被清掉或版本不符）退回压缩列，再不行退回文本预览
  let reqtext = ''
  let deduped = false
  const refs = readrefs(r.msgrefs)
  if (refs) {
    try {
      const out = await rebuild(conn, refs)
      if (out !== null) {
        reqtext = out
        deduped = true
      }
    } catch (err) {
      console.error(`[reqstore] 去重还原失败 #${id}：${err.message}`)
    }
  }
  if (!deduped) reqtext = unpack(r.reqbodyz, r.reqbody)
  const resptext = unpackresp(r.respbodyz, r.respbody, r.respenc)
  // 是否完整不能只看「有没有去重」，迁移过来的老记录可能本来就是截断的
  // 有引用序列的记录以 reqfull/respfull 为准，那是写入时就定下的
  // 更老的纯文本记录没有标志位，只能按是否顶到 32KB 上限猜
  const hasrefs = !!(r.msgrefs && r.msgrefs.length)
  const intact = (z, text, flag) => {
    if (hasrefs) return Number(flag) === 1
    if (z && z.length) return Number(flag) === 1
    return Buffer.byteLength(String(text || ''), 'utf8') < maxbody
  }
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
    reqbody: reqtext,
    respbody: resptext,
    reqsize: Number(r.reqsize) || 0,
    respsize: Number(r.respsize) || 0,
    reqfull: intact(r.reqbodyz, r.reqbody, r.reqfull),
    respfull: intact(r.respbodyz, r.respbody, r.respfull),
    dedup: deduped,
  }
}

export async function clear(day) {
  const conn = await db()
  if (!conn) throw new Error('日志库未连接')
  // 删之前先把这些记录的引用序列取出来，删完才好回收块
  const where = day ? 'WHERE day = ?' : ''
  const args = day ? [day] : []
  let refs = []
  try {
    refs = await conn.unsafe(`SELECT msgrefs FROM requests ${where}`, args)
  } catch {
    // 老库可能还没有这一列，取不到就直接删，块留给后台清扫
  }
  if (day) await conn.unsafe('DELETE FROM requests WHERE day = ?', [day])
  else {
    await conn.unsafe('DELETE FROM requests')
    try {
      await conn.unsafe('OPTIMIZE TABLE requests')
    } catch {
      // 回收失败不影响数据已经删掉
    }
  }
  const bufs = refs.map((r) => r.msgrefs).filter(Boolean)
  if (bufs.length) await dropblocks(conn, bufs)
  return null
}

// 删单条：详情面板里的删除走这里，不整表清空
export async function remove(id) {
  const conn = await db()
  if (!conn) throw new Error('日志库未连接')
  // 先取引用再删，顺序反了就找不回要回收哪些块
  let buf = null
  try {
    const rows = await conn.unsafe('SELECT msgrefs FROM requests WHERE id = ?', [Number(id) || 0])
    if (rows.length) buf = rows[0].msgrefs
  } catch {
    // 老库没有这一列，跳过回收
  }
  await conn.unsafe('DELETE FROM requests WHERE id = ?', [Number(id) || 0])
  if (buf) await dropblocks(conn, [buf])
  return null
}

// 后台清扫：重算引用计数，把没人引用的块删掉
// so: 记录可能被直接 SQL 删掉、也可能异常退出的请求少减了一次
//     光看 refs 会漏，必须重扫所有引用序列才知道真实引用数
// 只在服务空闲时由调用方触发，不放在请求路径上
export async function sweep() {
  const conn = await db()
  if (!conn) return 0
  const rows = await conn.unsafe('SELECT msgrefs FROM requests WHERE msgrefs IS NOT NULL')
  const tally = new Map()
  for (const r of rows) {
    const refs = readrefs(r.msgrefs)
    if (!refs) continue
    const ks = refs.whole
      ? [refs.whole]
      : [...refs.keys, refs.rest, refs.tool].filter(Boolean)
    for (const k of new Set(ks)) {
      tally.set(k, (tally.get(k) || 0) + 1)
    }
  }
  // 先归零，再按真实计数回写，最后删掉计数为零的
  await conn.unsafe('UPDATE msgblock SET refs = 0')
  const keys = [...tally.keys()].sort()
  for (let i = 0; i < keys.length; i += 400) {
    const slice = keys.slice(i, i + 400)
    // CASE hash WHEN UNHEX(?) 用一次，IN (UNHEX(?)) 再用一次，每个值要传两遍
    const sets = slice.map(() => 'WHEN UNHEX(?) THEN ?').join(' ')
    const ph = slice.map(() => 'UNHEX(?)').join(',')
    const args = []
    for (const k of slice) args.push(k, tally.get(k))
    for (const k of slice) args.push(k)
    await conn.unsafe(
      `UPDATE msgblock SET refs = CASE hash ${sets} END WHERE hash IN (${ph})`,
      args,
    )
  }
  const res = await conn.unsafe('DELETE FROM msgblock WHERE refs <= 0')
  return Number(res.affectedRows) || 0
}

// 老记录迁移：把 msgrefs 为空的历史行改成去重格式，腾出重复的正文空间
// 分批处理，每批搬完立刻清空旧列，避免整表重写时把磁盘撑爆
// 响应体不参与去重（SSE 每条都带唯一 id，实测去重率 0），只做 gzip
export async function migrate(opts = {}) {
  const conn = await db()
  if (!conn) throw new Error('日志库未连接')
  const batch = Math.max(1, Math.min(200, Number(opts.batch) || 50))
  const cap = Math.max(1, Number(opts.limit) || 1e9)
  const progress = typeof opts.progress === 'function' ? opts.progress : null

  const stat = {
    seen: 0,
    deduped: 0,
    textonly: 0,
    failed: 0,
    freed: 0,
    done: false,
  }

  // 老记录 id 只增不减，用游标往前推，避免 OFFSET 越来越慢
  let cursor = Number(opts.after) || 0
  for (;;) {
    if (stat.seen >= cap) break
    const rows = await conn.unsafe(
      `SELECT id, reqbody, respbody, reqbodyz, respbodyz, reqsize, respsize, reqfull, respfull
         FROM requests
        WHERE migrated = 0 AND id > ?
        ORDER BY id LIMIT ?`,
      [cursor, batch],
    )
    if (!rows.length) {
      stat.done = true
      break
    }

    for (const r of rows) {
      const id = Number(r.id)
      cursor = id
      stat.seen += 1

      // 请求正文优先取完整压缩列，没有就用 32KB 文本
      let reqtext = ''
      if (r.reqbodyz && r.reqbodyz.length) {
        try {
          reqtext = gunzipSync(Buffer.from(r.reqbodyz)).toString('utf8')
        } catch {
          reqtext = String(r.reqbody || '')
        }
      } else {
        reqtext = String(r.reqbody || '')
      }

      // 响应体不参与去重，只换成更省空间的 brotli
      // 老记录若已有全文压缩列就解出来重压，别拿 32KB 文本预览覆盖掉全文
      let resprawbuf = null
      if (r.respbodyz && r.respbodyz.length) {
        try {
          resprawbuf = gunzipSync(Buffer.from(r.respbodyz))
        } catch {
          resprawbuf = null
        }
      }
      if (!resprawbuf) {
        const text = String(r.respbody || '')
        resprawbuf = text ? Buffer.from(text, 'utf8') : null
      }
      const respbuf = resprawbuf || Buffer.alloc(0)
      let respz = null
      let respenc = 0
      if (respbuf.length) {
        // 响应体本来就可能很大，超过单包上限的截到上限再压
        const head = respbuf.length > maxstored ? respbuf.subarray(0, maxstored) : respbuf
        respz = brotliCompressSync(head, {
          params: { [zconst.BROTLI_PARAM_QUALITY]: brotliq },
        })
        respenc = 1
      }

      // 请求能切块就去重，切不动就整段压
      let refs = null
      let reqz = null
      // 是否完整：原来有全文压缩列的照旧，只有 32KB 文本的按是否顶到上限判
      let reqfull = 0
      // 文本是不是本来就截断过：正好 32768 字节就是被切过的，比它短才算完整
      const textcut = Buffer.byteLength(String(r.reqbody || ''), 'utf8') >= maxbody
      const parts = split(reqtext)
      if (parts) {
        try {
          const bufs = [...parts.parts, parts.restbuf]
          if (parts.toolbuf) bufs.push(parts.toolbuf)
          const wrote = await putblocks(conn, bufs)
          if (wrote) refs = linkrefs(parts.parts, parts.restbuf, parts.toolbuf)
        } catch (err) {
          console.error(`[migrate] 去重失败 #${id}：${err.message}`)
        }
      }
      if (!refs) {
        const packed = pack(reqtext, maxstored)
        reqz = packed.z
        // pack 的 full 只说明没超过 16MB 存储上限，和 32KB 截断无关
        // 老记录只存了前 32KB，够不到上限但内容已经不全，得按 textcut 判
        reqfull = textcut ? 0 : packed.full
        stat.textonly += 1
      } else {
        // 去重存的就是当前的完整内容，不再受 32KB 预览截断影响
        // so: 只有纯 gzip 路径才需要区分完整性，去重路径一律算完整
        reqfull = 1
        stat.deduped += 1
      }
      // 响应体同理：文本列存的就是全部原始长度时才算完整
      const respcut = respbuf.length >= maxbody
      const respfull = r.respfull !== undefined && r.respfull !== null && Number(r.respfull) === 1
        ? 1
        : (r.respbodyz && r.respbodyz.length ? 0 : (respcut ? 0 : 1))

      // 写回新格式，同时把旧的重复列清空，空间才真正腾出来
      // 文本预览列也一起清掉：内容已在块里，留着又是一份重复
      try {
        const before = Number(r.reqsize) || Buffer.byteLength(reqtext, 'utf8')
        await conn.unsafe(
          `UPDATE requests
              SET msgrefs = ?, reqbodyz = ?, respbodyz = ?, respenc = ?,
                  reqbody = '', respbody = '',
                  reqsize = ?, respsize = ?, reqfull = ?, respfull = ?,
                  migrated = 1
            WHERE id = ?`,
          [
            refs,
            reqz,
            respz,
            respenc,
            before,
            Number(r.respsize) || respbuf.length,
            reqfull,
            respfull,
            id,
          ],
        )
        stat.freed += Buffer.byteLength(String(r.reqbody || ''), 'utf8')
          + Buffer.byteLength(String(r.respbody || ''), 'utf8')
          + (r.reqbodyz ? r.reqbodyz.length : 0)
          + (r.respbodyz ? r.respbodyz.length : 0)
      } catch (err) {
        stat.failed += 1
        console.error(`[migrate] 写回失败 #${id}：${err.message}`)
      }
    }

    if (progress) progress({ ...stat, cursor })
    if (stat.seen >= cap) break
  }

  return { ...stat, cursor }
}

// 第二遍迁移：把第一遍留下的纯 gzip 记录转成整段去重
// 这批记录切不出 messages，但正文重复率 99%，整段去重才是最优解
// 老数据 migrated 记 2，和第一遍的 1 区分开，重复跑不会做无用功
export async function compact(opts = {}) {
  const conn = await db()
  if (!conn) throw new Error('日志库未连接')
  const batch = Math.max(1, Math.min(200, Number(opts.batch) || 50))
  const cap = Math.max(1, Number(opts.limit) || 1e9)
  const progress = typeof opts.progress === 'function' ? opts.progress : null

  const stat = { seen: 0, whole: 0, resprb: 0, failed: 0, freed: 0, done: false }

  let cursor = Number(opts.after) || 0
  for (;;) {
    if (stat.seen >= cap) break
    const rows = await conn.unsafe(
      `SELECT id, respbody, reqbodyz, respbodyz, respenc, reqsize, respsize, reqfull, respfull
         FROM requests
        WHERE migrated = 1 AND msgrefs IS NULL AND id > ?
        ORDER BY id LIMIT ?`,
      [cursor, batch],
    )
    if (!rows.length) {
      stat.done = true
      break
    }

    for (const r of rows) {
      const id = Number(r.id)
      cursor = id
      stat.seen += 1
      try {
        // 请求体解出来整段存块，解不出就跳过这条，保持原样不动
        let reqbuf = null
        if (r.reqbodyz && r.reqbodyz.length) {
          try {
            reqbuf = gunzipSync(Buffer.from(r.reqbodyz))
          } catch {
            reqbuf = null
          }
        }
        if (!reqbuf || !reqbuf.length) {
          // 没有请求正文可搬，标记完成即可，免得每轮重扫
          await conn.unsafe('UPDATE requests SET migrated = 2 WHERE id = ?', [id])
          continue
        }

        // 响应体顺手换成 brotli，编码标在 respenc
        let respz = r.respbodyz
        let respenc = Number(r.respenc) || 0
        if (r.respbodyz && r.respbodyz.length && respenc !== 1) {
          try {
            const raw = gunzipSync(Buffer.from(r.respbodyz))
            const head = raw.length > maxstored ? raw.subarray(0, maxstored) : raw
            respz = brotliCompressSync(head, {
              params: { [zconst.BROTLI_PARAM_QUALITY]: brotliq },
            })
            respenc = 1
            stat.resprb += 1
          } catch {
            respz = r.respbodyz
          }
        }

        const wrote = await putblocks(conn, [reqbuf])
        if (!wrote) {
          // 块大到塞不进单包，保持原样并标记完成，避免每轮重试
          await conn.unsafe('UPDATE requests SET migrated = 2 WHERE id = ?', [id])
          continue
        }
        const refs = linkwhole(reqbuf)
        const oldz = r.reqbodyz ? r.reqbodyz.length : 0
        const oldr = r.respbodyz ? r.respbodyz.length : 0
        // 完整性沿用第一遍的判定：块里装的就是原来那份内容
        // 老记录本来就只截了前 32KB，转成整段去重也不代表内容变完整了
        const reqfull = Number(r.reqfull) === 1 ? 1 : 0
        await conn.unsafe(
          `UPDATE requests
              SET msgrefs = ?, reqbodyz = NULL, respbodyz = ?, respenc = ?,
                  reqbody = '', respbody = '',
                  reqsize = ?, reqfull = ?, migrated = 2
            WHERE id = ?`,
          [
            refs,
            respz,
            respenc,
            Number(r.reqsize) || reqbuf.length,
            reqfull,
            id,
          ],
        )
        stat.whole += 1
        stat.freed += oldz + oldr - (respz ? respz.length : 0)
      } catch (err) {
        stat.failed += 1
        console.error(`[compact] 处理失败 #${id}：${err.message}`)
      }
    }

    if (progress) progress({ ...stat, cursor })
    if (stat.seen >= cap) break
  }

  return { ...stat, cursor }
}
