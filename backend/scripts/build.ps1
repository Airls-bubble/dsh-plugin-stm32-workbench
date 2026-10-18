<#
  build.ps1 —— 命令行构建（不依赖后端，给 agent 与批处理用）

  用法（在项目根目录执行）：
    powershell -ExecutionPolicy Bypass -File scripts\build.ps1 -Project blink-uart
    powershell -ExecutionPolicy Bypass -File scripts\build.ps1 -Project myproj -KeilRoot "D:\Keil_v5"

  为什么全用相对路径：项目所在目录含中文时，armcc 的 ANSI 命令行会把绝对路径
  拆坏（这是实测踩过的坑），所以一律先 cd 到工程目录再用相对路径调用工具。
#>
param(
    [Parameter(Mandatory = $true)][string]$Project,
    [string]$KeilRoot = '',
    [switch]$Quiet
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$bin = ''

function Find-KeilBin {
    param([string]$Hint)
    $cands = @()
    if ($Hint) { $cands += $Hint }
    if ($env:KEIL_ROOT) { $cands += $env:KEIL_ROOT }
    $cands += 'C:\Keil_v5', 'C:\Keil', 'D:\Keil_v5'
    foreach ($c in $cands) {
        $p = Join-Path $c 'ARM\ARMCC\bin'
        if (Test-Path (Join-Path $p 'armcc.exe')) { return $p }
    }
    foreach ($reg in 'HKLM:\SOFTWARE\WOW6432Node\Keil\Products\MDK', 'HKLM:\SOFTWARE\Keil\Products\MDK') {
        $v = (Get-ItemProperty $reg -ErrorAction SilentlyContinue).Path
        if ($v) {
            $p = Join-Path $v 'ARM\ARMCC\bin'
            if (Test-Path (Join-Path $p 'armcc.exe')) { return $p }
        }
    }
    return ''
}

if ($Project -notmatch '^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$') {
    throw "工程名不合法（只允许字母数字下划线短横线点）：$Project"
}

$bin = Find-KeilBin -Hint $KeilRoot
if (-not $bin) { throw '没有找到 Keil MDK 的 armcc。请安装 Keil MDK，或用 -KeilRoot 指定路径。' }

$projDir = Join-Path $root "firmware\projects\$Project"
if (-not (Test-Path $projDir)) { throw "工程不存在：$projDir" }

# 输出落到**全局工作数据目录**，不写进插件本体 —— 插件目录只装代码，整包拷走就是干净的一份
$dshHome  = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$outDir   = Join-Path $dshHome "mcu\build\$Project"
if (Test-Path $outDir) { Remove-Item $outDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

# 源文件与 -I 用**相对工程目录**的路径（armcc 是按 ANSI 解析命令行的，含中文的绝对路径会被拆坏）；
# 输出则可以用绝对路径 —— armcc 只对含中文的路径敏感，纯 ASCII 的绝对路径没问题
# （server/keil-build.js 也是这么做的）。
$relOut     = $outDir
$relBsp     = '..\..\bsp'
$relStartup = "$relBsp\startup\startup_stm32f10x_md.s"
$relScatter = "$relBsp\startup\stm32f103c8.ld"
$relSystem  = "$relBsp\cmsis\DeviceSupport\system_stm32f10x.c"

$cflags = @('--c99', '--cpu', 'Cortex-M3', '-g', '-O1', '--apcs=interwork', '-DSTM32F10X_MD',
    "-I$relBsp\cmsis\CoreSupport", "-I$relBsp\cmsis\DeviceSupport")

Push-Location $projDir
try {
    $objs = @()
    # 只取本目录的 .c（不递归，避免把 build 产物卷进来）
    $sources = Get-ChildItem -File -Filter *.c | Select-Object -ExpandProperty Name
    if (-not $sources) { throw "工程里没有 .c 源文件：$projDir" }

    foreach ($src in $sources) {
        $obj = "$relOut\" + [System.IO.Path]::GetFileNameWithoutExtension($src) + '.o'
        if (-not $Quiet) { Write-Host "  armcc   $src" }
        & "$bin\armcc.exe" @cflags -c $src -o $obj
        if ($LASTEXITCODE -ne 0) { throw "编译失败：$src" }
        $objs += $obj
    }

    if (-not $Quiet) { Write-Host '  armcc   system_stm32f10x.c' }
    & "$bin\armcc.exe" @cflags -c $relSystem -o "$relOut\system_stm32f10x.o"
    if ($LASTEXITCODE -ne 0) { throw '编译失败：system_stm32f10x.c' }
    $objs += "$relOut\system_stm32f10x.o"

    if (-not $Quiet) { Write-Host '  armasm  startup_stm32f10x_md.s' }
    & "$bin\armasm.exe" --cpu Cortex-M3 --apcs=interwork $relStartup -o "$relOut\startup.o"
    if ($LASTEXITCODE -ne 0) { throw '汇编失败：启动文件' }
    $objs += "$relOut\startup.o"

    if (-not $Quiet) { Write-Host '  armlink' }
    $axf = "$relOut\$Project.axf"
    & "$bin\armlink.exe" --cpu Cortex-M3 --strict --info summarysizes --scatter $relScatter `
        --entry Reset_Handler @objs -o $axf
    if ($LASTEXITCODE -ne 0) { throw '链接失败（常见原因：超出 64KB Flash / 20KB SRAM）' }

    if (-not $Quiet) { Write-Host '  fromelf hex + bin' }
    & "$bin\fromelf.exe" --i32combined --output "$relOut\$Project.hex" $axf
    & "$bin\fromelf.exe" --bin --output "$relOut\$Project.bin" $axf
}
finally {
    Pop-Location
}

Write-Host ''
Write-Host "  构建成功：$outDir"
Get-ChildItem -Path $outDir -Include *.axf, *.hex, *.bin -File -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
    '    {0,-22} {1,8:N0} B' -f $_.Name, $_.Length
}
