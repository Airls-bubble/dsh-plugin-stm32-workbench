/* pinout.js — LQFP48 引脚图 + 复用功能分配 + 初始化代码生成
 *
 * 设计要点
 *  1. 48 个引脚坐标全部由脚号公式算出（layout 是纯函数），没有任何手写坐标表。
 *     逆时针编号（顶视图）：1-12 左侧自上而下、13-24 底边自左向右、
 *     25-36 右侧自下而上、37-48 顶边自右向左（37 在顶右紧邻 36，48 在顶左紧邻 1）。
 *  2. 引脚数据优先用 GET /api/pins（由 app.js 拉取后 setData 注入），失败时用内置兜底表。
 *  3. 分配 / 冲突 / 代码生成都在本地完成，不依赖后端。
 *
 * 对外：window.STM32Pinout
 */
window.STM32Pinout = (function () {
  'use strict';

  /* ═══════════════════ 1. 内置兜底 48 脚表 ═══════════════════
   * 精简表：只保证“离线可看 + 常用复用功能可用”。
   * 权威数据以 /api/pins（data/pins.json）为准；五伏容忍与驱动能力请以 ST 数据手册复核。
   */
  const FALLBACK = {
    mcu: 'STM32F103C8T6',
    package: 'LQFP48',
    flashKB: 64,
    ramKB: 20,
    coreClockMHz: 72,
    source: '内置兜底表（2026-10-12 由 /api/pins 快照精简，离线时使用）',
    pins: [
      { pin: 1, name: 'VBAT', port: null, type: 'power', io: false, fiveVTolerant: false, verified: true, note: '备份域供电（RTC / 备份寄存器 / PC13-PC15 功率开关）。不用备份域时通常接到 VDD。非 IO。',
        functions: [
          { peripheral: 'PWR', signal: 'VBAT', kind: 'pwr' }
        ] },
      { pin: 2, name: 'PC13-TAMPER-RTC', port: 'C', type: 'gpio', io: true, fiveVTolerant: false, verified: true, note: '经功率开关供电：输出限 2 MHz / 负载<=30 pF / 最大 3 mA，不得作电流源（不能直接驱动 LED）。Table 5 未标 FT → 非 5V 容忍。RTC_TAMPER / RTC_OUT 属备份域，状…',
        functions: [
          { peripheral: 'GPIO', signal: 'PC13', kind: 'gpio' },
          { peripheral: 'EXTI', signal: 'EXTI13', kind: 'exti' },
          { peripheral: 'RTC', signal: 'RTC_TAMPER', kind: 'pwr' },
          { peripheral: 'RTC', signal: 'RTC_OUT', kind: 'pwr' }
        ] },
      { pin: 3, name: 'PC14-OSC32_IN', port: 'C', type: 'clock', io: true, fiveVTolerant: false, verified: true, note: 'OSC32_IN = LSE 32.768 kHz 晶振输入，复位后默认功能。不用 LSE 时才可作 GPIO PC14，且同样受 3 mA / 2 MHz 限制。未标 FT → 非 5V 容忍。',
        functions: [
          { peripheral: 'RCC', signal: 'OSC32_IN', kind: 'pwr' },
          { peripheral: 'GPIO', signal: 'PC14', kind: 'gpio' },
          { peripheral: 'EXTI', signal: 'EXTI14', kind: 'exti' }
        ] },
      { pin: 4, name: 'PC15-OSC32_OUT', port: 'C', type: 'clock', io: true, fiveVTolerant: false, verified: true, note: 'OSC32_OUT = LSE 32.768 kHz 晶振输出，复位后默认功能。不用 LSE 时才可作 GPIO PC15，同样受 3 mA / 2 MHz 限制。未标 FT → 非 5V 容忍。',
        functions: [
          { peripheral: 'RCC', signal: 'OSC32_OUT', kind: 'pwr' },
          { peripheral: 'GPIO', signal: 'PC15', kind: 'gpio' },
          { peripheral: 'EXTI', signal: 'EXTI15', kind: 'exti' }
        ] },
      { pin: 5, name: 'PD0-OSC_IN', port: 'D', type: 'clock', io: true, fiveVTolerant: false, verified: true, note: 'LQFP48 第 5 脚复位后是 OSC_IN（HSE 外部晶振输入，Typ.4-16 MHz）；按 DS5319 note 7，可由软件重映射为 PD0 当普通 GPIO。也就是说 LQFP48 上"外部 HSE 晶振…',
        functions: [
          { peripheral: 'RCC', signal: 'OSC_IN', kind: 'pwr' },
          { peripheral: 'GPIO', signal: 'PD0', kind: 'gpio' },
          { peripheral: 'EXTI', signal: 'EXTI0', kind: 'exti' }
        ] },
      { pin: 6, name: 'PD1-OSC_OUT', port: 'D', type: 'clock', io: true, fiveVTolerant: false, verified: true, note: 'LQFP48 第 6 脚复位后是 OSC_OUT（HSE 晶振输出）；可由软件重映射为 PD1 作 GPIO，作输出时最高 50 MHz（DS5319 note 7）。晶振脚未标 FT → 非 5V 容忍。',
        functions: [
          { peripheral: 'RCC', signal: 'OSC_OUT', kind: 'pwr' },
          { peripheral: 'GPIO', signal: 'PD1', kind: 'gpio' },
          { peripheral: 'EXTI', signal: 'EXTI1', kind: 'exti' }
        ] },
      { pin: 7, name: 'NRST', port: null, type: 'reset', io: false, fiveVTolerant: false, verified: true, note: '系统复位，低有效，内部弱上拉（DS5319 Table 5 注释 1 中类型为 I/O，但功能是复位，不能当 GPIO）。未标 FT，属 3.3V 域信号，不要直接喂 5V。',
        functions: [
          { peripheral: 'SYS', signal: 'NRST', kind: 'pwr' }
        ] },
      { pin: 8, name: 'VSSA', port: null, type: 'power', io: false, fiveVTolerant: false, verified: true, note: '模拟地（ADC 参考地）。应就近与 VSS 单点/低阻连接。非 IO。',
        functions: [
          { peripheral: 'PWR', signal: 'VSSA', kind: 'pwr' }
        ] },
      { pin: 9, name: 'VDDA', port: null, type: 'power', io: false, fiveVTolerant: false, verified: true, note: '模拟电源（ADC 参考电压）。工作范围 2.0-3.6V，需加去耦/滤波；本封装无独立 VREF+/VREF- 引脚。非 IO。',
        functions: [
          { peripheral: 'PWR', signal: 'VDDA', kind: 'pwr' }
        ] },
      { pin: 10, name: 'PA0-WKUP', port: 'A', type: 'gpio', io: true, fiveVTolerant: false, verified: true, note: 'ADC 输入脚（DS5319 Table 5 未标 FT，属 3.3V/模拟类）→ 不要直接接 5V 数字信号。可作唤醒源 WKUP。TIM2_CH1 与 TIM2_ETR 共用同一脚，二选一。',
        functions: [
          { peripheral: 'GPIO', signal: 'PA0', kind: 'gpio' },
          { peripheral: 'ADC1', signal: 'ADC1_IN0', kind: 'adc' },
          { peripheral: 'ADC2', signal: 'ADC2_IN0', kind: 'adc' },
          { peripheral: 'TIM2', signal: 'TIM2_CH1', kind: 'tim' },
          { peripheral: 'TIM2', signal: 'TIM2_ETR', kind: 'tim' },
          { peripheral: 'USART2', signal: 'USART2_CTS', kind: 'uart' },
          { peripheral: 'SYS', signal: 'WKUP', kind: 'pwr' },
          { peripheral: 'EXTI', signal: 'EXTI0', kind: 'exti' }
        ] },
      { pin: 11, name: 'PA1', port: 'A', type: 'gpio', io: true, fiveVTolerant: false, verified: true, note: 'ADC 输入脚，未标 FT → 非 5V 容忍。USART2_RTS 与 TIM2_CH2 复用此脚。',
        functions: [
          { peripheral: 'GPIO', signal: 'PA1', kind: 'gpio' },
          { peripheral: 'ADC1', signal: 'ADC1_IN1', kind: 'adc' },
          { peripheral: 'ADC2', signal: 'ADC2_IN1', kind: 'adc' },
          { peripheral: 'TIM2', signal: 'TIM2_CH2', kind: 'tim' },
          { peripheral: 'USART2', signal: 'USART2_RTS', kind: 'uart' },
          { peripheral: 'EXTI', signal: 'EXTI1', kind: 'exti' }
        ] },
      { pin: 12, name: 'PA2', port: 'A', type: 'gpio', io: true, fiveVTolerant: false, verified: true, note: 'ADC 输入脚，未标 FT → 非 5V 容忍。USART2_TX 的默认引脚（也是常用调试串口）。',
        functions: [
          { peripheral: 'GPIO', signal: 'PA2', kind: 'gpio' },
          { peripheral: 'ADC1', signal: 'ADC1_IN2', kind: 'adc' },
          { peripheral: 'ADC2', signal: 'ADC2_IN2', kind: 'adc' },
          { peripheral: 'TIM2', signal: 'TIM2_CH3', kind: 'tim' },
          { peripheral: 'USART2', signal: 'USART2_TX', kind: 'uart' },
          { peripheral: 'EXTI', signal: 'EXTI2', kind: 'exti' }
        ] },
      { pin: 13, name: 'PA3', port: 'A', type: 'gpio', io: true, fiveVTolerant: false, verified: true, note: 'ADC 输入脚，未标 FT → 非 5V 容忍。USART2_RX 默认引脚。',
        functions: [
          { peripheral: 'GPIO', signal: 'PA3', kind: 'gpio' },
          { peripheral: 'ADC1', signal: 'ADC1_IN3', kind: 'adc' },
          { peripheral: 'ADC2', signal: 'ADC2_IN3', kind: 'adc' },
          { peripheral: 'TIM2', signal: 'TIM2_CH4', kind: 'tim' },
          { peripheral: 'USART2', signal: 'USART2_RX', kind: 'uart' },
          { peripheral: 'EXTI', signal: 'EXTI3', kind: 'exti' }
        ] },
      { pin: 14, name: 'PA4', port: 'A', type: 'gpio', io: true, fiveVTolerant: false, verified: true, note: 'ADC 输入脚，未标 FT → 非 5V 容忍。注意：中等容量 F103C8 无 DAC，PA4 不是 DAC_OUT1（ST 官方引脚库中本型号无 DAC 信号）。',
        functions: [
          { peripheral: 'GPIO', signal: 'PA4', kind: 'gpio' },
          { peripheral: 'ADC1', signal: 'ADC1_IN4', kind: 'adc' },
          { peripheral: 'ADC2', signal: 'ADC2_IN4', kind: 'adc' },
          { peripheral: 'SPI1', signal: 'SPI1_NSS', kind: 'spi' },
          { peripheral: 'USART2', signal: 'USART2_CK', kind: 'uart' },
          { peripheral: 'EXTI', signal: 'EXTI4', kind: 'exti' }
        ] },
      { pin: 15, name: 'PA5', port: 'A', type: 'gpio', io: true, fiveVTolerant: false, verified: true, note: 'ADC 输入脚，未标 FT → 非 5V 容忍。SPI1_SCK 默认引脚。',
        functions: [
          { peripheral: 'GPIO', signal: 'PA5', kind: 'gpio' },
          { peripheral: 'ADC1', signal: 'ADC1_IN5', kind: 'adc' },
          { peripheral: 'ADC2', signal: 'ADC2_IN5', kind: 'adc' },
          { peripheral: 'SPI1', signal: 'SPI1_SCK', kind: 'spi' },
          { peripheral: 'EXTI', signal: 'EXTI5', kind: 'exti' }
        ] },
      { pin: 16, name: 'PA6', port: 'A', type: 'gpio', io: true, fiveVTolerant: false, verified: true, note: 'ADC 输入脚，未标 FT → 非 5V 容忍。SPI1_MISO / TIM3_CH1 / TIM1_BKIN 复用。',
        functions: [
          { peripheral: 'GPIO', signal: 'PA6', kind: 'gpio' },
          { peripheral: 'ADC1', signal: 'ADC1_IN6', kind: 'adc' },
          { peripheral: 'ADC2', signal: 'ADC2_IN6', kind: 'adc' },
          { peripheral: 'SPI1', signal: 'SPI1_MISO', kind: 'spi' },
          { peripheral: 'TIM3', signal: 'TIM3_CH1', kind: 'tim' },
          { peripheral: 'TIM1', signal: 'TIM1_BKIN', kind: 'tim' },
          { peripheral: 'EXTI', signal: 'EXTI6', kind: 'exti' }
        ] },
      { pin: 17, name: 'PA7', port: 'A', type: 'gpio', io: true, fiveVTolerant: false, verified: true, note: 'ADC 输入脚，未标 FT → 非 5V 容忍。SPI1_MOSI / TIM3_CH2 / TIM1_CH1N 复用。',
        functions: [
          { peripheral: 'GPIO', signal: 'PA7', kind: 'gpio' },
          { peripheral: 'ADC1', signal: 'ADC1_IN7', kind: 'adc' },
          { peripheral: 'ADC2', signal: 'ADC2_IN7', kind: 'adc' },
          { peripheral: 'SPI1', signal: 'SPI1_MOSI', kind: 'spi' },
          { peripheral: 'TIM3', signal: 'TIM3_CH2', kind: 'tim' },
          { peripheral: 'TIM1', signal: 'TIM1_CH1N', kind: 'tim' },
          { peripheral: 'EXTI', signal: 'EXTI7', kind: 'exti' }
        ] },
      { pin: 18, name: 'PB0', port: 'B', type: 'gpio', io: true, fiveVTolerant: false, verified: true, note: 'ADC 输入脚，未标 FT → 非 5V 容忍。TIM3_CH3 / TIM1_CH2N 复用。',
        functions: [
          { peripheral: 'GPIO', signal: 'PB0', kind: 'gpio' },
          { peripheral: 'ADC1', signal: 'ADC1_IN8', kind: 'adc' },
          { peripheral: 'ADC2', signal: 'ADC2_IN8', kind: 'adc' },
          { peripheral: 'TIM3', signal: 'TIM3_CH3', kind: 'tim' },
          { peripheral: 'TIM1', signal: 'TIM1_CH2N', kind: 'tim' },
          { peripheral: 'EXTI', signal: 'EXTI8', kind: 'exti' }
        ] },
      { pin: 19, name: 'PB1', port: 'B', type: 'gpio', io: true, fiveVTolerant: false, verified: true, note: 'ADC 输入脚，未标 FT → 非 5V 容忍。TIM3_CH4 / TIM1_CH3N 复用。',
        functions: [
          { peripheral: 'GPIO', signal: 'PB1', kind: 'gpio' },
          { peripheral: 'ADC1', signal: 'ADC1_IN9', kind: 'adc' },
          { peripheral: 'ADC2', signal: 'ADC2_IN9', kind: 'adc' },
          { peripheral: 'TIM3', signal: 'TIM3_CH4', kind: 'tim' },
          { peripheral: 'TIM1', signal: 'TIM1_CH3N', kind: 'tim' },
          { peripheral: 'EXTI', signal: 'EXTI9', kind: 'exti' }
        ] },
      { pin: 20, name: 'PB2-BOOT1', port: 'B', type: 'gpio', io: true, fiveVTolerant: true, verified: true, note: 'PB2 = BOOT1：复位时与 BOOT0 一起被采样决定启动模式（BOOT0=0 时 BOOT1 决定主 Flash / SRAM 启动），之后可作普通 IO。数据手册标 FT → 5V 容忍。用作 IO 时外部电路…',
        functions: [
          { peripheral: 'GPIO', signal: 'PB2', kind: 'gpio' },
          { peripheral: 'BOOT', signal: 'BOOT1', kind: 'boot' },
          { peripheral: 'EXTI', signal: 'EXTI10', kind: 'exti' }
        ] },
      { pin: 21, name: 'PB10', port: 'B', type: 'gpio', io: true, fiveVTolerant: true, verified: true, note: '冲突点：I2C2_SCL 与 USART3_TX 共用此脚（DS5319 Table 5 注释 4：同一引脚上的多个外设同一时刻只能使能一个）。TIM2_CH3 为部分重映射功能。标 FT → 5V 容忍。',
        functions: [
          { peripheral: 'GPIO', signal: 'PB10', kind: 'gpio' },
          { peripheral: 'I2C2', signal: 'I2C2_SCL', kind: 'i2c' },
          { peripheral: 'USART3', signal: 'USART3_TX', kind: 'uart' },
          { peripheral: 'TIM2', signal: 'TIM2_CH3', kind: 'tim' },
          { peripheral: 'EXTI', signal: 'EXTI10', kind: 'exti' }
        ] },
      { pin: 22, name: 'PB11', port: 'B', type: 'gpio', io: true, fiveVTolerant: true, verified: true, note: '冲突点：I2C2_SDA 与 USART3_RX 共用此脚。TIM2_CH4 为部分重映射功能。标 FT → 5V 容忍。',
        functions: [
          { peripheral: 'GPIO', signal: 'PB11', kind: 'gpio' },
          { peripheral: 'I2C2', signal: 'I2C2_SDA', kind: 'i2c' },
          { peripheral: 'USART3', signal: 'USART3_RX', kind: 'uart' },
          { peripheral: 'TIM2', signal: 'TIM2_CH4', kind: 'tim' },
          { peripheral: 'EXTI', signal: 'EXTI11', kind: 'exti' }
        ] },
      { pin: 23, name: 'VSS', port: null, type: 'power', io: false, fiveVTolerant: false, verified: true, note: '数字地（VSS_1）。非 IO。',
        functions: [
          { peripheral: 'PWR', signal: 'VSS', kind: 'pwr' }
        ] },
      { pin: 24, name: 'VDD', port: null, type: 'power', io: false, fiveVTolerant: false, verified: true, note: '数字电源（VDD_1），2.0-3.6V。非 IO。',
        functions: [
          { peripheral: 'PWR', signal: 'VDD', kind: 'pwr' }
        ] },
      { pin: 25, name: 'PB12', port: 'B', type: 'gpio', io: true, fiveVTolerant: true, verified: true, note: 'SPI2_NSS / I2C2_SMBA / USART3_CK / TIM1_BKIN 多重复用，同一时刻只能使能一个。标 FT → 5V 容忍。',
        functions: [
          { peripheral: 'GPIO', signal: 'PB12', kind: 'gpio' },
          { peripheral: 'SPI2', signal: 'SPI2_NSS', kind: 'spi' },
          { peripheral: 'I2C2', signal: 'I2C2_SMBA', kind: 'i2c' },
          { peripheral: 'USART3', signal: 'USART3_CK', kind: 'uart' },
          { peripheral: 'TIM1', signal: 'TIM1_BKIN', kind: 'tim' },
          { peripheral: 'EXTI', signal: 'EXTI12', kind: 'exti' }
        ] },
      { pin: 26, name: 'PB13', port: 'B', type: 'gpio', io: true, fiveVTolerant: true, verified: true, note: 'SPI2_SCK / USART3_CTS / TIM1_CH1N 复用。标 FT → 5V 容忍。',
        functions: [
          { peripheral: 'GPIO', signal: 'PB13', kind: 'gpio' },
          { peripheral: 'SPI2', signal: 'SPI2_SCK', kind: 'spi' },
          { peripheral: 'USART3', signal: 'USART3_CTS', kind: 'uart' },
          { peripheral: 'TIM1', signal: 'TIM1_CH1N', kind: 'tim' },
          { peripheral: 'EXTI', signal: 'EXTI13', kind: 'exti' }
        ] },
      { pin: 27, name: 'PB14', port: 'B', type: 'gpio', io: true, fiveVTolerant: true, verified: true, note: 'SPI2_MISO / USART3_RTS / TIM1_CH2N 复用。标 FT → 5V 容忍。',
        functions: [
          { peripheral: 'GPIO', signal: 'PB14', kind: 'gpio' },
          { peripheral: 'SPI2', signal: 'SPI2_MISO', kind: 'spi' },
          { peripheral: 'USART3', signal: 'USART3_RTS', kind: 'uart' },
          { peripheral: 'TIM1', signal: 'TIM1_CH2N', kind: 'tim' },
          { peripheral: 'EXTI', signal: 'EXTI14', kind: 'exti' }
        ] },
      { pin: 28, name: 'PB15', port: 'B', type: 'gpio', io: true, fiveVTolerant: true, verified: true, note: 'SPI2_MOSI / TIM1_CH3N 复用。标 FT → 5V 容忍。',
        functions: [
          { peripheral: 'GPIO', signal: 'PB15', kind: 'gpio' },
          { peripheral: 'SPI2', signal: 'SPI2_MOSI', kind: 'spi' },
          { peripheral: 'TIM1', signal: 'TIM1_CH3N', kind: 'tim' },
          { peripheral: 'EXTI', signal: 'EXTI15', kind: 'exti' }
        ] },
      { pin: 29, name: 'PA8', port: 'A', type: 'gpio', io: true, fiveVTolerant: true, verified: true, note: 'TIM1_CH1 / USART1_CK / MCO（RCC 时钟输出）复用。标 FT → 5V 容忍。',
        functions: [
          { peripheral: 'GPIO', signal: 'PA8', kind: 'gpio' },
          { peripheral: 'TIM1', signal: 'TIM1_CH1', kind: 'tim' },
          { peripheral: 'USART1', signal: 'USART1_CK', kind: 'uart' },
          { peripheral: 'RCC', signal: 'MCO', kind: 'pwr' },
          { peripheral: 'EXTI', signal: 'EXTI8', kind: 'exti' }
        ] },
      { pin: 30, name: 'PA9', port: 'A', type: 'gpio', io: true, fiveVTolerant: true, verified: true, note: 'USART1_TX 默认引脚（最常用串口 TX 之一）。TIM1_CH2 复用。标 FT → 5V 容忍。',
        functions: [
          { peripheral: 'GPIO', signal: 'PA9', kind: 'gpio' },
          { peripheral: 'USART1', signal: 'USART1_TX', kind: 'uart' },
          { peripheral: 'TIM1', signal: 'TIM1_CH2', kind: 'tim' },
          { peripheral: 'EXTI', signal: 'EXTI9', kind: 'exti' }
        ] },
      { pin: 31, name: 'PA10', port: 'A', type: 'gpio', io: true, fiveVTolerant: true, verified: true, note: 'USART1_RX 默认引脚。TIM1_CH3 复用。标 FT → 5V 容忍。',
        functions: [
          { peripheral: 'GPIO', signal: 'PA10', kind: 'gpio' },
          { peripheral: 'USART1', signal: 'USART1_RX', kind: 'uart' },
          { peripheral: 'TIM1', signal: 'TIM1_CH3', kind: 'tim' },
          { peripheral: 'EXTI', signal: 'EXTI10', kind: 'exti' }
        ] },
      { pin: 32, name: 'PA11', port: 'A', type: 'gpio', io: true, fiveVTolerant: true, verified: true, note: 'USB_DM（USB D-）/ CAN_RX / TIM1_CH4 / USART1_CTS 复用：USB 与 CAN 不能同时使用这组脚。标 FT → 5V 容忍。',
        functions: [
          { peripheral: 'GPIO', signal: 'PA11', kind: 'gpio' },
          { peripheral: 'USB', signal: 'USB_DM', kind: 'usb' },
          { peripheral: 'CAN', signal: 'CAN_RX', kind: 'can' },
          { peripheral: 'TIM1', signal: 'TIM1_CH4', kind: 'tim' },
          { peripheral: 'USART1', signal: 'USART1_CTS', kind: 'uart' },
          { peripheral: 'EXTI', signal: 'EXTI11', kind: 'exti' }
        ] },
      { pin: 33, name: 'PA12', port: 'A', type: 'gpio', io: true, fiveVTolerant: true, verified: true, note: 'USB_DP（USB D+）/ CAN_TX / TIM1_ETR / USART1_RTS 复用。标 FT → 5V 容忍。',
        functions: [
          { peripheral: 'GPIO', signal: 'PA12', kind: 'gpio' },
          { peripheral: 'USB', signal: 'USB_DP', kind: 'usb' },
          { peripheral: 'CAN', signal: 'CAN_TX', kind: 'can' },
          { peripheral: 'TIM1', signal: 'TIM1_ETR', kind: 'tim' },
          { peripheral: 'USART1', signal: 'USART1_RTS', kind: 'uart' },
          { peripheral: 'EXTI', signal: 'EXTI12', kind: 'exti' }
        ] },
      { pin: 34, name: 'PA13', port: 'A', type: 'debug', io: true, fiveVTolerant: true, verified: true, note: 'PA13 = JTMS/SWDIO（SWD 数据线），复位后由 SWJ 占用。当普通 IO 需要在 AFIO_MAPR 中关闭 SWJ（通常等于放弃调试口），界面必须对这种分配给出冲突警告。数据手册标 FT → 5V 容…',
        functions: [
          { peripheral: 'GPIO', signal: 'PA13', kind: 'gpio' },
          { peripheral: 'SYS', signal: 'JTMS/SWDIO', kind: 'debug' },
          { peripheral: 'EXTI', signal: 'EXTI13', kind: 'exti' }
        ] },
      { pin: 35, name: 'VSS', port: null, type: 'power', io: false, fiveVTolerant: false, verified: true, note: '数字地（VSS_2）。非 IO。',
        functions: [
          { peripheral: 'PWR', signal: 'VSS', kind: 'pwr' }
        ] },
      { pin: 36, name: 'VDD', port: null, type: 'power', io: false, fiveVTolerant: false, verified: true, note: '数字电源（VDD_2），2.0-3.6V。非 IO。',
        functions: [
          { peripheral: 'PWR', signal: 'VDD', kind: 'pwr' }
        ] },
      { pin: 37, name: 'PA14', port: 'A', type: 'debug', io: true, fiveVTolerant: true, verified: true, note: 'PA14 = JTCK/SWCLK（SWD 时钟线），复位后由 SWJ 占用。与 PA13 一样，改为普通 IO 需关闭 SWJ。数据手册标 FT → 5V 容忍。',
        functions: [
          { peripheral: 'GPIO', signal: 'PA14', kind: 'gpio' },
          { peripheral: 'SYS', signal: 'JTCK/SWCLK', kind: 'debug' },
          { peripheral: 'EXTI', signal: 'EXTI14', kind: 'exti' }
        ] },
      { pin: 38, name: 'PA15', port: 'A', type: 'debug', io: true, fiveVTolerant: true, verified: true, note: '默认 JTDI。作 GPIO / SPI1_NSS / TIM2_CH1_ETR 需要关闭 JTAG（只保留 SWD）。数据手册标 FT → 5V 容忍。',
        functions: [
          { peripheral: 'GPIO', signal: 'PA15', kind: 'gpio' },
          { peripheral: 'SYS', signal: 'JTDI', kind: 'debug' },
          { peripheral: 'SPI1', signal: 'SPI1_NSS', kind: 'spi', remap: true },
          { peripheral: 'TIM2', signal: 'TIM2_CH1', kind: 'tim', remap: true },
          { peripheral: 'TIM2', signal: 'TIM2_ETR', kind: 'tim', remap: true },
          { peripheral: 'EXTI', signal: 'EXTI15', kind: 'exti' }
        ] },
      { pin: 39, name: 'PB3', port: 'B', type: 'debug', io: true, fiveVTolerant: true, verified: true, note: '默认 JTDO/TRACESWO。作 GPIO / SPI1_SCK / TIM2_CH2 需要关闭 JTAG（保留 SWD）。数据手册标 FT → 5V 容忍。',
        functions: [
          { peripheral: 'GPIO', signal: 'PB3', kind: 'gpio' },
          { peripheral: 'SYS', signal: 'JTDO/TRACESWO', kind: 'debug' },
          { peripheral: 'SPI1', signal: 'SPI1_SCK', kind: 'spi', remap: true },
          { peripheral: 'TIM2', signal: 'TIM2_CH2', kind: 'tim', remap: true },
          { peripheral: 'EXTI', signal: 'EXTI3', kind: 'exti' }
        ] },
      { pin: 40, name: 'PB4', port: 'B', type: 'debug', io: true, fiveVTolerant: true, verified: true, note: '默认 NJTRST。作 GPIO / SPI1_MISO / TIM3_CH1 需要关闭 JTAG（保留 SWD）。数据手册标 FT → 5V 容忍。',
        functions: [
          { peripheral: 'GPIO', signal: 'PB4', kind: 'gpio' },
          { peripheral: 'SYS', signal: 'NJTRST', kind: 'debug' },
          { peripheral: 'SPI1', signal: 'SPI1_MISO', kind: 'spi', remap: true },
          { peripheral: 'TIM3', signal: 'TIM3_CH1', kind: 'tim', remap: true },
          { peripheral: 'EXTI', signal: 'EXTI4', kind: 'exti' }
        ] },
      { pin: 41, name: 'PB5', port: 'B', type: 'gpio', io: true, fiveVTolerant: false, verified: false, note: '不确定项：DS5319 Rev 19 Table 5 中 PB5 的 I/O structure 列为空（未标 FT），而相邻的 PB4/PB6 都标了 FT；ST 社区存在 "Is PB5 really not 5V …',
        functions: [
          { peripheral: 'GPIO', signal: 'PB5', kind: 'gpio' },
          { peripheral: 'I2C1', signal: 'I2C1_SMBA', kind: 'i2c' },
          { peripheral: 'SPI1', signal: 'SPI1_MOSI', kind: 'spi', remap: true },
          { peripheral: 'TIM3', signal: 'TIM3_CH2', kind: 'tim', remap: true },
          { peripheral: 'EXTI', signal: 'EXTI5', kind: 'exti' }
        ] },
      { pin: 42, name: 'PB6', port: 'B', type: 'gpio', io: true, fiveVTolerant: true, verified: true, note: 'I2C1_SCL 默认引脚（重映射后 I2C1_SCL 移到 PB8）。USART1_TX（重映射）/ TIM4_CH1 复用。标 FT → 5V 容忍。',
        functions: [
          { peripheral: 'GPIO', signal: 'PB6', kind: 'gpio' },
          { peripheral: 'I2C1', signal: 'I2C1_SCL', kind: 'i2c' },
          { peripheral: 'USART1', signal: 'USART1_TX', kind: 'uart', remap: true },
          { peripheral: 'TIM4', signal: 'TIM4_CH1', kind: 'tim' },
          { peripheral: 'EXTI', signal: 'EXTI6', kind: 'exti' }
        ] },
      { pin: 43, name: 'PB7', port: 'B', type: 'gpio', io: true, fiveVTolerant: true, verified: true, note: 'I2C1_SDA 默认引脚（重映射后移到 PB9）。USART1_RX（重映射）/ TIM4_CH2 复用。标 FT → 5V 容忍。',
        functions: [
          { peripheral: 'GPIO', signal: 'PB7', kind: 'gpio' },
          { peripheral: 'I2C1', signal: 'I2C1_SDA', kind: 'i2c' },
          { peripheral: 'USART1', signal: 'USART1_RX', kind: 'uart', remap: true },
          { peripheral: 'TIM4', signal: 'TIM4_CH2', kind: 'tim' },
          { peripheral: 'EXTI', signal: 'EXTI7', kind: 'exti' }
        ] },
      { pin: 44, name: 'BOOT0', port: null, type: 'boot', io: false, fiveVTolerant: false, verified: true, note: '专用启动模式选择脚（非 GPIO，无复用功能）。复位时 BOOT0=0 → 从主 Flash 启动；BOOT0=1 → 从系统存储器（内置 Bootloader）启动（配合 PB2/BOOT1）。芯片内部无上拉/下拉保证…',
        functions: [
          { peripheral: 'BOOT', signal: 'BOOT0', kind: 'boot' }
        ] },
      { pin: 45, name: 'PB8', port: 'B', type: 'gpio', io: true, fiveVTolerant: true, verified: true, note: 'TIM4_CH3 默认；I2C1_SCL 与 CAN_RX 为重映射功能（三者同一时刻只能用一个）。标 FT → 5V 容忍。',
        functions: [
          { peripheral: 'GPIO', signal: 'PB8', kind: 'gpio' },
          { peripheral: 'TIM4', signal: 'TIM4_CH3', kind: 'tim' },
          { peripheral: 'I2C1', signal: 'I2C1_SCL', kind: 'i2c', remap: true },
          { peripheral: 'CAN', signal: 'CAN_RX', kind: 'can', remap: true },
          { peripheral: 'EXTI', signal: 'EXTI8', kind: 'exti' }
        ] },
      { pin: 46, name: 'PB9', port: 'B', type: 'gpio', io: true, fiveVTolerant: true, verified: true, note: 'TIM4_CH4 默认；I2C1_SDA 与 CAN_TX 为重映射功能。标 FT → 5V 容忍。',
        functions: [
          { peripheral: 'GPIO', signal: 'PB9', kind: 'gpio' },
          { peripheral: 'TIM4', signal: 'TIM4_CH4', kind: 'tim' },
          { peripheral: 'I2C1', signal: 'I2C1_SDA', kind: 'i2c', remap: true },
          { peripheral: 'CAN', signal: 'CAN_TX', kind: 'can', remap: true },
          { peripheral: 'EXTI', signal: 'EXTI9', kind: 'exti' }
        ] },
      { pin: 47, name: 'VSS', port: null, type: 'power', io: false, fiveVTolerant: false, verified: true, note: '数字地（VSS_3）。非 IO。',
        functions: [
          { peripheral: 'PWR', signal: 'VSS', kind: 'pwr' }
        ] },
      { pin: 48, name: 'VDD', port: null, type: 'power', io: false, fiveVTolerant: false, verified: true, note: '数字电源（VDD_3），2.0-3.6V。非 IO。',
        functions: [
          { peripheral: 'PWR', signal: 'VDD', kind: 'pwr' }
        ] },
    ]
  };
  /* ═══════════════════ 2. 可分配角色目录 ═══════════════════ */
  const ROLES = [
    { id: 'gpio-out', label: 'GPIO 输出', hint: '推挽输出 50 MHz', mode: 'out-pp',
      match: (f) => f.kind === 'gpio' },
    { id: 'gpio-od', label: 'GPIO 开漏输出', hint: '开漏输出 50 MHz', mode: 'out-od',
      match: (f) => f.kind === 'gpio' },
    { id: 'gpio-in', label: 'GPIO 输入', hint: '浮空输入', mode: 'in-float',
      match: (f) => f.kind === 'gpio' },
    { id: 'gpio-in-pu', label: 'GPIO 输入上拉', hint: '上拉输入', mode: 'in-pu',
      match: (f) => f.kind === 'gpio' },
    { id: 'gpio-in-pd', label: 'GPIO 输入下拉', hint: '下拉输入', mode: 'in-pd',
      match: (f) => f.kind === 'gpio' },
    { id: 'gpio-analog', label: '模拟输入', hint: '模拟输入（ADC 采样用）', mode: 'in-analog',
      match: (f) => f.kind === 'gpio' },
    { id: 'usart-tx', label: 'USART TX', hint: '复用推挽输出 50 MHz', mode: 'af-pp',
      match: (f) => f.kind === 'uart' && /^TX$/i.test(f.core || '') },
    { id: 'usart-rx', label: 'USART RX', hint: '浮空输入', mode: 'in-float',
      match: (f) => f.kind === 'uart' && /^RX$/i.test(f.core || '') },
    { id: 'i2c-scl', label: 'I2C SCL', hint: '复用开漏输出（需外部上拉）', mode: 'af-od',
      match: (f) => f.kind === 'i2c' && /^SCL$/i.test(f.core || '') },
    { id: 'i2c-sda', label: 'I2C SDA', hint: '复用开漏输出（需外部上拉）', mode: 'af-od',
      match: (f) => f.kind === 'i2c' && /^SDA$/i.test(f.core || '') },
    { id: 'spi-sck', label: 'SPI SCK', hint: '复用推挽输出 50 MHz', mode: 'af-pp',
      match: (f) => f.kind === 'spi' && /^SCK$/i.test(f.core || '') },
    { id: 'spi-miso', label: 'SPI MISO', hint: '浮空输入', mode: 'in-float',
      match: (f) => f.kind === 'spi' && /^MISO$/i.test(f.core || '') },
    { id: 'spi-mosi', label: 'SPI MOSI', hint: '复用推挽输出 50 MHz', mode: 'af-pp',
      match: (f) => f.kind === 'spi' && /^MOSI$/i.test(f.core || '') },
    { id: 'spi-nss', label: 'SPI NSS', hint: '复用推挽输出 / 软件片选', mode: 'af-pp',
      match: (f) => f.kind === 'spi' && /^NSS$/i.test(f.core || '') },
    { id: 'adc-in', label: 'ADC 输入', hint: '模拟输入', mode: 'in-analog',
      match: (f) => f.kind === 'adc' && /^IN\d+$/i.test(f.core || '') },
    { id: 'tim-pwm', label: 'TIM PWM', hint: '复用推挽输出 50 MHz（不含 ETR/BKIN）', mode: 'af-pp',
      match: (f) => f.kind === 'tim' && /^CH\d/i.test(f.core || '') },
    { id: 'exti', label: 'EXTI 中断', hint: '上拉输入 + EXTI 线（默认上升沿）', mode: 'exti',
      match: (f) => f.kind === 'exti' }
  ];

  const KIND_LABEL = {
    gpio: 'GPIO', uart: '串口', i2c: 'I2C', spi: 'SPI', adc: 'ADC',
    tim: '定时器', exti: '外部中断', usb: 'USB', can: 'CAN',
    debug: '调试', pwr: '电源/系统', boot: '启动'
  };

  const TYPE_LABEL = {
    power: '电源', gpio: 'GPIO', reset: '复位', boot: '启动',
    clock: '时钟', analog: '模拟', debug: '调试'
  };

  const PORT_CODE = { A: 0, B: 1, C: 2, D: 3, E: 4 };

  /** 引脚名 → 端口字母：'PA9' / 'A' / 'PB12' → 'A' / 'A' / 'B'；认不出来返回 null */
  function portLetter(port, name) {
    const s = String(port === null || port === undefined ? '' : port).trim().toUpperCase();
    const m = /^(?:P)?([A-E])(?:\d{1,2})?$/.exec(s);
    if (m) return m[1];
    const m2 = /^P([A-E])\d{1,2}$/.exec(String(name || '').trim().toUpperCase());
    return m2 ? m2[1] : null;
  }

  /**
   * 复用功能的信号核心名：数据里 signal 可能带外设前缀
   * （'USART1_TX' → 'TX'，'ADC1_IN0' → 'IN0'，'EXTI13' → 'EXTI13'，'I2C1_SMBA' → 'SMBA'）。
   */
  function signalCore(fn) {
    let s = String(fn.signal || '').trim().toUpperCase();
    const p = String(fn.peripheral || '').trim().toUpperCase();
    if (!p || !s) return s;
    if (s === p) return s;
    if (s.indexOf(p + '_') === 0) return s.slice(p.length + 1);
    if (s.indexOf(p + '/') === 0) return s.slice(p.length + 1);
    return s;
  }

  function isRemap(fn) {
    if (!fn) return false;
    if (fn.remap) return true;
    // 数据里的约定：「重映射 …」= 本脚是重映射目标；
    // 「默认引脚；重映射后移到 …」= 本脚是默认映射，不能当成重映射。
    return /^重映射/.test(String(fn.note || '').trim());
  }

  /** 引脚在它自己端口里的位号（PA9 → 9，PB13 → 13）；数据不足返回 null */
  function portBit(pin) {
    if (!pin) return null;
    const m1 = /^P[A-E](\d{1,2})/i.exec(String(pin.name || '').trim());
    if (m1) return Number(m1[1]);
    const m2 = /^P?[A-E](?:\d{1,2})$/i.test(String(pin.port || '').trim())
      ? /^P?[A-E](\d{1,2})$/i.exec(String(pin.port || '').trim()) : null;
    if (m2) return Number(m2[1]);
    return null;
  }

  /* ═══════════════════ 3. 几何：脚号 → 坐标（纯函数） ═══════════════════ */
  const GEOM = {
    viewBox: [0, 0, 700, 700],
    body: { x: 72, y: 72, w: 556, h: 556 },
    lead: 22,
    pad: 15,
    perSide: 12,
    frame: 22,      // 本体内部细框的进深
    label: 36,      // 左右两排引脚名写在本体内部时的进深
    numOut: 8,      // 上下两排脚号写在最外侧时的偏移
    labelOut: 32    // 上下两排引脚名写在本体外侧时的偏移（相对本体边缘）
  };

  /**
   * 脚号 → 几何位置。
   * 逆时针：1-12 左(自上而下) · 13-24 下(自左向右) · 25-36 右(自下而上) · 37-48 上(自右向左)
   * @returns {{side:number,idx:number,orient:string,x:number,y:number}}
   */
  function layout(pinNo, g) {
    const geo = g || GEOM;
    const n = Number(pinNo);
    const total = geo.perSide * 4;
    if (!Number.isInteger(n) || n < 1 || n > total) throw new RangeError('引脚号必须在 1..' + total);
    const side = Math.floor((n - 1) / geo.perSide);
    const idx = (n - 1) % geo.perSide;
    const b = geo.body;
    const pitchX = b.w / geo.perSide;
    const pitchY = b.h / geo.perSide;
    if (side === 0) return { side, idx, orient: 'left',   x: b.x,                   y: b.y + pitchY * (idx + 0.5) };
    if (side === 1) return { side, idx, orient: 'bottom', x: b.x + pitchX * (idx + 0.5), y: b.y + b.h };
    if (side === 2) return { side, idx, orient: 'right',  x: b.x + b.w,             y: b.y + b.h - pitchY * (idx + 0.5) };
    return             { side, idx, orient: 'top',    x: b.x + b.w - pitchX * (idx + 0.5), y: b.y };
  }

  /**
   * 引脚在画面里的引线 / 焊盘 / 文字锚点 / 点击热区。
   * 文字一律保持水平，避免四角横排名与竖排名交叉：
   *   左、右两排的引脚名写在本体内侧；上、下两排的引脚名与脚号写在本体外侧（脚号在最外）。
   */
  function pinDrawing(pinNo, g) {
    const geo = g || GEOM;
    const p = layout(pinNo, geo);
    const b = geo.body;
    const half = geo.pad / 2;
    const pitchY = b.h / geo.perSide;
    const pitchX = b.w / geo.perSide;
    const inset = geo.label;
    const d = { orient: p.orient, x: p.x, y: p.y };
    if (p.orient === 'left') {
      d.lead = { x1: p.x - geo.lead, y1: p.y, x2: p.x, y2: p.y };
      d.pad = { x: p.x - half, y: p.y - half, w: geo.pad, h: geo.pad };
      d.hit = { x: p.x - geo.lead - 6, y: p.y - pitchY / 2, w: geo.lead + 6 + inset + 62, h: pitchY };
      d.num = { x: p.x - geo.lead - 6, y: p.y, anchor: 'end', baseline: 'central', rotate: 0 };
      d.name = { x: p.x + inset, y: p.y, anchor: 'start', baseline: 'central', rotate: 0 };
    } else if (p.orient === 'right') {
      d.lead = { x1: p.x, y1: p.y, x2: p.x + geo.lead, y2: p.y };
      d.pad = { x: p.x - half, y: p.y - half, w: geo.pad, h: geo.pad };
      d.hit = { x: p.x - inset - 62, y: p.y - pitchY / 2, w: geo.lead + 6 + inset + 62, h: pitchY };
      d.num = { x: p.x + geo.lead + 6, y: p.y, anchor: 'start', baseline: 'central', rotate: 0 };
      d.name = { x: p.x - inset, y: p.y, anchor: 'end', baseline: 'central', rotate: 0 };
    } else if (p.orient === 'bottom') {
      d.lead = { x1: p.x, y1: p.y, x2: p.x, y2: p.y + geo.lead };
      d.pad = { x: p.x - half, y: p.y - half, w: geo.pad, h: geo.pad };
      d.name = { x: p.x, y: p.y + geo.labelOut, anchor: 'middle', baseline: 'central', rotate: 0 };
      d.num = { x: p.x, y: d.name.y + 24, anchor: 'middle', baseline: 'central', rotate: 0 };
      // 热区只覆盖本体外侧（名字与脚号都在外面），避免与相邻边的热区在四角互相侵占
      d.hit = { x: p.x - pitchX / 2, y: p.y, w: pitchX, h: (d.num.y + 8) - p.y };
    } else {
      d.lead = { x1: p.x, y1: p.y, x2: p.x, y2: p.y - geo.lead };
      d.pad = { x: p.x - half, y: p.y - half, w: geo.pad, h: geo.pad };
      d.name = { x: p.x, y: p.y - geo.labelOut, anchor: 'middle', baseline: 'central', rotate: 0 };
      d.num = { x: p.x, y: d.name.y - 24, anchor: 'middle', baseline: 'central', rotate: 0 };
      d.hit = { x: p.x - pitchX / 2, y: d.num.y - 8, w: pitchX, h: p.y - (d.num.y - 8) };
    }
    return d;
  }

  /* ═══════════════════ 4. 数据整理 ═══════════════════ */
  const PIN_REQUIRED = ['pin', 'name'];

  /** 校验并规整 /api/pins 或内置表的载荷；不合法返回 null */
  function normalizePinData(raw) {
    if (!raw || !Array.isArray(raw.pins) || raw.pins.length !== 48) return null;
    const seen = new Set();
    const pins = [];
    for (const p of raw.pins) {
      if (!p || typeof p !== 'object') return null;
      for (const k of PIN_REQUIRED) if (p[k] === undefined || p[k] === null || p[k] === '') return null;
      const no = Number(p.pin);
      if (!Number.isInteger(no) || no < 1 || no > 48 || seen.has(no)) return null;
      seen.add(no);
      pins.push({
        pin: no,
        name: String(p.name),
        port: portLetter(p.port, p.name),
        type: String(p.type || (p.io === false ? 'power' : 'gpio')),
        io: p.io === undefined ? true : !!p.io,
        fiveVTolerant: !!p.fiveVTolerant,
        verified: p.verified === undefined ? true : !!p.verified,
        note: p.note ? String(p.note) : '',
        source: p.source ? String(p.source) : '',
        functions: Array.isArray(p.functions)
          ? p.functions.filter((f) => f && f.peripheral && f.signal).map((f) => ({
              peripheral: String(f.peripheral),
              signal: String(f.signal),
              core: signalCore(f),
              kind: String(f.kind || 'gpio'),
              remap: isRemap(f),
              note: f.note ? String(f.note) : ''
            }))
          : []
      });
    }
    pins.sort((a, b) => a.pin - b.pin);
    if (pins.length !== 48) return null;
    return {
      mcu: raw.mcu ? String(raw.mcu) : FALLBACK.mcu,
      package: raw.package ? String(raw.package) : FALLBACK.package,
      flashKB: Number(raw.flashKB) || FALLBACK.flashKB,
      ramKB: Number(raw.ramKB) || FALLBACK.ramKB,
      coreClockMHz: Number(raw.coreClockMHz) || FALLBACK.coreClockMHz,
      source: raw.source || (raw.__fromApi ? 'GET /api/pins' : '外部数据'),
      pins
    };
  }

  function fallbackData() {
    // 兜底表也走一遍规整，保证 port/core/verified 等派生字段与在线数据同构
    const norm = normalizePinData(FALLBACK);
    if (norm) {
      norm.source = FALLBACK.source || '内置兜底表';
      return norm;
    }
    return JSON.parse(JSON.stringify(FALLBACK));   // 极端情况：原样返回（不改变调用方预期）
  }

  /** SVG 内显示用的短名：'PC13-TAMPER-RTC' → 'PC13'，'PD0/OSC_IN' → 'OSC_IN' */
  function shortName(name) {
    let s = String(name || '').trim();
    if (s.indexOf('/') >= 0) s = s.split('/').pop().trim();
    else if (s.indexOf('-') > 0) s = s.split('-')[0].trim();
    if (s.length > 7) s = s.slice(0, 7);
    return s;
  }

  function byNumber(pins) {
    const m = new Map();
    for (const p of pins) m.set(p.pin, p);
    return m;
  }

  /** 该引脚可用的 (role, function) 组合。LQFP48 只引出 PA/PB/PC，PD0/PD1 仅作晶振脚。 */
  function assignable(pin) {
    return !!(pin && pin.io && (pin.port === 'A' || pin.port === 'B' || pin.port === 'C'));
  }

  function availableRoles(pin) {
    const out = [];
    if (!assignable(pin)) return out;
    for (const role of ROLES) {
      for (const fn of pin.functions) {
        if (role.match(fn)) { out.push({ role, fn }); break; }
      }
    }
    return out;
  }

  function roleById(id) {
    for (const r of ROLES) if (r.id === id) return r;
    return null;
  }

  function channelKey(a) {
    if (!a) return '';
    if (String(a.kind) === 'gpio') return 'GPIO:' + (a.signal || a.pin);
    const core = a.core || signalCore(a);
    return a.peripheral + ':' + core;
  }

  function fnLabel(a) {
    const core = a.core || signalCore(a);
    return a.kind === 'gpio' ? String(a.signal) : a.peripheral + '_' + core;
  }

  /* ═══════════════════ 5. 冲突检查 ═══════════════════ */
  /**
   * @param {Array} assignments [{pin, roleId, peripheral, signal, kind, mode, remap}]
   * @param {Map} pinByNo
   * @returns {{errors:Array, warnings:Array}} 每项 {msg, pins:[], fix}
   */
  function validate(assignments, pinByNo) {
    const errors = [];
    const warnings = [];
    const list = Array.isArray(assignments) ? assignments : [];
    const channel = new Map();   // channelKey → assignment
    const usedPin = new Map();

    for (const a of list) {
      const key = channelKey(a);
      if (channel.has(key)) {
        const other = channel.get(key);
        errors.push({
          msg: key + '：外设通道被占用 —— 引脚 ' + other.pin + '（' + fnLabel(other) + '）与引脚 ' + a.pin + '（' + fnLabel(a) + '）冲突',
          pins: [other.pin, a.pin], code: 'channel'
        });
      } else {
        channel.set(key, a);
      }
      if (usedPin.has(a.pin)) {
        errors.push({ msg: '引脚 ' + a.pin + ' 被分配了多个功能', pins: [a.pin], code: 'pin' });
      }
      usedPin.set(a.pin, a);
    }

    // 引脚是否真的支持该功能（数据换源后可能出现）
    for (const a of list) {
      const pin = pinByNo.get(a.pin);
      const role = roleById(a.roleId);
      if (!pin || !role) { errors.push({ msg: '引脚 ' + a.pin + ' 的分配已失效（数据源已变化）', pins: [a.pin], code: 'stale' }); continue; }
      if (!assignable(pin)) {
        errors.push({
          msg: pin.name + '（脚 ' + a.pin + '）在 LQFP48 上不引出为 GPIO（PD0/PD1 只作 OSC_IN/OSC_OUT），不能分配',
          pins: [a.pin], code: 'notbonded'
        });
      }
      const ok = pin.io && pin.functions.some((f) => role.match(f) && f.peripheral === a.peripheral && f.core === (a.core || signalCore(a)));
      if (!ok) {
        errors.push({
          msg: pin.name + '（脚 ' + a.pin + '）不支持 ' + role.label + ' → ' + fnLabel(a) + '；请换引脚',
          pins: [a.pin], code: 'unsupported'
        });
      }
      if (pin.verified === false) {
        warnings.push({
          msg: pin.name + ' 的数据标注为「未核实」（verified:false）—— ' + (pin.note || '接 5V 前请实测或查最新版手册确认'),
          pins: [a.pin], code: 'unverified'
        });
      }
      if (!pin.fiveVTolerant && pin.io && /^(out|af)/.test(String(a.mode))) {
        warnings.push({ msg: pin.name + ' 非 5V 容忍（按数据表标记），外部信号请勿超过 3.3 V', pins: [a.pin], code: 'voltage' });
      }
      if (pin.type === 'debug' && a.roleId !== 'exti') {
        warnings.push({ msg: pin.name + ' 是 JTAG/SWD 调试口，占用后需重设 AFIO->MAPR 的 SWJ_CFG，调试会失效', pins: [a.pin], code: 'swj' });
      }
      if (pin.port === 'C' && (pin.pin === 2 || pin.pin === 3 || pin.pin === 4) && /out/.test(String(a.mode))) {
        warnings.push({ msg: pin.name + ' 驱动能力弱（约 3 mA），不建议做输出', pins: [a.pin], code: 'drive' });
      }
      if (a.remap) {
        warnings.push({ msg: pin.name + ' 的 ' + fnLabel(a) + ' 属于重映射，代码片段已写入 AFIO->MAPR 设置', pins: [a.pin], code: 'remap' });
      }
    }

    // 串口 TX/RX 配对提示
    const uarts = new Map();
    for (const a of list) {
      if (a.kind !== 'uart') continue;
      const core = a.core || signalCore(a);
      const rec = uarts.get(a.peripheral) || { TX: null, RX: null };
      if (/^TX$/i.test(core)) rec.TX = a; else if (/^RX$/i.test(core)) rec.RX = a;
      uarts.set(a.peripheral, rec);
    }
    for (const [peri, rec] of uarts) {
      if (rec.TX && rec.RX) {
        warnings.push({ msg: peri + ' 已同时分配 TX 与 RX：别忘了两端的波特率/校验位要一致（本片段只做 GPIO 与时钟配置）', pins: [rec.TX.pin, rec.RX.pin], code: 'uart-pair' });
      } else if (rec.TX || rec.RX) {
        warnings.push({ msg: peri + ' 只分配了 ' + (rec.TX ? 'TX' : 'RX') + '，对端是否需要另一根线请自行确认', pins: [(rec.TX || rec.RX).pin], code: 'uart-half' });
      }
    }
    return { errors, warnings };
  }

  /* ═══════════════════ 6. 代码生成（CMSIS 寄存器级） ═══════════════════ */
  const GPIO_MODE_CNF = {
    'out-pp': { cnf: 0x0, mode: 0x3, text: '推挽输出 50 MHz' },
    'out-od': { cnf: 0x1, mode: 0x3, text: '开漏输出 50 MHz' },
    'in-float': { cnf: 0x1, mode: 0x0, text: '浮空输入' },
    'in-pu': { cnf: 0x2, mode: 0x0, text: '上拉输入', pull: 'up' },
    'in-pd': { cnf: 0x2, mode: 0x0, text: '下拉输入', pull: 'down' },
    'in-analog': { cnf: 0x0, mode: 0x0, text: '模拟输入' },
    'af-pp': { cnf: 0x2, mode: 0x3, text: '复用推挽输出 50 MHz' },
    'af-od': { cnf: 0x3, mode: 0x3, text: '复用开漏输出 50 MHz' }
  };

  /* 重映射规则：mask 为 AFIO_MAPR 里的字段掩码，value 为字段值。
   * TIM2/TIM3 的部分重映射是多位字段（不能简单 |= 掩码，那会写成全局重映射），
   * 所以统一用「清字段再赋值」的读改写形式。位定义见 RM0008 的 AFIO_MAPR。 */
  const REMAP_RULES = {
    'USART1:TX':   { mask: 'AFIO_MAPR_USART1_REMAP', value: 'AFIO_MAPR_USART1_REMAP', text: 'USART1 重映射：TX→PB6、RX→PB7' },
    'USART1:RX':   { mask: 'AFIO_MAPR_USART1_REMAP', value: 'AFIO_MAPR_USART1_REMAP', text: 'USART1 重映射：TX→PB6、RX→PB7' },
    'I2C1:SCL':    { mask: 'AFIO_MAPR_I2C1_REMAP',   value: 'AFIO_MAPR_I2C1_REMAP',   text: 'I2C1 重映射：SCL→PB8、SDA→PB9' },
    'I2C1:SDA':    { mask: 'AFIO_MAPR_I2C1_REMAP',   value: 'AFIO_MAPR_I2C1_REMAP',   text: 'I2C1 重映射：SCL→PB8、SDA→PB9' },
    'SPI1:SCK':    { mask: 'AFIO_MAPR_SPI1_REMAP',   value: 'AFIO_MAPR_SPI1_REMAP',   text: 'SPI1 重映射：SCK→PB3、MISO→PB4、MOSI→PB5、NSS→PA15' },
    'SPI1:MISO':   { mask: 'AFIO_MAPR_SPI1_REMAP',   value: 'AFIO_MAPR_SPI1_REMAP',   text: 'SPI1 重映射：SCK→PB3、MISO→PB4、MOSI→PB5、NSS→PA15' },
    'SPI1:MOSI':   { mask: 'AFIO_MAPR_SPI1_REMAP',   value: 'AFIO_MAPR_SPI1_REMAP',   text: 'SPI1 重映射：SCK→PB3、MISO→PB4、MOSI→PB5、NSS→PA15' },
    'SPI1:NSS':    { mask: 'AFIO_MAPR_SPI1_REMAP',   value: 'AFIO_MAPR_SPI1_REMAP',   text: 'SPI1 重映射：SCK→PB3、MISO→PB4、MOSI→PB5、NSS→PA15' },
    'TIM2:CH1':    { mask: 'AFIO_MAPR_TIM2_REMAP',   value: '(0x1UL << 8)',           text: 'TIM2 部分重映射（01）：CH1→PA15、CH2→PB3、CH3→PA2、CH4→PA3' },
    'TIM2:CH2':    { mask: 'AFIO_MAPR_TIM2_REMAP',   value: '(0x1UL << 8)',           text: 'TIM2 部分重映射（01）：CH1→PA15、CH2→PB3、CH3→PA2、CH4→PA3' },
    'TIM3:CH1':    { mask: 'AFIO_MAPR_TIM3_REMAP',   value: '(0x2UL << 10)',          text: 'TIM3 部分重映射（10）：CH1→PB4、CH2→PB5、CH3→PB0、CH4→PB1' },
    'TIM3:CH2':    { mask: 'AFIO_MAPR_TIM3_REMAP',   value: '(0x2UL << 10)',          text: 'TIM3 部分重映射（10）：CH1→PB4、CH2→PB5、CH3→PB0、CH4→PB1' }
  };

  function pinBitName(port, n) { return 'GPIO' + port + '->' + (n < 8 ? 'CRL' : 'CRH'); }
  function pinShift(n) { return (n % 8) * 4; }

  function extiIrq(line) {
    if (line <= 4) return 'EXTI' + line + '_IRQn';
    if (line <= 9) return 'EXTI9_5_IRQn';
    return 'EXTI15_10_IRQn';
  }

  /**
   * 生成初始化片段。
   * @returns {{code:string, warnings:string[]}}
   */
  function generateCode(assignments, data) {
    const list = Array.isArray(assignments) ? assignments.slice() : [];
    list.sort((a, b) => a.pin - b.pin);
    const pinByNo = byNumber(data.pins);
    const v = validate(list, pinByNo);
    const warn = [];

    if (!list.length) {
      return {
        code: '/* 尚未分配功能。\n' +
              ' * 打开「分配模式」，点击引脚图中的焊盘，选择功能后可在此生成初始化片段。 */',
        warnings: []
      };
    }

    const ports = new Set();
    const usesAfio = list.some((a) => a.kind === 'exti' || a.remap);
    for (const a of list) { const p = pinByNo.get(a.pin); if (p && p.port) ports.add(p.port); }

    const L = [];
    L.push('/* ============================================================');
    L.push(' * 引脚初始化片段 —— 由 STM32 工作台「引脚规划」生成');
    L.push(' * 目标：' + data.mcu + ' (' + data.package + ')');
    L.push(' * 说明：CMSIS 寄存器级（与 firmware/bsp 一致），本片段未经编译验证，');
    L.push(' *       合并前请自行核对时钟树、重映射与外部上拉。');
    L.push(' * ============================================================ */');
    L.push('#include "stm32f10x.h"');
    L.push('');
    L.push('void board_pin_init(void)');
    L.push('{');
    L.push('    /* 时钟使能 ------------------------------------------------ */');

    const rccBits = [];
    for (const p of Array.from(ports).sort()) rccBits.push('RCC_APB2ENR_IOP' + p + 'EN');
    if (usesAfio) rccBits.push('RCC_APB2ENR_AFIOEN');
    L.push('    RCC->APB2ENR |= ' + rccBits.join(' | ') + ';');

    // 重映射
    const remaps = new Map();   // mask → rule（同一字段只写一次）
    for (const a of list) {
      if (!a.remap) continue;
      const rule = REMAP_RULES[a.peripheral + ':' + (a.core || signalCore(a))];
      if (rule) remaps.set(rule.mask, rule);
      else warn.push(fnLabel(a) + ' 需要重映射，但本工具没有对应的 AFIO->MAPR 设置，请查参考手册手动处理');
    }
    if (remaps.size) {
      L.push('');
      L.push('    /* 重映射（AFIO->MAPR）------------------------------------ */');
      for (const rule of Array.from(remaps.values()).sort((x, y) => x.mask < y.mask ? -1 : 1)) {
        L.push('    AFIO->MAPR = (AFIO->MAPR & ~' + rule.mask + ') | ' + rule.value + ';  /* ' + rule.text + ' */');
      }
    }

    L.push('');
    L.push('    /* 引脚配置 ------------------------------------------------ */');

    for (const a of list) {
      const pin = pinByNo.get(a.pin);
      const role = roleById(a.roleId);
      if (!pin || !role) continue;
      const cc = '/* ' + pin.name + ' 脚' + pad2(a.pin) + '  ' + role.label + (a.kind === 'gpio' ? '' : '  ' + fnLabel(a)) + ' */';
      L.push('    ' + cc);

      const bit = portBit(pin);   // 端口内位号，注意不是封装脚号
      if (pin.port && (pin.type === 'gpio' || pin.type === 'debug') && bit === null) {
        L.push('    /* ⚠ 数据里缺少 ' + pin.name + ' 的端口位号，无法生成寄存器配置，请手动确认 */');
        warn.push(pin.name + ' 缺少端口位号，未生成配置');
      } else if (pin.port && (pin.type === 'gpio' || pin.type === 'debug')) {
        if (a.kind === 'usb') {
          L.push('    /* USB 的 DM/DP 由 USB 外设接管，保持默认浮空输入即可，无需配置 GPIO */');
        } else if (a.kind === 'exti') {
          const line = Number((/^EXTI(\d+)$/i.exec(a.core || a.signal) || /^(\d+)$/.exec(a.core || '') || [0, 0])[1]);
          const pc = PORT_CODE[pin.port] === undefined ? 0 : PORT_CODE[pin.port];
          L.push('    ' + pinBitName(pin.port, bit) + ' = (' + pinBitName(pin.port, bit) +
                 ' & ~(0xFUL << ' + pinShift(bit) + ')) | (0x08UL << ' + pinShift(bit) + ');  /* 上拉输入 */');
          L.push('    GPIO' + pin.port + '->BSRR = (1U << ' + bit + ');  /* ODR=1：选择上拉 */');
          L.push('    AFIO->EXTICR[' + Math.floor(line / 4) + '] = (AFIO->EXTICR[' + Math.floor(line / 4) +
                 '] & ~(0xFUL << ' + ((line % 4) * 4) + ')) | (' + pc + 'UL << ' + ((line % 4) * 4) + ');  /* EXTI' + line + ' ← P' + pin.port + ' */');
          L.push('    EXTI->IMR  |= (1U << ' + line + ');');
          L.push('    EXTI->RTSR |= (1U << ' + line + ');  /* 上升沿；下降沿用 FTSR，双边沿用两者 */');
          L.push('    NVIC_EnableIRQ(' + extiIrq(line) + ');');
        } else {
          const m = GPIO_MODE_CNF[role.mode] || GPIO_MODE_CNF['in-float'];
          const bits = (m.cnf << 2) | m.mode;
          L.push('    ' + pinBitName(pin.port, bit) + ' = (' + pinBitName(pin.port, bit) +
                 ' & ~(0xFUL << ' + pinShift(bit) + ')) | (0x' + bits.toString(16).toUpperCase() + 'UL << ' + pinShift(bit) + ');  /* ' + m.text + '，P' + pin.port + bit + ' */');
          if (m.pull === 'up') L.push('    GPIO' + pin.port + '->BSRR = (1U << ' + bit + ');  /* ODR=1：上拉 */');
          if (m.pull === 'down') L.push('    GPIO' + pin.port + '->BRR  = (1U << ' + bit + ');  /* ODR=0：下拉 */');
        }
      } else {
        L.push('    /* ' + (TYPE_LABEL[pin.type] || pin.type) + '引脚，无需 GPIO 配置 */');
      }
      L.push('');
    }

    if (v.errors.length) {
      L.push('    /* ⚠ 存在 ' + v.errors.length + ' 项冲突，上面的配置可能互相矛盾：');
      for (const e of v.errors) L.push('     *   - ' + e.msg);
      L.push('     */');
    }
    L.push('}');
    L.push('');
    if (v.warnings.length) {
      L.push('/* 提示：');
      for (const w of v.warnings) L.push(' *  - ' + w.msg);
      L.push(' */');
    }
    return { code: L.join('\n'), warnings: v.errors.map((e) => e.msg).concat(warn) };
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /* ═══════════════════ 7. 视图（SVG + 面板 + 交互） ═══════════════════ */
  const SVG_NS = 'http://www.w3.org/2000/svg';

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function svgEl(tag, attrs, text) {
    const el = document.createElementNS(SVG_NS, tag);
    if (attrs) for (const k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k) && attrs[k] !== null) el.setAttribute(k, attrs[k]);
    if (text !== undefined && text !== null) el.textContent = text;
    return el;
  }

  /**
   * 装配引脚规划视图。
   * @param {{getElementById:Function, onToast:Function, onChange:Function, onCopy:Function}} cfg
   */
  function createPlanner(cfg) {
    const doc = cfg.document || document;
    const $ = (id) => doc.getElementById(id);
    const onToast = cfg.onToast || function () {};
    const onChange = cfg.onChange || function () {};

    const el = {
      svg: $('pinSvg'),
      wrap: $('pinCanvasWrap'),
      legend: $('pinLegend'),
      detailTitle: $('pinDetailTitle'),
      detailBadge: $('pinDetailBadge'),
      detailBody: $('pinDetailBody'),
      assignBox: $('pinAssignBox'),
      roleButtons: $('pinRoleButtons'),
      assignRows: $('assignRows'),
      assignCount: $('assignCount'),
      conflictList: $('conflictList'),
      conflictCount: $('conflictCount'),
      codeOut: $('codeOut'),
      codeWarn: $('codeWarn'),
      pinTableBody: $('pinTableBody'),
      assignMode: $('assignMode'),
      colorMode: $('padColorMode'),
      hint: $('assignModeHint'),
      copyStatus: $('copyStatus'),
      chipName: $('chipName'),
      chipPackage: $('chipPackage'),
      chipMeta: $('chipMeta'),
      pinSource: $('pinSource')
    };

    let data = fallbackData();
    let pinByNo = byNumber(data.pins);
    let assignments = [];
    let selected = null;          // 选中的脚号
    let assignMode = false;
    let colorMode = 'assign';
    let pinNodes = new Map();     // pinNo → <g>
    let conflictSet = new Set();

    /* ---------- SVG 主体 ---------- */
    function buildSvg() {
      const svg = el.svg;
      while (svg.firstChild) svg.removeChild(svg.firstChild);
      pinNodes = new Map();

      const b = GEOM.body;
      const vb = GEOM.viewBox;
      svg.setAttribute('viewBox', vb.join(' '));
      svg.setAttribute('data-color', colorMode);

      // 芯片本体（外框 + 内框 + 角标 + 定位点）
      const layers = [
        ['body', svgEl('rect', { class: 'pin-body-shape', x: b.x, y: b.y, width: b.w, height: b.h, rx: 4 })],
        ['inner', svgEl('rect', { class: 'pin-inner', x: b.x + GEOM.frame, y: b.y + GEOM.frame, width: b.w - GEOM.frame * 2, height: b.h - GEOM.frame * 2, rx: 2 })],
        ['corner', svgEl('path', { class: 'pin-corner', d: 'M' + b.x + ' ' + (b.y + 26) + 'V' + b.y + 'H' + (b.x + 26) })]
      ];
      for (const [, node] of layers) svg.appendChild(node);

      // 脚 1 标记：画在本体左上角外侧，避免压到 48/1 脚的引脚名
      const notch = svgEl('circle', { class: 'pin-notch', cx: b.x - 14, cy: b.y - 14, r: 9 });
      svg.appendChild(notch);
      const mark = svgEl('text', { class: 'pin-1-mark', x: b.x - 14, y: b.y - 14, 'text-anchor': 'middle', 'dominant-baseline': 'central' }, '1');
      svg.appendChild(mark);

      // 中心文字
      const cx = b.x + b.w / 2;
      const cy = b.y + b.h / 2;
      svg.appendChild(svgEl('text', { class: 'pin-core-name', x: cx, y: cy - 14, 'text-anchor': 'middle', 'dominant-baseline': 'central' }, data.mcu));
      svg.appendChild(svgEl('text', { class: 'pin-core-sub', x: cx, y: cy + 10, 'text-anchor': 'middle', 'dominant-baseline': 'central' },
        data.package + ' · 48 脚 · ' + data.flashKB + ' KB Flash / ' + data.ramKB + ' KB RAM'));
      const stat = svgEl('text', { class: 'pin-core-sub', x: cx, y: cy + 32, 'text-anchor': 'middle', 'dominant-baseline': 'central' }, '');
      stat.setAttribute('id', 'pinCoreStat');
      svg.appendChild(stat);

      // 48 根引脚
      for (const pin of data.pins) {
        const d = pinDrawing(pin.pin);
        const g = svgEl('g', {
          class: 'pin', 'data-pin': String(pin.pin), 'data-port': pin.port || '-',
          'data-tone': pin.type, tabindex: '0', role: 'button'
        });
        g.appendChild(svgEl('title', null, '脚 ' + pin.pin + ' · ' + pin.name + '（' + (TYPE_LABEL[pin.type] || pin.type) + '）'));
        g.appendChild(svgEl('line', { class: 'lead', x1: d.lead.x1, y1: d.lead.y1, x2: d.lead.x2, y2: d.lead.y2 }));
        g.appendChild(svgEl('rect', { class: 'pad', x: d.pad.x, y: d.pad.y, width: d.pad.w, height: d.pad.h, rx: 2 }));
        const numAttrs = { class: 'num', x: d.num.x, y: d.num.y, 'text-anchor': d.num.anchor, 'dominant-baseline': d.num.baseline };
        if (d.num.rotate) numAttrs.transform = 'rotate(' + d.num.rotate + ' ' + d.num.x + ' ' + d.num.y + ')';
        g.appendChild(svgEl('text', numAttrs, String(pin.pin)));
        const nameAttrs = { class: 'nm', x: d.name.x, y: d.name.y, 'text-anchor': d.name.anchor, 'dominant-baseline': d.name.baseline };
        if (d.name.rotate) nameAttrs.transform = 'rotate(' + d.name.rotate + ' ' + d.name.x + ' ' + d.name.y + ')';
        g.appendChild(svgEl('text', nameAttrs, shortName(pin.name)));
        g.appendChild(svgEl('rect', { class: 'hit', x: d.hit.x, y: d.hit.y, width: d.hit.w, height: d.hit.h, fill: 'transparent' }));
        g.setAttribute('aria-label', pinAria(pin));
        svg.appendChild(g);
        pinNodes.set(pin.pin, g);
      }
      updateSvgStates();
    }

    function pinAria(pin) {
      const roles = availableRoles(pin).map((r) => r.role.label + '（' + r.fn.peripheral + '_' + r.fn.core + '）');
      return '引脚 ' + pin.pin + '，' + shortName(pin.name) +
        (pin.port ? '，端口 P' + pin.port : '') +
        (pin.verified === false ? '，数据未核实' : '') +
        (roles.length ? '，可用：' + roles.slice(0, 6).join('、') : '，无可用分配');
    }

    function updateSvgStates() {
      const used = new Map();
      for (const a of assignments) used.set(a.pin, a);
      for (const [no, g] of pinNodes) {
        const a = used.get(no);
        let state = '';
        if (conflictSet.has(no)) state = 'conflict';
        else if (a) state = 'assigned';
        g.setAttribute('data-state', state);
        g.classList.toggle('is-selected', selected === no);
        const pin = pinByNo.get(no);
        g.setAttribute('aria-pressed', String(selected === no));
        g.setAttribute('aria-label', (pin ? pinAria(pin) : '引脚 ' + no) + (a ? '；已分配 ' + roleLabel(a) : ''));
      }
      const stat = el.svg.querySelector('#pinCoreStat');
      if (stat) stat.textContent = '已分配 ' + assignments.length + ' / ' + data.pins.filter(assignable).length + ' 个可分配引脚';
    }

    /* ---------- 图例 ---------- */
    function renderLegend() {
      const items = colorMode === 'assign'
        ? [['accent', '已分配'], ['', '未分配'], ['err', '冲突'], ['accent-soft', '选中']]
        : colorMode === 'port'
          ? [['accent', 'PAx'], ['accent-soft', 'PBx'], ['power', 'PCx'], ['dashed', '电源/复位/时钟']]
          : [['accent-soft', 'GPIO'], ['power', '电源'], ['warn', '复位/启动'], ['dashed', '时钟/晶振']];
      el.legend.innerHTML = items.map(([fill, label]) =>
        '<span class="legend-item"><span class="legend-swatch" data-fill="' + fill + '"></span>' + esc(label) + '</span>'
      ).join('');
    }

    function renderChipHeader() {
      if (el.chipName) el.chipName.textContent = data.mcu;
      if (el.chipPackage) el.chipPackage.textContent = data.package;
      if (el.chipMeta) el.chipMeta.textContent = 'Flash ' + data.flashKB + ' KB · RAM ' + data.ramKB + ' KB · ' + data.coreClockMHz + ' MHz';
      if (el.pinSource) {
        const fromApi = String(data.source).indexOf('api') >= 0;
        el.pinSource.textContent = '引脚数据：' + data.source;
        el.pinSource.setAttribute('data-src', fromApi ? 'api' : 'fallback');
      }
    }

    /* ---------- 详情面板 ---------- */
    function roleLabel(a) {
      const role = roleById(a.roleId);
      const base = role ? role.label : a.roleId;
      return base + (a.kind === 'gpio' ? ' ' + a.signal : ' ' + fnLabel(a));
    }

    function renderDetail() {
      const pin = selected ? pinByNo.get(selected) : null;
      if (!pin) {
        el.detailTitle.textContent = '引脚详情';
        el.detailBadge.hidden = true;
        el.detailBody.innerHTML = '<p class="empty">未选中引脚。点击引脚图中的焊盘，或用 <kbd>Tab</kbd> 聚焦后按方向键浏览。</p>';
        el.assignBox.hidden = true;
        return;
      }
      const assigned = assignments.find((a) => a.pin === pin.pin) || null;
      el.detailTitle.textContent = '引脚详情';
      el.detailBadge.hidden = false;
      el.detailBadge.textContent = '脚 ' + pad2(pin.pin);
      el.detailBadge.setAttribute('data-tone', conflictSet.has(pin.pin) ? 'err' : (assigned ? 'accent' : ''));

      const fns = pin.functions.length
        ? '<ul class="fn-list">' + pin.functions.map((f) =>
            '<li><span class="fn-peri">' + esc(f.peripheral) + '</span><span class="fn-sig">' + esc(f.core) + '</span>' +
            '<span class="fn-kind">' + esc(KIND_LABEL[f.kind] || f.kind) + (f.remap ? ' · 重映射' : '') + '</span></li>').join('') + '</ul>'
        : '<p class="hint" style="padding-left:0">该脚为电源/复位/时钟脚，数据表里没有列出可分配的复用功能。</p>';

      const v5 = !pin.io ? { tone: '', text: '非 IO' }
        : pin.verified === false ? { tone: 'warn', text: pin.fiveVTolerant ? '5V 容忍（未核实）' : '5V 容忍未核实（保守按否）' }
        : pin.fiveVTolerant ? { tone: 'ok', text: '5V 容忍' }
        : { tone: 'warn', text: '非 5V 容忍' };

      el.detailBody.innerHTML =
        '<div class="headline">' +
          '<span class="pinno mono">' + pad2(pin.pin) + '</span>' +
          '<span class="pinname mono">' + esc(pin.name) + '</span>' +
          (pin.port ? '<span class="badge">P' + esc(pin.port) + '</span>' : '') +
          '<span class="badge">' + esc(TYPE_LABEL[pin.type] || pin.type) + '</span>' +
          '<span class="badge" data-tone="' + v5.tone + '">' + esc(v5.text) + '</span>' +
          (pin.verified === false ? '<span class="badge" data-tone="warn">数据未核实</span>' : '') +
          (assignable(pin) ? '' : '<span class="badge">LQFP48 不可作 GPIO</span>') +
          (assigned ? '<span class="badge" data-tone="accent">已分配：' + esc(roleLabel(assigned)) + '</span>' : '') +
        '</div>' +
        (pin.verified === false ? '<p class="issue issue-warn" role="note">此脚结论未核实（数据标 verified:false）：接 5V 前请实测或查最新版数据手册确认。</p>' : '') +
        (pin.note ? '<p class="dim">' + esc(pin.note) + '</p>' : '') +
        '<h4 class="sub" style="margin-left:0">数据表中的复用功能</h4>' + fns;

      // 分配按钮
      const avail = availableRoles(pin);
      el.assignBox.hidden = false;
      const hintEl = $('assignBoxHint');
      if (hintEl) hintEl.textContent = assignMode ? '（点击即分配）' : '（只读：打开工具栏的「分配模式」后可点击分配）';
      if (!avail.length) {
        el.roleButtons.innerHTML = '<p class="hint" style="padding-left:0">' +
          (assignable(pin) ? '该脚没有本工具支持的复用功能（电源/复位/时钟/晶振脚）。'
                           : '该脚在 LQFP48 上不引出为 GPIO（PD0/PD1 只作 OSC_IN/OSC_OUT），不参与分配。') + '</p>';
      } else if (!assignMode) {
        el.roleButtons.innerHTML = avail.map((r) =>
          '<span class="badge" title="' + esc(r.role.hint) + '">' + esc(r.role.label) + ' · ' + esc(r.fn.peripheral + '_' + r.fn.core) + '</span>'
        ).join(' ');
      } else {
        el.roleButtons.innerHTML = avail.map((r) => {
          const key = channelKey({ kind: r.fn.kind, signal: r.fn.signal, core: r.fn.core, peripheral: r.fn.peripheral, pin: pin.pin });
          const owner = assignments.find((a) => channelKey(a) === key && a.pin !== pin.pin);
          const taken = owner ? ' data-taken="1" title="' + esc(key + ' 已被引脚 ' + owner.pin + ' 占用，点击会产生冲突') + '"' : '';
          return '<button type="button" class="role-btn" data-role="' + esc(r.role.id) + '" data-peri="' + esc(r.fn.peripheral) +
                 '" data-sig="' + esc(r.fn.signal) + '" data-core="' + esc(r.fn.core) + '" data-kind="' + esc(r.fn.kind) +
                 '" data-remap="' + (r.fn.remap ? '1' : '0') + '"' + taken + '>' +
                 esc(r.role.label) + '<span class="rk">' + esc(r.fn.peripheral + '_' + r.fn.core) + (owner ? ' · 已占用' : '') + '</span></button>';
        }).join(' ') + (assigned ? '<button type="button" class="role-btn" data-unassign="1">解除分配（' + esc(roleLabel(assigned)) + '）</button>' : '');
      }
    }

    /* ---------- 分配表 ---------- */
    function renderAssignments() {
      const rows = assignments.slice().sort((a, b) => a.pin - b.pin);
      el.assignCount.textContent = rows.length + ' 项';
      if (!rows.length) {
        el.assignRows.innerHTML = '<tr class="empty-row"><td colspan="4">还没有分配任何功能。打开「分配模式」后点击引脚图。</td></tr>';
        return;
      }
      el.assignRows.innerHTML = rows.map((a) => {
        const role = roleById(a.roleId);
        const bad = conflictSet.has(a.pin);
        return '<tr>' +
          '<td>' + esc(role ? role.label : a.roleId) + (bad ? ' <span class="badge" data-tone="err">冲突</span>' : '') + '</td>' +
          '<td class="mono">' + esc(a.kind === 'gpio' ? '—' : fnLabel(a)) + (a.remap ? ' <span class="dim">(重映射)</span>' : '') + '</td>' +
          '<td class="mono">' + pad2(a.pin) + ' ' + esc(shortName((pinByNo.get(a.pin) || {}).name || '')) + '</td>' +
          '<td><button type="button" class="btn btn-sm" data-unassign-pin="' + a.pin + '">解除</button></td>' +
        '</tr>';
      }).join('');
    }

    /* ---------- 冲突面板 ---------- */
    function renderConflicts() {
      const v = validate(assignments, pinByNo);
      conflictSet = new Set();
      for (const e of v.errors) for (const p of e.pins) conflictSet.add(p);

      const items = [];
      for (const e of v.errors) items.push('<li class="issue issue-err"><b>冲突</b> ' + esc(e.msg) + '</li>');
      for (const w of v.warnings) items.push('<li class="issue issue-warn"><b>提示</b> ' + esc(w.msg) + '</li>');
      if (!items.length) items.push('<li class="issue issue-ok">当前分配未发现冲突</li>');
      el.conflictList.innerHTML = items.join('');
      el.conflictCount.textContent = v.errors.length ? v.errors.length + ' 项冲突' : (v.warnings.length ? v.warnings.length + ' 条提示' : '无冲突');
      el.conflictCount.setAttribute('data-tone', v.errors.length ? 'err' : v.warnings.length ? 'warn' : 'ok');
      return v;
    }

    /* ---------- 代码 ---------- */
    let lastCode = '';
    let lastCodeWarnings = [];

    function renderCode() {
      const out = generateCode(assignments, data);
      lastCode = out.code;
      lastCodeWarnings = out.warnings;
      el.codeOut.textContent = out.code;
      if (out.warnings.length) {
        el.codeWarn.hidden = false;
        el.codeWarn.textContent = '⚠ ' + out.warnings.length + ' 项需要人工确认：' + out.warnings.slice(0, 3).join('；') + (out.warnings.length > 3 ? ' …' : '');
      } else {
        el.codeWarn.hidden = true;
        el.codeWarn.textContent = '';
      }
    }

    /* ---------- 引脚表（无图形环境/逐条查阅） ---------- */
    function renderPinTable() {
      const rows = data.pins.map((pin) => {
        const a = assignments.find((x) => x.pin === pin.pin);
        return '<tr>' +
          '<td class="mono">' + pad2(pin.pin) + '</td>' +
          '<td class="mono">' + esc(pin.name) + '</td>' +
          '<td>' + esc(TYPE_LABEL[pin.type] || pin.type) + '</td>' +
          '<td>' + (pin.io ? (pin.verified === false ? '未核实' : (pin.fiveVTolerant ? '是' : '否')) : '—') + '</td>' +
          '<td>' + (a ? '<span class="badge" data-tone="accent">' + esc(roleLabel(a)) + '</span>' : '<span class="dim">—</span>') + '</td>' +
          '<td><button type="button" class="btn btn-sm" data-select-pin="' + pin.pin + '">查看</button></td>' +
        '</tr>';
      });
      el.pinTableBody.innerHTML = rows.join('');
    }

    /* ---------- 全量渲染 ---------- */
    function renderAll() {
      renderChipHeader();
      renderLegend();
      buildSvg();
      renderDetail();
      renderAssignments();
      renderConflicts();
      updateSvgStates();
      renderCode();
      renderPinTable();
    }

    /* ---------- 状态变更 ---------- */
    function commit(reason) {
      renderAssignments();
      renderConflicts();
      updateSvgStates();
      renderDetail();
      renderCode();
      renderPinTable();
      onChange(assignments.slice(), reason);
    }

    function select(pinNo, focus) {
      selected = pinNo;
      updateSvgStates();
      renderDetail();
      if (focus && pinNodes.has(pinNo)) pinNodes.get(pinNo).focus();
    }

    function assign(pinNo, roleId, fn) {
      const exists = assignments.find((a) => a.pin === pinNo);
      const core = fn.core || signalCore(fn);
      if (exists && exists.roleId === roleId && exists.peripheral === fn.peripheral && (exists.core || signalCore(exists)) === core) {
        onToast('该功能已分配', 'warn');
        return;
      }
      const rec = {
        pin: pinNo, roleId, peripheral: fn.peripheral, signal: fn.signal, core,
        kind: fn.kind, mode: (roleById(roleId) || {}).mode, remap: !!fn.remap
      };
      assignments = assignments.filter((a) => a.pin !== pinNo).concat([rec]);
      const v = validate(assignments, pinByNo);
      const role = roleById(roleId);
      const mine = v.errors.filter((e) => e.pins.indexOf(pinNo) >= 0);
      if (mine.length) onToast('已分配，但存在冲突：' + mine[0].msg, 'err');
      else onToast('已分配 ' + (role ? role.label : roleId) + ' → ' + pinNo + (fn.kind === 'gpio' ? '' : ' · ' + fn.peripheral + '_' + core), 'ok');
      commit('assign');
    }

    function unassign(pinNo) {
      const before = assignments.length;
      assignments = assignments.filter((a) => a.pin !== pinNo);
      if (assignments.length !== before) { onToast('已解除引脚 ' + pinNo + ' 的分配', ''); commit('unassign'); }
    }

    /* ---------- 事件绑定 ---------- */
    function bindEvents() {
      el.svg.addEventListener('click', (ev) => {
        const g = ev.target.closest ? ev.target.closest('.pin') : null;
        if (!g) return;
        select(Number(g.getAttribute('data-pin')), false);
      });
      el.svg.addEventListener('keydown', (ev) => {
        const g = ev.target.closest ? ev.target.closest('.pin') : null;
        if (!g) return;
        const no = Number(g.getAttribute('data-pin'));
        let next = null;
        if (ev.key === 'ArrowDown' || ev.key === 'ArrowRight') next = no >= 48 ? 1 : no + 1;
        else if (ev.key === 'ArrowUp' || ev.key === 'ArrowLeft') next = no <= 1 ? 48 : no - 1;
        else if (ev.key === 'Home') next = 1;
        else if (ev.key === 'End') next = 48;
        else if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); select(no, true); return; }
        else if (ev.key === 'Escape') { select(null, false); el.wrap.focus(); return; }
        if (next !== null) { ev.preventDefault(); select(next, true); }
      });
      el.wrap.addEventListener('keydown', (ev) => {
        if (ev.key === 'ArrowRight' || ev.key === 'ArrowDown') { ev.preventDefault(); select(selected ? selected : 1, true); }
      });

      el.assignMode.addEventListener('change', () => {
        assignMode = el.assignMode.checked;
        el.hint.textContent = assignMode ? '分配模式：点击焊盘后从功能列表选择' : '点击引脚查看详情';
        el.hint.setAttribute('data-tone', assignMode ? 'run' : '');
        renderDetail();
      });
      el.colorMode.addEventListener('change', () => {
        colorMode = el.colorMode.value;
        el.svg.setAttribute('data-color', colorMode);
        renderLegend();
      });
      $('btnClearAssign').addEventListener('click', () => {
        if (!assignments.length) { onToast('当前没有分配', 'warn'); return; }
        if (!window.confirm('清空全部 ' + assignments.length + ' 项分配？')) return;
        assignments = [];
        onToast('已清空分配', '');
        commit('clear');
      });
      $('btnResetView').addEventListener('click', () => {
        selected = null;
        updateSvgStates(); renderDetail();
      });
      el.roleButtons.addEventListener('click', (ev) => {
        const btn = ev.target.closest ? ev.target.closest('button') : null;
        if (!btn || !selected) return;
        if (btn.hasAttribute('data-unassign')) { unassign(selected); return; }
        const roleId = btn.getAttribute('data-role');
        if (!roleId) return;
        assign(selected, roleId, {
          peripheral: btn.getAttribute('data-peri'),
          signal: btn.getAttribute('data-sig'),
          core: btn.getAttribute('data-core'),
          kind: btn.getAttribute('data-kind'),
          remap: btn.getAttribute('data-remap') === '1'
        });
      });
      el.assignRows.addEventListener('click', (ev) => {
        const btn = ev.target.closest ? ev.target.closest('button[data-unassign-pin]') : null;
        if (btn) unassign(Number(btn.getAttribute('data-unassign-pin')));
      });
      el.pinTableBody.addEventListener('click', (ev) => {
        const btn = ev.target.closest ? ev.target.closest('button[data-select-pin]') : null;
        if (!btn) return;
        select(Number(btn.getAttribute('data-select-pin')), false);
        el.wrap.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      });
      $('btnGenCode').addEventListener('click', () => { renderCode(); onToast('已重新生成代码片段', 'ok'); });
      $('btnCopyCode').addEventListener('click', () => copyCode());
      $('btnDownloadCode').addEventListener('click', () => downloadCode());
    }

    function setCopyStatus(text, tone) {
      el.copyStatus.textContent = text;
      el.copyStatus.setAttribute('data-tone', tone || '');
      window.setTimeout(() => { if (el.copyStatus.textContent === text) el.copyStatus.textContent = ''; }, 2600);
    }

    function copyCode() {
      const text = lastCode;
      const done = () => setCopyStatus('已复制 ' + text.split('\n').length + ' 行', '');
      const fail = (err) => { setCopyStatus('复制失败：' + (err && err.message ? err.message : err), 'err'); onToast('复制失败，请手动全选代码框复制', 'err'); };
      if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(done, () => legacyCopy(text, done, fail));
      } else {
        legacyCopy(text, done, fail);
      }
    }

    function legacyCopy(text, done, fail) {
      try {
        const ta = doc.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', 'readonly');
        ta.style.position = 'fixed';
        ta.style.top = '-1000px';
        doc.body.appendChild(ta);
        ta.select();
        const ok = doc.execCommand('copy');
        doc.body.removeChild(ta);
        if (!ok) throw new Error('execCommand 返回 false');
        done();
      } catch (err) { fail(err); }
    }

    function downloadCode() {
      try {
        const blob = new Blob([lastCode], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = doc.createElement('a');
        a.href = url;
        a.download = 'board_pin_init.c';
        doc.body.appendChild(a);
        a.click();
        doc.body.removeChild(a);
        window.setTimeout(() => URL.revokeObjectURL(url), 4000);
        onToast('已导出 board_pin_init.c', 'ok');
      } catch (err) { onToast('导出失败：' + (err && err.message ? err.message : err), 'err'); }
    }

    /* ---------- 对外接口 ---------- */
    return {
      mount() {
        el.assignMode.checked = false;
        el.colorMode.value = colorMode;
        el.hint.textContent = '点击引脚查看详情';
        bindEvents();
        renderAll();
      },
      setData(next, sourceNote) {
        const norm = normalizePinData(next);
        if (!norm) { onToast('引脚数据不合法（需要 48 条、pin 1..48 无重复），继续使用内置兜底表', 'warn'); return false; }
        norm.source = sourceNote || norm.source;
        data = norm;
        pinByNo = byNumber(data.pins);
        // 丢掉在新数据里不再成立的分配
        assignments = assignments.filter((a) => {
          const pin = pinByNo.get(a.pin);
          const role = roleById(a.roleId);
          const core = a.core || signalCore(a);
          return !!(pin && role && assignable(pin) &&
            pin.functions.some((f) => role.match(f) && f.peripheral === a.peripheral && f.core === core));
        });
        renderAll();
        onChange(assignments.slice(), 'data');
        return true;
      },
      setAssignments(next) {
        if (!Array.isArray(next)) return;
        assignments = next.filter((a) => a && Number.isInteger(Number(a.pin)) && a.pin >= 1 && a.pin <= 48)
          .map((a) => ({
            pin: Number(a.pin), roleId: String(a.roleId), peripheral: String(a.peripheral),
            signal: String(a.signal), core: a.core ? String(a.core) : signalCore(a),
            kind: String(a.kind), mode: String(a.mode || ''), remap: !!a.remap
          }));
        renderAll();
      },
      getAssignments() { return assignments.slice(); },
      getData() { return data; },
      selectPin(no) { select(Number(no), false); },
      refreshCode() { renderCode(); }
    };
  }

  return {
    FALLBACK,
    ROLES,
    GEOM,
    KIND_LABEL,
    TYPE_LABEL,
    layout,
    pinDrawing,
    fallbackData,
    normalizePinData,
    shortName,
    portLetter,
    portBit,
    signalCore,
    byNumber,
    assignable,
    availableRoles,
    roleById,
    channelKey,
    validate,
    generateCode,
    createPlanner
  };
})();
