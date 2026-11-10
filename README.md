# dsh

本地 OpenAI 兼容代理与控制面板，跑在 Bun 上，单目录、无构建步骤。

把远端免费的 OpenAI 兼容接口包装成本地统一入口，附带请求记录、用量统计、密钥管理和可视化面板。默认只监听 `127.0.0.1:25715`。

## 功能

- OpenAI 兼容代理：`/v1/chat/completions`、`/v1/completions`、`/v1/responses`、`/v1/models`
- 两个入口：`/v1` 按设置抑制工具定义，`/raw/v1` 原样转发，供 opencode 之类需要完整工具的客户端使用
- 请求记录：按客户端 UA 归类来源（opencode / codex / astrbot / 网页 / 脚本 / 其他），记录状态码、耗时、token 用量
- 用量统计：区间新增 token、每日柱状、按模型和来源排行，花费按 `/v1/models` 返回的单价估算
- 密钥管理：可选的本地 `sk-` 鉴权，不开启时直接放行
- 人设、模型映射、出口 IP 检测、进程监控
- 设置内建文档页：本代理说明、两个入口的差别、上游模型与免费额度、上游门禁判据、429 分流规则、接入示例
- 面板页签：主页 / 聊天 / 设置 / 日志 / 用量，前端零依赖，改完刷新即生效

## 环境要求

- Bun（脚本以 `#!/usr/bin/env bun` 启动）
- MariaDB 或 MySQL，可选。数据库不可用时请求记录降级为只进内存，代理本身照常工作
- Termux / Android 下会自动用 `mariadbd-safe` 拉起数据库；数据目录是空的会先就地初始化系统表，不用手工跑 `mariadb-install-db`；库本身也会自动创建。其它平台需要自行准备好服务
- CPU 占用、进程列表与出口 IP 切换需要 Shizuku。这两块功能会以 adb shell（uid 2000）身份执行命令

## 远程 shell 与 Shizuku

读 CPU 每核占用、进程列表，以及 429 时关开移动数据换出口 IP，都需要 adb shell 权限。仓库自带一份 rish 与 dex（`srv/rish/`），不再依赖用户机器上另行配置的脚本：

```
srv/rish/rish                 启动包装，调 app_process 加载 dex
srv/rish/rish_shizuku.dex     Shizuku 的 shell 入口
```

使用前提只有两条：装好 Shizuku 并启动它，然后在本终端 app 里授权。包名不用手改，`srv/adbshell.js` 会从 Termux 的数据目录变量推导，官方版、F-Droid 版、改过包名的分支版都能对上。

没有 Shizuku 时不影响代理本身，只是面板上的 CPU 占用、进程列表和自动换出口不可用。

`rish` 与 dex 取自 [Shizuku](https://github.com/RikkaApps/Shizuku)，Apache License 2.0。

## 快速开始

```sh
git clone git@github.com:Mrkalilunx/opendsh.git
cd opendsh
bun dshboot.js
```

打开 `http://127.0.0.1:25715` 即可看到面板。端口在 `dshboot.js` 顶部改。

后端改动需要重启进程；前端（`js/`、`css/`、`index.html`）由服务端轮询热重载，刷新页面就行。

## 后台常驻

`srv/keeplive.sh` 是个守护壳：前台等子进程退出，把退出码和信号记进日志，然后重新拉起。它自己不认任何具体产物，启动命令由环境变量交进去：

```sh
# 默认守护 bun dshboot.js
setsid nohup bash srv/keeplive.sh >> ~/.local/share/dsh/serve.log 2>&1 < /dev/null &

# 换成别的启动方式
DSHSTART="你想跑的命令" DSHPORT=25715 setsid nohup bash srv/keeplive.sh >> ~/.local/share/dsh/serve.log 2>&1 < /dev/null &
```

日志在 `~/.local/share/dsh/serve.log`，`[keep]` 开头的行记录了每次启动与退出原因，区分被打死还是自己崩就靠它。

需要让进程名不含脚本名时，可以自行编译成单文件：

```sh
bun build --compile --target=bun-linux-arm64 dshboot.js --outfile 你想放的路径
```

产物不在仓库里，放哪、叫什么由你自己决定。编译版读静态文件要靠 `DSHROOT` 指回仓库根：

```sh
DSHSTART="/你的路径/产物名" DSHROOT="$PWD" bash srv/keeplive.sh
```

## 数据目录

运行期数据统一放在 `~/.local/share/dsh`：

| 路径 | 内容 |
|---|---|
| `settings.json` | 运行期设置，面板改完立即写入 |
| `mysql/` | MariaDB 数据目录，不存在时会自动初始化 |
| `keys.json` | 本地接口密钥 |
| `personas.json` | 人设 |
| `modelmap.json` | 模型映射 |

`mysql/` 是随服务一起准备的自包含数据目录：第一次启动时如果它是空的，会就地跑一遍 `mariadb-install-db` 装上系统表，再把库建出来；之后重启只做探活与补建，不会重复初始化。

数据库这块的默认值贴着一套全新安装：`127.0.0.1:3306`、用户 `root`、空密码、库名 `dsh`。要换账号或端口就在设置页改，改动即时生效。

老版本的 `srv/.state/` 只在首次启动时读一次，之后所有写入都进数据目录。

## 目录结构

```
dshboot.js         HTTP 服务、路由、静态文件与热重载
index.html         单页应用外壳
srv/               后端模块：代理、上游、记录、统计、密钥、进程监控
js/                前端模块：路由、各视图渲染
css/               样式，按页面分文件
res/               静态资源与上游请求模板
opencode-api.py    同一套思路的 Python 单文件版本，独立可用
```

`srv/mysqlboot.js` 负责把数据库拉起来并初始化，`srv/dbinit.js` 负责建库，两张表的结构在 `srv/logstore.js` 与 `srv/reqstore.js` 首次连接时补齐。

## 注意

- 仓库不含任何密钥或数据库密码，`srv/.state/` 已在 `.gitignore` 中排除
- 默认不开启鉴权，不要把面板直接暴露到公网
- 花费数字按模型列表的单价估算，免费模型的单价为 0，显示为「免费」

## 许可

尚未指定许可证，默认保留所有权利。需要开源许可时再补 `LICENSE`。
