// 请求入口：同一套代理，按 URL 前缀决定出站那个 read 工具能不能被调用
// so: 客户端大多只能改 base_url 里的一段，路径前缀和端口一样好配，但不用多开监听

export const entries = [
  { id: 'main', marker: '', path: '/v1', mute: true, label: '默认' },
  { id: 'raw', marker: '/raw', path: '/v1', mute: false, label: 'opencode' },
]

const bases = ['/v1', '/models', '/health']

// 返回 { entry, rest }，rest 是剥掉入口前缀后的路径，交给代理当 /v1 处理
export function pick(pathname) {
  for (const one of entries) {
    if (!one.marker) continue
    if (pathname === one.marker) return null
    if (!pathname.startsWith(one.marker + '/')) continue
    const rest = pathname.slice(one.marker.length)
    if (bases.some((base) => rest === base || rest.startsWith(base + '/'))) return { entry: one, rest }
    return null
  }
  if (bases.some((base) => pathname === base || pathname.startsWith(base + '/'))) {
    return { entry: entries[0], rest: pathname }
  }
  return null
}
