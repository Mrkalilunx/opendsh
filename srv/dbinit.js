// 建库：库不存在时先把库补上，再让上层连过去建表
// 只管「库」这一层，账号与权限不碰，免得擅自改动别人的凭据
// so: 新机器上装好 MariaDB 之后，服务端能起，但 dsh 这个库还不存在，
//     直接连会报 1049，上层就降级成只进内存，记录功能等于全废

import { SQL } from 'bun'

// 库名要拼进 SQL，反引号加倍转义，防止名字里带反引号把语句拆坏
function quote(name) {
  return '`' + String(name).replace(/`/g, '``') + '`'
}

// 连服务端但不指定库：CREATE DATABASE 是服务级语句，不依赖当前在哪个库
// so: 这里不能带库名，带了就又回到 1049，死循环
function server(cfg) {
  const url = `mysql://${cfg.user}:${encodeURIComponent(cfg.password)}@${cfg.host}:${cfg.port}`
  return new SQL({ url, max: 1, idleTimeout: 5, connectionTimeout: 8000 })
}

export async function ensuredb(cfg) {
  const name = String(cfg.database || '').trim()
  if (!name) throw new Error('库名为空，无法建库')
  const db = server(cfg)
  try {
    await db.unsafe(
      `CREATE DATABASE IF NOT EXISTS ${quote(name)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    )
    return { created: true, name }
  } finally {
    try {
      await db.close()
    } catch {
      // 关不掉不影响建库结果，上层照常重连
    }
  }
}
