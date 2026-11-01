// 设置页：读写 /__settings，保存后由服务端立即应用

const fields = {
  defaultmodel: 'setmodel',
  retries: 'setretries',
  timeoutms: 'settimeout',
  sessionpool: 'setpool',
  logshow: 'setlogshow',
  retryafter: 'setretryafter',
  modelcache: 'setmodelcache',
  temp: 'settemp',
  maxtok: 'setmaxtok',
  toolbudget: 'setbudget',
  statedir: 'setstatedir',
  dbhost: 'setdbhost',
  dbport: 'setdbport',
  dbuser: 'setdbuser',
  dbpass: 'setdbpass',
  dbname: 'setdbname',
  dbdatadir: 'setdatadir',
}

const el = (id) => document.getElementById(id)

let saytimer = 0

// 状态在底部浮一下就走，改完不用自己去关
function says(text, tone = '') {
  const node = el('setstate')
  if (!node) return
  clearTimeout(saytimer)
  node.textContent = text
  node.dataset.tone = tone
  if (!text) return
  saytimer = setTimeout(() => {
    node.textContent = ''
    node.dataset.tone = ''
  }, tone === 'bad' ? 4000 : 1600)
}

function syncswitch() {
  const box = el('setproxy')
  const label = el('setproxytext')
  if (box && label) label.textContent = box.checked ? '启用' : '关闭'
  const tbox = el('settools')
  const tlabel = el('settoolstext')
  if (tbox && tlabel) tlabel.textContent = tbox.checked ? '启用' : '关闭'
  const bbox = el('setbridge')
  const blabel = el('setbridgetext')
  if (bbox && blabel) blabel.textContent = bbox.checked ? '启用' : '关闭'
  const mbox = el('setmute')
  const mlabel = el('setmutetext')
  if (mbox && mlabel) mlabel.textContent = mbox.checked ? '启用' : '关闭'
  const rbox = el('setresp')
  const rlabel = el('setresptext')
  if (rbox && rlabel) rlabel.textContent = rbox.checked ? '启用' : '关闭'
  const wbox = el('setraw')
  const wlabel = el('setrawtext')
  if (wbox && wlabel) wlabel.textContent = wbox.checked ? '启用' : '关闭'
}

// sk 校验开关在设置卡里，开关文字跟着勾选走，API Key 卡的注记只反映已生效的状态
function syncskey() {
  const box = el('keyauth')
  if (!box) return
  const label = el('keyauthtext')
  if (label) label.textContent = box.checked ? '开启' : '关闭'
}

function syncskeynote(settings) {
  const note = el('keynote')
  if (!note) return
  note.textContent = settings.keyauth ? '已启用 · chat 需带 sk' : '未启用校验'
}

function fill(settings) {
  for (const [key, id] of Object.entries(fields)) {
    const input = el(id)
    if (!input || input === document.activeElement) continue
    // 密码不回填，输入框留空就是保持原样
    if (key === 'dbpass') {
      input.value = ''
      continue
    }
    // 0 表示跟随默认，显示成空让占位提示露出来
    input.value = key === 'dbport' && !settings[key] ? '' : settings[key] ?? ''
  }
  const box = el('setproxy')
  if (box) box.checked = Boolean(settings.proxypool)
  const tbox = el('settools')
  if (tbox) tbox.checked = Boolean(settings.tools)
  const bbox = el('setbridge')
  if (bbox) bbox.checked = Boolean(settings.toolbridge)
  const mbox = el('setmute')
  if (mbox) mbox.checked = Boolean(settings.toolmute)
  const rbox = el('setresp')
  if (rbox) rbox.checked = Boolean(settings.responses)
  const wbox = el('setraw')
  if (wbox) wbox.checked = Boolean(settings.rawentry)
  syncswitch()
  const skey = el('keyauth')
  if (skey) skey.checked = Boolean(settings.keyauth)
  syncskey()
  syncskeynote(settings)
}

