// 用量统计：按天、按模型、按来源把 token 汇总出来，供用量页展示
// 数据全部来自 requests 表，不额外记录，省一份存储也省一次对账

import * as reqstore from './reqstore.js'
import { listmodels } from './upstream.js'
import { daykey } from './daykey.js'

let conn = null
let retryat = 0
const retryms = 30000

async function db() {
  if (conn) return conn
  if (Date.now() < retryat) throw new Error('日志库未连接')
  // 先让请求记录那边把表建好、列补齐，否则新加的 token 列会查不到
  const ready = await reqstore.schema()
  if (!ready) {
    retryat = Date.now() + retryms
    throw new Error('日志库未连接')
  }
  conn = ready
  return conn
}

function drop(err) {
  if (!/connect|closed|gone|ECONN|ETIMEDOUT|refused/i.test(err && err.message ? err.message : '')) return
  conn = null
  retryat = Date.now() + retryms
}

// 统一把数字列转成纯数字，库驱动有时给字符串
const n = (v) => Number(v) || 0

// 词表：值可能是 Date 也可能是字符串，统一成 yyyy-mm-dd
function daytext(v) {
  return v instanceof Date ? daykey(v.getTime()) : String(v).slice(0, 10)
}

const zero = () => ({
  calls: 0,
  ptok: 0,
  ctok: 0,
  ttok: 0,
  cachetok: 0,
  reasontok: 0,
  newtok: 0,
  newtotal: 0,
})

// 单价表：从上游模型列表里摘下来，按百万 token 计价
// 拿不到价格的模型按 0 算，免费模型本来也是 0
let priceat = 0
let pricemap = new Map()

function priceof(one) {
  const text = (one && one.cost && one.cost.text) || {}
  const input = Number((text.input || {}).price) || 0
  const cache = Number(((text.input || {}).cache || {}).read) || 0
  const output = Number((text.output || {}).price) || 0
  return { input, cache, output }
}

async function prices() {
  // 模型价格很少变，十分钟取一次就够，拿不到就沿用上一份
  if (Date.now() - priceat < 600000 && pricemap.size) return pricemap
  try {
    const list = await listmodels()
    const next = new Map()
    for (const one of list || []) {
      if (!one || !one.id) continue
      next.set(String(one.id), priceof(one))
    }
    if (next.size) {
      pricemap = next
      priceat = Date.now()
    }
  } catch {
    // 上游不通就先不算钱，别把整个用量页拖垮
  }
  return pricemap
}

// 花费 = 未命中缓存的输入 + 命中缓存的输入 + 输出，各自乘各自单价
// 缓存命中那部分已经在 ptok 里含了，要减掉避免重复计
function money(one, price) {
  if (!price) return 0
  const hit = Math.min(Number(one.cachetok) || 0, Number(one.ptok) || 0)
  const fresh = Math.max(0, (Number(one.ptok) || 0) - hit)
  const out = Number(one.ctok) || 0
  return (fresh * price.input + hit * price.cache + out * price.output) / 1000000
}

// 按模型分别算价，返回总量和每种模型的花费，方便排行里显示
function costing(rows, price) {
  let usd = 0
  const bymodel = new Map()
  for (const one of rows) {
    const unit = price.get(one.model)
    const cost = money(one, unit)
    usd += cost
    bymodel.set(one.model, (bymodel.get(one.model) || 0) + cost)
  }
  return { usd, bymodel }
}

function merge(into, row) {
  into.calls += n(row.n)
  into.ptok += n(row.ptok)
  into.ctok += n(row.ctok)
  into.ttok += n(row.ttok)
  into.cachetok += n(row.cachetok)
  into.reasontok += n(row.reasontok)
  // 新增输入 = 输入去掉命中缓存的部分，这才是本轮真要算的量
  // 单条缓存理论上不会超过输入，兜底取 0，避免异常数据把总量拉成负数
  const fresh = Math.max(0, n(row.ptok) - n(row.cachetok))
  into.newtok += fresh
  // 新增总量再并上输出，顶部大数字用这个，别拿含缓存的数当门面
  into.newtotal += fresh + n(row.ctok)
  return into
}

