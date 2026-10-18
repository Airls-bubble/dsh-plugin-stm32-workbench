# STM32F103C8T6 开发工作台

给「自己动手玩 STM32F103C8T6 最小系统板」准备的一套本地工具：**真的编译、真的烧录、真的看串口**，外加一块引脚规划界面。
不是一个仿真演示——界面上的构建按钮走的是你机器上的 Keil AC5，产物是能直接烧进板子的 `.hex`。

---

## 一、它到底能做什么

| 能力 | 实现方式 | 状态 |
| --- | --- | --- |
| 编译出真实固件 | Keil MDK **ARM Compiler 5（armcc）** → armasm → armlink → fromelf | ✅ 已跑通，产出 axf/bin/hex |
| 烧录到板子 | **OpenOCD + ST-Link（SWD）**，带 verify | ⚠️ 工具链就位，**等你插上 ST-Link 才能验证** |
| 串口收发 | .NET SerialPort 桥（无需装 node 包） | ⚠️ 无串口设备时无法验证 |
| 引脚规划 | LQFP48 交互引脚图 + 复用功能冲突检查 + 生成 C 代码 | ✅ 数据表与界面（见 `data/pins.json`） |
| 尺寸账本 | armlink 的 Program Size → Flash/SRAM 占用条 | ✅ |
| 给 agent 用 | 命令行 `build.ps1` / `flash.ps1` + HTTP 接口 | ✅ |

### 这台机器上的实测结果（不是估计）

```
Program Size: Code=1220 RO-data=268 RW-data=20 ZI-data=3172
  → Flash 占用 1508 B / 64 KB，SRAM 占用 3192 B / 20 KB
```

编译器路径：`C:\Keil_v5\ARM\ARMCC\bin\armcc.exe`（自动探测，支持注册表与常见目录）
烧录器路径：`tools\openocd\xpack-openocd-0.12.0-7\bin\openocd.exe`（xPack 便携版，由 `scripts\fetch-openocd.ps1` 下载，不污染系统）

---

## 二、目录结构

> ⚠ 这份文档写于**独立工作台时期**（当时整个东西是一个能双击启动的桌面文件夹）。
> 现在它已经是 DSH 插件，入口是会话里的工作台面板与 `mcu` 工具，不再有 `启动工作台.bat`；
> 运行期数据也搬出了插件目录（见 `server/paths.js` 与仓库根的 `PORTING.md`）。
> 下面的结构与说明保留作历史记录，**以实际文件为准**。

```
stm32-workbench\backend\        ← 现在的插件后端目录（原「单片机agent」文件夹）
├─ server\                 ← 本地后端（零依赖，只用 node:http）
│   ├─ server.js           接口与静态托管（默认 127.0.0.1:8788）
│   ├─ toolchain.js        工具链探测（Keil 注册表/常见目录、OpenOCD、串口）
│   ├─ build.js            armcc→armasm→armlink→fromelf 构建流程
│   ├─ openocd.js          SWD 探测 / 烧录 / 复位
│   └─ serial.js           串口会话管理（驱动 scripts\serial-bridge.ps1）
├─ web\                    ← 界面（引脚图 / 构建台 / 烧录 / 串口台 / 计算器）
├─ DSH-MODE.md             ← 「单片机模式」怎么装、怎么回滚、为什么这么做
├─ firmware\
│   ├─ bsp\cmsis\          CMSIS Cortex-M3 核心头 + STM32F10x 设备头
│   ├─ bsp\startup\        ST 官方启动文件 + armlink 分散加载脚本
│   ├─ template\           工程模板（新建工程时复制）
│   ├─ projects\           你的工程（每个一个文件夹）
│   └─ build\              构建产物（axf / hex / bin / .o）
├─ data\                   引脚表与外设映射（pins.json / peripherals.json）
├─ scripts\                构建、烧录、串口桥、工具链准备
├─ tools\openocd\          便携 OpenOCD
└─ AGENT.md                ← 给 AI agent 的操作手册（工具链路径、命令、API）
```

---

