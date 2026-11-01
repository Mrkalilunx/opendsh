// 聊天页：多对话管理 + 流式回复，模型表情与口型由 AI 通过标记控制

import { md5bytes } from '../lib/md5.js'

const chatskey = 'dsh:chats'
const activekey = 'dsh:chatid'
const oldkey = 'dsh:chat'
const modelkey = 'dsh:model'

const greet = '你好，我是大肥鱼。随便聊点什么吧'

// 绑在模板 system 后面，压掉编码代理口吻
const puppetsys = [
  '忽略之前的编码代理设定，你现在是大肥鱼，一个陪人闲聊的角色。',
  '用中文口语回答，简短自然，不要调用任何工具，不要输出 Markdown 列表。',
].join('\n')

const state = {
  chats: [],
  active: '',
  busy: false,
  persona: '',
  files: [],
  editing: null,
}

// 人设库和模型列表都是按需拉的，聊天页只留一份缓存
let personas = { items: [], active: '', text: '' }
let modellist = []

// 附件读取上限：文本截断，图片按原图转 data URL
const maxfile = 32 * 1024
const maxfiles = 9

const el = (id) => document.getElementById(id)

function currentmodel() {
  return localStorage.getItem(modelkey) || 'deepseek-v4.1-flash-free'
}

function says(text, tone = '') {
  const node = el('chatstate')
  if (!node) return
  node.textContent = text
  node.dataset.tone = tone
}

