/* main.c —— STM32F103C8T6 最小可跑例程（寄存器级，不依赖标准外设库）
 *
 * 硬件：STM32F103C8T6 最小系统板（LQFP48）
 *   LED ：板载 LED 一般接 PC13 且低电平点亮（若你的板子不同，改 BOARD_LED_* 三个宏）
 *   串口：USART1，PA9 = TX → USB 转串口的 RX，PA10 = RX ← USB 转串口的 TX，115200 8N1
 *
 * 时钟：默认走 HSI 8 MHz（不做 PLL 倍频），这是刻意的——
 *   不依赖外部晶振，插上就能跑，先把「编译→烧录→串口」这条链路打通。
 */

#include "stm32f10x.h"
#include "board.h"

/* ---------- 简单的忙等延时（毫秒级，粗算） ---------- */
static void delay_loop(volatile uint32_t n)
{
    while (n--) {
        __NOP();
    }
}

/* ---------- 串口 ---------- */
static void uart_init(uint32_t pclk2_hz, uint32_t baud)
{
    /* PA9 = USART1_TX 复用推挽输出，PA10 = USART1_RX 上拉输入 */
    RCC->APB2ENR |= RCC_APB2ENR_IOPAEN | RCC_APB2ENR_USART1EN;

    GPIOA->CRH &= ~(0xFFUL << 4);          /* 清 PA9/PA10 配置位 */
    GPIOA->CRH |= (0xBUL << 4);            /* PA9 : 复用推挽输出 50 MHz */
    GPIOA->CRH |= (0x4UL << 8);            /* PA10: 浮空输入 */

    USART1->BRR = (pclk2_hz + baud / 2U) / baud;   /* 就近取整，误差 < 1% */
    USART1->CR1 = USART_CR1_UE | USART_CR1_TE | USART_CR1_RE;  /* 使能 + 收发 */
}

static void uart_putc(char c)
{
    while ((USART1->SR & USART_SR_TXE) == 0U) {
        /* 等发送数据寄存器空 */
    }
    USART1->DR = (uint16_t)(uint8_t)c;
}

static void uart_puts(const char *s)
{
    while (*s != '\0') {
        uart_putc(*s++);
    }
}

static int uart_has_byte(void)
{
    return (USART1->SR & USART_SR_RXNE) != 0U;
}

static char uart_getc(void)
{
    return (char)(USART1->DR & 0xFFU);
}

/* ---------- LED ---------- */
static void led_init(void)
{
    RCC->APB2ENR |= BOARD_LED_CLK;

    if (BOARD_LED_PORT == GPIOC) {
        GPIOC->CRH &= ~(0xFUL << BOARD_LED_SHIFT);
        GPIOC->CRH |= (0x3UL << BOARD_LED_SHIFT);   /* 推挽输出 50 MHz */
        GPIOC->BSRR = BOARD_LED_PIN;                /* 先熄灭 */
    } else if (BOARD_LED_PORT == GPIOB) {
        GPIOB->CRL &= ~(0xFUL << BOARD_LED_SHIFT);
        GPIOB->CRL |= (0x3UL << BOARD_LED_SHIFT);
        GPIOB->BSRR = BOARD_LED_PIN;
    } else {
        GPIOA->CRL &= ~(0xFUL << BOARD_LED_SHIFT);
        GPIOA->CRL |= (0x3UL << BOARD_LED_SHIFT);
        GPIOA->BSRR = BOARD_LED_PIN;
    }
}

static void led_set(int on)
{
    /* 低电平点亮：置位 BSRR 高 16 位 = 输出低 */
    if (on) {
        BOARD_LED_PORT->BRR = BOARD_LED_PIN;
    } else {
        BOARD_LED_PORT->BSRR = BOARD_LED_PIN;
    }
}

/* ---------- 主程序 ---------- */
int main(void)
{
    volatile uint32_t i;
    uint32_t ticks = 0U;

    led_init();
    uart_init(8000000U, 115200U);           /* HSI 8 MHz 直接做 PCLK2 */

    uart_puts("\r\n");
    uart_puts("[stm32f103c8t6] boot ok, HSI 8MHz, uart1 @115200 8N1\r\n");
    uart_puts("[stm32f103c8t6] type anything, it echoes back\r\n");

    for (;;) {
        led_set(1);
        for (i = 0; i < 400000U; i++) {
            delay_loop(1U);
        }
        led_set(0);
        for (i = 0; i < 400000U; i++) {
            delay_loop(1U);
        }

        ticks++;
        if ((ticks % 2U) == 0U) {
            uart_puts("[stm32f103c8t6] alive, led toggling\r\n");
        }

        if (uart_has_byte()) {
            char c = uart_getc();
            uart_putc(c);                   /* 回显 */
            if (c == '\r') {
                uart_puts("\r\n");
            }
        }
    }
}