function collect() {
  const num = (id) => Number(el(id).value)
  const text = (id) => el(id).value.trim()
  const body = {
    defaultmodel: el('setmodel').value.trim(),
    retries: num('setretries'),
    timeoutms: num('settimeout'),
    sessionpool: num('setpool'),
    logshow: num('setlogshow'),
    retryafter: num('setretryafter'),
    modelcache: num('setmodelcache'),
    temp: num('settemp'),
    maxtok: num('setmaxtok'),
    toolbudget: num('setbudget'),
    statedir: text('setstatedir'),
    dbhost: text('setdbhost'),
    dbport: num('setdbport'),
    dbuser: text('setdbuser'),
    dbname: text('setdbname'),
    dbdatadir: text('setdatadir'),
    proxypool: el('setproxy').checked,
    tools: el('settools').checked,
    toolbridge: el('setbridge').checked,
    toolmute: el('setmute').checked,
    rawentry: el('setraw').checked,
    keyauth: el('keyauth').checked,
    responses: el('setresp').checked,
  }
  // 密码留空表示不动，免得每改别的字段就把库里那份清掉
  const pass = text('setdbpass')
  if (pass) body.dbpass = pass
  return body
}

async function load() {
  try {
    const res = await fetch('/__settings', { cache: 'no-store' })
    const doc = await res.json()
    fill(doc.settings)
    paintpaths(doc.paths)
    says('')
  } catch (err) {
    says(`读取失败：${err.message}`, 'bad')
  }
}

// 路径那几项只显示当前生效值，输入框留空就说明走默认
// 顺带标出目录能不能写，填了个不存在的路径保存前就能看出来
function paintpaths(paths) {
  if (!paths) return
  // 占位符直接写默认路径，用户一眼知道留空会落到哪儿
  const sin = el('setstatedir')
  if (sin) sin.placeholder = paths.statedirdefault || '留空用默认'
  const din = el('setdatadir')
  if (din) din.placeholder = paths.datadefault || '留空用默认'
  const state = el('statedirnow')
  if (state) {
    const mine = String(el('setstatedir')?.value || '').trim()
    const note = mine ? `当前生效：${paths.statedir}` : `当前生效：${paths.statedirdefault}（默认）`
    state.textContent = paths.statedirready ? note : `${note} · 写不进去`
    state.dataset.tone = paths.statedirready ? '' : 'bad'
  }
  const data = el('datadirnow')
  if (data) {
    const note = `当前生效：${paths.datadir}`
    data.textContent = paths.datadirready ? note : `${note} · 读不到`
    data.dataset.tone = paths.datadirready ? '' : 'bad'
  }
  const db = el('dbnow')
  if (db) {
    const it = paths.db || {}
    db.textContent = it.host
      ? `当前连的是 ${it.user}@${it.host}:${it.port}/${it.database}`
      : '还没读到库的连接信息'
  }
}

