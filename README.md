# stm32-workbench 插件（DSH 内建单片机工作台）

把 STM32 工作台做成 DSH 插件：**不另开浏览器**，在 DSH 里选工作区 → 会话进入「单片机模式」→ 工作台就在会话视图里。

> **当前版本 0.5.0，适配 DSH 0.2.1-rc.2（2026-10-24）**。mcu 工具 **19 个 action**
> （0.3.0 新增 `symbols`/`readmem`/`gfx`；0.4.0 新增 `watch` 并重做为「AI 省 token」形态；
> 0.5.0 新增 `project` 工程卡：芯片/工具链/烧录端口/引脚表落成与工具链无关的 JSON，换工程直接读）。
> 升级适配的根因与修复见文末。

## 目录中为什么不是「挂在每个对话下面」

第一版我把面板注册进了 `conversation.input.dock`（会话级全宽插槽），结果**每个对话下面都会冒出工作台**——错的。

正确做法参考 [dsh-openwrite](https://github.com/LiPu-jpg/Openwrite)（DSH 小说创作插件，含原生工作台）：

| 它的做法 | 本插件的对应实现 |
| --- | --- |
| 侧栏底部一个入口按钮（`sidebar.footer.action`，id `openwrite.launch`） | 侧栏底部「STM32 工作台」（id `stm32.launch`） |
| 点击后选作品目录 → 建工作区 → 建会话 → `ctx.remote.agentPresets.select(sessionId, 自己的预设)` → 打开会话 | 同样流程，预设 id = `mcu` |
| 工作台是 `conversation.view`，并由 `watchWritingScope` **门控**：只读当前主视图会话的 `projectionValues.agentPreset`，等于自己的预设才挂载 | `watchScope(list, isMcuSession, mountView)`，非 `mcu` 会话不挂载 |
| 预设由插件自己注册（`ctx.agentPresets.register()`，见其 `plugin.mjs`） | 宿主半边 `ctx.inject(['agentPresets'], …)` 注册「单片机模式」 |
| 已有会话不会被自动切换预设 | 同样：只影响入口新建/选中的那个会话 |

关键判据（照抄自它的 `writing-scope.ts`）：`state.byId[id].projectionValues.agentPreset`，会话 id 取 `retainedBy.mainView > 0` 的那一行（0.1 是 `state.current`）。

## 半边职责

| 半边 | 文件 | 干什么 |
| --- | --- | --- |
| 宿主 | `index.js` | ① `ctx.agentPresets.register()` 注册「单片机模式」预设；② 拉起/停止 MCU 后端进程；③ 注册同源路由 `/mcu/state`、`/mcu/start`、`/mcu/stop`、`/mcu/api/*` 代理 |
| 客户端 | `client.js` | ① 侧栏入口按钮 + 选工作区对话框；② 门控的 `conversation.view` 工作台（引脚图/构建台/串口/计算器） |
| 后端 | `backend/` | 真编译（Keil AC5）、真烧录（OpenOCD + ST-Link）、串口桥；固件源码与 BSP 随仓库提供，便携 OpenOCD 由 `backend/scripts/fetch-openocd.ps1` 一键下载（不随仓库分发） |

**入口一旦某个会话被选定，「单片机模式」下 agent 就能直接用编译/烧录/串口**：端口与 routes 都在 `/mcu` 下。

## 安装与生效

- **从 GitHub 克隆后**：先准备便携 OpenOCD（仓库故意不提交这 7.6 MB 第三方二进制）：
  `powershell -ExecutionPolicy Bypass -File backend\scripts\fetch-openocd.ps1`
  （从官方 xPack release 下载并校验 sha256，只需一次）
- 安装：`plugin_manager: install_bundle target=<你放本插件的绝对路径>`
- **改动插件代码后必须重启 DSH**：装载器不会热替换已装载的包代际（客户端资源还要刷新页面）
- 生效后：侧栏底部出现「STM32 工作台」；模式选择器里出现「单片机模式」（由插件注册，不再依赖 profile 补丁）
- 换台电脑怎么装、需要什么前置条件、数据落在哪：见 [PORTING.md](PORTING.md)

## 许可证

- 本仓库代码：**MIT**，见 [LICENSE](LICENSE)。
- 第三方组件：ARM CMSIS（Apache-2.0）、STMicroelectronics STM32F10x 标准外设库（ST 许可）、
  xPack OpenOCD（GPLv2，**不随仓库分发**，由脚本按需下载）——详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 目录结构与数据落点（2026-10-14 重构）

**插件本体只装代码，运行期不往自己目录里写任何东西。** 一个目录拷到别的机器就是干净的一份。

```
stm32-workbench/              ← 约 1.8 MB（不含便携 OpenOCD；它由 fetch-openocd.ps1 按需下载）
├── package.json              ← files: 白名单；dsh.bundle / dsh.client / exports 声明（含 locale/icon）
├── cordis.patch.yml          ← backendDir 故意留空 → 取「index.js 旁边那份 backend/」
├── index.js / client.js      ← 宿主半边（mcu 工具 + preset + 路由）/ 客户端半边（工作台面板）
├── locale/{en,zh}.json       ← 设置页/插件页的显示标题与描述（DSH 0.2.1 起必需）
├── icon.svg                  ← 插件图标（原创，≤256 KiB）
├── .gitignore                ← 兜底老版本遗留
├── PORTING.md / README.md
└── backend/
    ├── server/               ← 后端模块（16 个）
    ├── scripts/              ← 诊断脚本（35 个，全相对路径）
    ├── data/                 ← pins.json / peripherals.json
    ├── tools/openocd/        ← 便携 OpenOCD（不提交进仓库；fetch-openocd.ps1 下载到此）
    ├── firmware/{bsp,projects,template}   ← 自带测试工程（只读）
    └── web/                  ← 老版独立浏览器界面（留作调试）
```

数据分两处，规则在 `backend/server/paths.js`：

```
<你打开的 Keil 工程目录>/.dsh-mcu/     ← 跟这个工程有关的一切，都可以安全删除
    .gitignore（内容 `*`）  build/keil/<工程>-<哈希>/  last-build.json
    logs/  src-backup/<时间戳>/  uv4-ref/  tmp/

<DSH_HOME>/mcu/                       ← 默认 ~/.dsh/mcu
    recent.json                        ← 上次打开哪个工程（唯一一处跨工程记忆）
    build/<工程>/                       ← 自带测试工程的构建输出
```

三条好处，都是这次重构换来的：

1. **插件瘦了 30 多倍**（61.0 MB → 1.8 MB 代码；7.6 MB 的便携 OpenOCD 改为按需下载），而且拷走不用清理；
2. **换工作区 = 换一整套缓存**，切回去直接读得到，不用重新编译；
3. **顺手修掉一个真错误**：以前构建账本是全局唯一一份，切换工程后会把**旧工程**的
   `programSize`/`map` 拿来当新工程的占用数据展示（界面上还挂着新工程的名字）。
   按工程分开存之后，这个错误在结构上不可能发生。

工程目录只读时（网络盘、受保护目录），`.dsh-mcu/` 自动退到
`<DSH_HOME>/mcu/projects/<路径哈希>/` 并留一张 `WHY-HERE.txt`。

**怎么证明插件本体没被写脏**：跑完一整套操作后对插件目录做文件快照比对，
应当「新增 0 / 删除 0 / 变化 0」。这是设计保证，也可以自己核对。

## 设计约束（创造模式随包技能给的硬规矩）

1. **禁止 iframe**：插件 UI 必须是真 React 组件、用 `--dsw-alias-*` 主题令牌。
2. **禁止 import Harness 客户端包**（如 `dsh-client-ui-primitives`）：随版本变动，且抛错会让插槽整块崩掉。
3. **资源注册要用 effect 管生命周期**：`ctx.slots.inject(ownerKey, () => ctx.slots.register(...))`，卸载即撤销。
4. **不写 profile 的 package.json / cordis.patch.yml**：交给 `plugin_manager`。

## 踩过的坑

1. **`type: "module"` 毒死 CommonJS 后端** → `backend/package.json` 写 `{"type":"commonjs"}` 就近隔离。
2. **DSH 路由匹配 = 精确表优先 + 前缀取最长**，所以 `/mcu/state`（精确）不会被 `/mcu`（前缀代理）吃掉。
3. **插件资源 URL 带内容哈希 rev**（`/plugins/<包名>/client.js?rev=<sha1前12>`），无 rev 一律 404，不能凭猜 URL 验证客户端。
4. **重复 preset id 会让声明加载失败**：所以本插件注册预设后，必须把先前手写进 profile 补丁的那段撤掉（已撤，备份 `cordis.patch.yml.bak-mcu-*`）。

## 待验证（如实记录）

- 客户端渲染只能在 DSH 页面里验证；本会话无浏览器控制能力，不能截图或读 DOM。
- 若侧栏没有出现入口、或工作台没起来，看浏览器控制台是否有 `slot entry crashed in 'conversation.view'` 或我打印的 `[stm32-workbench]` 警告。
- 烧录与串口仍需 ST-Link 与实物才能验证（没插设备时界面会如实显示「未检测到 ST-Link」）。

## 回滚

```
plugin_manager: set_bundle enabled=false target=dsh-plugin-stm32-workbench
```

## Keil 工程接入（2026-10-13）

原来只能编插件自带的 `firmware/projects/<id>/`，编译参数写死。现在可以直接吃用户的 Keil 工程，
**产物与 Keil UV4 逐字节一致**（已用真实毕设工程验证：53788 字节、0 差异）。

### 新增模块

| 文件 | 干什么 |
| --- | --- |
| `server/uvprojx.js` | 解析 .uvprojx：芯片 / 宏 / 头路径 / 文件清单 / 优化 / 输出设置 + 配置诊断 |
| `server/keil-build.js` | 用工程自己的配置驱动 armcc → armasm → armlink → fromelf |
| `server/srcfile.js` | 编码感知的源码读写（GBK / UTF-8 / BOM 自动识别） |
| `server/pinmap.js` | 从源码**静态解析引脚配置**：跟踪 SPL 结构体状态、关联 EXTI、检出冲突 |
| `server/regread.js` | SWD 直读寄存器：RCC 时钟树、外设时钟使能、GPIO 实际配置，并与源码对照 |

### 新增接口

- `POST /api/keil/open` — 打开工程（进程内记住，界面刷新不丢）
- `GET  /api/keil/state` — 当前工程摘要
- `GET  /api/keil/pins` — 引脚配置（静态解析结果）
- `POST /api/keil/registers` — 寄存器 + 「源码分析 vs 芯片实际」对照
- `POST /api/keil/build` — 按工程编译（NDJSON 流式日志）

### 踩到的坑（全是实测踩出来的）

1. **Keil 的 `<Optim>` 是 1-based**。工程写 `<Optim>3</Optim>` 要用 `-O2` 而不是 `-O3`。
   实测 `-O3` 编出的 `main` 是 610 B，Keil 自己编的是 590 B；换 `-O2` 后逐字节一致。
   映射：`1→-O0、2→-O1、3→-O2、4→-O3`。
2. **Keil 生成的 scatter 多一行 `.ANY (+XO)`**，照抄才能对齐链接结果。
3. **`.uvprojx` 里没有器件宏**。Keil 按 `<Device>` 自动定义 `STM32F10X_MD` 之类，
   外部工具链必须自己补，否则 `#error "Please select first the target STM32F10x device"`。
4. **`<Cpu>CLOCK(...)` 不是晶振频率**，只是 Keil IDE 的显示值。真实值要看源码
   `stm32f10x.h` 的 `HSE_VALUE`（还要区分 `STM32F10X_CL` 分支是否生效）。
   信错了会把 8 MHz×9=72 MHz 算成 12 MHz×9=108 MHz，看起来像严重超频。
5. **中文路径**：armcc 是 ANSI 程序，命令行里出现中文会被拆坏。所以 cwd 设为工程目录、
   源文件与 `-I` 一律用**工程文件里的相对路径原文**，只有 `-o`/`--scatter` 用绝对路径，
   且落在纯 ASCII 的插件工作区（不污染用户工程）。
6. **Keil 工程源码常常是 GBK**。按 UTF-8 读会 `invalid UTF-8` 或乱码，改完写回去会在 Keil 里
   显示成乱码。读写都必须走 `srcfile.js`；写回依赖 `scripts/transcode.ps1`（Node 无内置 GBK 编码器）。
7. **插件根 `package.json` 是 `type: module`**。放在插件根目录的辅助 `.js` 脚本要么写 ESM，
   要么改名 `.cjs`（`backend/` 已用 `{"type":"commonjs"}` 就近隔离）。

### 验证方式（可复现）

拿 Keil 自己的命令行 UV4 在**临时副本**上做参照构建，再逐地址比对两份 hex：

```
仅 Keil 有 / 仅插件有 / 公共地址上不同的字节：0 / 0 / 0
✅ 内容完全一致
```

单文件定位差异用 `scripts/keil-param-experiment.js`（参数二分）、
`scripts/keil-symdiff.js`（符号表逐函数比大小）。

## 闭环补强（2026-10-14）—— P0 四项

对着「写代码 → 编译 → 烧录 → 观测 → 回归」逐环核对，结论是：**编译与烧录两环有实测证据，
写代码那一环是断的**。四项 P0 已补，全部有可复现的验证。

### 病根：同一个逻辑走了两条路

宿主半边原来只注册了路由和 preset，**一个 DSH 工具都没有**。于是界面走 HTTP，
AI 自己跑 `node scripts/*.js` 或手拼 URL —— 同一个逻辑两条路，这才是「Flash 面板数字不对」
「诊断脚本比对到 D 盘旧产物还打印一致」这类事故的共同原因。

### ① 宿主注册 `mcu` 工具（`index.js`）

一个工具、19 个 action：
`status/project/open/scan/files/read/write/build/flash/size/pins/regs/chip/reset/spec/symbols/readmem/gfx/watch`。
AI 与界面从此落在**同一套 /api** 上。

2026-10-18 新增三项（对应用户《工具问题记录》第 1/3/13 条）：
- `symbols`：解析构建产物 `.axf` 的符号表（`fromelf --text -s`），变量/函数的地址与大小不用再靠段偏移推算；
- `readmem`：读目标内存，`addr` 可写十六进制地址或符号名；后端 `init → mdw → exit`，**不 halt**；
- `gfx`：把 SSD1306 显存解成 128×64 点阵，返回 ASCII 图并落一份标准 PBM（默认自动找 `shadow` 等显存符号）。

同时修了两个工具输出/写入问题：
- `write` 失败时返回的 `data` 以前带 `undefined`（`currentMtime`），会被 DSH 判成
  `value is not lossless JSON`、把真实错误盖掉；现在 `done()` 统一清洗成无损 JSON，失败原因如实返回。
- `write` 现在**支持新建文件**：文件不存在时按 `encoding` 新建（默认含中文=UTF-8 BOM、纯 ASCII=UTF-8），
  返回 `created:true`；只有修改已有文件才有备份。

注册形态照 DSH 自己的 `dsh-tool-todo`：**不导入 `@deepseek-ai/dsh-tools`**
（插件不能依赖 Harness 的包）。`defineTool` 那套 DSL 编译完就是原生 JSON Schema
（见其 `parameterSchemaSpecToJsonSchema`），所以直接写原生 JSON Schema 注册等价，且少一个版本耦合点。
注意 DSH 只接受这个子集：`type/oneOf/properties/required/additionalProperties/items/enum/const`，
且 `required` 必须是**字符串数组**，不是逐属性的 `required: true`。

`index.js` 因此多导出 `mcuToolDefinition`，好让 `scripts/test-mcu-tool.js` 能脱离 DSH 直接测它。

### ② 源码读写路由（编码感知，`server.js` + `srcfile.js`）

`srcfile.js` 的 `writeText()` 早就写好了，但**零调用者** —— 没有任何路由用它，
所以工作台看不见也改不了代码，GBK 写回全靠手工跑 `transcode.ps1`。

新增三条路由：

| 路由 | 作用 |
| --- | --- |
| `GET  /api/keil/src/list` | 列出工程源文件与各自编码（不泄露绝对路径） |
| `GET  /api/keil/src/read?path=` | 读单个文件，自动识别 GBK/UTF-8/BOM |
| `POST /api/keil/src/write` | 写回（**按原编码**），写前自动备份，支持并发防呆 |

两条安全规矩：
1. **只能碰当前打开的工程目录里的文件**，用 `path.relative` 判包含关系挡住 `..\..\` 穿越，越界 403；
2. 写之前把原件备份到 `build/src-backup/<时间戳>/`，备份路径回给调用方。
   另外 `expectMtime` 对不上就 409 拒绝覆盖（防止读了之后被别处改过又盲写）。

### ③ 编译诊断结构化（新模块 `server/diag.js`）

以前 `errors` 只有 `{file:'..\\User\\main.c'}` —— 行号、错误码、原文全丢，界面等于什么都没说；
`keil-build.js:142` 那句 `warnings.push(f.raw)` 更把警告也压成了一个文件名。

`diag.js` 把真实输出里的
`"..\Hardware\IRSensor.c", line 97: Warning:  #1-D: ...`
解析成 `{level, file, line, col, code, message, raw, tool}`，并且：

- 认 `armcc` / `armasm` / `armlink`（含 `L6218E` 这类链接错误码）三种形态；
- 容忍工作台落盘日志的 `[build] ` 前缀；
- **不把 `.\x.c: 1 warning, 0 errors` 这种每文件汇总行当成一条诊断**；
- 解析不出来就返回 null，绝不编造行号。

构建返回因此多了 `diagnostics`（按严重度分好的 `warnings`/`errors` 也在），
并且**成功构建时的警告不再被丢掉** —— 毕设工程本来就有 8 条警告一直看不见。

界面（`client.js`）新增「编译诊断」面板：按严重度分组列出，**点一条直接看那一行的源码**
（走 `src/read`，GBK 也能正确解码，带前后 6 行上下文）。

### ④ 诊断脚本不再写死开发期路径（`scripts/_ctx.js`）

`scripts/` 里那些是「为什么和 Keil 差 48 字节」那次调试的产物，当时把调试现场的绝对路径写死进了源码：

```js
const OURS_DIR = 'D:\\AI workspace\\stm32-workbench\\backend\\firmware\\build\\keil\\Project-b04c7833';
```

**危险的不是跑不起来，而是跑起来更像对的**：插件真正在用的是 `.dsh` 下那份，
而 `outputKey()` 是「工程名 + 路径哈希」，两份目录**同名** —— 脚本会去读 D 盘那份陈旧产物，
比出一个与当前代码毫无关系的「0 差异」。

现在一切路径从 `_ctx.js`（即脚本自己的位置）推出来：`projectFile()` 读
`build/keil-recent.json`，`latestBuildDir()` 取本插件最新的产物目录，`keilTools()` 从
`toolchain.detectEnv()` 取 armcc/fromelf 并反推 UV4。规矩是**缺东西就中止**（退出码 3），
并且 `staleness()` 会在**产物比源码旧**时直接拦下来（`--allow-stale` 可强制放行）。
命令行可用 `--project` / `--build-dir` / `MCU_PROJECT` / `MCU_BUILD_DIR` 覆盖。

### ⑤ 功能契约：让用户读人话，不读代码（`server/features.js`）

**用户不读 C 文件。** 他要知道的是「这块板子现在能干什么」——
上电先看到什么、按了键有什么反应、串口吐什么格式、哪个功能是半成品。
这一层以前完全不存在：代码改完，用户只能靠模型在对话里随口说两句。

现在它是一个**受管理的契约层**：

```
<工程>\.dsh-mcu\features.json            模块化的自然语言功能描述（跟工程走）
<工程>\.dsh-mcu\project.json             工程卡：芯片/工具链/烧录端口/引脚表/外设（与工具链无关）
<工程>\.dsh-mcu\features-history\*.json  最近 20 版，面板上可一键退回
```

`.dsh-mcu/` 默认被 `.gitignore` 里的 `*` 挡住。**想让工程卡跟着仓库走**（推荐：
它描述的是硬件事实，换机器/换协作者都该带着），在工程 `.gitignore` 里加一行
`!.dsh-mcu/project.json` 即可。

模块形状 `{id, name, summary, detail, files[], status}`，
`status ∈ done 已实现 / partial 部分实现 / todo 还没做 / broken 有问题`。

闭环是**三段**，缺一段这套东西就没意义：

| 段 | 谁做 | 走哪条路 |
| --- | --- | --- |
| 模型改完代码 → 重写描述 | 模型 | `mcu action=spec` + `content={modules:[…]}` |
| 用户读描述 → 直接改描述 | 人 | 工作台「功能清单」页，就地编辑 |
| 改完 → 回去改代码 | 人 → 模型 | 面板发一条自然语言需求到当前会话（`ctx.sessions`） |

三个不那么显然的设计决定：

1. **过期横幅是这套机制的牙齿**。`staleness()` 拿描述的时间戳和工程里源码的 mtime 比：
   描述之后还有人改代码 → 面板顶上一条警告，并指出是哪个文件。
   **没有它，用户读到的可能是关于旧代码的描述 —— 那比没有描述更糟。**
   `.dsh-mcu/` 整个目录跳过，否则每次编译的产物都会把它误判成「过期」。
2. **发给模型的那段话由后端生成**（`buildMessage` / `buildRefreshMessage` / `buildDescribeMessage`），
   不在前端拼字符串。措辞是机制的核心（改代码 + 回写描述 + 用自然语言汇报），
   只能有一份、必须可测试。
3. **投递失败要如实失败**。客户端半边用 `ctx.sessions.binding(id).session.prompt(...)`
   发消息；拿不到会话就退化成「复制粘贴」，**不假装发成功**。

路由：

| 路由 | 作用 |
| --- | --- |
| `GET  /api/features` | 读描述 + 过期判定 + 渲染好的 Markdown + 历史列表 |
| `POST /api/features` | 保存（自动留历史，内容没变不新增版本） |
| `POST /api/features/message` | 把「用户改的描述」编译成一条发给模型的话（`revise`/`refresh`/`describe`） |
| `POST /api/features/restore` | 退回某个历史版本（恢复本身也进历史，所以「撤销撤销」可用） |

`features.json` 坏掉时**如实报 broken、不删不改** —— 用户的字不替用户做主。

### 怎么复现验证

```
node backend/scripts/test-diag.js       # 拿真 armcc 编一个故意写错的文件，验证诊断解析
node backend/scripts/test-src-api.js    # 造沙箱工程，端到端验证源码读写（含 GBK 往返、越界、并发）
node backend/scripts/test-mcu-tool.js   # 脱离 DSH 直接跑 mcu 工具的全部 action
node backend/scripts/test-features.js   # 功能契约：纯逻辑 + 沙箱端到端 + mcu action=spec 读写
node backend/scripts/keil-verify.js     # 与 Keil 产物逐字节比对（自动拒绝陈旧产物）
```

四个 test 脚本都在**插件自己的工作区**里造沙箱/落产物，不写用户的 Keil 工程；
`test-src-api.js` 与 `test-features.js` 会快照并还原全局 `recent.json`
（打开沙箱工程会覆盖「上次打开的工程」，踩过两次）。
`test-mcu-tool.js` 里 `symbols` 依赖一次成功构建，`readmem`/`gfx`/`watch`/`chip`/`reset` 依赖实物 ST-Link ——
没有硬件时这几项会**如实失败**（脚本断言的是「如实」，不是「必须成功」）。

## 0.5.0：工程卡（2026-10-24）—— 换工程不用重新猜

**问题**：AI 每换一个工程，都要重新解析 `.uvprojx` 才知道芯片/源文件/工具链；引脚和烧录端口
还得靠扫源码反推。下一步要接 ESP32-S3-CAM，那边**根本没有 Keil 工程文件** —— 再写第二套解析器，
工具接口就会分叉（「STM32 这样问、ESP32 那样问」），那才是真繁杂。

**做法**：把「工程事实」抽成一份与工具链无关的 JSON，Keil 降级成「导入器 + 一个构建后端」。

```
<工程>/.dsh-mcu/project.json   芯片/内存 · 工具链 · 烧录端口 · 串口 · 引脚表 · 外设 · 源文件分布
```

| op | 行为 |
| --- | --- |
| （缺省）`read` | 读卡 + 校验；没卡时告诉你怎么生成 |
| `import` | 从 `.uvprojx` 生成草案：器件 / 内存布局 / 工程文件 / OpenOCD target / 源文件目录 |
| `init` | 按证据文件识别工具链：ESP-IDF（CMakeLists + sdkconfig/main）、PlatformIO（platformio.ini）、Keil |
| `write` | 增量补丁：深合并、数组整体替换、`null` 删字段；日常只发改动部分 |
| `validate` | 只校验不写；路径给 `.uvprojx` 且还没卡时，预览 import 会生成什么 |

四条硬规矩：

1. **导入不猜**。`.uvprojx` 里没有引脚和串口，导入就留空，由 `validate` 的 `missing` 报「该补什么」。
   一张看起来完整、实际是编的卡，比没有卡更危险。
2. **已有卡不覆盖**。`import`/`init` 遇到已有 `project.json` 直接拒绝 —— 那是人/模型确认过的事实，
   不能被一次误调用冲掉；要改走 `write`。
3. **引脚冲突算 error**：同一脚两个信号、保留脚（SWD）被占用、外设引用了不存在的脚，
   都会明文列出来（`errors` 非空但写入仍成功 —— 文件写成功与内容自洽是两件事）。
4. **`pins` 以卡为准**：卡里有引脚表就直接返回，并标明来源与 mtime；没有才回退到源码推导。
   两条路径结论可能不同，模型必须能分辨「声明的事实」与「反推的结果」。

`status` 已经带上卡摘要（芯片 · 工具链 · 引脚数 · 串口 · 待补项），所以新会话仍然只需要一次 status。
`project` 也是**唯一不要求已打开 Keil 工程**的读接口：给 `path` 就能读任意工程目录的卡。

回归：新增 `backend/scripts/test-projectcard.js`（模块级 40+ 断言，全在临时目录跑），
`test-mcu-tool.js` 增加 `project` 全流程与「pins 以卡为准」断言，19 个 action 覆盖 18 个（flash 需显式 `--with-flash`）。

## 0.4.0：为 AI 省 token（2026-10-19/20）

目标是「对 AI 更好用、更易上手，别把 token 浪费在空转上」。做了六件事：

| 改动 | 省掉了什么 |
| --- | --- |
| `status` 改为 `/api/keil/overview` 聚合 | 新会话以前要 status→spec→size→chip 四次调用，现在一次拿全（工程/契约/上次构建/工具链） |
| 工具输出按 action 紧凑渲染（`full:true` 才回原始 JSON） | `size`/`symbols`/`pins`/`regs`/`readmem` 不再把 summary 说过的东西用 JSON 再抄一遍 |
| `gfx` 默认只回指纹/亮点/基线差异，`mode=ascii` 才拉图，`region` 只看局部 | 查「屏幕变没变」从约 2K token 降到几十 token |
| `gfx baseline=save|compare` | 「按键后第一行变了没有」这类验证有了一条命令的闭环 |
| `spec` 支持 `{updates:[…]}` / `{remove:[…]}` 增量写 | 日常只发改动字段，不必整份重述 8~10 个模块 |
| 读类 action 自动加载最近工程 | 不必为了读一个符号先调一次 `open` |

外加 `watch`：单次 OpenOCD 会话内用 Tcl 循环采样一个变量/寄存器，看「1 ms 节拍在不在跑」「任务周期抖不抖」，
不必再为每个点重连一次 SWD。

## 适配 DSH 0.2.1（2026-10-18）

DSH 从 0.2.0 升到 **0.2.1-rc.2**（Electron 44.7.0）后，用户报告 `mcu` 工具全部失败。查明是
**插件自身的启动逻辑问题被新版启动时序放大**，与新版宿主 API 无关（`/mcu/state`、工具注册、
preset 注册在新版都正常）：

### 根因（三层，缺一不可）

1. **健康检查选错端点**：`waitForHealth()` 用 `/api/env` 探活，每次只等 1.5 s；而 `/api/env` 要枚举串口，
   在 Windows 上会起一个 `powershell.exe`（实测 ~2 s）—— 每一次探测都超时，20 s 后判「后端启动超时」。
2. **超时后不清理**：健康检查失败时不 kill 子进程、也不复位 `child/childPort`，后端变孤儿；下一次
   `start()` 又 spawn 一个 → `EADDRINUSE` 死循环。
3. **`port: 0` 是假的**：`index.js` 只在 `port > 0` 时才把 `MCU_AGENT_PORT` 传给后端，`0`（本意=系统分配）
   没生效，后端退回默认 **8788** 固定端口 —— 多实例/DSH 热重启必抢。

### 修复

| 位置 | 改动 |
| --- | --- |
| `backend/server/server.js` | 新增 `GET /api/ping`（不碰磁盘、不起子进程，毫秒级）；`LISTEN` 行改为**最先打印**；`EADDRINUSE` 给人话提示 |
| `backend/server/toolchain.js` | `detectEnv()` 加 5 s 缓存（`?fresh=1` 强制刷新），`/api/env` 不再每次起 powershell |
| `index.js` | `waitForHealth` 改打 `/api/ping`（30 s 窗口）；总是传 `MCU_AGENT_PORT`（`0` 有效）；失败即清理子进程；固定端口启动前用 `/api/ping` **认领已在跑的旧后端**（`adopted:true`）；`autoStartDelayMs` 默认 1200 ms，避开 DSH 启动期忙 |
| `index.js` `/mcu/state` | 多报 `adopted` / `backendPid` / 解析到的后端目录，排查时一眼看到后端是谁 |

### 新版规范性

- 补 `locale/en.json`、`locale/zh.json`（`meta.title`/`meta.description`）与 `icon.svg`；
  `exports` 增加 `./locale/*.json`、`./icon`，`files` 白名单补上（DSH 0.2.1 的
  `host-plugin.md`「Display metadata and icon」清单要求，缺了会退回包名/默认图）。
- 版本 `0.2.0 → 0.3.0`。
- **改完插件代码必须重启 DSH**（装载器不热替换已装载的包代际），客户端资源还要刷新页面；
  只同步 `local-plugins` 副本不重启，运行中的仍是旧代码。

### 安装后自检（不开 DSH 也能跑）

```bash
# 宿主半边：假 Cordis ctx 直接加载 index.js，验证 preset/工具/路由/后端生命周期
node -e "import('./index.js').then(m=>console.log(Object.keys(m)))"   # 至少能加载
# 后端半边：直起一个隔离实例
$env:MCU_AGENT_PORT='18990'; node backend/server/server.js
# 然后 curl http://127.0.0.1:18990/api/ping
```

`/api/ping` 返回 `{ok:true,name:"stm32-workbench-backend",pid,cwd,port,startedAt,uptimeMs}`，
`cwd` 用来确认后端是不是插件自己那份。