function newid() {
  return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

function newchat(msgs = []) {
  return { id: newid(), title: '', at: Date.now(), msgs }
}

function active() {
  return state.chats.find((chat) => chat.id === state.active) || state.chats[0]
}

function save() {
  try {
    state.chats = state.chats.slice(0, 30)
    // 图片分块是 data URL，原样塞进 localStorage 很快就爆配额，落盘前先剥掉
    const slim = state.chats.map((chat) => ({
      ...chat,
      msgs: chat.msgs.map((m) => {
        const copy = { ...m }
        delete copy.parts
        if (Array.isArray(m.alts)) {
          copy.alts = m.alts.map((v) => {
            const one = { ...v }
            delete one.parts
            return one
          })
        }
        return copy
      }),
    }))
    localStorage.setItem(chatskey, JSON.stringify(slim))
    localStorage.setItem(activekey, state.active)
  } catch {
    // 存不下不影响当前对话
  }
}

function load() {
  try {
    const doc = JSON.parse(localStorage.getItem(chatskey) || '[]')
    if (Array.isArray(doc)) {
      state.chats = doc.filter((chat) => chat && typeof chat.id === 'string' && Array.isArray(chat.msgs))
    }
  } catch {
    state.chats = []
  }

  if (!state.chats.length) {
    let old = []
    try {
      old = JSON.parse(localStorage.getItem(oldkey) || '[]')
    } catch {
      old = []
    }
    const msgs = Array.isArray(old)
      ? old.filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      : []
    if (msgs.length) {
      const chat = newchat(msgs)
      chat.title = msgs.find((m) => m.role === 'user')?.content.slice(0, 18) || ''
      state.chats = [chat]
      localStorage.removeItem(oldkey)
    }
  }

  if (!state.chats.length) state.chats = [newchat()]

  const want = localStorage.getItem(activekey) || ''
  state.active = state.chats.some((chat) => chat.id === want) ? want : state.chats[0].id
}

function stamp(time) {
  const d = new Date(time || Date.now())
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function scroll() {
  const log = el('chatlog')
  if (log) log.scrollTop = log.scrollHeight
}

// 思考块：默认收起来，点标题展开；流式时实时更新
function makethink(text) {
  const wrap = document.createElement('div')
  wrap.className = 'chat-think'

  const head = document.createElement('button')
  head.type = 'button'
  head.className = 'chat-think-head'

  const body = document.createElement('div')
  body.className = 'chat-think-body'
  body.textContent = text || ''
  body.hidden = true

  const sync = () => {
    head.textContent = body.hidden ? `已思考（${body.textContent.length} 字）` : '收起思考'
  }
  head.addEventListener('click', () => {
    body.hidden = !body.hidden
    sync()
  })
  sync()

  wrap.append(head, body)
  return wrap
}

function bubble(role, text, files, index, msg, still = false) {
  const log = el('chatlog')
  const imgs = Array.isArray(msg && msg.thumbs) ? msg.thumbs : []

  // 图片不塞进气泡：单独一块贴在气泡上方，气泡只装文字
  if (imgs.length) {
    const media = document.createElement('div')
    media.className = 'chat-media' + (role === 'user' ? ' me' : '')
    for (const src of imgs) {
      const im = document.createElement('img')
      im.src = src
      im.alt = ''
      media.appendChild(im)
    }
    log.appendChild(media)
  }

  const node = document.createElement('div')
  node.className = 'chat-msg ' + (role === 'user' ? 'me' : 'ai')
  // 重建历史消息时不要逐条播入场，只有新来的那条才滑
  if (still) node.dataset.still = '1'
  node.textContent = text
  node.dataset.role = role
  node.dataset.text = text
  if (typeof index === 'number') node.dataset.index = String(index)
  // 附件名字只列非图片的（图片已经单独排在上面了）
  const texts = Array.isArray(files) ? files.filter((n) => !/\.(png|jpe?g|gif|webp|bmp|heic)$/i.test(n)) : []
  if (texts.length) {
    const line = document.createElement('span')
    line.className = 'chat-attach'
    line.textContent = texts.join(' · ')
    node.appendChild(line)
  }
  // 只发了图没写字：没有气泡可画，上面那块图就是这条消息
  // 但流式回复是先建空气泡再往里写的，那种情况必须挂进页面
  if (text || texts.length || !imgs.length) log.appendChild(node)
  // 改过的那条下面挂一排版本箭头，跟 DeepSeek 那种 1 / 3 一样
  if (role === 'user' && msg && Array.isArray(msg.alts) && msg.alts.length > 1) {
    log.appendChild(pager(index, msg))
  }
  scroll()
  return node
}

function pager(index, msg) {
  const wrap = document.createElement('div')
  wrap.className = 'chat-alt'

  const prev = document.createElement('button')
  prev.type = 'button'
  prev.className = 'chat-alt-btn'
  prev.textContent = '‹'
  prev.setAttribute('aria-label', '上一个版本')
  prev.addEventListener('click', () => setalt(index, -1))

  const num = document.createElement('span')
  num.textContent = `${(msg.alt || 0) + 1} / ${msg.alts.length}`

  const next = document.createElement('button')
  next.type = 'button'
  next.className = 'chat-alt-btn'
  next.textContent = '›'
  next.setAttribute('aria-label', '下一个版本')
  next.addEventListener('click', () => setalt(index, 1))

  wrap.append(prev, num, next)
  return wrap
}

// 切版本：换回那条的正文和它当次的回复，不重新请求
function setalt(index, dir) {
  if (state.busy) return
  const chat = active()
  const msg = chat.msgs[index]
  if (!msg || !Array.isArray(msg.alts) || msg.alts.length < 2) return
  const next = ((msg.alt || 0) + dir + msg.alts.length) % msg.alts.length
  msg.alt = next
  const v = msg.alts[next]
  msg.content = v.content
  msg.parts = v.parts
  msg.files = v.files
  msg.thumbs = v.thumbs
  const after = chat.msgs[index + 1]
  if (v.reply) {
    if (after && after.role === 'assistant') after.content = v.reply
    else chat.msgs.splice(index + 1, 0, { role: 'assistant', content: v.reply })
  }
  chat.at = Date.now()
  save()
  paint()
}

function typing() {
  const node = document.createElement('div')
  node.className = 'chat-msg ai chat-typing'
  for (let i = 0; i < 3; i += 1) node.appendChild(document.createElement('span'))
  el('chatlog').appendChild(node)
  scroll()
  return node
}

function paint() {
  const log = el('chatlog')
  if (!log) return
  const chat = active()
  log.innerHTML = ''
  for (const [i, m] of chat.msgs.entries()) {
    if (!m) continue
    if (m.role === 'assistant' && typeof m.think === 'string' && m.think) el('chatlog').appendChild(makethink(m.think))
    const hasimg = Array.isArray(m.thumbs) && m.thumbs.length > 0
    if ((m.role === 'user' || m.role === 'assistant') && ((typeof m.content === 'string' && m.content) || hasimg)) {
      bubble(m.role, m.content || '', m.files, i, m, true)
    }
  }
  if (!chat.msgs.length) {
    const node = bubble('assistant', greet, undefined, undefined, undefined, true)
    node.classList.add('chat-greet')
  }
  scroll()
  renderlist()
}

function renderlist() {
  const list = el('chatlist')
  if (!list) return
  list.innerHTML = ''
  const total = el('chatcount')
  if (total) total.textContent = String(state.chats.length)

  const rows = [...state.chats].sort((a, b) => (b.at || 0) - (a.at || 0))
  for (const chat of rows) {
    const row = document.createElement('li')
    row.className = 'chat-menu-row'
    row.setAttribute('aria-current', String(chat.id === state.active))

    const name = document.createElement('span')
    name.className = 'chat-menu-name'
    name.textContent = chat.title || '新对话'

    const time = document.createElement('span')
    time.className = 'chat-menu-time'
    time.textContent = stamp(chat.at)

    const del = document.createElement('button')
    del.type = 'button'
    del.className = 'keyact'
    del.textContent = '−'
    del.title = '删除这个对话'
    del.setAttribute('aria-label', '删除这个对话')
    del.addEventListener('click', (ev) => {
      ev.stopPropagation()
      drop(chat.id)
    })

    row.append(name, time, del)
    row.tabIndex = 0
    row.setAttribute('role', 'button')
    row.addEventListener('click', () => pick(chat.id))
    row.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return
      ev.preventDefault()
      pick(chat.id)
    })
    list.appendChild(row)
  }
}