async function save(body) {
  try {
    const res = await fetch('/__settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const doc = await res.json()
    if (!res.ok) throw new Error(doc.error || `HTTP ${res.status}`)
    fill(doc.settings)
    paintpaths(doc.paths)
    document.dispatchEvent(new CustomEvent('settings:change', { detail: doc.settings }))
    says('已保存', 'ok')
  } catch (err) {
    says(`保存失败：${err.message}`, 'bad')
  }
}

// 二级菜单：只显示当前分类，切完记住上次看的分类
const secs = ['model', 'sampling', 'net', 'codex', 'logs', 'data', 'theme', 'persona', 'session', 'keys', 'debug']
const seckey = 'dsh:setsec'

// 选中项居中：只滚二级菜单那条横向轨道，绝不让整个页面跟着滚
// scrollIntoView 会连带滚动 window，粘顶的菜单会把顶栏顶出屏幕
function centerpick(btn) {
  const track = el('setnav')
  if (!track || !btn) return
  const left = btn.offsetLeft - (track.clientWidth - btn.offsetWidth) / 2
  track.scrollTo({ left: Math.max(0, left), behavior: 'smooth' })
}

// 二级菜单的滑动指示块：量出选中项的位置和宽高，交给 CSS 过渡滑过去
// 首帧只定位不滑动，位置落定后再挂 subglider-on
function glide() {
  const track = el('setnav')
  if (!track) return
  const bar = track.querySelector('.subglider')
  const cur = track.querySelector('.subnav-item[aria-pressed="true"]')
  if (!bar || !cur) return
  // 设置页还没显示时量不到宽度，直接跳过，等真正可见再定位
  if (!cur.offsetWidth) return
  bar.style.width = `${cur.offsetWidth}px`
  bar.style.height = `${cur.offsetHeight}px`
  bar.style.transform = `translate(${cur.offsetLeft}px, ${cur.offsetTop}px)`
  if (!track.classList.contains('subglider-on')) {
    requestAnimationFrame(() => track.classList.add('subglider-on'))
  }
}

function showsec(name) {
  const pick = secs.includes(name) ? name : 'model'
  for (const btn of document.querySelectorAll('.subnav-item')) {
    const on = btn.dataset.sec === pick
    btn.setAttribute('aria-pressed', String(on))
    if (on) centerpick(btn)
  }
  glide()
  for (const node of document.querySelectorAll('#view-settings .setsec, #view-settings .setactions')) {
    node.hidden = !node.dataset.sec.split(/\s+/).includes(pick)
  }
  // 分类不在表单里就整块收起，免得空表单占一段间距
  const form = el('setform')
  if (form) form.hidden = !['model', 'sampling', 'net', 'logs', 'data'].includes(pick)
  try {
    localStorage.setItem(seckey, pick)
  } catch {
    // 隐私模式写不进去，本次照样生效
  }
}

// 切分类回到页面顶部，不是回到设置卡的顶部
// 对齐设置卡会把顶栏和页签一起滚出屏幕，看着像整页自己往下跑了
function topscroll() {
  window.scrollTo({ top: 0 })
}

function lastsec() {
  try {
    return localStorage.getItem(seckey) || 'model'
  } catch {
    return 'model'
  }
}

export function mountsettings() {
  const form = el('setform')
  if (!form) return

  el('setproxy')?.addEventListener('change', syncswitch)
  el('settools')?.addEventListener('change', syncswitch)
  el('setbridge')?.addEventListener('change', syncswitch)
  el('setmute')?.addEventListener('change', syncswitch)
  el('setraw')?.addEventListener('change', syncswitch)
  el('keyauth')?.addEventListener('change', syncskey)
  // Responses 开关搬到 Codex 那栏，不在表单里，得单独接一条自动保存
  el('setresp')?.addEventListener('change', () => {
    syncswitch()
    save(collect())
  })

  for (const btn of document.querySelectorAll('.subnav-item')) {
    btn.addEventListener('click', () => {
      showsec(btn.dataset.sec)
      // 换分类后回到页面顶部，长面板切到短面板不会停在半空
      topscroll()
    })
  }
  showsec(lastsec())

  document.addEventListener('view:change', (ev) => {
    if (ev.detail.name === 'settings') showsec(lastsec())
  })

  // 屏幕旋转、字号缩放都会改变菜单项宽度，重新量一次并对齐
  window.addEventListener('resize', () => {
    const track = el('setnav')
    if (!track) return
    track.classList.remove('subglider-on')
    glide()
  })

  document.addEventListener('settings:change', (ev) => {
    if (ev.detail) fill(ev.detail)
  })

  // 这些字段全都是改完立刻生效，不再需要保存按钮
  for (const node of form.querySelectorAll('input, select')) {
    node.addEventListener('change', () => save(collect()))
  }

  // 回车提交走同一条路，页面不跳
  form.addEventListener('submit', (ev) => {
    ev.preventDefault()
    save(collect())
  })

  return load()
}