## 三、开始使用

### 1. 打开工作台

双击 **`启动工作台.bat`**，浏览器会自动打开 `http://127.0.0.1:8788/`。
或者命令行：

```powershell
node server\server.js
```

后端只监听 `127.0.0.1`，不对外网开放。

### 2. 构建一个工程

界面里选 `blink-uart` → 点「构建」。命令行等价写法：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build.ps1 -Project blink-uart
```

产物在 `firmware\build\blink-uart\`：`blink-uart.axf`（调试用）、`.hex`（烧录用）、`.bin`（裸镜像）。

### 3. 烧录（需要插上 ST-Link）

接线（板子 3.3V 供电，四根线）：

| ST-Link | 最小系统板 |
| --- | --- |
| 3.3V | 3V3 |
| GND | GND |
| SWDIO | DIO / PA13 |
| SWCLK | CLK / PA14 |

先探测，再烧录：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\flash.ps1 -Probe            # 只探测
powershell -ExecutionPolicy Bypass -File scripts\flash.ps1 -Project blink-uart
powershell -ExecutionPolicy Bypass -File scripts\flash.ps1 -Reset            # 只复位
```

**没插板子时它会明确报错**，这是正确行为：`Error: open failed` 表示没找到 ST-Link 或目标。

### 4. 看串口

`blink-uart` 跑起来后，会以 115200 8N1 在 USART1（PA9=TX / PA10=RX）上打印启动信息并回显你发的字符。
接线：**PA9 → USB 转串口的 RXD，PA10 → TXD，GND 对 GND**（TX 接 RX，别接错）。
然后在界面的「串口台」里选端口、115200，打开即可。

---

## 四、关于 `blink-uart` 模板

寄存器级写法，**不依赖标准外设库**，只用 CMSIS 设备头——这样模板不会因为你没装器件包就编不过：

- 板载 LED：**PC13，低电平点亮**（换板子改 `board.h` 里三个宏）
- 串口：USART1 PA9/PA10，115200 8N1
- 时钟：**走 HSI 8 MHz**，刻意不做 PLL 倍频——不依赖外部晶振，插上就能跑，先把「编译→烧录→串口」链路打通
- 主循环：LED 闪烁 + 每两轮打印一次存活信息 + 回显串口收到的每个字符

想做正经项目时，把 `firmware\projects\<名>\` 里的 `main.c` 换成你自己的逻辑即可，构建脚本会自动收集该目录下所有 `.c`。

---

## 五、HTTP 接口（界面与 agent 共用）

基址 `http://127.0.0.1:8788/api`，长任务返回 **NDJSON** 流（每行一个 JSON）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/env` | 环境探测：编译器、烧录器、串口、板子线索 |
| POST | `/api/detect` | 同上，重新探测 |
| GET | `/api/pins` | LQFP48 引脚表 |
| GET | `/api/peripherals` | 外设-引脚映射 |
| GET | `/api/templates` | 可用模板 |
| GET / POST / DELETE | `/api/projects[/{id}]` | 列出 / 新建 / 删除工程 |
| POST | `/api/build` | 构建（流式日志） |
| POST | `/api/flash` | 烧录（流式日志） |
| POST | `/api/chip-info` | 读芯片 ID / Flash 容量 |
| POST | `/api/reset` | 复位目标 |
| POST | `/api/serial/open`·`/close`·`/write` | 串口控制 |
| GET | `/api/serial/stream?sessionId=` | 串口数据流 |

---

## 六、校验脚本（四道，随时可复跑）

```powershell
node data\validate-pins.js            # 引脚表：48 脚完整性、枚举合法性、来源标注（47 项）
node scripts\verify-consistency.js    # 跨文件：EXTI 线号 vs 位号、pins.json ↔ peripherals.json 双向一致
node web\selftest.js --api            # 前端：几何方向、标签不重叠、计算器数值、分配冲突、代码生成（96 项）
node scripts\verify-artifact.js blink-uart   # 产物：HEX 校验和、向量表 SP/Reset、Thumb 位、容量（8 项）
```

