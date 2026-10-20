# 问题台账

来源：用户 2026-10-15 提交的《工具问题记录.md》（14 条，来自一次真实的固件开发会话：
多级菜单 + 精简内核 + 中文显示）。这份文件记录**每条的处理状态**，避免下次重复排查。

状态：`已修` / `已查清（不是缺陷）` / `待做` / `非插件（宿主或第三方）`

> **2026-10-18 复核**：DSH 已升级到 0.2.1-rc.2（Electron 44.7.0）。本轮把插件适配到新版，
> 同时把 14 条里所有「插件自己能修」的项补上了（第 1/3/4/6 条实修，第 2/5/7 条写进工具文档），
> 逐条结论见下表。**第 9 条的宿主半边仍未闭环**：新 DSH 的 `edit`/`write` 仍然会丢掉 UTF-8 BOM，
> 含中文的 `.c/.h` 必须用 `mcu write` 写（插件侧保证保留 BOM）。

---

## 一、mcu 工具与 OpenOCD

| # | 问题 | 状态 | 说明 |
| --- | --- | --- | --- |
| 1 | 读 RAM/寄存器会把目标停住且不保证恢复 | **已修（2026-10-18）** | 新增 `mcu action=readmem`（`addr` + `length`，addr 也可写符号名）。后端用 `init → mdw → exit`，**不 halt**，读完即退出，目标保持原运行状态。实测读 `0x40021000` 与 `regs` 的 RCC_CR 逐字一致（`0x03035b83`）。一次最多读 4 KB，地址要求 4 字节对齐（mdw 限制）。 |
| 2 | `mdd`（64 位读）报 `Size 8 not supported` | **已写进文档** | OpenOCD 侧限制，不是插件能改的。`mcu` 工具说明里写明「mdd 不支持，64 位读请用两次 mdw」。`mdw`/`mdh` 正常。 |
| 3 | 没有符号地址查询，变量地址只能靠推 | **已修（2026-10-18）** | 新增 `mcu action=symbols`（`filter` 子串过滤）：解析构建产物 `.axf` 的 `.symtab`（`fromelf --text -s`），返回 `名字 → 地址/大小/绑定/段/类型`。实测本工程 602 个符号，`shadow 0x20000068 (1024 B)`、`reqDirty 0x2000002e (1 B)`、`reqPage 0x20000029 (1 B)`。返回值有缓存（按 axf mtime 失效）。 |
| 4 | 构建目录里没有 map 文件 | **已修（2026-10-18）** | `keil-build.js` 把 armlink 的完整 `--map` 输出落成 `Project.map`（构建目录内，与 .axf/.hex/.bin 并列），并写进 `artifact.map`；`action=size` 现在也返回 `mapFile`。 |
| 5 | 链接器区域符号的含义没说清 | **已写进文档** | `mcu` 工具说明新增一段：`Image$$ER_IROM1$$Length` = Code+RO；`Image$$RW_IRAM1$$Length` 只含 `.data`；`.bss` 用 `Image$$RW_IRAM1$$ZI$$Length`；没有 `ER_IROM1$$ZI` 写法（试过 4 种均 L6218E）；`build.flashBytes` 含 RW 初值副本，所以比 `ER_IROM1$$Length` 大。 |
| 6 | 单次 OpenOCD 调用可能长时间不返回 | **已修（2026-10-18）** | `runOCD` 现在有**硬超时**（默认 90 s，到点先 SIGTERM、1.5 s 后再 SIGKILL），并且对**瞬时故障**自动重试一次：`Polling failed`、`trying to reexamine`、`Force reconnect`、`Fail reading CTRL/STAT`、`unexpected STLINK status`、以及超时本身。**flash 类会改芯片的操作不重试**（`retryOnTimeout:false`），避免重复编程。 |
| 7 | `flash` 之后的运行状态没写清楚 | **已写进文档** | `flash` 说明写明：末尾 OpenOCD 执行 `reset exit`，**烧完芯片自动开始运行**，不是停在复位状态。`reset` 的说明同样写明是 `reset run`。 |
| 8 | `pins` 把 PA1/PA2 报成「代码里有、芯片里没有」 | **已查清：不是噪音** | 复核结论：`Hardware\LED.c` 里确实配了 PA1/PA2，但 `main.c` **从未调用 `LED_Init()`** —— 芯片里就是没配。工具是对的，代码里有死模块。已在功能描述里标成 `partial`。这条不是 bug，是**工具报对了而人以为是噪音**。 |

