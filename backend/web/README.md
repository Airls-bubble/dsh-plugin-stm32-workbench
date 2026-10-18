# STM32 工作台 · 前端（web/）

STM32F103C8T6（LQFP48）的离线可用工程工作台：**引脚规划 / 构建台 / 烧录 / 串口台 / 计算器**。
纯原生 HTML + CSS + JavaScript，**无框架、无 CDN、无外部字体或图片**，与后端同源（`/api`）。

```
web/
  index.html   页面骨架（各视图的静态结构、对话框、状态条）
  style.css    工程工作台视觉：中性底、1px 细线、单一强调色（青绿）、等宽字体用于代码/日志/寄存器
  pinout.js    引脚数据 / LQFP48 几何 / 分配与冲突 / C 代码生成 / SVG 交互
  calc.js      定时器周期 + USART BRR 计算（纯函数 + DOM 装配）
  app.js       壳体：环境探测、页签、项目、构建、烧录、串口、状态条、主题
  selftest.js  交付前自验脚本（node 直接跑，见 §7）
  README.md    本文件
```

启动：后端同源托管本目录即可（`node server/server.js` 或 `npm start`，127.0.0.1:8788）。
直接双击 `index.html` 也能打开：引脚图与计算器照常工作，只是构建/烧录/串口会提示后端未启动。

---

## 1. 引脚规划（默认视图）

**LQFP48 引脚图是视觉主体**，坐标全部由脚号公式算出（`STM32Pinout.layout()`，纯函数，无手写坐标表）：

| 引脚 | 位置 | 方向 |
| --- | --- | --- |
| 1–12 | 左侧 | 自上而下 |
| 13–24 | 底边 | 自左向右 |
| 25–36 | 右侧 | 自下而上 |
| 37–48 | 顶边 | **自右向左**（37 在顶右紧邻 36，48 在顶左紧邻 1） |

> 顶边这一句与任务书最初写法相反：QFP 相邻脚必须连号，只有「顶边自右向左」才能让 36↔37、48↔1 相邻，
> 这也是 DS5319 LQFP48 顶视图的画法。代码里有断言级别的自验（见 §7）。

- **引脚数据**：优先 `GET /api/pins`（48 条，字段 `pin/name/port/type/io/fiveVTolerant/note/functions[]/verified/source`）。
  请求失败或数据不合法（不是 48 条 / 脚号重复）时，自动落回 `pinout.js` 里的**内置兜底表**，状态条与顶栏会标明数据来源
  （`data-src="api"` 或「内置兜底表」）。
- **点选引脚**：点击焊盘或用键盘选中 → 右侧详情面板显示脚号、名称、端口、类型、5V 容忍、备注、数据表列出的全部复用功能。
  `verified:false` 的脚（当前是 PB5 / 脚 41）会显示「数据未核实」徽标和一行提示，5V 结论不作为绿灯给出。
- **分配模式**：工具栏勾选后，详情面板里的可用功能变成按钮，点一下就绑定（GPIO 输出/开漏/输入/上拉/下拉/模拟、
  USART TX/RX、I2C SCL/SDA、SPI SCK/MISO/MOSI/NSS、ADC 输入、TIM PWM、EXTI 中断）。未勾选时列表只读。
  - 每个引脚一次只能承担一个功能；给同一引脚再次分配会替换旧功能（有 toast 提示）。
  - **冲突检查**：同一外设通道被两个引脚占用（含重映射脚，例如 PA9 与 PB6 都是 `USART1:TX`）、
    同名 EXTI 线来自两个端口、数据换源后引脚不再支持该功能、LQFP48 上不引出为 GPIO 的脚（PD0/PD1）都会在
    「冲突检查」面板里红色报错，冲突引脚的焊盘变红，生成的代码里也带 `⚠ 存在 N 项冲突` 头。
  - **提示（非错误）**：非 5V 容忍脚做输出、占用 JTAG/SWD 脚、PC13–PC15 驱动能力弱、需要重映射、
    串口只分配了 TX 或 RX、`verified:false` 的脚。