function openmenu() {
  const menu = el('chatmenu')
  if (!menu) return
  menu.hidden = false
  el('chathist').setAttribute('aria-expanded', 'true')
  renderlist()
}

function closemenu() {
  const menu = el('chatmenu')
  if (!menu) return
  menu.hidden = true
  el('chathist').setAttribute('aria-expanded', 'false')
}

function pick(id) {
  if (state.busy) return
  state.active = id
  state.editing = null
  save()
  closemenu()
  paint()
}

function drop(id) {
  if (state.busy) return
  state.editing = null
  state.chats = state.chats.filter((chat) => chat.id !== id)
  if (!state.chats.length) state.chats = [newchat()]
  if (!state.chats.some((chat) => chat.id === state.active)) state.active = state.chats[0].id
  save()
  paint()
}

function fresh() {
  if (state.busy) return
  closemenu()
  state.editing = null
  const chat = active()
  if (chat && !chat.msgs.length) {
    paint()
    el('chatinput').focus()
    return
  }
  const next = newchat()
  state.chats.unshift(next)
  state.active = next.id
  save()
  paint()
  el('chatinput').focus()
}

function autosize() {
  const box = el('chatinput')
  if (!box) return
  box.style.height = 'auto'
  // 上限交给 CSS 的 max-height 管，别在 JS 里写死像素，换屏幕才不会卡住
  box.style.height = box.scrollHeight + 'px'
}

async function pump(res, ondelta, onthink) {
  if (!res.body) throw new Error('响应没有数据流')
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let cut = buf.indexOf('\n')
    while (cut >= 0) {
      const line = buf.slice(0, cut).trim()
      buf = buf.slice(cut + 1)
      cut = buf.indexOf('\n')
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (!payload || payload === '[DONE]') continue
      let obj
      try {
        obj = JSON.parse(payload)
      } catch {
        continue
      }
      const delta = obj.choices && obj.choices[0] && obj.choices[0].delta
      if (!delta) continue
      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) onthink(delta.reasoning_content)
      else if (typeof delta.content === 'string' && delta.content) ondelta(delta.content)
    }
  }
}

