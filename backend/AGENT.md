# AGENT.md — 给 AI agent 的 STM32F103C8T6 操作手册

> 这份文件写给「要在本目录里帮人做 STM32F103C8T6 开发」的 agent。
> 读它就够开工：工具链在哪、命令怎么发、坑在哪、什么时候必须停下来问人。
> 项目背景与目录结构见 `README.md`。

---

## 0. 一句话认知

这是一台 **Windows + Keil MDK(AC5) + OpenOCD/ST-Link** 的裸机开发环境。
所有工具都用**相对路径 + 先 cd 进工程目录**的方式调用——因为中文目录会打碎 armcc 的命令行（见 §5）。

---

## 1. 先探测，别猜

```powershell
# 拿到编译器/烧录器/串口/板子线索的权威结论
Invoke-RestMethod http://127.0.0.1:8788/api/env       # 需要后端在跑
```

后端没跑时用脚本直接读：

```powershell
node -e "console.log(JSON.stringify(require('./server/toolchain').detectEnv(),null,1))"
```

返回里关键字段：

- `compilers[]`：`keil-ac5`（可用，真正的编译器）、`keil-ac6`（存在但当前构建流程不用）
- `flashers[]`：`openocd`（xPack 便携版，含 scripts 路径）、`cubeprog`（若装了 CubeProgrammer）
- `serialPorts[]`：`role` 为 `stlink-vcp` 或 `usb-serial`
- `board.evidence[]`：**只有它说的话能当成「板子在不在」的依据**；串口存在 ≠ SWD 可用

**禁止**：编造工具链路径、编造芯片 ID、把「没检测到」说成「已连接」。

---

## 2. 构建

```powershell
# 方式一：命令行（推荐给 agent）
powershell -ExecutionPolicy Bypass -File scripts\build.ps1 -Project blink-uart

# 方式二：HTTP（流式日志，适合长任务）
#   POST http://127.0.0.1:8788/api/build  {"project":"blink-uart"}
#   返回 NDJSON 行：{"type":"line","text":...,"tag":"cmd|build|error"}
#                   {"type":"end","ok":true,"size":{...},"artifact":{...}}
```

流程固定为：`armcc(每个 .c) → armcc(system_stm32f10x.c) → armasm(startup) → armlink(--scatter) → fromelf(hex/bin)`。

产物：`firmware\build\<工程>\<工程>.axf|.hex|.bin`。

**判断构建是否成功，只认 `ok:true` 与 `.hex` 文件真实存在**，不要凭日志末尾猜。

关键编译参数（照抄，别自创）：

```
--c99 --cpu Cortex-M3 -g -O1 --apcs=interwork -DSTM32F10X_MD
-I<bsp>\cmsis\CoreSupport -I<bsp>\cmsis\DeviceSupport
```

---

## 3. 烧录与调试

```powershell
powershell -ExecutionPolicy Bypass -File scripts\flash.ps1 -Probe                       # 探测
powershell -ExecutionPolicy Bypass -File scripts\flash.ps1 -Project blink-uart          # 烧录+校验+复位
powershell -ExecutionPolicy Bypass -File scripts\flash.ps1 -Reset                       # 复位
```

等价 HTTP：`POST /api/chip-info`、`POST /api/flash`、`POST /api/reset`（都是 NDJSON 流）。

OpenOCD 调用式（需要自己拼时）：

```
openocd.exe -s <openocd>\openocd\scripts -f interface/stlink.cfg -f target/stm32f1x.cfg \
  -c "adapter speed 1000" -c "transport select swd" \
  -c "init" -c "program <hex 用正斜杠> verify reset exit"
```

**没有插 ST-Link 时会报 `Error: open failed`——这是正确行为。**
报告给用户时要写清是「未连接/接线问题」，不要写「烧录成功」。

---

## 4. 串口

后端：`POST /api/serial/open {port,baud}` → `{sessionId}`，然后 `GET /api/serial/stream?sessionId=`（NDJSON）。
底层是 `scripts\serial-bridge.ps1`（.NET SerialPort，行协议 READY/DATA/ERROR/CLOSED，数据用 base64 传）。

接线铁律：**板子 PA9(TX) → USB 转串口 RXD，PA10(RX) → TXD，GND 共地**；波特率默认 115200 8N1。

