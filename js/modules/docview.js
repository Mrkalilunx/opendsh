// 文档页：介绍本代理与上游，内容全部是静态文本，不读写接口

const el = (id) => document.getElementById(id)

// 章节按顺序排，二级菜单点了就在同一块里换内容
// 正文一律写死在这里，不在 HTML 里堆一大片，改文案只动这一个文件
const chapters = {
  about: {
    title: '这个代理是什么',
    blocks: [
      {
        type: 'p',
        text: 'dsh 是一个跑在本机的 OpenAI 兼容代理。它把远端免费的 OpenAI 接口包装成本地统一入口，再配一套请求记录、用量统计和面板，方便在同一条链路上换模型、看用量、查问题。',
      },
      {
        type: 'p',
        text: '上游是 opencode 提供的免费模型接口。免费额度跟着客户端身份和出口 IP 走，代理负责把客户端发来的请求补成上游认得的形状，这样各家客户端都能直接用，不用自己适配。',
      },
      {
        type: 'list',
        items: [
          '代理只做协议适配与出站自检，不改模型回答的内容',
          '出站只保证上游要的最小结构：env 块、read 工具、stream 为真，其余内容原样透传',
          '默认只监听 127.0.0.1:25715，同网段默认连不进来',
          '请求记录、日志、用量都会落库，库不可用时降级为只进内存',
          '前端改完刷新即生效，后端改动要重启进程',
        ],
      },
      {
        type: 'note',
        text: '面板默认不开鉴权，别把端口直接暴露到公网。需要对外时先到 Key 栏开本地 sk- 校验。',
      },
    ],
  },
  entry: {
    title: '两个入口',
    blocks: [
      {
        type: 'p',
        text: '同一个代理挂了两个前缀，区别只有一个：代理补的那份 read 凭据能不能被调用。',
      },
      {
        type: 'table',
        head: ['路径', '适用', '行为'],
        rows: [
          ['/v1', '通用客户端', '抑制补出来的 read 凭据，只让客户端自己的工具可用'],
          ['/raw/v1', 'opencode', '不抑制，凭据以及客户端的 read 都照常可调'],
        ],
      },
      {
        type: 'p',
        text: '两条路发的请求体结构一样，env 块与 read 凭据都要有，否则上游直接拒。客户端自己带了 read 时直接用它的，代理一个字不补；没带才补一份隐形的。客户端工具名一律原名直发，不再加前缀。',
      },
      { type: 'sub', text: '模型真去调那份凭据时的三种结局' },
      {
        type: 'table',
        head: ['客户端有什么', '模型调用补出来的 read 时发生什么'],
        rows: [
          ['有 read 或 read_file 之类同名工具', '自动改派到客户端那个，模型拿到真实结果'],
          ['只有 shell 这类能跑的通用工具', '改写成 sed 命令改派过去，模型照样拿到文件内容'],
          ['什么工具都没有', '调用被吞掉，转成一句提示回给模型'],
        ],
      },
      {
        type: 'note',
        text: '改派是纯自动的，客户端不会收到自己没声明过的工具名。实测 /v1 下客户端只给了 bash 时，模型对凭据的调用会被改写成 bash 命令再发回客户端。',
      },
      {
        type: 'note',
        text: '凭据去掉 type 字段之后，模型基本不会再去调它，这条改派链路只是兜底。实测客户端只给 bash 并问「看看 /etc/hostname」，模型多数直接说做不到并给命令。',
      },
      {
        type: 'p',
        text: '直通入口 /raw/v1 不做抑制也不做改派：模型调凭据就原样交给客户端，认不认这个工具由客户端自己决定。opencode 这类自己就带 read 工具的客户端用这条路，行为与直连上游一致。',
      },
    ],
  },
  upstream: {
    title: '上游是什么',
    blocks: [
      {
        type: 'p',
        text: '上游有两个 host 路径都能用，判定规则完全一致，代理默认走第一个。',
      },
      {
        type: 'table',
        head: ['地址', '说明'],
        rows: [
          ['opencode.ai/inference', '代理默认上游，OpenAI 兼容路径是 /openai/v1'],
          ['opencode.ai/zen/v1', 'opencode 客户端内置的同一个服务，路径直接是 /v1'],
        ],
      },
      {
        type: 'p',
        text: '两边模型列表一致：一共 80 个模型，其中 9 个带 free 后缀，全部支持工具调用与推理，上下文从 20 万到 100 万不等。',
      },
      {
        type: 'list',
        items: [
          'beam-free · 104 万上下文',
          'flint-40b-free · 26 万上下文',
          'mimo-v2.6-flash-free · 20 万上下文',
          'nemotron-3.5-super-vl-free · 104 万上下文',
          'nemotron-3.5-lightning-free · 26 万上下文',
          'deepseek-v4.1-flash-free · 20 万上下文',
          'glm-5.3-flash-free · 20 万上下文',
          'pulse-alpha-free · 104 万上下文',
          'crouton-alpha-free · 104 万上下文',
        ],
      },
      {
        type: 'note',
        text: 'beam-free 与 crouton-alpha-free 会按地区回 403 RegionError，这是地区限制，不是额度用完，换出口也没用。',
      },
    ],
  },
  gate: {
    title: '门禁：上游认什么',
    blocks: [
      {
        type: 'p',
        text: '上游对免费模型请求查五件事：消息里要有 env 块、tools 里要有名为 read 的工具、stream 必须为 true、user-agent 要是 opencode 且版本不低于 1.18.0、客户端工具名不能撞上黑名单组合。任何一条不满足都会被拒，其中前三条回 429，版本过低回 426。',
      },
      {
        type: 'table',
        head: ['条件', '具体要求', '缺了'],
        rows: [
          ['env 块', '某条 system 或 developer 消息里含 <env> 与 </env>，块内至少有 Working directory 和 Platform 两行', '429'],
          ['read 工具', 'tools 数组里有一个名字正好是 read 的工具', '429'],
          ['stream', '顶层 stream 为 true', '429'],
          ['user-agent', 'opencode/<版本> 或 opencode/latest/<版本>，版本 ≥ 1.18.0', '429 或 426'],
          ['工具名', '不能同时出现 astrbot_execute_shell 与 astrbot_file_read_tool', '429'],
        ],
      },
      {
        type: 'p',
        text: '下面每一条都是在本机同一出口上逐项打出来的，不是从客户端源码或文档里推的。',
      },
      { type: 'sub', text: 'env 块' },
      {
        type: 'table',
        head: ['写法', '结果'],
        rows: [
          ['<env> 加两行字段加 </env>', '通过'],
          ['块前后再挂一大段其它说明文字', '通过'],
          ['块内多夹一个空行', '通过'],
          ['两行字段换顺序', '通过'],
          ['字段值随便填（/ 和 linux 都行）', '通过'],
          ['字段值留空，只留冒号', '通过'],
          ['字段行完全不缩进', '通过'],
          ['拆成两条 system 消息，各放一块', '通过'],
          ['把 env 块放在 user 消息里', '429'],
          ['<env></env> 空标签', '429'],
          ['块里只写一行字段', '429'],
          ['字段名改小写 working directory', '429'],
          ['字段名改词 Workdir 与 Os', '429'],
          ['标签带空格 <env >', '429'],
          ['标签大写 <ENV>', '429'],
          ['只有开标签，或只有闭标签', '429'],
        ],
      },
      {
        type: 'p',
        text: '位置不挑：system 排在 user 之前或之后都能过，用 developer 角色也能过，只要不是 user。字段名区分大小写，Working directory 与 Platform 这两个写法一个字都不能改，值反倒随意。',
      },
      { type: 'sub', text: 'read 工具' },
      {
        type: 'table',
        head: ['写法', '结果'],
        rows: [
          ['完整定义，带 description 与 parameters', '通过'],
          ['只留 {type, function: {name: "read"}}', '通过'],
          ['最简的裸对象 {name: "read"}', '通过'],
          ['read 之外再塞任意多个别的工具', '通过'],
          ['read 排在第几个都行', '通过'],
          ['名字大写 Read', '429'],
          ['名字带尾空格 "read "', '429'],
          ['名字加后缀 readx', '429'],
          ['换成 write、edit、glob、grep、shell、execute、skill、webfetch', '429'],
          ['tools 传空数组（普通请求时）', '429，见下文两种请求形态'],
        ],
      },
      {
        type: 'note',
        text: '只认名字。名字以外的描述和参数定义可以全删，删到只剩一个名字也照样过；反过来名字差一个字符就不过。所以不能拿别的工具名顶替 read。',
      },
      { type: 'sub', text: '两种请求形态' },
      {
        type: 'p',
        text: '上面那张表说的是带工具的请求。上游其实认两种形态，区别在于要不要 tools。两者要求的门槛完全不同，混在一起看会以为 env 块有时可以不带。',
      },
      {
        type: 'table',
        head: ['形态', 'system 要求', 'tools 要求', '结果'],
        rows: [
          ['一 普通请求', 'env 块（含 Working directory 与 Platform 两行）', '必须有名为 read 的工具', '200'],
          ['一 普通请求', 'env 块齐全', '不带 tools 或空数组', '429'],
          ['一 普通请求', '没有 env 块', '有 read', '429'],
          ['二 标题生成', '完整标题首句 + 含 Never use tools 的 rules 块', '不带 tools 或空数组', '200'],
          ['二 标题生成', '同上', '带了 read', '429'],
          ['二 标题生成', '首句不完整，或没有 rules 块', '不带 tools', '429'],
        ],
      },
      {
        type: 'note',
        text: 'env 块只在形态一里是硬要求。形态二压根不查 env，带不带都行，实测带 env 与不带 env 都是 200。所以不能把 env 当成两种形态的共同前提。',
      },
      {
        type: 'p',
        text: '形态二的判别依据是整段固定提示词，不是某单独一行。完整首句与 rules 块必须同时在场：只留 rules 块、或只留首句，都回 429。',
      },
      {
        type: 'table',
        head: ['system 内容（不带 tools 时）', '结果'],
        rows: [
          ['完整首句 + 含该行的 rules 块', '200'],
          ['完整首句 + 无 rules 块', '429'],
          ['短首句 + rules 块', '429'],
          ['仅 rules 块', '429'],
          ['空 rules 块', '429'],
          ['仅语言要求那一行', '429'],
          ['首句改小写 you', '429'],
          ['首句少 Nothing else', '429'],
          ['首句多一个词', '429'],
        ],
      },
      {
        type: 'note',
        text: '首句必须逐字一致，改大小写、少一个词、多一个词都不过。rules 块里那一行也要连写：Never use any tools、Never use the tools、Never call tools、Do not use tools 都不认，只有 never use tools 紧挨着写才认，大小写不敏感。',
      },
      {
        type: 'note',
        text: '两形态是互斥的：带工具就必须有 read，不带工具就必须是那整段固定提示词。这也解释了标题生成为什么不该补工具——它本来走形态二，补了 read 就同时满足「有工具」和「无工具提示词」两条，被判成矛盾，回 429。',
      },
      { type: 'sub', text: '标题生成怎么处理' },
      {
        type: 'p',
        text: '代理默认给所有请求补 read，因为绝大多数是普通对话。标题生成从客户端发来时 tools 是空的，system 是那段固定提示词，属于第二形态。直接补 read 会让它同时满足「有工具」和「无工具提示词」两条，上游判成矛盾直接 429，正文还伪装成免费额度耗尽。',
      },
      {
        type: 'p',
        text: '处理办法是出站时把 rules 块里那行 Never use tools 剔掉。剔掉之后 system 不再满足第二形态的条件，请求退回第一形态，补 read 变成合规操作。只动那一行，标题提示词的首句、task、examples 原样保留，标题质量不受影响。',
      },
      {
        type: 'note',
        text: '剔除要扫到第 0 条 message。opencode 发标题请求时把 env 块和标题提示词放在同一条 system 里，那一条就是第 0 条。早期实现从第 1 条开始扫，正好漏掉这个最常见的形态，线上表现为标题生成仍然全部失败。developer 角色也要扫，上游把它和 system 同等对待。',
      },
      { type: 'sub', text: '工具名怎么发' },
      {
        type: 'p',
        text: '客户端声明了什么工具就原样转发什么，不改名也不加前缀。早期版本会把客户端工具统一加 c_ 前缀，那是为了避开代理自己注入的 read；现在注入的那份对模型完全隐形，前缀这层就没有存在必要了，去掉之后工具名对模型来说就是它熟悉的原名。',
      },
      { type: 'sub', text: 'read 什么时候补、怎么隐形' },
      {
        type: 'p',
        text: '上游门禁要的是 tools 数组里存在一个叫 read 的工具。所以分两种情况：客户端自己带了 read，就直接用它的，代理一个字都不补；客户端没带，代理才补一份。',
      },
      {
        type: 'p',
        text: '补的那份故意去掉 type 字段，描述和参数也全部删掉，只剩 {"function":{"name":"read"}}。这是关键：带 type 时它就是一条合法工具，模型会按工具解析，被问「你有哪些工具」时会把它报出来；不带 type 模型就认不出来，当成看不懂的杂项跳过。门禁那边只校验 function.name，照样通过。',
      },
      {
        type: 'table',
        head: ['客户端工具', '出站 tools', '补 read'],
        rows: [
          ['自带 read', '原名原样 + 客户端的 read', '不补'],
          ['有工具但没 read', '原名原样 + 隐形 read 排在最后', '补一份'],
          ['一个工具都没有', '只有隐形 read', '补一份'],
        ],
      },
      {
        type: 'note',
        text: '去掉 type 是实测出来的。同一份请求，凭据带 type 时模型会把它列进工具清单，去掉 type 之后跑 3 个模型、每个 2 轮，一次都没有列过它；同时门禁连发 4 次全是 200。改文案只能劝模型别说，去掉 type 是让它压根认不出来。',
      },
      {
        type: 'note',
        text: '早期版本还试过往 system 里塞声明，让模型「把 read 当成不存在」。实测只能降低概率，压不到零，而且一提到「工具表里若有残留条目」反而更糟。凭据隐形之后这些声明全部删掉了，现在出站只有一条 env system。',
      },
      { type: 'sub', text: '为什么不一律注入' },
      {
        type: 'p',
        text: '既然凭据是隐形的，能不能每轮都补一份、客户端工具照常加？实测能跑通，但会多出一条同名条目，所以当前仍按需补，客户端带了 read 就不补。',
      },
      {
        type: 'p',
        text: '同名的两条放在一起时，模型只认带 type 的那条。实测把隐形凭据排在真实 read 前面，模型回答「我有两个工具：read、bash」，与只有真实 read 时的回答逐字几乎一致，排在前面的那份等于不存在。所以隐形与否取决于格式，不取决于位置，放前放后都不影响。',
      },
      {
        type: 'table',
        head: ['出站 tools', '模型列出 read', '模型调 read'],
        rows: [
          ['只有隐形 read + bash', '不提', '不调，走 bash'],
          ['隐形 read 在前 + 真实 read + bash', '列 1 个（真实的那份）', '调 read'],
          ['只有真实 read + bash', '列 1 个', '调 read'],
        ],
      },
      {
        type: 'note',
        text: '调用本身不带任何能区分条目的信息，返回的只有名字 read，协议层分不出指的是哪一条。正因为分不出，线上才不制造同名局面：客户端自带 read 时代理一个字不补。重复函数名在 OpenAI 兼容服务上是个常见的 400 原因，opencode.ai 这边虽然容忍，但没有理由去踩。',
      },
      { type: 'sub', text: '注入的凭据会不会被调用' },
      {
        type: 'p',
        text: '会，但代理会兜住。客户端没带 read 时，模型偶尔还是会调那个凭据，代理先尝试改派到客户端真实拥有的工具：有同类 read 就搬参数过去，只有 shell 就拼成 sed 命令，都没有才吞掉并提示。所以即便模型踩了这一步，用户也不会看到一次失败的工具调用。',
      },
      {
        type: 'note',
        text: '吞掉调用时的提示语分得很细：缺参数说「参数给得不全」，工具不存在说「那个工具在本轮不可用」。这两句混成一句会让模型以为整轮没有工具，之后再也不调，白白废掉一次能力。',
      },
      { type: 'sub', text: 'user-agent' },
      {
        type: 'table',
        head: ['写法', '结果'],
        rows: [
          ['opencode/latest/2.0.22/cli', '通过'],
          ['opencode/2.0.22', '通过'],
          ['opencode/latest/2.0.0/cli', '通过'],
          ['opencode/latest/1.0.0/cli', '426 UpgradeRequired'],
          ['opencode/latest（版本低于 1.18.0）', '426 UpgradeRequired'],
          ['光秃秃的 opencode', '429'],
          ['随便一个 curl/8.0', '429'],
        ],
      },
      {
        type: 'p',
        text: '426 是 UpgradeRequired，正文会直接说「OpenCode 1.18.0 or newer is required」，这跟 429 不是一回事。代理默认固定发 opencode/latest/2.0.22/cli，落在安全区间内。',
      },
      { type: 'sub', text: '工具名黑名单' },
      {
        type: 'p',
        text: 'astrbot_execute_shell 与 astrbot_file_read_tool 这两个名字同时出现必然回 429，换描述、换参数、换顺序都照挂，单独出现任一个则没问题。代理会在出站前把这两个名字换成 run_cmd 与 read_text，调用回来再还原，客户端完全无感。',
      },
      { type: 'sub', text: '最小可用请求' },
      {
        type: 'code',
        text: '{\n  "model": "deepseek-v4.1-flash-free",\n  "messages": [\n    { "role": "system", "content": "<env>\\n  Working directory: /tmp\\n  Platform: android\\n</env>" },\n    { "role": "user", "content": "你好" }\n  ],\n  "tools": [{ "type": "function", "function": { "name": "read" } }],\n  "stream": true\n}',
      },
      {
        type: 'p',
        text: '就上面这些，约 60 字 system 加一个空壳工具，实测能正常对话、多轮对话，也能触发流式工具调用。代理现在发的就是这套最小结构，出站体积约 575 字节，不再背 26KB 的官方模板。',
      },
      { type: 'sub', text: '怎么分清门禁与额度' },
      {
        type: 'p',
        text: '分不开响应。两类 429 的正文都是 FreeUsageLimitError，Retry-After 也都是到 UTC 零点的秒数，实测都在 6 万秒量级，逐字节比也看不出差别。',
      },
      {
        type: 'p',
        text: '唯一可靠的区分办法是补齐结构再打一次：补完还是 429 就是额度，补完变 200 就是门禁。',
      },
      {
        type: 'table',
        head: ['现象', '判定', '处置'],
        rows: [
          ['补齐 env、read、stream 后仍 429', '额度类', '换出口 IP'],
          ['补齐后 200，去掉任一项就 429', '门禁类', '改请求结构，换 IP 没用'],
        ],
      },
      {
        type: 'p',
        text: '代理出站时一律先把结构补齐再发，所以实际发出去的请求基本都是合规的。判据也据此改成看请求本身：三样门禁项还有缺项，或者本轮刚补过结构还没重发，都算门禁类；三样齐全且补完重发过了还回 429，才算额度类，这时候换出口才有意义。',
      },
      {
        type: 'note',
        text: '之前按 Retry-After 小于 3600 秒判门禁，实测门禁类 429 的 Retry-After 也在 6 万秒量级，那条判据根本不会命中，已按请求形态重写。',
      },
    ],
  },
  quota: {
    title: '额度和 429',
    blocks: [
      {
        type: 'p',
        text: '429 有两种原因：请求结构没过门禁，或者这个出口 IP 的免费额度真用完了。两者的正文和响应头完全一样，没法靠响应本身区分。',
      },
      {
        type: 'p',
        text: '唯一可靠的判法是补齐结构再打一次：补齐后变 200 是门禁，补齐后还是 429 是额度。',
      },
      {
        type: 'p',
        text: 'Retry-After 给的是到当天 UTC 零点重置的秒数，通常是几万秒，看着像要等一整天。实际上换一个出口 IP 就能立刻继续用，不用等重置。',
      },
      {
        type: 'list',
        items: [
          '额度是按出口 IP 算的，同一出口上换 session 不会恢复，实测连发 15 次也照样过',
          '额度也不是按请求次数或体积算的，两万字的 system 一样能过',
          '同 IP 上原地等待重试没用，等多久都是 429',
          '开了自动换 IP 才走换出口，否则直接把 429 抛给客户端',
          '门禁类 429 换 IP 无效，换多少次都是同一个结果',
        ],
      },
      {
        type: 'note',
        text: '调试时会撞到这个坑：额度耗尽的旧 IP 上，什么样的请求都回 429，看起来像是结构不对。换出口后再测才准，否则会把额度问题误判成门禁问题。',
      },
    ],
  },
  use: {
    title: '怎么接进来',
    blocks: [
      {
        type: 'p',
        text: '任何支持自定义 base_url 的 OpenAI 兼容客户端都能用，把地址指到本机端口即可。',
      },
      {
        type: 'code',
        text: 'base_url = http://127.0.0.1:25715/v1\napi_key  = 随便填，没开校验时不会检查\nmodel    = deepseek-v4.1-flash-free',
      },
      {
        type: 'p',
        text: 'opencode 这类需要完整工具的客户端用 /raw/v1，否则 read 会被抑制，对它的调用会被改成提示文本。',
      },
      {
        type: 'code',
        text: 'opencode 的 provider 配置\n{\n  "baseURL": "http://127.0.0.1:25715/raw/v1"\n}',
      },
      {
        type: 'list',
        items: [
          '/v1/chat/completions · 绝大多数客户端用这个',
          '/v1/completions · 老式文本补全',
          '/v1/responses · Codex 这类客户端，要在设置里先开',
          '/v1/models · 拉模型列表，含映射出来的名字',
          '/health · 健康检查，回服务状态和模型数',
        ],
      },
      {
        type: 'note',
        text: '模型名对不上时可以在设置 › Codex 里配映射，客户端报的名字会换成上游认的那个。',
      },
    ],
  },
}