- **生成代码**：CMSIS 寄存器级（与 `firmware/bsp` 一致，不依赖标准外设库），逐脚写出 `CRL/CRH` 配置、必要的
  `BSRR/BRR` 上拉下拉、`AFIO->EXTICR/IMR/RTSR` 与 `NVIC_EnableIRQ`，重映射写成
  `AFIO->MAPR = (AFIO->MAPR & ~掩码) | 值;`（TIM2/TIM3 的部分重映射是多位字段，不能简单 `|=`）。
  按钮：复制（`navigator.clipboard`，失败自动降级到 `execCommand`）、下载 `board_pin_init.c`。
  **片段只做引脚与时钟配置，未经编译验证**，UART/I2C/SPI/定时器的参数需另行初始化。
- 分配结果存 `localStorage`（键 `stm32wb.assignments.v1`），刷新后自动恢复；换数据源时不再成立的分配会被丢弃。
- 48 脚明细表放在折叠区 `<details>`，供无图形环境或逐条核对使用。

## 2. 构建台

`POST /api/build {project}` → NDJSON 流（`start` / `line` / `end`）逐行刷进日志面板；
`end.ok` 决定状态灯；`end.artifact`（axf/hex/bin）列在「产物」；`end.size{text,data,bss}`
换算成 Flash(64 KB) 与 RAM(20 KB) 占用条（ROM=text+data，RAM=data+bss，>70% 转黄、>90% 转红）。
「中止」用 `AbortController` 中断流。项目未选或后端不在时会明确提示，不会空转。

## 3. 烧录

- `POST /api/flash {project, flasher?, verify?}`：`verify` 由「烧录后校验」勾选决定。
- `POST /api/reset {flasher?}`：复位运行。
- `POST /api/chip-info {flasher?}`：`end` 事件带 `{ok,connected,reason,chip:{...}}`，`chip` 逐字段显示。
- **无硬件时如实显示**：`/api/env` 里没有可用烧录器时，顶部横幅写「未检测到 ST-Link」，三个按钮禁用并给出 tooltip；
  后端不在时同样禁用。绝不假装成功——只显示流里真实返回的内容。

## 4. 串口台

`POST /api/serial/open {port,baud}` → `{sessionId}`；`GET /api/serial/stream?sessionId=` 读 NDJSON：
`{type:"data",text,hex,ts}` / `{type:"error"}` / `{type:"closed"}`。**文本与 hex 都直接用后端给的字段**，本地不再转换。
控件：端口（来自 `/api/env` 的 `serialPorts`，`role=stlink-vcp` 会标注）、波特率（9600–921600）、打开/关闭、
16 进制显示、时间戳、自动滚动、清空、收发字节计数。发送框支持 Ctrl/Cmd+Enter 发送、可选追加 CRLF；
勾选「按 HEX 发送」时把 `AA 55 01` 解析成字节，以二进制字符串放进 `data`，并附 `hex` 字段（后端按 latin1/二进制写入才正确，
见 §8 存疑项），TX 会在接收区回显实际发送内容。关闭页面时用 `sendBeacon` 通知后端关会话。

## 5. 计算器

两个都做了数值自验（见 §7）：

- **定时器周期**：`T = (PSC+1)(ARR+1)/TIMxCLK`，输出周期（自动 µs/ms/s）、频率、计数时钟、单拍时间、该 PSC 下最长定时；
  越界（PSC/ARR 超出 0–65535、时钟 ≤0）给出可执行的错误提示而不是旧结果。
  「求解并回填」由目标周期反解：从能装下 ARR 的最小预分频起向后扫描，取实际周期最接近目标的一组（同样接近时取 ARR 更大者），
  例如 72 MHz 求 1 s 会得到 PSC=1199 / ARR=59999 的精确解，而不是误差更大的近似解。
- **USART BRR**：F1 只有 16 倍过采样，`USARTDIV = PCLK/(16×baud)`，`BRR = DIV_Mantissa<<4 | DIV_Fraction`，
  小数按 1/16 就近取整并处理进位（`25.99 → mantissa 26, fraction 0`）；输出 BRR 十六进制/十进制、
  Mantissa/Fraction、实际波特率、误差百分比与容差判定，并给出常用波特率误差对照表（用当前 PCLK）。
  `PCLK/16` 上限、BRR 12 位整数上限都会拦截并说明原因。

## 6. 键盘可达性与响应式

- 页签是标准 `role="tablist"`：`←` `→` `Home` `End` 切换，`aria-selected` / `tabindex` 同步。
- 引脚图里每个引脚是 `role="button"` + `tabindex="0"`，有 `aria-label`（脚号、名称、可用功能、已分配）；
  `Enter`/`Space` 选中，`↑↓←→` 前后切换引脚，`Home/End` 到首/末脚，`Esc` 取消选中。
