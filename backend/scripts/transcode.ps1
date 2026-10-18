param(
    [Parameter(Mandatory=$true)][string]$Source,
    [Parameter(Mandatory=$true)][string]$Target,
    [Parameter(Mandatory=$true)][string]$Encoding
)
# 把 UTF-8 源文件按指定编码写到目标文件（Node 没有内置 GBK 编码器，借 .NET 完成）
$ErrorActionPreference = 'Stop'
try {
    $enc = [System.Text.Encoding]::GetEncoding($Encoding)
    $text = [System.IO.File]::ReadAllText($Source, [System.Text.Encoding]::UTF8)
    [System.IO.File]::WriteAllText($Target, $text, $enc)
    Write-Output ("OK " + (Get-Item -LiteralPath $Target).Length + " bytes as " + $Encoding)
} catch {
    Write-Error ("转码失败: " + $_.Exception.Message)
    exit 1
}