async function send() {
  if (state.busy) return
  const box = el('chatinput')
  const text = box.value.trim()
  const files = state.files.slice()
  if (!text && !files.length) return
  const chat = active()

  // 文本文件直接拼进正文，图片才走 image_url 分块，免得上游不认数组
  const extra = files
    .filter((f) => f.kind === 'text')
    .map((f) => `【附件 ${f.name}】\n${f.text}`)
    .join('\n\n')
  const imgs = files.filter((f) => f.kind === 'img')
  const whole = [text, extra].filter(Boolean).join('\n\n')
  const body = imgs.length
    ? [
        ...(whole ? [{ type: 'text', text: whole }] : []),
        ...imgs.map((f) => ({ type: 'image_url', image_url: { url: f.src } })),
      ]
    : whole
  // 只带图片又没写字时，气泡里不放「（发送了附件）」这种概括，直接看图
  const shown = text
  const names = files.map((f) => f.name)
  const thumbs = files.filter((f) => f.kind === 'img').map((f) => f.thumb)

  box.value = ''
  autosize()
  state.files = []
  rendertray()
  syncsend()
  says('')

  // 编辑态走替换分支：把新内容作为这条的新版本，旧回复先存进旧版本里
  const editing = state.editing
  state.editing = null
  let target = null
  const oldmsg = editing !== null ? chat.msgs[editing] : null
  if (oldmsg && oldmsg.role === 'user') {
    if (!Array.isArray(oldmsg.alts)) {
      oldmsg.alts = [{ content: oldmsg.content, parts: oldmsg.parts, files: oldmsg.files, reply: '' }]
      oldmsg.alt = 0
    }
    const cur = oldmsg.alts[oldmsg.alt || 0]
    const old = chat.msgs[editing + 1]
    if (cur && old && old.role === 'assistant') cur.reply = old.content
    oldmsg.alts.push({ content: shown, parts: body, files: names, thumbs, reply: '' })
    oldmsg.alt = oldmsg.alts.length - 1
    oldmsg.content = shown
    oldmsg.parts = body
    oldmsg.files = names
    oldmsg.thumbs = thumbs
    chat.msgs = chat.msgs.slice(0, editing + 1)
    target = oldmsg
    chat.at = Date.now()
    save()
    paint()
  } else {
    const msg = {
      role: 'user',
      content: shown,
      files: names,
      thumbs,
      parts: body,
      alts: [{ content: shown, parts: body, files: names, thumbs, reply: '' }],
      alt: 0,
    }
    chat.msgs.push(msg)
    target = msg
    chat.at = Date.now()
    if (!chat.title) chat.title = (text || names[0] || '').slice(0, 18)
    bubble('user', shown, names, chat.msgs.length - 1, msg)
    save()
    renderlist()
  }

  const tip = typing()
  let think = null
  const out = bubble('assistant', '')
  out.hidden = true
  let raw = ''
  let mind = ''
  state.busy = true
  el('chatsend').disabled = true
  try {
    // 只带最近 20 条，人设作为额外 system 压在模板后面
    // 内容为空的消息（比如只有思考的回复）不带上去，上游会因为空 content 报错
    const history = chat.msgs
      .slice(-20)
      .map((m) => ({ role: m.role, content: m.parts || m.content }))
      .filter((m) => (Array.isArray(m.content) ? m.content.length : String(m.content || '').trim().length))
    const res = await fetch('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: currentmodel(),
        stream: true,
        messages: [{ role: 'system', content: state.persona || puppetsys }, ...history],
      }),
    })
    if (!res.ok) {
      const doc = await res.json().catch(() => ({}))
      const msg = (doc.error && (doc.error.message || doc.error)) || `HTTP ${res.status}`
      throw new Error(msg)
    }
    await pump(
      res,
      (delta) => {
        if (out.hidden) {
          out.hidden = false
          tip.remove()
        }
        raw += delta
        out.textContent = raw
        scroll()
      },
      (delta) => {
        // 推理模型的思考流单独放一块，别混进正文
        if (!think) {
          think = makethink('')
          el('chatlog').insertBefore(think, out)
          tip.remove()
        }
        mind += delta
        think.lastChild.textContent = mind
        think.querySelector('.chat-think-head').textContent = `已思考（${mind.length} 字）`
        scroll()
      },
    )
    tip.remove()
    let content = raw.trim()
    if (!content) {
      // 只有思考没有正文时不要留一个空气泡
      if (mind.trim()) {
        out.remove()
        content = ''
      } else {
        content = '（空回复）'
        out.hidden = false
        out.textContent = content
      }
    } else {
      out.textContent = content
    }
    chat.msgs.push({ role: 'assistant', content, think: mind.trim() || undefined })
    // 存回当前版本，切回别的版本时能直接恢复
    if (target && Array.isArray(target.alts)) {
      const cur = target.alts[target.alt || 0]
      if (cur) cur.reply = content
    }
    chat.at = Date.now()
    save()
    renderlist()
  } catch (err) {
    tip.remove()
    out.remove()
    const line = `出错了：${err.message}`
    bubble('assistant', line)
    if (target && Array.isArray(target.alts)) {
      const cur = target.alts[target.alt || 0]
      if (cur) cur.reply = line
    }
    says(`${err.message}`, 'bad')
    save()
  } finally {
    state.busy = false
    syncsend()
  }
}

