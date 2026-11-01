// 支持的接口清单：首页展示用，能否使用完全跟着设置走
// so: 端点是静态的，开关是动态的，放在一起算一次就不用前端自己判断了

import { getsettings } from './settings.js'
import { forced } from './overrides.js'

export function list() {
  const s = getsettings()
  // 调试里的强制开关优先：强制关掉就当没开，强制打开就当开了
  const sw = (key, value) => {
    const force = forced(key)
    if (force === 'fail') return false
    if (force === 'ok') return true
    return Boolean(value)
  }

  return [
    {
      id: 'chat',
      method: 'POST',
      path: '/v1/chat/completions',
      note: '聊天补全，绝大多数客户端用这个',
      use: 'OpenAI SDK、各类机器人框架',
      on: true,
    },
    {
      id: 'completions',
      method: 'POST',
      path: '/v1/completions',
      note: '老式文本补全，接旧客户端用',
      use: '早期工具、简单的文本生成',
      on: true,
    },
    {
      id: 'responses',
      method: 'POST',
      path: '/v1/responses',
      note: 'Responses API，Codex 这类客户端要走',
      use: 'codex、支持 Responses 的客户端',
      on: sw('responses', s.responses),
      hint: '设置 › 网络 › Responses API',
    },
    {
      id: 'models',
      method: 'GET',
      path: '/v1/models',
      note: '列出可用模型，含映射出来的名字',
      use: '客户端拉模型列表',
      on: true,
    },
    {
      id: 'modelone',
      method: 'GET',
      path: '/v1/models/{id}',
      note: '查单个模型是否存在',
      use: '客户端按名字校验',
      on: true,
    },
    {
      id: 'health',
      method: 'GET',
      path: '/health',
      note: '健康检查，回服务状态和模型数',
      use: '探活脚本、容器健康检查',
      on: true,
    },
    {
      id: 'rawchat',
      method: 'POST',
      path: '/raw/v1/chat/completions',
      note: 'opencode 专用，不抑制模板工具',
      use: 'opencode',
      on: sw('raw', s.rawentry),
      hint: '设置 › 工具 › opencode 入口',
    },
    {
      id: 'rawresp',
      method: 'POST',
      path: '/raw/v1/responses',
      note: 'opencode 专用，Responses 协议',
      use: 'opencode',
      on: sw('raw', s.rawentry) && sw('responses', s.responses),
      hint: s.rawentry ? '设置 › 网络 › Responses API' : '设置 › 工具 › opencode 入口',
    },
  ]
}
