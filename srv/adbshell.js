// 远程 shell：走 Shizuku 以 adb shell 权限在设备上执行命令
// 用仓库自带的 rish 与 dex，不再依赖用户机器上那份家酿的 ad 脚本
// so: ad 是本地适配产物，换台机器就没有；随仓库分发才能开箱即用

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// rish 在 srv/rish 下
// 源码直接跑时 import.meta.url 指向 srv/，编译成单文件后变成 /$bunfs 虚拟路径
// 两种情况下基准不同：源码是 srv/，二进制是仓库根（DSHROOT）
// so: 统一按「仓库根」算，避免二进制版拼出 <仓库根>/rish/rish 这种不存在的路径
const selfdir = path.dirname(fileURLToPath(import.meta.url))
const root = selfdir.startsWith('/$bunfs')
  ? path.resolve(process.env.DSHROOT || process.cwd())
  : path.resolve(selfdir, '..')
const RISH = path.join(root, 'srv', 'rish', 'rish')

// rish 只认调用方 app 的包名，填错的后果是所有请求静默超时
// Termux 的包名从数据目录末段取，官方版、F-Droid 版、改包名的分支版都能对上
// so: 不写死 com.termux，别人拿去也能直接跑
function appid() {
  const dirs = [process.env.TERMUX_APP__LEGACY_DATA_DIR, process.env.TERMUX_APP__DATA_DIR]
  for (const dir of dirs) {
    const name = String(dir || '').trim().replace(/\/+$/, '').split('/').pop()
    // 包名一定带点，纯目录名说明环境变量没给对
    if (name && name.includes('.')) return name
  }
  return 'com.termux'
}

// 结束标记：rish 不透传退出码，只能让远程自己回显一行
// 只有标记不够：dex 转发层会偶发丢字节、错顺序，标记行本身也会被拆坏
// so: 标记行除了退出码，还带上输出的字节数与 md5，本地对不上就知道这趟传坏了
const mark = '__adbshell_rc='
const markre = /^__adbshell_rc=(\d+) (\d+) ([0-9a-f]{32})$/

// 远程侧把输出先落一份临时文件，跑完再算长度与校验和
// so: 直接对着管道算不了校验和，必须有一份完整的中间产物
// so: 临时文件放 /data/local/tmp，那是 shell 用户可写的唯一稳定位置
function wrap(script) {
  return [
    'f=/data/local/tmp/.dsho.$$',
    `( ${script} ) > "$f" 2>&1`,
    'rc=$?',
    'n=$(wc -c < "$f" | tr -d " ")',
    'c=$(md5sum "$f" | cut -d" " -f1)',
    'cat "$f"',
    'rm -f "$f"',
    `printf '\\n${mark}%s %s %s\\n' "$rc" "$n" "$c"`,
  ].join('\n')
}

// 剥掉结束标记行，返回真正的输出
// 标记行由 printf 带一个前导换行发出，所以要按位置切，并且只去掉那一个换行
// so: 用 replace(/\n+$/) 会连正文自身的尾部空行一起吃掉，校验和就对不上了
function split(raw) {
  const lines = raw.split('\n')
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const m = markre.exec(lines[i].trim())
    if (!m) continue
    // 标记行之前的内容原样保留
    // so: printf 那个前导换行在 split 时已经变成行分隔符，不能再减一次
    const body = lines.slice(0, i).join('\n')
    return { hit: m, body }
  }
  return { hit: null, body: raw }
}

// 单次执行的超时兜底：超时了就杀掉子进程，别让一个卡住的服务拖住整轮
async function once(script, timeout) {
  return new Promise((resolve) => {
    const body = wrap(script)
    let child
    try {
      // 交一层 sh 做两件事
      // 一是 2>&1，把 rish 的输出并成一路；二是 | cat，让输出串行吐出
      // so: rish 的 dex 转发层在并发写时会丢字节、错顺序，实测裸接 30 次坏 29 次，
      //     两个管道同时收时 40 次坏 1 到 2 次，加 | cat 后大幅收敛但仍会漏
      //     所以真正兜底的是标记行里的长度与 md5，对不上就重发
      child = spawn('/system/bin/sh', ['-c', 'exec "$0" -c "$1" 2>&1 | cat', RISH, body], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: Object.assign({}, process.env, { RISH_APPLICATION_ID: appid() }),
      })
    } catch (err) {
      resolve({ ok: false, out: '', err: err.message })
      return
    }
    let raw = ''
    child.stdout.on('data', (d) => {
      raw += d
    })
    // 合并之后 stderr 只剩极少数异常，仍收一份防止内容漏掉
    child.stderr.on('data', (d) => {
      raw += d
    })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve({ ok: false, out: split(raw).body, err: 'timeout' })
    }, timeout)
    child.on('error', (err) => {
      clearTimeout(timer)
      // 找不到 rish 时给一句能看懂的提示，别只丢个 ENOENT
      const miss = err.code === 'ENOENT' ? `找不到 ${RISH}` : err.message
      resolve({ ok: false, out: '', err: miss })
    })
    child.on('close', () => {
      clearTimeout(timer)
      const { hit, body } = split(raw)
      if (!hit) {
        // 标记没回来，说明远程侧没跑起来，或者标记行本身被传坏了
        resolve({ ok: false, out: body, err: 'no rc' })
        return
      }
      const code = Number(hit[1])
      const want = Number(hit[2])
      const sum = hit[3]
      // 长度与 md5 都对上才算传完整，任一不符都让上层重发
      // so: 字符被换序时长度不变，只有 md5 能抓出来
      const got = Buffer.from(body, 'utf8')
      const real = createHash('md5').update(got).digest('hex')
      if (got.length !== want || real !== sum) {
        resolve({ ok: false, out: body, err: 'broken' })
        return
      }
      resolve({ ok: code === 0, out: body, err: '' })
    })
  })
}

// 传坏了就重发，最多三趟
// 实测 rish 的转发层偶发丢字节或错顺序，概率在百分之一量级
// so: 面板每 2.5 秒轮询一次，不重试就会被放大成满屏红点
// so: 重发是无副作用的 —— 传坏的那趟本来就没把结果交付出去
const tries = 3

export async function run(script, timeout = 20000) {
  let last = null
  for (let i = 0; i < tries; i += 1) {
    last = await once(script, timeout)
    if (last.ok) return last
    // 命令真的跑完了只是返回非零，说明远侧执行过了，不该再跑一遍
    // 超时也不重试：重试只会让调用方多等一倍时间
    if (last.err !== 'no rc' && last.err !== 'broken') return last
  }
  return last
}