// 长按菜单：复制 / 选择文本 / 修改 / 分享，图标手画，不引外部资源
const acticons = {
  copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M15 6V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h1" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>',
  pick: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 4h8M12 4v16M8 20h8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  edit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L20 8l-4-4L4 16v4z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
  share: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 5l6 5-6 5V9.8C7.8 9.8 5 12.5 4 17c-.6-6.4 2.8-10 10-10.4V5z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
}

function closeact() {
  const wrap = el('chatact')
  if (wrap) wrap.hidden = true
}

async function copytext(text) {
  try {
    await navigator.clipboard.writeText(text)
    says('已复制', '')
  } catch {
    // 非安全上下文或权限被拒时退回老办法
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    try {
      document.execCommand('copy')
      says('已复制', '')
    } catch {
      says('复制失败', 'bad')
    }
    ta.remove()
  }
}

function picktext(node) {
  node.classList.add('chat-sel')
  const range = document.createRange()
  range.selectNodeContents(node)
  const sel = window.getSelection()
  if (!sel) return
  sel.removeAllRanges()
  sel.addRange(range)
}

async function sharetext(text) {
  if (navigator.share) {
    try {
      await navigator.share({ text })
    } catch {
      // 用户取消分享不算错
    }
    return
  }
  copytext(text)
}

function actrow(key, label, run) {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'chat-act-row'
  btn.setAttribute('role', 'menuitem')
  btn.innerHTML = acticons[key] || ''
  const span = document.createElement('span')
  span.textContent = label
  btn.appendChild(span)
  btn.addEventListener('click', run)
  return btn
}

function openact(node, x, y) {
  const wrap = el('chatact')
  const card = el('chatactcard')
  const role = node.dataset.role
  if (!wrap || !card || !role) return
  const text = node.dataset.text || ''
  card.innerHTML = ''
  card.append(
    actrow('copy', '复制', () => {
      copytext(text)
      closeact()
    }),
    actrow('pick', '选择文本', () => {
      closeact()
      picktext(node)
    }),
  )
  // 只有用户自己说的话能拉回输入框改
  if (role === 'user' && node.dataset.index !== undefined) {
    card.append(
      actrow('edit', '修改', () => {
        closeact()
        editmsg(Number(node.dataset.index))
      }),
    )
  }
  card.append(
    actrow('share', '分享', () => {
      sharetext(text)
      closeact()
    }),
  )

  wrap.hidden = false
  const box = card.getBoundingClientRect()
  const pad = 8
  const left = Math.max(pad, Math.min(x - box.width / 2, innerWidth - box.width - pad))
  let top = y + 14
  if (top + box.height > innerHeight - pad) top = Math.max(pad, y - box.height - 14)
  card.style.left = `${left}px`
  card.style.top = `${top}px`
}

// 修改某条：先不动历史，把原话放回输入框；发送时才加一个版本并替换后面的回复
function editmsg(index) {
  if (state.busy) return
  const chat = active()
  const msg = chat.msgs[index]
  if (!chat || !msg || msg.role !== 'user') return
  const v = Array.isArray(msg.alts) && msg.alts[msg.alt || 0] ? msg.alts[msg.alt || 0] : msg
  state.editing = index
  const box = el('chatinput')
  if (box) {
    box.value = String(v.content || '')
    autosize()
    syncsend()
    box.focus()
  }
  says('改完发送就替换这条，旧版本留在下面的箭头里', '')
}

// 发送键只在有字或有附件时亮起来
function syncsend() {
  const btn = el('chatsend')
  if (!btn) return
  const has = el('chatinput').value.trim().length > 0 || state.files.length > 0
  btn.disabled = state.busy || !has
}

function one(text) {
  return String(text || '').replace(/\s+/g, ' ').trim()
}

