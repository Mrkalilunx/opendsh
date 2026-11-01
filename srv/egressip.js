// 出口 IP 查询：可指定代理，返回真正出网的地址
// 依次尝试多个服务，单个被墙或超时不影响整体

const endpoints = [
  { url: 'https://ipinfo.io/ip', parse: (text) => text.trim() },
  { url: 'https://ifconfig.me/ip', parse: (text) => text.trim() },
  { url: 'https://www.cloudflare.com/cdn-cgi/trace', parse: (text) => (text.match(/^ip=(.+)$/m) || [])[1] },
]

const shape = /^[0-9a-f:.]{3,45}$/i

export async function lookup(proxy = null) {
  const errors = []

  for (const point of endpoints) {
    const opts = {
      headers: { 'user-agent': 'curl/8.0' },
      signal: AbortSignal.timeout(6000),
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