// 汇总函数：一次把首页要的几块都算好，前端不用拼多次请求
// opts.days 控制趋势里铺多少天，默认最近 14 天
export async function summary(opts = {}) {
  const days = Math.max(1, Math.min(90, Number(opts.days) || 14))
  const today = daykey(Date.now())
  const from = daykey(Date.now() - (days - 1) * 86400000)

  try {
    const db1 = await db()

    // 总量：只算真正调模型的那些路径，模型列表之类不产生 token
    const allRes = await db1.unsafe(
      `SELECT COUNT(*) AS n, COALESCE(SUM(ptok),0) AS ptok, COALESCE(SUM(ctok),0) AS ctok,
              COALESCE(SUM(ttok),0) AS ttok, COALESCE(SUM(cachetok),0) AS cachetok,
              COALESCE(SUM(reasontok),0) AS reasontok
         FROM requests WHERE (model <> '' OR ttok > 0)`,
    )
    const total = merge(zero(), allRes[0] || {})

    // 区间汇总：卡片和排行都按当前选的区间算，累计值另算一份放脚注
    const rangeRes = await db1.unsafe(
      `SELECT COUNT(*) AS n, COALESCE(SUM(ptok),0) AS ptok, COALESCE(SUM(ctok),0) AS ctok,
              COALESCE(SUM(ttok),0) AS ttok, COALESCE(SUM(cachetok),0) AS cachetok,
              COALESCE(SUM(reasontok),0) AS reasontok
         FROM requests WHERE day >= ? AND (model <> '' OR ttok > 0)`,
      [from],
    )
    const range = merge(zero(), rangeRes[0] || {})

    const todayRes = await db1.unsafe(
      `SELECT COUNT(*) AS n, COALESCE(SUM(ptok),0) AS ptok, COALESCE(SUM(ctok),0) AS ctok,
              COALESCE(SUM(ttok),0) AS ttok, COALESCE(SUM(cachetok),0) AS cachetok,
              COALESCE(SUM(reasontok),0) AS reasontok
         FROM requests WHERE day = ? AND (model <> '' OR ttok > 0)`,
      [today],
    )
    const todayone = merge(zero(), todayRes[0] || {})

    // 趋势：没有记录的日子也要占位，折线才不会跳着走
    const daily = await db1.unsafe(
      `SELECT day, COUNT(*) AS n, COALESCE(SUM(ptok),0) AS ptok, COALESCE(SUM(ctok),0) AS ctok,
              COALESCE(SUM(ttok),0) AS ttok, COALESCE(SUM(cachetok),0) AS cachetok,
              COALESCE(SUM(reasontok),0) AS reasontok
         FROM requests WHERE day >= ? AND (model <> '' OR ttok > 0) GROUP BY day ORDER BY day`,
      [from],
    )
    const held = new Map(daily.map((r) => [daytext(r.day), r]))
    const trend = []
    for (let i = days - 1; i >= 0; i -= 1) {
      const day = daykey(Date.now() - i * 86400000)
      const row = held.get(day)
      trend.push({ day, ...(row ? merge(zero(), row) : zero()) })
    }

    // 这里不设条数上限：花费要按全部模型算，只在返回时才截断给页面看
    const models = await db1.unsafe(
      `SELECT model, COUNT(*) AS n, COALESCE(SUM(ptok),0) AS ptok, COALESCE(SUM(ctok),0) AS ctok,
              COALESCE(SUM(ttok),0) AS ttok, COALESCE(SUM(cachetok),0) AS cachetok,
              COALESCE(SUM(reasontok),0) AS reasontok
         FROM requests WHERE day >= ? AND (model <> '' OR ttok > 0) GROUP BY model ORDER BY SUM(ttok) DESC`,
      [from],
    )

    const sources = await db1.unsafe(
      `SELECT source, COUNT(*) AS n, COALESCE(SUM(ptok),0) AS ptok, COALESCE(SUM(ctok),0) AS ctok,
              COALESCE(SUM(ttok),0) AS ttok, COALESCE(SUM(cachetok),0) AS cachetok,
              COALESCE(SUM(reasontok),0) AS reasontok
         FROM requests WHERE day >= ? AND (model <> '' OR ttok > 0) GROUP BY source ORDER BY SUM(ttok) DESC`,
      [from],
    )

    // 活跃天数：有请求的日子
    const activeRes = await db1.unsafe(
      `SELECT COUNT(DISTINCT day) AS n FROM requests WHERE day >= ? AND (model <> '' OR ttok > 0)`,
      [from],
    )

    // 成功率与平均耗时：只统计真正调模型的请求，模型列表这类不掺进来
    const qualRes = await db1.unsafe(
      `SELECT COUNT(*) AS n,
              COALESCE(SUM(status BETWEEN 200 AND 299), 0) AS ok,
              COALESCE(AVG(ms), 0) AS avgms,
              COALESCE(MAX(ms), 0) AS maxms
         FROM requests WHERE day >= ? AND (model <> '' OR ttok > 0)`,
      [from],
    )
    const qual = qualRes[0] || {}
    const quality = {
      calls: n(qual.n),
      ok: n(qual.ok),
      avgms: Math.round(n(qual.avgms)),
      maxms: n(qual.maxms),
    }

    // 花费按模型单价算，同一套价格也用来给每种模型标价
    const price = await prices()
    const modelrows = models.map((r) => ({ model: r.model || '未记录', ...merge(zero(), r) }))
    const sourcerows = sources.map((r) => ({ source: r.source || 'other', ...merge(zero(), r) }))
    const rangecost = costing(modelrows, price)
    // 累计花费要覆盖全部历史，跟区间无关，另按模型归一次
    const lifemodels = await db1.unsafe(
      `SELECT model, COUNT(*) AS n, COALESCE(SUM(ptok),0) AS ptok, COALESCE(SUM(ctok),0) AS ctok,
              COALESCE(SUM(ttok),0) AS ttok, COALESCE(SUM(cachetok),0) AS cachetok,
              COALESCE(SUM(reasontok),0) AS reasontok
         FROM requests WHERE (model <> '' OR ttok > 0) GROUP BY model`,
    )
    const lifecost = costing(
      lifemodels.map((r) => ({ model: r.model || '未记录', ...merge(zero(), r) })),
      price,
    )
    const todaycost = costing(
      await db1.unsafe(
        `SELECT model, COUNT(*) AS n, COALESCE(SUM(ptok),0) AS ptok, COALESCE(SUM(ctok),0) AS ctok,
                COALESCE(SUM(ttok),0) AS ttok, COALESCE(SUM(cachetok),0) AS cachetok,
                COALESCE(SUM(reasontok),0) AS reasontok
           FROM requests WHERE day = ? AND (model <> '' OR ttok > 0) GROUP BY model`,
        [today],
      ).then((rows) => rows.map((r) => ({ model: r.model || '未记录', ...merge(zero(), r) }))),
      price,
    )

    return {
      at: Date.now(),
      today,
      days,
      from,
      total,
      range,
      today: todayone,
      active: n(activeRes[0] && activeRes[0].n),
      quality,
      cost: { usd: lifecost.usd, today: todaycost.usd, range: rangecost.usd },
      trend,
      models: modelrows
        .slice(0, 20)
        .map((one) => ({ ...one, usd: rangecost.bymodel.get(one.model) || 0 })),
      sources: sourcerows.slice(0, 20),
    }
  } catch (err) {
    drop(err)
    throw err
  }
}
