// 出口 IP 查询：可指定代理，返回真正出网的地址
// 依次尝试多个服务，单个被墙或超时不影响整体
// 只用回 IPv4 的端点：双栈端点会让同一个出口在两族地址间跳
// so: 换 IP 期间要判断地址变没变，地址族一跳就会被误判成换了新出口

const endpoints = [
  { url: 'https://ipinfo.io/ip', parse: (text) => text.trim() },
  { url: 'https://ipv4.icanhazip.com', parse: (text) => text.trim() },
  { url: 'https://ifconfig.me/ip', parse: (text) => text.trim() },
]

// 必须是以点分四段的 IPv4：IPv6 的网卡地址在换出口时也常变
// 但上游额度与出口路径对应，混着比会让变没变失去意义
const shape = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

function validip(ip) {
  if (!shape.test(ip)) return false
  return ip.split('.').every((one) => Number(one) <= 255)
}

// fast 为真时只打第一个端点：换 IP 期间要高频轮询，多个端点串行会把每轮拖长
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
      if (!validip(ip)) throw new Error(`返回的不是 IPv4：${ip.slice(0, 40)}`)
      return ip
    } catch (err) {
      errors.push(err.message)
    }
  }

  throw new Error(`连接失败：${errors[0] || '未知错误'}`)
}
