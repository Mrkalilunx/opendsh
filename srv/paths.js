// 数据路径：状态文件放哪儿、数据库连哪儿，全从这里取
// 默认全放 ~/.local/share/dsh，跟着 XDG 走，卸载 Termux 时也留在 home 里
// so: 设置文件是唯一必须住原地的引导件，它要是跟着搬，改目录后就找不到自己在哪

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getsettings } from './settings.js'

const selfdir = path.dirname(fileURLToPath(import.meta.url))
// 编译成单文件后这里是虚拟路径，引导目录得跟着仓库走，否则读不到老设置
const here = selfdir.startsWith('/$bunfs') ? (process.env.DSHROOT || process.cwd()) : selfdir
// 引导目录：settings.json 永远住这里，不受设置影响
const home = path.join(here, '.state')
// 默认数据根目录
const root = path.join(os.homedir(), '.local', 'share', 'dsh')

export function expand(raw) {
  let text = String(raw || '').trim()
  if (!text) return ''
  if (text === '~') text = os.homedir()
  else if (text.startsWith('~/')) text = path.join(os.homedir(), text.slice(2))
  const prefix = process.env.PREFIX || '/data/data/com.termux/files/usr'
  text = text.replace(/^\$PREFIX/, prefix)
  return path.resolve(text)
}

// 状态目录：设置里没填就用 ~/.local/share/dsh
export function statedir() {
  const custom = expand(getsettings().statedir)
  return custom || root
}

// 默认数据根，设置页展示「默认」时用
export function dataroot() {
  return root
}

// 读状态文件：当前目录找不到就依次退回默认根目录和老目录，换目录不丢老数据
export async function readstate(name) {
  const tried = new Set()
  for (const dir of [statedir(), root, home]) {
    if (tried.has(dir)) continue
    tried.add(dir)
    try {
      return await readFile(path.join(dir, name), 'utf8')
    } catch {
      // 这一处没有就试下一处
    }
  }
  throw new Error(`${name} 不存在`)
}

// 写一律写当前目录，旧目录不再动
export async function writestate(name, text) {
  const dir = statedir()
  await mkdir(dir, { recursive: true })
  const file = path.join(dir, name)
  await writeFile(file, text, 'utf8')
  return file
}

export async function savestate(name, value) {
  return writestate(name, JSON.stringify(value, null, 2) + '\n')
}

export async function readjson(name, fallback = null) {
  try {
    return JSON.parse(await readstate(name))
  } catch {
    return fallback
  }
}

// MariaDB 的数据目录，改完要重新拉起库才生效
// 默认跟着状态目录一起放在 ~/.local/share/dsh/mysql
export function datadir() {
  const custom = expand(getsettings().dbdatadir)
  if (custom) return custom
  return path.join(root, 'mysql')
}

// 连接参数以设置为主，老 mysql.json 兜底，方便升级后不用重填
// 每项单独兜底：只改地址时用户名密码仍沿用库里原来那套
export async function dbconf() {
  const s = getsettings()
  const old = (await readjson('mysql.json', {})) || {}
  return {
    host: s.dbhost || old.host || '127.0.0.1',
    port: Number(s.dbport) || Number(old.port) || 3306,
    user: s.dbuser || old.user || 'root',
    password: s.dbpass !== '' && s.dbpass !== undefined ? s.dbpass : old.password || '',
    database: s.dbname || old.database || 'dsh',
  }
}
