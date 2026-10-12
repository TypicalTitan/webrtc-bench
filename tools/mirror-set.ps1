# PC screen -> TV screen over WebRTC mirroring (standard and cloud-gaming profiles), timed by the
# TV's screen probe. Saves reports\WebRTCBench_<Name>_Mirror_WebRTC-<profile>.json/.xlsx.
# One TV at a time: the runs share the full-screen pattern window on the PC.
#
#   powershell -File tools\mirror-set.ps1 -Device 192.168.50.32 -Serial 192.168.50.32:44625 -TvFileTag Shed -Name Shed
#
# -Serial: the TV's adb serial, used to open the TV app and accept Android's screen-capture prompt.
param(
    [Parameter(Mandatory)][string]$Device,
    [Parameter(Mandatory)][string]$Serial,
    [Parameter(Mandatory)][string]$TvFileTag,
    [Parameter(Mandatory)][string]$Name,
    [string[]]$Profiles = @('standard', 'gaming')
)
$root = Split-Path -Parent $PSScriptRoot
$common = @('--transport=webrtc', '--video=display', '--screen-probe=1', '--codecs=H264', '--res=1080', '--fps=60', '--warmup=6', '--measure=15')
$logs = Join-Path $root 'reports\logs'
New-Item -ItemType Directory -Force $logs | Out-Null
Push-Location $root
try {
    foreach ($prof in $Profiles) {
        $config = "Mirror_WebRTC-$prof"
        adb -s $Serial shell am start -n dev.webrtcbench.tv/.MainActivity 2>&1 | Out-Null
        $started = Get-Date
        $log = Join-Path $logs "$Name-$config.log"
        $cmd = "Set-Location '$root'; & .\desktop\node_modules\.bin\electron.cmd desktop --auto --allow-multiple --device=$Device $($common -join ' ') --latency-profile=$prof --quit 2>&1 | Out-File '$log'"
        $p = Start-Process powershell -ArgumentList '-NoProfile', '-Command', $cmd -WindowStyle Hidden -PassThru
        & (Join-Path $PSScriptRoot 'accept-screen-capture.ps1') -Serial $Serial | Out-Null
        $p.WaitForExit(300000) | Out-Null
        $new = Get-ChildItem reports -Filter "WebRTCBench_${TvFileTag}_20*.json" | Where-Object { $_.LastWriteTime -gt $started } |
            Sort-Object LastWriteTime | Select-Object -Last 1
        if (-not $new) { Write-Output "${config}: no report (see $log)"; continue }
        foreach ($ext in 'json', 'xlsx') {
            Move-Item -LiteralPath ($new.FullName -replace '\.json$', ".$ext") -Destination "reports\WebRTCBench_${Name}_$config.$ext" -Force
        }
        Write-Output "${config}: saved"
    }
} finally {
    Pop-Location
}