- 分配表、引脚表、会话/状态用真实 `<button>` 与 `role="status"`；日志是 `role="log" aria-live="off"`（流式日志不做逐行播报）。
- 有「跳到主内容」链接；对话框用原生 `<dialog>`（不支持时降级到 `open` 属性）。
- 布局：1365/1920 双栏（左侧引脚图 + 右侧详情/分配/冲突），≤1180 折叠成单列，≤1080 侧栏变抽屉（`项目与环境` 按钮，
  `Esc` 关闭），≤768 收窄间距、串口发送区改单列，≤420 表单单列。窄屏下引脚图容器横向滚动（`min-width` 保证字号可读），
  不把整张图缩到看不清。
- 主题：默认跟随 `prefers-color-scheme`，顶栏「主题」可强制浅色/深色并记入 `localStorage`。文字最小 12px。

---

## 7. 交付前自验（全部真实执行，命令与结果照抄）

在开发机的一个独立工作台目录下执行（Node v24.19.0、Edge headless 可用）
—— 这是**当时的独立工作台目录**，现在那份已并入插件的 `backend/`，此处保留原始记录不作改写：

**① 语法**：`node --check` 每个 js 文件 → `app.js` / `calc.js` / `pinout.js` 均 OK。

**② 几何与标签（纯函数，48 脚）**：从 `pinout.js` 取 `layout()` / `pinDrawing()` 断言：
- 四段方向正确（左侧 y 递增、底边 x 递增、右侧 y 递减、顶边 x 递减）；
- 48 个坐标唯一；角邻关系成立：**36 的最近邻是 37、48 的最近邻是 1**（顶边自右向左的直接证据）；
- 48 个引脚名 + 48 个脚号的文字包围盒**互不相交**、全部落在 viewBox 内；48 个点击热区互不重叠。

**③ 计算器数值**：
`T(72 MHz, PSC=7199, ARR=9999) = 1 s`、`f = 1 Hz`；反解 1 s → PSC=1199/ARR=59999（误差 0）；
`BRR(72 MHz, 115200) = 0x271（39/1，误差 0%）`、`BRR(36 MHz, 115200) = 0x139（误差 −0.16%）`、
`BRR(8 MHz, 115200) = 0x45（误差 +0.64%）`；进位分支 `USARTDIV 25.99 → mantissa 26 / fraction 0`；
`clk=0`、`PSC>65535`、超短/超长周期、超过 `PCLK/16` 的波特率全部按预期报错。

**④ 分配 / 冲突 / 代码生成（42 项断言，对真实 `/api/pins` 数据）**：
`port:"PA9"→"A"`、`signal:"USART1_TX"→core "TX"`、PB5 的 `verified:false` 保留、PD0（脚 5）不可分配、
PB6 可分配 I2C1_SCL 与 USART1_TX（重映射）、PA9 抢 PB6 的 `USART1:TX` 报通道冲突、
PA10 与 PB10 同用 EXTI10 报冲突；代码生成断言 `GPIOA->CRH` 移位 4/8、`0xB`/`0x4`、
PB6 I2C 的 `CRL` 移位 24 / `0xF`、PB8 才写 `AFIO_MAPR_I2C1_REMAP`（默认脚不误判）、
EXTI 的 `EXTICR` 分片与 `NVIC_EnableIRQ`、有冲突时输出 `⚠` 头。结果：**42/42 通过**。

**⑤ 真实 DOM 交互（Edge headless，23 项断言）**：渲染 48 个引脚组/热区/表格行 →
勾选分配模式 → 点脚 30 分配 USART TX、脚 31 分配 RX → 点脚 42 抢 `USART1:TX`：
冲突面板出现红色报错、脚 42 的 `data-state="conflict"`、冲突计数变 err 色调、代码出现 `⚠ 存在`；
换成 GPIO 输出后冲突消失并生成 `GPIOB->CRL … 0x3UL << 24`；键盘：Tab 聚焦、`Enter` 选中、
`↓` 移到下一脚、`Esc` 取消；PB5 详情出现「未核实」；清空分配后表格回到空状态。结果：**23/23 通过**。

