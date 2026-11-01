// 调试用的强制开关：把某一段假装成坏掉或假装成正常，用来验证页面和降级逻辑
// so: 只影响自检结果和接口清单的展示，不真的去关服务，排查完记得清空

import { getsettings } from './settings.js'

// 可用 token 与各段一一对应，前端下拉里也列这一份
export const tokens = [
  { id: 'svc', label: 'dsh 服务' },
  { id: 'db', label: 'MariaDB' },
  { id: 'adb', label: 'Shizuku / ad' },
  { id: 'models', label: '上游模型' },
  { id: 'tls', label: '上游链路' },
  { id: 'tpl', label: '模板工具' },
  { id: 'disk', label: '状态目录' },
  { id: 'responses', label: 'Responses 接口' },
  { id: 'raw', label: 'opencode 入口' },
]

function split(text) {
  return new Set(
    String(text || '')
      .split(/[,，\s]+/)
      .map((one) => one.trim().toLowerCase())
      .filter((one) => tokens.some((it) => it.id === one)),
  )
}

// 返回该 token 被强制成什么：ok 强制正常、fail 强制失败、null 不干预
export function forced(id) {
  const s = getsettings()
  if (split(s.forceoff).has(id)) return 'fail'
  if (split(s.forceon).has(id)) return 'ok'
  return null
}

export function describe() {
  const s = getsettings()
  const off = [...split(s.forceoff)]
  const on = [...split(s.forceon)]
  if (!off.length && !on.length) return ''
  const bits = []
  if (off.length) bits.push(`强制失败 ${off.join('、')}`)
  if (on.length) bits.push(`强制正常 ${on.join('、')}`)
  return bits.join(' · ')
}
