# Third-party notices / 第三方组件声明

本仓库（MIT，见 [LICENSE](LICENSE)）自带的第三方代码仅限于 `backend/firmware/bsp/` 下的
芯片支持文件。其余依赖（Keil AC5、OpenOCD、Node.js、DSH）由运行环境提供，不随仓库分发。

## 1. ARM CMSIS（Cortex-M3 Core Peripheral Access Layer）

- 文件：`backend/firmware/bsp/cmsis/CoreSupport/cmsis_*.h`、`core_cm3.h`、`mpu_armv7.h`、`cmsis_version.h`
- 版权：Copyright (c) 2009-2023 Arm Limited
- 许可证：**Apache License 2.0**（各文件头有 `SPDX-License-Identifier: Apache-2.0`）
- 来源：<https://github.com/ARM-software/CMSIS_5>

## 2. STMicroelectronics STM32F10x 标准外设库（Cortex-M3 设备支持）

- 文件：`backend/firmware/bsp/cmsis/DeviceSupport/stm32f10x.h`、`system_stm32f10x.c`、`system_stm32f10x.h`；
  `backend/firmware/bsp/startup/startup_stm32f10x_md.s`、`stm32f103c8.ld`
- 版权：Copyright (c) 2011 STMicroelectronics（MCD Application Team），V3.5.0
- 许可证：STMicroelectronics 的软件许可（各文件头保留原版权声明；允许在 STM32 设备上使用与再分发，
  详见文件头与 <https://www.st.com/> 的许可条款）
- 来源：STM32F10x Standard Peripheral Library V3.5.0

## 3. xPack OpenOCD（不随仓库分发）

- `backend/tools/openocd/` 故意不提交（见 `.gitignore`）。需要时运行
  `backend/scripts/fetch-openocd.ps1`，从官方 release 下载并校验 sha256：
  <https://github.com/xpack-dev-tools/openocd-xpack/releases/tag/v0.12.0-7>
- OpenOCD 本身：**GNU GPL v2**（或更新版本）<https://openocd.org/>，源码见官方仓库
  <https://sourceforge.net/projects/openocd/> / <https://github.com/openocd-org/openocd>
- xPack 是 OpenOCD 的再打包发行版，版权归其上游与 xPack 项目所有；本仓库只是下载它，不再分发。

## 4. 其它

- `icon.svg`、`client.js` / `index.js` / `backend/` 下的自有代码：MIT（见 LICENSE）。
- 插件 UI 模仿了 DSH 宿主组件的标记与主题令牌（`--dsw-alias-*`），但**没有**拷贝或依赖
  `@deepseek-ai/dsh-client-ui-primitives` 等 Harness 客户端包（遵循 DSH 插件规范）。
- 设计参考：[dsh-openwrite](https://github.com/LiPu-jpg/Openwrite)（仅参考其插件结构，未复制代码）。
