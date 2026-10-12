# Waits for Android's screen-capture consent dialog (WebRTC Bench's screen probe asks once per run)
# on one TV and presses its Start button over adb, for unattended screen-probe runs.
#
#   powershell -File tools\accept-screen-capture.ps1 -Serial 192.168.50.32:44625
param([Parameter(Mandatory)][string]$Serial, [int]$TimeoutSec = 90)
$deadline = (Get-Date).AddSeconds($TimeoutSec)
while ((Get-Date) -lt $deadline) {
    $top = adb -s $Serial shell 'dumpsys activity activities | grep -m1 -E "topResumedActivity|mResumedActivity"' 2>$null
    if ($top -match 'MediaProjectionPermissionActivity|MediaProjection') {
        adb -s $Serial shell uiautomator dump /sdcard/wb-ui.xml 2>$null | Out-Null
        $xml = adb -s $Serial shell cat /sdcard/wb-ui.xml 2>$null
        adb -s $Serial shell rm /sdcard/wb-ui.xml 2>$null | Out-Null
        $m = [regex]::Matches(($xml -join ''), 'text="([^"]*)"[^>]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"')
        $btn = $m | Where-Object { $_.Groups[1].Value -match '^(Start now|Start|Allow|OK)$' } | Select-Object -First 1
        if ($btn) {
            $x = ([int]$btn.Groups[2].Value + [int]$btn.Groups[4].Value) / 2
            $y = ([int]$btn.Groups[3].Value + [int]$btn.Groups[5].Value) / 2
            adb -s $Serial shell input tap $x $y
            Write-Output "pressed '$($btn.Groups[1].Value)' at $x,$y on $Serial"
            exit 0
        }
        Write-Output "dialog up, buttons: $(($m | ForEach-Object { $_.Groups[1].Value } | Where-Object { $_ }) -join ' | ')"
    }
    Start-Sleep -Milliseconds 700
}
Write-Output "no consent dialog seen on $Serial"
exit 1