agent 自己起一次抓几秒输出的写法：

```powershell
$p = Start-Process powershell -ArgumentList '-NoProfile','-File','scripts\serial-bridge.ps1','-Port','COM5','-Baud','115200' -RedirectStandardOutput out.txt -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 3; Stop-Process -Id $p.Id -Force; Get-Content out.txt
```

---

## 5. 必须知道的坑（违反就会浪费半小时）

1. **中文路径**：工程目录含中文时，`armcc` 的 ANSI 命令行会把绝对路径拆坏。
   → 一律 `Set-Location` 到工程目录，用相对路径调用工具链。所有现成脚本已这么做。
2. **`-DUSE_STDPERIPH_DRIVER=0` 不等于不用标准库**：头文件用 `#if !defined` 判断，定义过就会去找 `stm32f10x_conf.h`。不用 SPL 就**别定义这个宏**。
3. **`-DSTM32F10X_MD` 必须给**（中等容量），否则 `stm32f10x.h` 直接 `#error`。
4. **`--microlib` 属于 armcc**，armlink 不认识，别传。
5. **Flash 上限 64 KB / SRAM 20 KB**（按标称布局）：链接失败先看是不是超了。
6. **ST 官网下载会被掐断**：需要器件库时优先 GitHub raw 或 Keil 自带模板目录，别硬怼 st.com。

---

## 6. 新建工程

```powershell
# 复制模板（脚本或 HTTP 都行）
# POST /api/projects {"id":"myapp","name":"我的板子实验","template":"blink-uart"}
```

生成后 `firmware\projects\myapp\` 里会有 `main.c` / `board.h` / `project.json`；
构建脚本自动收集该目录下**所有 `.c`**，所以加文件不用改任何配置。

模板 `blink-uart` 的事实（不要写成别的）：

- LED：**PC13，低电平点亮**；改 `board.h` 的 `BOARD_LED_PORT/PIN/CLK/SHIFT`
- 时钟：**HSI 8 MHz，不做 PLL**（刻意为之：不依赖外部晶振）
- USART1：PA9/PA10，115200 8N1，能打印启动信息并回显

---

## 7. 引脚与外设数据

- `data/pins.json`：LQFP48 全 48 脚，每条含 `functions[]`（`kind` 枚举：gpio|uart|i2c|spi|adc|tim|exti|usb|can|debug|pwr|boot）、`fiveVTolerant`、`verified`、`source`
- `data/peripherals.json`：外设 → 可用引脚映射（20 个外设、100 条 signal→pins）

**5V 容忍的正确口径（别用流传的说法）**：F103 上 **PA13/PA14/PA15/PB3/PB4 是 5V 容忍（FT）**，它们的特殊之处是被 SWJ/JTAG 默认占用，不是电平例外。按 DS5319 Rev19 Table 5，**不**标 FT 的是 16 个 IO：PA0–PA7、PB0、PB1（ADC 脚）、PB5、PC13/PC14/PC15、PD0/PD1。当前数据：FT 21 个、非 FT 的 IO 16 个。**一律读 `fiveVTolerant` 字段，不要按端口名硬编码。**

**使用纪律**：`verified:false` 的条目在给用户接线建议前必须复核数据手册（DS5319 / RM0008），并如实说明「此条未核实」。目前唯一未核实项是 **PB5（pin 41）**：手册该行 I/O 结构列空缺，社区讨论帖正文抓不到，按保守值 false 处理。
引脚方向（LQFP48 逆时针）：1-12 左侧自上而下、13-24 底边自左向右、25-36 右侧自下而上、**37-48 顶边自右向左**。

---

## 8. 报告纪律

- 只说工具真实输出过的内容。构建成功要有 `ok:true` 和产物文件；烧录成功要有 OpenOCD 的 `wrote N bytes` / `verified`。
- 没硬件、没串口 → 明说「未检测到，需要你插上才能验证」，不要用演示数据糊过去。
- 不确定的引脚/寄存器 → 说「不确定」，并给出核查途径（数据手册章节、参考手册）。
- 改动用户代码前先读原文件；破坏性操作（删工程、覆盖 main.c）先问。