## 二、构建与文件编码

| # | 问题 | 状态 | 说明 |
| --- | --- | --- | --- |
| 9 | 写文件丢 UTF-8 BOM → armcc 报 `#870-D` 或**静默编出乱码** | **插件侧已修；宿主侧仍未闭环** | `srcfile.writeText()` 保证「磁盘上原本有 BOM，写回就一定有 BOM」，不管调用方传什么 encoding；反过来（无 BOM + 写非 ASCII）会返回 `warning` 提示 `#870-D` / 乱码风险，但不擅自替用户改编码。2026-10-18 用 44 项 e2e + 20 项单测复核仍通过。<br>⚠️ 原始症状来自**宿主 `edit`/`write` 工具**丢 BOM —— 那是 DSH 宿主工具，插件改不了；**新 DSH 0.2.1 实测仍然丢**（UTF-8+BOM 文件经宿主 edit 后变 `69 6E 74`）。**含中文的 `.c/.h` 请继续用 `mcu write`**（保留原编码与 BOM）。 |
| 10 | 没有「这个文件什么编码」的快速回显 | 已满足 | `mcu files` 每个文件带 `encoding`；`mcu read` 返回 `encoding`/`hadBom`；`mcu write` 也回 `hadBom`/`bomBefore`/`bomKept`。 |
| 11 | `grep` 工具在中文路径下搜不到 | 非插件 | 宿主工具。2026-10-18 复核：宿主 grep 在中文路径下的行为仍不稳定；`Select-String` 可用作绕行。插件内的搜索/读文件不经过宿主 grep。 |

## 三、其它

| # | 问题 | 状态 | 说明 |
| --- | --- | --- | --- |
| 12 | OpenOCD stderr 在 PS 5.1 里被当成异常 | 非插件 | 宿主/脚本行为。插件内部直接 `spawn` OpenOCD、不经过 PowerShell 管道。 |
| 13 | 屏幕内容读不回来，只能读显存反向识别 | **已修（2026-10-18）** | 新增 `mcu action=gfx`：用 `readmem` 读显存（默认 1024 B，自动找 `shadow`/`fb`/`buffer` 等符号），按 SSD1306 页格式解成 128×64 点阵，返回 ASCII 图并落一份标准 PBM（`<工程>/.dsh-mcu/tmp/gfx/screen-*.pbm`，可直接打开）。显存全 0 时如实标 `blank`（屏幕灭/固件没在跑），不假装是图。`readmem addr=shadow length=1024` 仍可直接读原始字节。**注意**：只输出点阵图，不做「字模反向识别成文字」。 |
| 14 | `Select-Object -First N` 让命令以退出码 1 结束 | 非插件 | 宿主行为。 |

---

## 本轮顺带发现（不在原记录里）

| 问题 | 状态 | 说明 |
| --- | --- | --- |
| 同一秒内对同一个文件写两次，备份会互相覆盖 | **已修** | 备份目录按秒命名、文件名按相对路径扁平化 → 同秒两次写入撞名。现在同名时自动加序号后缀；回归测试在 `test-src-api.js`（BOM 段连续写两次后仍能还原）。2026-10-18 复核仍通过。 |
| 功能描述历史存的是「归一化后的对象」而不是原文件 | **已修** | 归一化会丢掉不认识的字段、抹平「字符串 vs 数组」。现在直接 `copyFileSync` 原文件。 |
| `UI.c` 文件头注释与实际按键行为不符 | 待用户确认 | 注释写「长按 K1 进入 / 长按 K2 回主菜单」，但代码里没有长按逻辑，全是短按（K1 进入、K4 退出，K2/K3 翻页）。已写进功能描述的 `limits`。 |

---

## 2026-10-18：适配 DSH 0.2.1（新增）

### 事故：升级后 mcu 工具全挂（「后端启动超时」→ 全部 EADDRINUSE）

