// 日志落库：MySQL 永久保存，内存环形缓冲只负责实时推送
// 连接信息在设置里，库挂了也不拖垮主服务，降级成只进内存

import { SQL } from 'bun'
import { ensuremysql } from './mysqlboot.js'
import { dbconf } from './paths.js'
import { daykey } from './daykey.js'

let sql = null
// 连不上不永久停用，冷却一会儿再试，库被重新拉起来后能自己恢复
let retryat = 0
const retryms = 30000
// 连接参数读一次就留着，主页断线时也要能显示库地址
let conf = null
let queue = []
let timer = null
let inflight = false

const batchmax = 50
const delayms = 200

async function connect() {
  // 连接参数以设置为准，老的 mysql.json 只在设置没填时兜底
  const cfg = await dbconf()
  conf = cfg
  // 库没开就先把 MariaDB 拉起来，端口不通的常见情况是手机重开后没人启动
  await ensuremysql(cfg)
  const url = `mysql://${cfg.user}:${encodeURIComponent(cfg.password)}@${cfg.host}:${cfg.port}/${cfg.database}`
  const next = new SQL({ url, max: 4, idleTimeout: 30, connectionTimeout: 8 })
  await next`SELECT 1`
  await next`
    CREATE TABLE IF NOT EXISTS logs (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      at BIGINT NOT NULL,
      day DATE NOT NULL,
      level VARCHAR(8) NOT NULL,
      msg TEXT NOT NULL,
      PRIMARY KEY (id),
      KEY idx_day_at (day, at),
      KEY idx_level_at (level, at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `
  sql = next
  return sql
}

// 首次使用时连一次，失败就冷却一段时间，后续请求不再反复阻塞
export async function init() {
  if (sql) return sql
  if (Date.now() < retryat) return null
  try {
    return await connect()
  } catch (err) {
    retryat = Date.now() + retryms
    console.error(`[logstore] 连接 MySQL 失败，日志只留内存：${err.message}`)
    return null
  }
}

// 连接断了就丢掉旧实例，下批日志重新连一次
// 设置里改了库地址也走这里，conf 一并清掉，下次重读新参数
export function drop() {
  sql = null
  conf = null
  retryat = Date.now() + 5000
}

// 主页要显示库通不通，探一次真实连接，不能只看进程在不在
export async function ping() {
  const db = await init()
  if (!db) return false
  try {
    await db`SELECT 1`
    return true
  } catch {
    drop()
    return false
  }
}

// 版本、库名、表数、占用，主页展示用
export async function brief() {
  const db = await init()
  if (!db) throw new Error('日志库未连接')
  const one = await db.unsafe('SELECT VERSION() AS v, DATABASE() AS d')
  const size = await db.unsafe(
    'SELECT COUNT(*) AS t, COALESCE(SUM(data_length + index_length), 0) AS b FROM information_schema.tables WHERE table_schema = DATABASE()',
  )
  const id = one[0] || {}
  const info = size[0] || {}
  return {
    version: String(id.v || ''),
    name: String(id.d || ''),
    host: (conf && conf.host) || '',
    port: Number(conf && conf.port) || 0,
    tables: Number(info.t) || 0,
    bytes: Number(info.b) || 0,
  }
}

// 库地址：没连上也读得到，主页红着的时候照样能看见端口
export async function target() {
  if (conf) return conf
  conf = await dbconf()
  return conf
}

async function flush() {
  if (inflight || !queue.length) return
  // 先占位再 await：连库可能要等拉起 MariaDB，这期间不能再开第二个 flush
  inflight = true
  let rows = []
  try {
    const db = await init()
    if (!db) {
      // 库还没起来，留最近一批等冷却结束再写，不无限攒
      queue = queue.slice(-batchmax * 10)
      return
    }
    rows = queue
    queue = []
    if (!rows.length) return
    // 一条多值 INSERT 落一整批，避免每条日志一次往返
    const ph = rows.map(() => '(?, ?, ?, ?)').join(',')
    const args = rows.flatMap((it) => [it.at, daykey(it.at), it.level, String(it.msg)])
    await db.unsafe(`INSERT INTO logs (at, day, level, msg) VALUES ${ph}`, args)
  } catch (err) {
    // 写失败把批次塞回队头，下一轮重试，最多攒到 batchmax*10 条
    queue = rows.concat(queue).slice(-batchmax * 10)
    console.error(`[logstore] 写入失败，${queue.length} 条待重试：${err.message}`)
    // 连接类错误丢掉旧实例，让下一批重新走连库流程
    if (/connect|closed|gone|ECONN|ETIMEDOUT|refused/i.test(err.message)) drop()
  } finally {
    inflight = false
    // 后面还有积压就立刻接着写，不要每批都等满 200ms
    if (queue.length) schedule(queue.length >= batchmax ? 0 : delayms)
  }
}