**⑥ 无后端与有后端两种打开方式（Edge headless + 本地静态服务器）**：- 静态服务器（`/api/*` 一律 404）：`/`、`/index.html`、`/style.css`、`/app.js`、`/pinout.js`、`/calc.js` 全部 **200**；
  只请求这 5 个本地资源，`/api/env`、`/api/pins` 404 属预期。DOM 断言通过：48 脚渲染、状态条显示
  「后端未启动」+ `node server/server.js`、引脚数据来源标记为兜底表、ST-Link 按钮禁用并提示「未检测到 ST-Link」、
  计算器结果单元格照常渲染（`0x271`）。
- 真实后端 `http://127.0.0.1:8788/`：状态条「后端正常」、`data-state="online"`、
  引脚数据来源 `GET /api/pins`、48 脚渲染、环境详情含 Keil 与 openocd、项目列表读到 `blink-uart`。

**⑦ 构建台流式渲染（真实 app.js + 打桩 NDJSON，12 项断言）**：测试页加载的是未改动的 `app.js`，
只把 `fetch('/api/build')` 换成后端形状的 NDJSON 流（start / line / warning 行 / `Program Size` 行 /
`end{ok:true,artifact,size:{code,rodata,rwdata,zidata,flashBytes,ramBytes,flashKB,ramKB}}`），点击「开始构建」后断言：
日志出现编译行与 size 行、warning 行标黄、状态变「构建成功」、行数统计 6 行、按钮恢复可用；
**Flash 占用条 1.47 KB / 64 KB（2.3%）、RAM 3.12 KB / 20 KB（15.6%）**（与后端 1508 B / 3192 B 一致）、
`size` 明细按新字段渲染、产物列出 hex、并给出 `node scripts/verify-artifact.js <工程名>` 复核提示。结果：**12/12 通过**。

**⑧ 深浅主题**：截图取像素值验证 —— 浅色页面背景 `#f2f4f5 (242,244,245)`、深色 `#131518 (19,21,24)`，
两套主题下引脚图、表头、日志、错误/警告色均可读；字号无 <12px（含 SVG 内文字按最窄实际渲染宽度反推 ≥12px）。

**⑨ 静态资源与依赖检查**：`index.html` 只引用本地 `style.css`/`pinout.js`/`calc.js`；JS 里除 SVG 命名空间常量和
`127.0.0.1` 自验地址外无任何外部 URL；JS 里引用的每个 DOM id 都在 `index.html` 中存在且无重复 id。
同源托管下逐个取资源（真实后端 8788）：`/`、`/index.html`、`/style.css`、`/app.js`、`/pinout.js`、`/calc.js`、
`/README.md`、`/selftest.js` 全部 **200**；页面引用的本地资源集合 `style.css, pinout.js, calc.js, app.js` 全部 200，**无 404**。

**⑩ 后端侧的产物级验证（由后端负责人完成，此处照录以便追溯）**：`node scripts/verify-artifact.js` 8/8 通过——
HEX 98 行格式与校验和合法且含 EOF 记录、覆盖 `0x08000000..0x080005E3`；向量表[0] 初始 SP = `0x20000C78`（落在 SRAM 内）；
向量表[1] Reset_Handler = `0x080004F5`（Flash 内且为奇数 = Thumb）；`.bin` 1508 B / 64 KB = 2.30%；
构建尺寸 Code=1220 / RO-data=268 / RW-data=20 / ZI-data=3172（Flash 1508 B、SRAM 3192 B）。
构建成功后界面会在「产物」栏提示这条复核命令（`node scripts/verify-artifact.js <工程名>`）。

### 复现命令（PowerShell，工作根目录）

```powershell
# ① 语法
Get-ChildItem web\*.js | ForEach-Object { node --check $_.FullName }

# ② 几何 / 标签 / 计算器 / 分配冲突 / 代码生成 / 兜底表一致性（91 项）
node web\selftest.js

# ③ 追加在线数据一致性检查（需后端在 8788 或 8789），共 96 项
node web\selftest.js --api

# ④ 无 404：后端同源托管后逐个取资源
foreach ($u in '/','/index.html','/style.css','/app.js','/pinout.js','/calc.js','/README.md','/selftest.js') {
  $r = Invoke-WebRequest -Uri ("http://127.0.0.1:8788" + $u) -UseBasicParsing
  "{0} {1} {2}" -f $r.StatusCode, $r.Headers['Content-Type'], $u
}
```

