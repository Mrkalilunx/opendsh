// 日志与请求统计共用的日期键：本地时区的 YYYY-MM-DD
// 不能用 toISOString，那是 UTC，东八区凌晨会算到前一天，按天汇总就对不上

function pad(n) {
  return String(n).padStart(2, '0')
}

export function daykey(at) {
  const d = new Date(at)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
