/* board.h —— 板级配置：换板子只改这里
 * 默认按最常见的 STM32F103C8T6 最小系统板（蓝色小板 / 黑色小板）：
 *   板载 LED 在 PC13，低电平点亮。
 */
#ifndef BOARD_H
#define BOARD_H

#include "stm32f10x.h"

/* 系统主频：本模板走 HSI 8 MHz，不做 PLL 倍频 */
#define BOARD_SYSCLK_HZ     8000000UL
#define BOARD_PCLK2_HZ      8000000UL    /* USART1 挂 APB2 */

/* LED 引脚：改这里即可换板
 * 本模板是寄存器级（不依赖标准外设库），所以引脚用裸掩码，不用 GPIO_Pin_13 那种库宏。
 * 想把 LED 换到 PA0：BOARD_LED_PORT=GPIOA, BOARD_LED_PIN=0x0001, SHIFT=0（PA0 在 CRL）
 * 想把 LED 换到 PB12：BOARD_LED_PORT=GPIOB, BOARD_LED_PIN=0x1000, SHIFT=16（PB12 在 CRH）
 */
#define BOARD_LED_PORT      GPIOC
#define BOARD_LED_PIN       0x2000U      /* PC13 = bit 13 */
#define BOARD_LED_CLK       RCC_APB2ENR_IOPCEN
#define BOARD_LED_SHIFT     20U          /* PC13 在 CRH 中的位偏移 (13-8)*4 */

/* 串口：USART1 PA9/PA10，默认 115200 8N1 */
#define BOARD_UART_BAUD     115200U

#endif /* BOARD_H */
