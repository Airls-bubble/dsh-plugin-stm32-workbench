<#
  serial-bridge.ps1 —— 串口桥：把 COM 口的收发改成标准输入输出的行协议
  为什么不用 node-serialport：本机 node 全局没有安装任何包，而这个桥用系统自带的
  .NET SerialPort 就行，零依赖。

  行协议（stdout，UTF-8）：
    READY|<port>|<baud>      端口已打开
    DATA|<base64>            收到数据的原始字节（base64，避免二进制与换行互相破坏）
    ERROR|<message>          出错
    CLOSED|<message>         端口已关闭
  stdin 命令：
    SEND <base64>            向串口写字节
    CLOSE                    关闭并退出
    PING                     探活
#>
param(
    [Parameter(Mandatory = $true)][string]$Port,
    [int]$Baud = 115200,
    [int]$DataBits = 8,
    [string]$Parity = 'None',
    [string]$StopBits = 'One',
    [switch]$DtrEnable,
    [switch]$RtsEnable
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)

function Emit([string]$line) {
    [Console]::Out.Write($line + "`n")
    [Console]::Out.Flush()
}

$sp = $null
try {
    $sp = New-Object System.IO.Ports.SerialPort $Port, $Baud, ([System.IO.Ports.Parity]::$Parity), $DataBits, ([System.IO.Ports.StopBits]::$StopBits)
    $sp.DtrEnable = [bool]$DtrEnable
    $sp.RtsEnable = [bool]$RtsEnable
    $sp.ReadTimeout = 100
    $sp.WriteTimeout = 1000
    $sp.Open()
} catch {
    Emit "ERROR|打开 $Port 失败：$($_.Exception.Message)"
    exit 2
}

Emit "READY|$Port|$Baud"

$buf = New-Object byte[] 4096
$running = $true
$reader = [Console]::In

while ($running) {
    # --- 读串口 ---
    try {
        if ($sp.IsOpen -and $sp.BytesToRead -gt 0) {
            $n = $sp.Read($buf, 0, [Math]::Min($buf.Length, $sp.BytesToRead))
            if ($n -gt 0) {
                $b64 = [Convert]::ToBase64String($buf, 0, $n)
                Emit "DATA|$b64"
            }
        }
    } catch {
        Emit "ERROR|读取失败：$($_.Exception.Message)"
        $running = $false
        break
    }

    # --- 读 stdin（不阻塞：有输入才处理） ---
    try {
        if ($reader.Peek() -ge 0) {
            $line = $reader.ReadLine()
            if ($null -eq $line) { $running = $false; break }
            $line = $line.Trim()
            if ($line -eq 'CLOSE') {
                $running = $false
            } elseif ($line -eq 'PING') {
                Emit "PONG|"
            } elseif ($line.StartsWith('SEND ')) {
                try {
                    $bytes = [Convert]::FromBase64String($line.Substring(5).Trim())
                    $sp.Write($bytes, 0, $bytes.Length)
                } catch {
                    Emit "ERROR|写入失败：$($_.Exception.Message)"
                }
            }
        }
    } catch {
        # Peek 在管道关闭时会抛异常，视为断开
        $running = $false
    }

    Start-Sleep -Milliseconds 8
}

try { if ($sp -and $sp.IsOpen) { $sp.Close() } } catch { }
Emit "CLOSED|正常关闭"
exit 0