// 附件托盘：图片给缩略方格，文本文件还是名字胶囊
function rendertray() {
  const tray = el('chattray')
  if (!tray) return
  tray.innerHTML = ''
  tray.hidden = !state.files.length
  state.files.forEach((item, i) => {
    if (item.kind === 'img') {
      const tile = document.createElement('span')
      tile.className = 'chat-thumb'

      const img = document.createElement('img')
      img.src = item.thumb || item.src
      img.alt = item.name

      const del = document.createElement('button')
      del.type = 'button'
      del.className = 'chat-thumb-del'
      del.textContent = '×'
      del.setAttribute('aria-label', `移除 ${item.name}`)
      del.addEventListener('click', () => {
        state.files.splice(i, 1)
        rendertray()
        syncsend()
      })

      tile.append(img, del)
      tray.appendChild(tile)
      return
    }

    const chip = document.createElement('span')
    chip.className = 'chat-file-chip'

    const name = document.createElement('span')
    name.className = 'chat-file-name'
    name.textContent = item.name

    const del = document.createElement('button')
    del.type = 'button'
    del.className = 'chat-file-del'
    del.textContent = '×'
    del.setAttribute('aria-label', `移除 ${item.name}`)
    del.addEventListener('click', () => {
      state.files.splice(i, 1)
      rendertray()
      syncsend()
    })

    chip.append(name, del)
    tray.appendChild(chip)
  })
}

function readas(file, how) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onerror = () => reject(new Error('读取失败'))
    fr.onload = () => resolve(fr.result)
    if (how === 'text') fr.readAsText(file)
    else fr.readAsDataURL(file)
  })
}

// 读图：只读一次尺寸，压缩时反复用同一个 Image 对象
function loadimg(src) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('图片读不出来'))
    img.src = src
  })
}

// 压到能发的尺寸：一律重编码成 JPEG，单张控制在一百多 KB
// 原图可能是几 MB 的 PNG 截图，直接发出去一次好几张会把请求撑爆
const imglimit = 340 * 1024

async function packimg(src) {
  const img = await loadimg(src)
  let edge = 1024
  let out = ''

  for (let round = 0; round < 3; round += 1) {
    const scale = Math.min(1, edge / Math.max(img.width, img.height))
    const cv = document.createElement('canvas')
    cv.width = Math.max(1, Math.round(img.width * scale))
    cv.height = Math.max(1, Math.round(img.height * scale))
    const ctx = cv.getContext('2d')
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, cv.width, cv.height)
    ctx.drawImage(img, 0, 0, cv.width, cv.height)

    let q = 0.82
    out = cv.toDataURL('image/jpeg', q)
    // 质量一路往下降，降到底还超就下一轮缩边长
    while (out.length > imglimit && q > 0.52) {
      q -= 0.1
      out = cv.toDataURL('image/jpeg', q)
    }
    if (out.length <= imglimit) return out
    edge = Math.round(edge * 0.75)
  }

  return out
}

// 托盘和气泡里只留小图，省内存也不卡滚动
async function thumbimg(src) {
  const img = await loadimg(src)
  // 256 边刚好够在 3 倍屏上按 5.5rem 显示，再大只是白占存储
  const scale = Math.min(1, 256 / Math.max(img.width, img.height))
  const cv = document.createElement('canvas')
  cv.width = Math.max(1, Math.round(img.width * scale))
  cv.height = Math.max(1, Math.round(img.height * scale))
  cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height)
  return cv.toDataURL('image/jpeg', 0.72)
}

// 附件去重按内容哈希算，别只看文件名：同名不同图、同图不同名都得分开处理
async function filemd5(file, kind, raw) {
  if (kind === 'img') {
    const resp = await fetch(raw)
    const buf = new Uint8Array(await resp.arrayBuffer())
    return md5bytes(buf)
  }
  return md5bytes(new TextEncoder().encode(String(raw)))
}

async function addfiles(list) {
  const seen = new Set(state.files.map((f) => f.hash).filter(Boolean))
  for (const file of list) {
    if (state.files.length >= maxfiles) {
      says(`一次最多带 ${maxfiles} 个文件`, 'warn')
      break
    }
    try {
      if (String(file.type).startsWith('image/')) {
        const raw = await readas(file, 'dataurl')
        const hash = await filemd5(file, 'img', raw)
        if (seen.has(hash)) {
          // 重复的静默丢掉，不弹提示
          continue
        }
        seen.add(hash)
        const src = await packimg(raw)
        const thumb = await thumbimg(raw)
        state.files.push({ name: file.name, kind: 'img', src, thumb, hash })
      } else {
        const raw = await readas(file, 'text')
        const hash = await filemd5(file, 'text', raw)
        if (seen.has(hash)) {
          // 重复的静默丢掉，不弹提示
          continue
        }
        seen.add(hash)
        state.files.push({ name: file.name, kind: 'text', text: raw.slice(0, maxfile), hash })
      }
    } catch {
      says(`读不了 ${file.name}`, 'bad')
    }
  }
  rendertray()
  syncsend()
}

