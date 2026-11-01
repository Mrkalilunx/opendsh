// 入口：装配各模块，不做具体渲染

import { mounthero } from './modules/hero.js'
import { mountpicker } from './modules/pickmodel.js'
import { mountip } from './modules/ipview.js'
import { mountsess } from './modules/sessview.js'
import { mountsettings } from './modules/viewsettings.js'
import { mountsessionedit } from './modules/sessionedit.js'
import { mountkeymanage } from './modules/keymanage.js'
import { mountpersona } from './modules/personaedit.js'
import { mountmap } from './modules/modelmap.js'
import { mounttheme } from './modules/theme.js'
import { mountlogs } from './modules/viewlogs.js'
import { mountdebug } from './modules/debugmode.js'
import { mountselfcheck } from './modules/selfcheck.js'
import { mountfakeforce } from './modules/fakeforce.js'
import { mountlogadmin } from './modules/logadmin.js'
import { mountchat } from './modules/chat.js'
import { mounthomemon } from './modules/homemon.js'
import { mountusage } from './modules/usageview.js'
import { mountrouter } from './modules/router.js'

mounthero()
mountpicker()
mountip()
mountsess()

// 设置页下半部分依赖这几块数据，先攒着，等首轮都回来再放开闸门
// 挂载里某一块抛错也不能把闸门锁死，出错就当这块已经完成
function hold(fn) {
  try {
    return fn()
  } catch {
    return Promise.resolve()
  }
}

const boot = [
  hold(mountsettings),
  hold(mountsessionedit),
  hold(mountkeymanage),
  hold(mountpersona),
  hold(mountmap),
]

mounttheme()
mountlogs()
mountdebug()
mountselfcheck()
mountfakeforce()
boot.push(hold(mountlogadmin))
mountchat()
mounthomemon()
mountusage()
mountrouter()

// 数据没到齐之前二级菜单下面留白，到齐了一次性显出来，不再逐块闪
const gate = document.getElementById('view-settings')
if (gate) {
  // 最多等三秒，接口卡住也不至于一直空白
  const cap = new Promise((r) => setTimeout(r, 3000))
  Promise.race([Promise.allSettled(boot), cap]).finally(() => {
    gate.removeAttribute('data-boot')
  })
}
