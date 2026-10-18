# 移植到另一台电脑

这个插件的目标是**一个目录拷走就能用**。插件本体只装代码（约 1.8 MB，不含便携 OpenOCD ——
它由 `backend/scripts/fetch-openocd.ps1` 按需下载 7.6 MB），运行期数据一律落在别处 ——
所以拷过去不用先清理，也没有要删的缓存。

> **版本对应**：0.3.0 起适配 DSH **0.2.1-rc.2+**（Electron 44.7.0）。旧版 DSH（0.2.0）没有验证过；
> 新版要求的 `locale/{en,zh}.json` + `icon.svg` 显示元数据已随包提供（缺了设置页会退回包名/默认图）。
> 仓库代码为 MIT（见 [LICENSE](LICENSE)），第三方组件许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

---

## 一、前置条件

| 需要什么 | 说明 | 不装会怎样 |
| --- | --- | --- |
| **Windows** | 后端依赖 `armcc` 与 ST-Link 的 Windows 驱动 | 非 Windows 跑不了 |
| **Keil MDK + ARM Compiler 5（AC5）** | 装在哪都行，插件会自动探测（环境变量 `KEIL_ROOT` 可指定） | 「构建」会明确报「没有找到可用的 armcc」 |
| **ST-Link 的 USB 驱动** | Keil 装完通常自带；或用 ST 官方的 ST-LINK USB driver | 检测连接 / 烧录失败，读寄存器也会失败 |
| **DSH**（DeepSeek Harness）**0.2.1-rc.2 或更新** | 插件宿主；0.3.0 按新版插件规范适配 | 旧版未验证（显示元数据/工具契约可能不同） |

**不需要**单独装 armcc、armlink、fromelf —— 那三个来自 Keil；
OpenOCD 用仓库带的 `backend/scripts/fetch-openocd.ps1` 一键下载（或在系统 PATH 里自备，插件会自动探测）。

### 可选：USB 转串口模块

串口面板要**真有一个 COM 口**才能验证（本机开发时一直是 0 个串口，所以这一环至今未跑通）。
接线：模块 `RXD → PA9`、`TXD → PA10`、`GND → GND`。

---

## 二、装

1. 把整个 `stm32-workbench` 目录拷到新机器上**任意位置**（路径含中文也可以，插件自己会处理
   armcc 的中文 argv 问题）。
2. 准备便携 OpenOCD（只需一次；仓库里故意不提交这 7.6 MB 二进制）：

   ```
   powershell -ExecutionPolicy Bypass -File backend\scripts\fetch-openocd.ps1
   ```

   脚本从官方 xPack release 下载 `xpack-openocd-0.12.0-7-win32-x64.zip` 并校验 sha256，
   解压到 `backend\tools\openocd\`（该目录已 gitignore，不进仓库）。
3. 用 `plugin_manager` 安装：

   ```
   plugin_manager: install_bundle target=<你放 stm32-workbench 的那个绝对路径>
   ```

4. **重启 DSH**（装载器不热替换已装载的包代际），然后刷新页面。
5. 侧栏底部应出现「STM32 工作台」；新建/选中的会话进入「单片机模式」后，工作台挂在会话视图里。
   设置页/插件页里应能看到「STM32 工作台 / STM32 Workbench」标题、描述和图标。

> 装完可以访问 `http://127.0.0.1:<你的 DSH 端口>/mcu/state` 看宿主状态。
> 正常情况下 `codeDir` 与 `backendDir` 指向**同一个**插件目录、`splitCodeBackend:false`；
> 只有你显式配置了 `config.backendDir` 指向另一份后端时才会不同（那就需要自己保证两份同步）。
> `running:true` + `port>0` + `error:null` 才说明后端起来了；`adopted:true` 表示复用了已在跑的旧后端。
>
> **改完插件代码必须重启 DSH**（客户端资源还要刷新页面）。只改文件不重启，运行中的仍是旧代际 ——
> 2026-10-18 那次「改了没生效」就是因为 DSH 还在跑 13:20 加载的旧 JS。

---

## 三、装完自检

```
node backend/scripts/test-diag.js      # 用真 armcc 编一个故意写错的文件，验证诊断解析
```

要跑源码读写与工具的端到端测试，先在工作台里打开一次 Keil 工程（让后端记住它），然后：

```
node backend/scripts/test-src-api.js   # 沙箱在系统临时目录，不碰你的工程
node backend/scripts/test-features.js  # 功能契约：纯逻辑 + 沙箱端到端
node backend/scripts/test-mcu-tool.js  # 会真的编译一次你的工程
node backend/scripts/keil-verify.js    # 与 Keil 自己编出的 Objects\Project.hex 逐字节比对
```

`test-mcu-tool.js` 里 `symbols` 依赖一次成功构建；`readmem`/`gfx`/`chip`/`reset` 依赖实物 ST-Link——
没有硬件时这四项会**如实失败**（脚本断言的是「如实上报」，不是「必须成功」）。

不做任何 DSH 安装操作、只验证后端本身：

```
$env:MCU_AGENT_PORT='18990'; node backend/server/server.js
# 另开一个终端：
#   GET  http://127.0.0.1:18990/api/ping        → {ok:true,name:"stm32-workbench-backend",...}
#   GET  http://127.0.0.1:18990/api/env         → 编译器/烧录器/串口探测（默认 5 s 缓存，?fresh=1 强制刷新）
```