// 人设卡片：读的就是设置页那份人设库，选哪张下一句就带哪张
function syncpersona() {
  const btn = el('chatpersona')
  if (!btn) return
  const hit = personas.items.find((item) => item.id === personas.active)
  btn.textContent = hit ? one(hit.text).slice(0, 10) || '空人设' : '未选人设'
}

function renderpersonas() {
  const list = el('chatpersonalist')
  if (!list) return
  list.innerHTML = ''
  const count = el('chatpersonacount')
  if (count) count.textContent = String(personas.items.length)

  const rows = [{ id: '', text: '不用人设' }, ...personas.items]
  for (const item of rows) {
    const row = document.createElement('li')
    row.className = 'chat-menu-row'
    row.setAttribute('aria-current', String(item.id === personas.active))
    row.tabIndex = 0

    const dot = document.createElement('span')
    dot.className = 'chat-dot'
    dot.setAttribute('aria-hidden', 'true')

    const name = document.createElement('span')
    name.className = 'chat-menu-name'
    name.textContent = one(item.text).slice(0, 40) || '空人设'

    const tick = document.createElement('span')
    tick.className = 'chat-tick'
    tick.textContent = item.id === personas.active ? '✓' : ''

    row.append(dot, name, tick)
    const pick = () => pickpersona(item.id)
    row.addEventListener('click', pick)
    row.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return
      ev.preventDefault()
      pick()
    })
    list.appendChild(row)
  }
}

async function loadpersonas() {
  try {
    const res = await fetch('/__personas', { cache: 'no-store' })
    const doc = await res.json()
    personas = {
      items: Array.isArray(doc.items) ? doc.items : [],
      active: String(doc.active || ''),
      text: String(doc.text || ''),
    }
    state.persona = personas.text
    syncpersona()
  } catch {
    // 读不到就用内置人设
  }
}

async function pickpersona(id) {
  try {
    const res = await fetch('/__personas', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'select', id }),
    })
    const doc = await res.json()
    if (doc.error) throw new Error(doc.error)
    personas = {
      items: Array.isArray(doc.items) ? doc.items : [],
      active: String(doc.active || ''),
      text: String(doc.text || ''),
    }
    state.persona = personas.text
    syncpersona()
    renderpersonas()
    closepop()
  } catch (err) {
    says(`切换人设失败：${err.message}`, 'bad')
  }
}

// 模型列表读本地 /v1/models，选完写同一个 localStorage 键，设置页也跟着换
function syncmodel() {
  // 一个模型都没选时统一写「未选择」，别留空白格子
  const id = currentmodel() || '未选择'
  const btn = el('chatmodelsel')
  if (btn) btn.textContent = id
  const note = el('chatmodel')
  if (note) note.textContent = id
}

function rendermodels() {
  const list = el('chatmodellist')
  if (!list) return
  list.innerHTML = ''
  const count = el('chatmodelcount')
  if (count) count.textContent = String(modellist.length)

  if (!modellist.length) {
    const row = document.createElement('li')
    row.className = 'chat-menu-row'
    row.textContent = '模型列表读取失败'
    list.appendChild(row)
    return
  }

  for (const id of modellist) {
    const row = document.createElement('li')
    row.className = 'chat-menu-row'
    row.setAttribute('aria-current', String(id === currentmodel()))
    row.tabIndex = 0

    const name = document.createElement('span')
    name.className = 'chat-menu-name'
    name.textContent = id

    const tick = document.createElement('span')
    tick.className = 'chat-tick'
    tick.textContent = id === currentmodel() ? '✓' : ''

    row.append(name, tick)
    if (id.endsWith('-free')) {
      const tag = document.createElement('span')
      tag.className = 'chat-tag'
      tag.textContent = '免费'
      row.insertBefore(tag, tick)
    }
    const pick = () => {
      localStorage.setItem(modelkey, id)
      syncmodel()
      rendermodels()
      closepop()
    }
    row.addEventListener('click', pick)
    row.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return
      ev.preventDefault()
      pick()
    })
    list.appendChild(row)
  }
}

async function loadmodels() {
  try {
    const res = await fetch('/v1/models', { cache: 'no-store' })
    const doc = await res.json()
    modellist = (doc.data || []).map((m) => m.id)
  } catch {
    modellist = []
  }
  rendermodels()
  syncmodel()
}