// 纯文本一律走 textContent 拼节点，文案里有 <env> 这类尖括号，不能当 HTML 塞
function node(tag, cls) {
  const one = document.createElement(tag)
  if (cls) one.className = cls
  return one
}

function paintblock(block) {
  if (block.type === 'sub') {
    const h = node('h4', 'docsub')
    h.textContent = block.text
    return h
  }
  if (block.type === 'p') {
    const p = node('p', 'docp')
    p.textContent = block.text
    return p
  }
  if (block.type === 'note') {
    const p = node('p', 'docnote')
    p.textContent = block.text
    return p
  }
  if (block.type === 'code') {
    const pre = node('pre', 'doccode')
    pre.textContent = block.text
    return pre
  }
  if (block.type === 'list') {
    const ul = node('ul', 'doclist')
    for (const one of block.items) {
      const li = node('li')
      li.textContent = one
      ul.append(li)
    }
    return ul
  }
  if (block.type === 'table') {
    // 表格用 div 拼而不是 table，窄屏下靠 CSS 让它整块横向滚动
    const wrap = node('div', 'doctablewrap')
    const table = node('table', 'doctable')
    const thead = node('thead')
    const hrow = node('tr')
    for (const cell of block.head) {
      const th = node('th')
      th.textContent = cell
      hrow.append(th)
    }
    thead.append(hrow)
    const tbody = node('tbody')
    for (const row of block.rows) {
      const tr = node('tr')
      for (const cell of row) {
        const td = node('td')
        td.textContent = cell
        tr.append(td)
      }
      tbody.append(tr)
    }
    table.append(thead, tbody)
    wrap.append(table)
    return wrap
  }
  return null
}

let current = 'about'

// 只有自己定义的章节才算数，别让 constructor 这类原型属性混进来
function known(name) {
  return Object.prototype.hasOwnProperty.call(chapters, name)
}

function showdoc(name) {
  const pick = known(name) ? name : 'about'
  current = pick
  for (const btn of document.querySelectorAll('.docnav-item')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.doc === pick))
  }
  const body = el('docbody')
  if (!body) return
  const one = chapters[pick]
  body.textContent = ''
  const head = node('h3', 'dochead')
  head.textContent = one.title
  body.append(head)
  for (const block of one.blocks) {
    const built = paintblock(block)
    if (built) body.append(built)
  }
}

export function mountdoc() {
  const nav = el('docnav')
  if (!nav) return
  for (const btn of nav.querySelectorAll('.docnav-item')) {
    btn.addEventListener('click', () => showdoc(btn.dataset.doc))
  }
  showdoc(current)
}