---

## 四、数据落在哪（重要）

**插件目录里不会有任何运行期文件。** 数据分两处：

```
<你打开的 Keil 工程目录>/
└── .dsh-mcu/                  ← 跟这个工程有关的一切，全部可以安全删除
    ├── .gitignore             ← 内容就是 `*`，不会误提交
    ├── build/keil/<工程>-<哈希>/   ← 构建产物（.o/.axf/.hex/.bin/Project.map）
    ├── last-build.json        ← 构建账本（占用、诊断、产物路径）
    ├── logs/                  ← armlink 完整输出
    ├── src-backup/<时间戳>/    ← 源码写回前的备份
    ├── uv4-ref/               ← 「与 Keil 逐字节一致」验证用的参照构建
    ├── tmp/gfx/               ← gfx 落盘的屏幕 PBM 文件（可直接打开看）
    └── tmp/                   ← 参数实验等临时文件

<DSH_HOME>/mcu/                ← 默认 ~/.dsh/mcu
├── recent.json                ← 上次打开的是哪个工程（唯一一处跨工程记忆）
└── build/<工程>/               ← 自带测试工程（blink-uart）的构建输出

<系统临时目录>/dsh-mcu/         ← OpenOCD 的临时 cfg（ASCII 路径，随系统清理）
```

**换工作区 = 换一整套缓存。** 切回去直接读得到，不用重新编译。

工程目录**只读**时（网络盘、受保护目录），`.dsh-mcu/` 会自动退到
`<DSH_HOME>/mcu/projects/<路径哈希>/`，并留一张 `WHY-HERE.txt` 说明原因。

---

## 五、常见问题

**mcu 报「后端启动失败 / 后端启动超时 / EADDRINUSE」**
先看 `http://127.0.0.1:<DSH 端口>/mcu/state`：
- `error` 里写「端口 X 已被其它进程占用」→ 上一次 DSH 异常退出留下的后端还活着。把插件
  `config.port` 设为 `0`（默认就是 0，系统分配空闲端口）或手工结束那个 node 进程；
- `running:true` 但 `adopted:true` → 复用了已在运行的后端，正常；
- 仍报超时 → 看 DSH 日志里 `stm32-workbench 后端:` 的 stderr，后端启动失败的真实原因都在那里。
> 2026-10-18 修过一次：旧版用 `/api/env`（会起 powershell 枚举串口，约 2 s）做健康检查，
> 每次只等 1.5 s → 必然超时 → 误报「后端启动超时」并留下占端口的孤儿。现在改用 `/api/ping`。

**含中文的 `.c/.h` 被宿主 `edit`/`write` 写坏（BOM 丢失 → armcc 乱码）**
DSH 宿主的 `edit`/`write` 会丢 UTF-8 BOM（新 DSH 0.2.1 实测仍然如此），armcc 靠 BOM 判断编码。
**含非 ASCII 字符的源文件请用 `mcu action=write` 写**（插件保证「原本有 BOM 写回必有 BOM」，
GBK 文件也按原编码往返）。这条是宿主工具的问题，插件改不了。

**`mcu write` 报 `tool "mcu" returned invalid output: value is not lossless JSON`**
2026-10-18 之前的版本有 bug：write 失败分支里的 `currentMtime` 是 `undefined`（只有 STALE 错误才有），
DSH 会把整条工具结果判成「不是无损 JSON」，把真实错误（文件不存在 / 越界 / 转码失败）盖掉。
已修：所有工具返回值统一清洗成无损 JSON，失败原因如实显示。**如果还看到这句，说明 DSH 仍在跑旧代码，
重启 DSH 即可。**
另外旧版 `mcu write` **只能改已有文件**；新版支持新建（文件不存在时按 `encoding` 新建，默认含中文=UTF-8 BOM）。

**构建报「没有找到可用的 armcc」**
Keil 没装，或装在非常规位置。设环境变量 `KEIL_ROOT` 指向 Keil 根目录
（即含 `ARM\` 与 `UV4\` 的那一层），重启 DSH。

**检测连接 / 烧录失败**
先看 ST-Link 驱动装了没；再确认板子供电与 SWD 接线（SWDIO/SWCLK/GND，必要时接 NRST）。

**串口面板没设备**
没插 USB 转串口模块。插上后**重启后端**（重启 DSH 即可）才会重新枚举。

**中文用户名 / 中文路径**
armcc 与 OpenOCD 是 ANSI 程序，命令行里的**非 ASCII 绝对路径**可能被拆坏。
插件对编译的做法是：`cwd` 设为工程目录、源文件与 `-I` 用工程文件里的相对路径原文、
只有 `-o`/`--scatter` 用绝对路径且落在 `.dsh-mcu/` 或系统临时目录下。
若你的 Windows 用户名是中文，系统临时目录也会带中文 —— 这时 OpenOCD 的临时 cfg
可能出问题，可以设 `DSH_HOME` 到纯 ASCII 路径规避。

**想确认插件本体没被写脏**
跑完任何操作后，插件目录的文件列表与时间戳应当完全不变。这是设计保证的，也可以自己核对。