function closepop() {
  for (const id of ['chatpersonamenu', 'chatmodelmenu']) {
    const node = el(id)
    if (node) node.hidden = true
  }
  const p = el('chatpersona')
  if (p) p.setAttribute('aria-expanded', 'false')
  const m = el('chatmodelsel')
  if (m) m.setAttribute('aria-expanded', 'false')
}

function togglepop(id, btn) {
  const node = el(id)
  if (!node) return
  const open = node.hidden
  closepop()
  if (!open) return
  node.hidden = false
  if (btn) btn.setAttribute('aria-expanded', 'true')
  if (id === 'chatpersonamenu') renderpersonas()
  else rendermodels()
}

export function mountchat() {
  if (!el('chatform')) return
  loadpersonas()
  loadmodels()
  document.addEventListener('persona:change', () => {
    loadpersonas()
  })
  load()
  paint()
  syncsend()

  el('chatform').addEventListener('submit', (ev) => {
    ev.preventDefault()
    send()
  })

  let composing = false
  el('chatinput').addEventListener('compositionstart', () => {
    composing = true
  })
  el('chatinput').addEventListener('compositionend', () => {
    composing = false
  })
  el('chatinput').addEventListener('input', () => {
    autosize()
    syncsend()
  })
  el('chatinput').addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' || ev.shiftKey || composing) return
    ev.preventDefault()
    send()
  })

  // 加号走系统文件选择，图片和文本都能带
  el('chatplus').addEventListener('click', () => el('chatfile').click())
  el('chatfile').addEventListener('change', (ev) => {
    // 先转成普通数组再清 value：FileList 是活的，清空后异步读就只剩空表
    const picked = [...ev.target.files]
    ev.target.value = ''
    addfiles(picked)
  })

  el('chatpersona').addEventListener('click', () => togglepop('chatpersonamenu', el('chatpersona')))
  el('chatmodelsel').addEventListener('click', () => togglepop('chatmodelmenu', el('chatmodelsel')))

  // 长按气泡弹菜单，桌面右键也走同一条
  const log = el('chatlog')
  let presstimer = 0
  let pressnode = null
  let presspt = null

  const cancelpress = () => {
    clearTimeout(presstimer)
    pressnode = null
    presspt = null
  }

  log.addEventListener('pointerdown', (ev) => {
    const node = ev.target.closest('.chat-msg')
    if (!node || !node.dataset.role) return
    cancelpress()
    pressnode = node
    presspt = { x: ev.clientX, y: ev.clientY }
    presstimer = setTimeout(() => {
      if (!pressnode || !presspt) return
      openact(pressnode, presspt.x, presspt.y)
      pressnode = null
    }, 480)
  })

  log.addEventListener('pointermove', (ev) => {
    if (!presspt) return
    if (Math.abs(ev.clientX - presspt.x) > 10 || Math.abs(ev.clientY - presspt.y) > 10) cancelpress()
  })

  for (const name of ['pointerup', 'pointercancel', 'pointerleave']) log.addEventListener(name, cancelpress)

  log.addEventListener('scroll', closeact)
  log.addEventListener('contextmenu', (ev) => {
    const node = ev.target.closest('.chat-msg')
    if (!node || !node.dataset.role) return
    ev.preventDefault()
    openact(node, ev.clientX, ev.clientY)
  })

  el('chatact').addEventListener('click', (ev) => {
    if (ev.target === el('chatact')) closeact()
  })

  el('chatnew').addEventListener('click', fresh)
  el('chathist').addEventListener('click', () => {
    if (el('chatmenu').hidden) openmenu()
    else closemenu()
  })

  document.addEventListener('click', (ev) => {
    if (!el('chatpersonamenu').hidden || !el('chatmodelmenu').hidden) {
      if (!ev.target.closest('.chat-pop') && !ev.target.closest('#chatpersona') && !ev.target.closest('#chatmodelsel')) closepop()
    }
    if (el('chatmenu').hidden) return
    if (ev.target.closest('.chat-menu') || ev.target.closest('#chathist')) return
    closemenu()
  })

  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return
    closemenu()
    closepop()
    closeact()
  })

  document.addEventListener('view:change', (ev) => {
    if (ev.detail.name !== 'chat') {
      closemenu()
      closepop()
      closeact()
      return
    }
    syncmodel()
    renderlist()
  })

  syncmodel()
}
