/* stm32f103c8.ld —— STM32F103C8T6 链接脚本（armlink 语法）
 * Flash 64 KB @ 0x08000000 ，SRAM 20 KB @ 0x20000000
 *
 * 栈与堆不在此处指定：ST 官方 startup_stm32f10x_md.s 里已有 STACK/HEAP 段
 * （Stack_Size 0x400 / Heap_Size 0x800，可自行修改），由 .ANY(+RW +ZI) 收进 SRAM。
 *
 * 注意：F103C8 标称 64 KB Flash；部分批次实际可用 128 KB，这里按标称布局，
 * 超出由 armlink 直接报错，不会悄悄烧穿。
 */
LR_IROM1 0x08000000 0x00010000  {    ; 64 KB Flash
  ER_IROM1 0x08000000 0x00010000  {  ; 中断向量表 + 代码 + 只读数据
    *.o (RESET, +First)
    *(InRoot$$Sections)
    .ANY (+RO)
  }
  RW_IRAM1 0x20000000 0x00005000  {  ; 20 KB SRAM：.data / .bss / 栈 / 堆
    .ANY (+RW +ZI)
  }
}