**这套校验不是摆设**——它真的抓到过一个错：`pins.json` 里 PB0/PB1/PB2 的 EXTI 线号被写成 EXTI8/9/10，
而 EXTI 线号只看端口位号（0–15），正确值是 EXTI0/1/2。当时 `peripherals.json` 是对的，
两份文件自相矛盾——单文件校验查不出来，所以才有 `verify-consistency.js`。同类错误现在会被第 1 项直接拦下。

---

## 七、踩过的坑（留给以后的自己）

1. **中文路径会打死 armcc**：armcc 的命令行按 ANSI 解析，工程目录含中文时绝对路径会被拆坏（实测报 `cannot open source input file`，路径里出现乱码）。解法：**先 `cd` 到工程目录，全部用相对路径**调用工具链——`build.js` 与 `build.ps1` 都是这么做的，这套东西也因此能整个文件夹搬走。
2. **`-DUSE_STDPERIPH_DRIVER=0` 无效**：`stm32f10x.h` 用的是 `#if !defined`，只要「定义过」就会去找 `stm32f10x_conf.h`。不用标准库就**完全不要定义它**。
3. **设备宏必须给**：`-DSTM32F10X_MD`（中等容量），否则头文件直接 `#error`。
4. **`--microlib` 是 armcc 的选项**，不是 armlink 的，别往链接器上扔。
5. **ST 官网下载会被掐断**（实测 `连接被意外关闭`）：设备头改为取自 Keil 自带的模板目录（`C:\Keil_v5\ARM\Flash\_Template\Test`），CMSIS 核心头取自 ARM 官方 GitHub。

---

## 八、当前边界（不吹牛）

- **Flash 标称 64 KB**：F103C8 部分批次实际能用 128 KB，但链接脚本按标称布局，超出会直接报错而不是悄悄烧穿。要放宽就改 `firmware\bsp\startup\stm32f103c8.ld`。
- **只用 AC5 流程**：ARM Compiler 6（armclang）已探测到但未接入构建流程。
- **烧录与串口需要实物**：没插 ST-Link / 没有串口设备时，界面会如实显示「未检测到」，不会假装成功。
- **标准外设库（SPL / HAL）未随附**：现在只有寄存器级模板。想用 SPL 就把库放进 `firmware\` 并把 `-DUSE_STDPERIPH_DRIVER` 加回构建参数（记得同时提供 `stm32f10x_conf.h`）。
- **引脚表以外设手册为准**：`data/pins.json` 中每条数据带 `verified` 与 `source` 字段，未核实的项会明确标出来；接线前建议复核数据手册 DS5319。
  - 已按 DS5319 Rev19 Table 5 核对：**PA13/PA14/PA15/PB3/PB4 是 5V 容忍（FT）**，它们的特殊之处是被 SWJ/JTAG 默认占用，不是电平例外（这是个流传很广的误传）。
  - **不**标 FT 的 16 个 IO：PA0–PA7、PB0、PB1、PB5、PC13/PC14/PC15、PD0/PD1。界面一律读数据里的 `fiveVTolerant`，不按端口名硬编码。
  - 唯一 `verified:false` 的是 **PB5（pin 41）**：手册该行 I/O 结构列空缺，社区讨论帖正文抓不到——接 5V 前请实测。
  - 引脚表是 47 项自动校验全过的（`node data/validate-pins.js`），但这只证明结构完整与枚举合法，**不证明每个复用功能都对**。
- **没有实现**：RTOS 集成、调试器（GDB）接入、OTA、多芯片型号支持。

---

## 九、许可与来源

- CMSIS Cortex-M3 核心头：ARM 官方 CMSIS_5 仓库（Apache-2.0）
- STM32F10x 设备头 / 启动文件 / system 文件：Keil MDK 自带模板（ST 原版，BSD-3-Clause 风格声明见文件头）
- OpenOCD：xPack 便携发行版（GPL-2.0）
- Keil MDK / ARM Compiler：你本机已安装的商业工具，本项目只调用、不分发
