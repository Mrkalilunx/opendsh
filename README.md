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
- Termux / Android 下会自动用 `mariadbd-safe` 拉起数据库；其它平台需要自行准备好服务

## 快速开始

```sh
git clone git@github.com:Mrkalilunx/opendsh.git
cd opendsh
bun dshboot.js
```

打开 `http://127.0.0.1:25715` 即可看到面板。端口在 `dshboot.js` 顶部改。

后端改动需要重启进程；前端（`js/`、`css/`、`index.html`）由服务端轮询热重载，刷新页面就行。

## 数据目录

运行期数据统一放在 `~/.local/share/dsh`：

| 路径 | 内容 |
|---|---|
| `settings.json` | 运行期设置，面板改完立即写入 |
| `mysql/` | MariaDB 数据目录 |
| `keys.json` | 本地接口密钥 |
| `personas.json` | 人设 |
| `modelmap.json` | 模型映射 |

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

## 注意

- 仓库不含任何密钥或数据库密码，`srv/.state/` 已在 `.gitignore` 中排除
- 默认不开启鉴权，不要把面板直接暴露到公网
- 花费数字按模型列表的单价估算，免费模型的单价为 0，显示为「免费」

## 许可

尚未指定许可证，默认保留所有权利。需要开源许可时再补 `LICENSE`。
