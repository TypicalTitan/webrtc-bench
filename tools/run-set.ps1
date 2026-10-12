# Runs the comparison set against one TV, one configuration after another, and saves each report
# as reports\WebRTCBench_<Name>_<config>.json/.xlsx (the names tools\compare-report.js reads).
# Safe to run for two TVs at once: reports are matched by the TV's file tag.
#
#   powershell -File tools\run-set.ps1 -Device 192.168.50.32 -TvFileTag Shed -Name Shed [-Only WebRTC-gaming_live]
#
# -TvFileTag: the TV's name as it appears in report file names (non-alphanumerics become "_").
param(
    [Parameter(Mandatory)][string]$Device,
    [Parameter(Mandatory)][string]$TvFileTag,
    [Parameter(Mandatory)][string]$Name,
    [string]$Only = ''
)
$root = Split-Path -Parent $PSScriptRoot
$common = @('--codecs=H264,H265', '--res=720,1080,1440,2160', '--fps=60', '--warmup=5', '--measure=8')
$configs = [ordered]@{
    'Native_live'              = @('--transport=native')
    'Native_preencoded'        = @('--transport=native', '--preencoded=1')
    'WebRTC-gaming_live'       = @('--transport=webrtc', '--latency-profile=gaming')
    'WebRTC-gaming_preencoded' = @('--transport=webrtc', '--latency-profile=gaming', '--preencoded=1')
    'WebRTC-standard_live'     = @('--transport=webrtc', '--latency-profile=standard')
}
$logs = Join-Path $root 'reports\logs'
New-Item -ItemType Directory -Force $logs | Out-Null
Push-Location $root
try {
    foreach ($config in $configs.Keys) {
        if ($Only -and $config -ne $Only) { continue }
        $started = Get-Date
        & .\desktop\node_modules\.bin\electron.cmd desktop --auto --allow-multiple "--device=$Device" @common @($configs[$config]) --quit 2>&1 |
            Out-File (Join-Path $logs "$Name-$config.log")
        $new = Get-ChildItem reports -Filter "WebRTCBench_${TvFileTag}_20*.json" | Where-Object { $_.LastWriteTime -gt $started } |
            Sort-Object LastWriteTime | Select-Object -Last 1
        if (-not $new) { Write-Output "${config}: no report (see reports\logs\$Name-$config.log)"; continue }
        foreach ($ext in 'json', 'xlsx') {
            Move-Item -LiteralPath ($new.FullName -replace '\.json$', ".$ext") -Destination "reports\WebRTCBench_${Name}_$config.$ext" -Force
        }
        Write-Output "${config}: saved"
    }
} finally {
    Pop-Location
}