**现象**：DSH 升级到 0.2.1-rc.2 后，`/mcu/state` 报 `running:false`、`error:"后端启动超时"`；
一个后端进程明明在 8788 上活着，但 `mcu` 的 action 全部失败（`EADDRINUSE`）。

**根因（实测三层，缺一不可）**：
1. **健康检查选错端点**：`waitForHealth()` 拿 `/api/env` 做健康检查，每次请求只给 1.5 s；而
   `/api/env` 会枚举串口，在 Windows 上起一个 `powershell.exe`（实测 **~2 s**）——所以每一次
   探测都超时，20 s 后判「后端启动超时」。后端其实早就起来了。
2. **超时后不清理**：`start()` 在健康检查失败时不 kill 子进程、也不复位 `child/childPort`，
   后端变成孤儿；下一次 `start()` 又 spawn 一个 → `EADDRINUSE` 死循环。
3. **`port: 0` 是假的**：`index.js` 只在 `wantedPort > 0` 时才把 `MCU_AGENT_PORT` 传给后端，
   配置里的 `port: 0`（本意=系统分配）根本没生效，后端退回默认 **8788** 固定端口 —— 多实例/热重启必抢。

**修复**：
- 后端新增**廉价健康检查** `GET /api/ping`（不碰磁盘、不起子进程，毫秒级）；`waitForHealth` 改用它。
- `detectEnv()` 加 5 s 缓存（`?fresh=1` 强制刷新），界面反复拉 `/api/env` 不再每次都起 powershell。
- 后端启动横幅的 `LISTEN` 行改为**最先打印**（以前排在 detectEnv 之后，启动窗口被白吃 ~2 s）。
- `index.js` 总是传 `MCU_AGENT_PORT`（`0` 是有效值）；健康检查失败/端口占用时**清理子进程**；
  固定端口启动前先用 `/api/ping` **认领已在跑的自己人后端**（DSH 崩溃/热重启后的常见状态）。
- 后端 `EADDRINUSE` 改为**一句人话 + 处理办法**，不再甩 Node 堆栈。
- `/mcu/state` 增加 `adopted` / `backendPid` / 后端目录，排查时一眼看到后端是谁。

**验证**（不用重启 DSH，直接对着真后端/假 ctx 跑）：
- 假 Cordis ctx 加载 `index.js`：17 个 action 全通（status/files/size/pins/build/spec/symbols/readmem/gfx/reset…）；
  `port:0` 实际拿到系统分配端口；`/mcu/stop` 后后端真的退出；同端口第二次 `apply` 成功复用旧后端（`adopted:true`）。
- 后端直测：`/api/ping` 毫秒级；`/api/env` 首次 ~1.6 s、之后 1~13 ms；构建 6.3 s、无诊断；
  `symbols` 602 个；`readmem` 读 RCC_CR 与 `regs` 一致；`readmem addr=shadow` 解析符号成功。

### 新版 DSH 规范性
- 补 `locale/en.json`、`locale/zh.json`（`meta.title`/`meta.description`）与 `icon.svg`，
  `exports` 增加 `./locale/*.json`、`./icon`，`files` 白名单补上（DSH 0.2.1 的
  `host-plugin.md`「Display metadata and icon」要求，缺了会退回包名/默认图）。
- 版本 `0.2.0 → 0.3.0`（接口面新增 2 个 action + 显示元数据）。

### 已知未闭环
- 宿主 `edit`/`write` 仍丢 BOM（第 9 条宿主半边）。
- `action=gfx` 只输出点阵图，不做「字模反向识别成文字」（第 13 条的可选加强，未做）。
- 本机 ST-Link 克隆有瞬时链路故障（`Fail reading CTRL/STAT register`、`Polling failed`），
  已加自动重试；`reset` 的成功判据改为「读 DHCSR 确认内核未 halt」，不再只看 OpenOCD 退出码。
- 界面可见文案（339 处）仍是硬编码中文，未迁到 Client locale 服务（新版规范建议项，不影响功能）。

### 追加事件（2026-10-18）：`mcu write` 报 `value is not lossless JSON`