> ⑤（真实 DOM 交互 23 项）与 ⑥⑦（无头渲染 + 截图像素）用 Edge headless 驱动，脚本是本轮写在 `%TEMP%` 下的一次性脚本，
> 未随 `web/` 交付；它们验证的是浏览器侧行为，结论见上文。②③ 已随包，可随时复跑。

---

## 8. 已知限制与存疑项（不美化）

1. **生成的 C 片段未经编译验证**：只写引脚/时钟/重映射/EXTI 配置，不含外设（USART/I2C/SPI/TIM）参数与中断服务函数；
   `EXTI` 默认写上升沿（`RTSR`），需要下降沿/双边沿要自己改 `FTSR`。片段有冲突时会带 `⚠` 注释但仍然输出，便于人工修改。
2. **PD0/PD1（5/6 脚）不参与分配**：LQFP48 上它们只作 OSC_IN/OSC_OUT，数据文件里虽有 `GPIO/PD0` 功能，但本工具按封装现实
   判定为不可分配，详情面板会说明。若后端要改这条判断，改 `pinout.js` 的 `assignable()`。
3. **HEX 发送的编码**：`POST /api/serial/write {sessionId,data}` 里 `data` 是二进制字符串（latin1），并额外带 `hex` 字段。
   后端若按 UTF-8 写 >0x7F 的字节会多出一个字节；建议后端在 `hex` 字段存在时按 hex 写。
4. **复位按钮**用 `POST /api/reset`（后端已实现）；契约里 `POST /api/detect` 与 `GET /api/env` 都试过，取先成功者。
5. **兜底表是快照**：由 `GET /api/pins` 在 2026-10-12 生成（含 `verified`/`fiveVTolerant`），与数据文件逐脚一致；
   权威数据仍在 `data/pins.json`，后端更新后应重新生成兜底表（生成脚本未随包）。
6. **5V 容忍**直接读数据的 `fiveVTolerant`，不做任何端口硬编码；PB5（脚 41）数据标 `verified:false`，界面按「未核实」显示。
7. **数据侧观察（不影响前端）**：`/api/pins` 里 PB2（脚 20）列的 EXTI 线是 `EXTI10`，按同端口位号应为 `EXTI2`；
   已同步给后端负责人。前端只按数据展示，未做改写。
8. **未做**：`/api/peripherals` 未接入（当前分配功能表已由 `/api/pins` 的 `functions[]` 覆盖）；
   串口流没有做断线重连；构建/烧录日志没有做虚拟滚动（超过 2000 行时截断头部）。
9. **验证覆盖面的边界（如实说明）**：
   - **烧录 / 复位 / 读芯片信息**：本机没有接 ST-Link，只验证了「无硬件时的行为」——横幅显示「未检测到 ST-Link」、
     三个按钮禁用并给出 tooltip、请求不会发出。**按钮在有硬件条件下的真实流程未验证**（代码路径与构建台共用同一 NDJSON 读取器）。
   - **串口台**：同样没有真实串口设备，验证的是控件状态机（打开前发送禁用、关闭后复位、HEX 解析与报错分支），
     未验证真实收发。
   - **构建台的流式渲染**：已用真实 `app.js` + 后端形状的打桩 NDJSON 验证（见 §7 ⑦，12/12，含 `size` 新契约→占用条换算）；
     真实编译本身由后端侧跑通并做了产物级校验（§7 ⑩）。「构建中」这段在真实网络抖动下的表现（中途断流）没有实测，
     只覆盖了 `AbortError`（用户点「中止」）与 HTTP 非 200 两个分支。
   - **视口**：DOM 交互断言跑在 1365×940；截图覆盖 1920×1080、1365×940、768×1000、390×844；
     768 与 390 只做了截图检查（侧栏抽屉、单列化、表格横向滚动、引脚图横向滚动），**没有做这些视口下的点击级验证**。
   - 浏览器只测了 Edge（Chromium 内核）；Firefox/Safari 未实测，只用到了标准 API（`<dialog>`、`fetch` 流、
     `AbortController`、`clipboard`，未用 `structuredClone` 等新接口）。
10. **兜底表再生成**：若 `data/pins.json` 更新，用同样的方式重新快照（把 `/api/pins` 的 48 条转成 `pinout.js` 里的
    `FALLBACK` 常量），或者在离线场景接受旧快照。`node web/selftest.js --api` 的「逐脚一致」检查会在两者不一致时报警。