function schedule(delay = delayms) {
  if (timer) return
  timer = setTimeout(() => {
    timer = null
    flush()
  }, delay)
}

// 日志进来先入队，攒够一批或等满 200ms 再落库
export function append(item) {
  queue.push(item)
  if (queue.length >= batchmax) {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    flush()
    return
  }
  schedule()
}

// 队列里的全写干净再返回，灌完要马上统计时用
export async function flushnow() {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  const until = Date.now() + 15000
  while ((inflight || queue.length) && Date.now() < until) {
    await flush()
    if (inflight || queue.length) await new Promise((r) => setTimeout(r, 15))
  }
}

// 按天翻查：day 为空就取今天，level 为空不过滤，q 走模糊匹配
export async function query(opts = {}) {
  const db = await init()
  if (!db) throw new Error('日志库未连接')
  const day = opts.day || daykey(Date.now())
  const level = String(opts.level || '').trim()
  const q = String(opts.q || '').trim()
  const limit = Math.max(1, Math.min(2000, Number(opts.limit) || 500))
  const offset = Math.max(0, Number(opts.offset) || 0)

  const where = ['day = ?']
  const args = [day]
  if (level && level !== 'all') {
    where.push('level = ?')
    args.push(level)
  }
  if (q) {
    where.push('msg LIKE ?')
    args.push(`%${q}%`)
  }
  const clause = where.join(' AND ')

  const rows = await db.unsafe(
    `SELECT id, at, level, msg FROM logs WHERE ${clause} ORDER BY at DESC, id DESC LIMIT ? OFFSET ?`,
    [...args, limit, offset],
  )
  const counted = await db.unsafe(`SELECT COUNT(*) AS n FROM logs WHERE ${clause}`, args)
  return {
    day,
    logs: rows.map((r) => ({ id: Number(r.id), at: Number(r.at), level: r.level, msg: r.msg })).reverse(),
    total: Number(counted[0] && counted[0].n) || 0,
  }
}

// 有日志的日期和条数，给前端日期选择用
export async function days(limit = 60) {
  const db = await init()
  if (!db) throw new Error('日志库未连接')
  const rows = await db.unsafe(
    'SELECT day, COUNT(*) AS n FROM logs GROUP BY day ORDER BY day DESC LIMIT ?',
    [Math.max(1, Math.min(365, Number(limit) || 60))],
  )
  return rows.map((r) => ({
    day: r.day instanceof Date ? daykey(r.day.getTime()) : String(r.day).slice(0, 10),
    n: Number(r.n) || 0,
  }))
}

// 存储概况：多少天、多少条、占多少字节，给设置页的管理面板用
export async function stat() {
  const db = await init()
  if (!db) throw new Error('日志库未连接')
  const rows = await db.unsafe('SELECT COUNT(*) AS n, COUNT(DISTINCT day) AS d FROM logs')
  const size = await db.unsafe(
    "SELECT COALESCE(data_length + index_length, 0) AS b FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'logs'",
  )
  return {
    rows: Number(rows[0] && rows[0].n) || 0,
    days: Number(rows[0] && rows[0].d) || 0,
    bytes: Number(size[0] && size[0].b) || 0,
  }
}

export async function clear(day) {
  const db = await init()
  if (!db) throw new Error('日志库未连接')
  if (day) return db.unsafe('DELETE FROM logs WHERE day = ?', [day])
  await db.unsafe('DELETE FROM logs')
  // InnoDB 删行不把空间还给系统，整表清完顺手回收一次
  try {
    await db.unsafe('OPTIMIZE TABLE logs')
  } catch {
    // 回收失败不影响数据已经删掉
  }
  return null
}