**现象**：`mcu write` 返回 `tool "mcu" returned invalid output: value is not lossless JSON`
（界面标「工具故障」），**真正的错误信息不见了**。

**根因**：DSH 会把工具返回值快照成「无损 JSON」，遇到 `undefined` 属性、`NaN`/`Infinity` 会把
**整条工具结果**判非法。`index.js` 的 write 失败分支把 `currentMtime: r.body.currentMtime` 直接塞进
`data`，而 `currentMtime` 只有 STALE（409）响应里才有；文件不存在（404）、越界（403）、转码失败（500）
时它是 `undefined` → 整条结果非法 → 报「不是无损 JSON」，把「文件不存在…」等真实原因盖掉。
（来源：`dsh-tools/lib/index.js` 的 `snapshotToolValue` → `value is not lossless JSON`。）

**修复**：
1. `done()` 统一把 `data` 清成无损 JSON（`toLosslessJson`：去掉 undefined 属性、非有限数变 null）——
   以后任何 action 都不会再因为后端少一个字段而整条报错；
2. write 失败分支 `currentMtime: r.body.currentMtime ?? null`；
3. 顺带把 `mcu write` 扩展成**可以新建文件**（以前只能改已有文件，这大概就是那次触发原因）：
   文件不存在时按 `encoding` 新建（默认含中文=UTF-8 BOM、纯 ASCII=UTF-8；可选
   `encoding=utf8|utf8-bom|gbk|ascii`），返回 `created:true`、`backup:null`，不产生备份；
4. 失败信息更明确：目录不存在、编码不支持、路径越界都会如实说；
5. 回归测试：`test-mcu-tool.js` 新增「write 新建 + 失败输出无损 JSON」断言，验证返回值的每一层都没有
   undefined；`test-src-api.js` 的 BOM/GBK/备份用例全部仍通过。

---

## 2026-10-20：0.4.0「为 AI 省 token / 更好上手」

目标：让模型少调用、少读废话，把每轮开销压到最低。

1. **`status` 变成一次拿全貌**：新增后端 `GET /api/keil/overview`（工程摘要 + 功能契约摘要 +
   上次构建 + 工具链/串口，全部读文件与缓存，毫秒级）。新会话不再需要 status→spec→size→chip 四次调用。
2. **工具输出按 action 紧凑渲染**：`size`/`symbols`/`pins`/`regs`/`readmem`/`build`/`files` 等
   默认只回摘要 + 精选表格；`full:true` 才回原始 JSON。带正文的 action（read/spec/gfx/watch）只回
   精选元数据，不再把 words/bytes/ascii 抄两遍。
3. **`gfx` 省 token 形态**：默认只回 `hash`/`litPixels`/`blank`/与基线差异；
   `mode=ascii` 才拉点阵图；`region="x0,y0,x1,y1"` 只看局部；新增 `baseline=save|compare|clear`
   （存 `/dsh-mcu/tmp/gfx/baseline.bin`，compare 回变化像素数 + 包围盒）。
   查「屏幕变没变」从约 2K token 降到几十 token。
4. **`spec` 增量更新**：`{"updates":[{id,…只写改动字段}]}`（upsert）与 `{"remove":[id]}`，
   不必每轮全量重述；`features.js` 的 `applyPatch()` 先合并再走原来的校验/落盘/历史。
   **策略也从「每次 write/build 后必须全量重写」改成「行为/模块变化时才更新」**（persona 与技能同步改）。
5. **`watch` 新 action**：单次 OpenOCD 会话里用 Tcl 循环采样一个 32 位字（`samples`/`intervalMs`），
   返回 first/last/min/max/changes + 样本；用于「1 ms 节拍在不在跑」「任务周期抖不抖」。
6. **读类接口懒加载最近工程**：pins/symbols/gfx/readmem/watch 不再要求先 `open`。
7. 回归：`test-mcu-tool.js` 与 `test-features.js` 增加对应断言（status 全貌、gfx 默认不吐 ASCII、
   baseline save/compare/clear、watch、spec 增量），全套通过。硬件相关 action 在未接 ST-Link 时
   仍按「如实失败」断言。


**注意**：修复需要**重启 DSH** 才会加载。
