<#
  flash.ps1 —— 命令行烧录（OpenOCD + ST-Link/SWD）

  用法：
    powershell -ExecutionPolicy Bypass -File scripts\flash.ps1 -Project blink-uart
    powershell -ExecutionPolicy Bypass -File scripts\flash.ps1 -Probe          # 只探测板子
    powershell -ExecutionPolicy Bypass -File scripts\flash.ps1 -Reset          # 只复位

  真实行为：没有插板子/接线不对时它会明确报错 —— 这是正确行为，不是脚本坏了。
#>
param(
    [string]$Project = '',
    [switch]$Probe,
    [switch]$Reset,
    [switch]$NoVerify
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

function Find-OpenOCD {
    $dir = Join-Path $root 'tools\openocd'
    if (Test-Path $dir) {
        $exe = Get-ChildItem $dir -Recurse -Filter 'openocd.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($exe) {
            $scripts = Join-Path (Split-Path $exe.FullName -Parent) '..\openocd\scripts'
            $scripts = [System.IO.Path]::GetFullPath($scripts)
            if (Test-Path $scripts) { return @{ exe = $exe.FullName; scripts = $scripts } }
        }
    }
    $cmd = Get-Command openocd -ErrorAction SilentlyContinue
    if ($cmd) { return @{ exe = $cmd.Source; scripts = '' } }
    throw '没有找到 OpenOCD。请先运行 scripts\fetch-toolchain.ps1'
}

$ocd = Find-OpenOCD
$baseArgs = @()
if ($ocd.scripts) { $baseArgs += @('-s', $ocd.scripts) }
$baseArgs += @('-f', 'interface/stlink.cfg', '-f', 'target/stm32f1x.cfg')

function Invoke-OCD {
    param([string[]]$Cmds, [string]$Label)
    Write-Host "  $Label"
    $args = $baseArgs + @('-c', 'adapter speed 1000', '-c', 'transport select swd')
    foreach ($c in $Cmds) { $args += @('-c', $c) }
    Push-Location $root
    $prev = $ErrorActionPreference
    # OpenOCD 会把进度写到 stderr，PowerShell 会当成错误记录 —— 这里要让它正常流过
    $ErrorActionPreference = 'Continue'
    try {
        # 日志必须走 Write-Host（写宿主，不进「成功输出流」）。
        # 以前这里用管道输出 `| ForEach-Object { "    $_" }`，日志会变成函数的返回值的一部分，
        # 调用处 `$code = Invoke-OCD ...` 拿到的是「日志数组 + 退出码」；
        # 而 PowerShell 把单元素数组按元素转布尔 —— [bool]@(0) 是 False，
        # 于是 -Probe 恒报「未连接」，同时日志被整个吞掉。实测确认。
        & $ocd.exe @args 2>&1 | ForEach-Object { Write-Host "    $_" }
        return $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $prev
        Pop-Location
    }
}

if ($Probe) {
    Write-Host ''
    Write-Host '  探测 ST-Link / 目标芯片'
    # [int] 是保险：万一以后又有别的输出混进函数的返回值，这里会直接报错，
    # 而不是让「数组当布尔」悄悄得出一个相反的结论。
    $code = [int](Invoke-OCD -Cmds @('init', 'targets', 'flash probe 0', 'exit') -Label 'openocd probe')
    Write-Host ''
    if ($code -eq 0) { Write-Host '  结果：探测成功' }
    else { Write-Host "  结果：未连接或出错（openocd 退出码 $code；检查 USB、SWD 四线、板子供电）" }
    exit $code
}

if ($Reset) {
    $code = [int](Invoke-OCD -Cmds @('init', 'reset run', 'exit') -Label 'openocd reset')
    if ($code -eq 0) { Write-Host '  结果：已复位' } else { Write-Host "  结果：复位失败（openocd 退出码 $code）" }
    exit $code
}

if (-not $Project) { throw '请指定 -Project，或使用 -Probe / -Reset' }
if ($Project -notmatch '^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$') { throw "工程名不合法：$Project" }

# 产物落在**全局工作数据目录**（插件目录只装代码，规则见 server\paths.js）。
# 上一轮重构把产物从 firmware\build\ 搬走了，这里必须跟着改，否则永远找不到 hex。
$dshHome   = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$buildRoot = Join-Path $dshHome 'mcu\build'
$hex = Join-Path $buildRoot "$Project\$Project.hex"
if (-not (Test-Path $hex)) {
    throw "没有可烧录的产物：$hex`n  先构建：scripts\build.ps1 -Project $Project`n  用户自己的 Keil 工程请改用 mcu 工具的 flash action（它烧的是上次构建的产物）"
}

$hexArg = $hex -replace '\\', '/'
$program = if ($NoVerify) { "program `"$hexArg`" reset exit" } else { "program `"$hexArg`" verify reset exit" }

Write-Host ''
Write-Host "  烧录 $Project → STM32F103C8T6"
$code = [int](Invoke-OCD -Cmds @('init', $program) -Label 'openocd program')
Write-Host ''
if ($code -eq 0) { Write-Host '  结果：烧录完成并复位' }
else { Write-Host "  结果：烧录失败（openocd 退出码 $code，见上方 OpenOCD 输出）" }
exit $code
