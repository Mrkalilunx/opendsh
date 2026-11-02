// 出口 IP 查询：可指定代理，返回真正出网的地址
// 依次尝试多个服务，单个被墙或超时不影响整体
// cf trace 排第一：实测它 608ms 最快，另外两个要 1 秒以上

const endpoints = [
  { url: 'https://www.cloudflare.com/cdn-cgi/trace', parse: (text) => (text.match(/^ip=(.+)$/m) || [])[1] },
  { url: 'https://ipinfo.io/ip', parse: (text) => text.trim() },
  { url: 'https://ifconfig.me/ip', parse: (text) => text.trim() },
]

const shape = /^[0-9a-f:.]{3,45}$/i

// fast 为真时只打第一个端点：换 IP 期间要高频轮询，三个端点串行会把每轮拖长
export async function lookup(proxy = null, timeoutms = 6000, fast = false) {
  const errors = []
  const list = fast ? endpoints.slice(0, 1) : endpoints

  for (const point of list) {
    const opts = {
      headers: { 'user-agent': 'curl/8.0' },
      signal: AbortSignal.timeout(Math.max(500, Number(timeoutms) || 6000)),
    }
    if (proxy) opts.proxy = proxy

    try {
      const res = await fetch(point.url, opts)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const text = await res.text()
      const ip = String(point.parse(text) || '').trim()
      if (!shape.test(ip)) throw new Error('返回格式异常')
      return ip
    } catch (err) {
      errors.push(err.message)
    }
  }

  throw new Error(`连接失败：${errors[0] || '未知错误'}`)
}
