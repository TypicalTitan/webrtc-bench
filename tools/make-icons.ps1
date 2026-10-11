# Renders the app icon / TV banner PNGs (and the Windows .ico) used by both apps.
# Usage: pwsh tools/make-icons.ps1
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$root = Split-Path $PSScriptRoot -Parent

function New-Canvas([int]$w, [int]$h) {
    $bmp = New-Object System.Drawing.Bitmap $w, $h
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'
    $g.TextRenderingHint = 'AntiAliasGridFit'
    $g.InterpolationMode = 'HighQualityBicubic'
    return @($bmp, $g)
}

function Draw-Mark($g, [float]$cx, [float]$cy, [float]$r) {
    # Concentric "signal" arcs around a play triangle.
    $teal = [System.Drawing.Color]::FromArgb(255, 79, 209, 197)
    foreach ($i in 0..2) {
        $rr = $r * (0.55 + 0.22 * $i)
        $alpha = 255 - 70 * $i
        $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb($alpha, 79, 209, 197)), ($r * 0.075)
        $pen.StartCap = 'Round'; $pen.EndCap = 'Round'
        $g.DrawArc($pen, $cx - $rr, $cy - $rr, 2 * $rr, 2 * $rr, -50, 100)
        $g.DrawArc($pen, $cx - $rr, $cy - $rr, 2 * $rr, 2 * $rr, 130, 100)
        $pen.Dispose()
    }
    $t = $r * 0.32
    $pts = [System.Drawing.PointF[]]@(
        (New-Object System.Drawing.PointF ($cx - $t * 0.75), ($cy - $t)),
        (New-Object System.Drawing.PointF ($cx - $t * 0.75), ($cy + $t)),
        (New-Object System.Drawing.PointF ($cx + $t * 1.0), $cy))
    $b = New-Object System.Drawing.SolidBrush $teal
    $g.FillPolygon($b, $pts)
    $b.Dispose()
}

function Fill-Background($g, [int]$w, [int]$h, [float]$radius) {
    $rect = New-Object System.Drawing.RectangleF 0, 0, $w, $h
    $grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush $rect,
        ([System.Drawing.Color]::FromArgb(255, 11, 15, 20)),
        ([System.Drawing.Color]::FromArgb(255, 18, 50, 74)), 35
    if ($radius -gt 0) {
        $p = New-Object System.Drawing.Drawing2D.GraphicsPath
        $d = $radius * 2
        $p.AddArc(0, 0, $d, $d, 180, 90); $p.AddArc($w - $d, 0, $d, $d, 270, 90)
        $p.AddArc($w - $d, $h - $d, $d, $d, 0, 90); $p.AddArc(0, $h - $d, $d, $d, 90, 90)
        $p.CloseFigure()
        $g.FillPath($grad, $p)
    } else {
        $g.FillRectangle($grad, $rect)
    }
    $grad.Dispose()
}

function Save-Png($bmp, [string]$path) {
    New-Item -ItemType Directory -Force (Split-Path $path) | Out-Null
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
}

# Square icon (used for Android launcher fallback, Electron window and Windows .ico)
function Make-Icon([int]$size) {
    $bmp, $g = New-Canvas $size $size
    $g.Clear([System.Drawing.Color]::Transparent)
    Fill-Background $g $size $size ($size * 0.22)
    Draw-Mark $g ($size / 2) ($size / 2) ($size * 0.42)
    $g.Dispose()
    return $bmp
}

$icon192 = Make-Icon 192
Save-Png $icon192 "$root\android\app\src\main\res\drawable-xxxhdpi\icon.png"
$icon256 = Make-Icon 256
Save-Png $icon256 "$root\desktop\assets\icon.png"

# Windows .ico with a single PNG-compressed 256x256 entry.
$ms = New-Object System.IO.MemoryStream
$icon256.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
$png = $ms.ToArray()
$ico = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter $ico
$bw.Write([UInt16]0); $bw.Write([UInt16]1); $bw.Write([UInt16]1)
$bw.Write([byte]0); $bw.Write([byte]0); $bw.Write([byte]0); $bw.Write([byte]0)
$bw.Write([UInt16]1); $bw.Write([UInt16]32); $bw.Write([UInt32]$png.Length); $bw.Write([UInt32]22)
$bw.Write($png); $bw.Flush()
[System.IO.File]::WriteAllBytes("$root\desktop\assets\icon.ico", $ico.ToArray())

# TV banner: 320x180 dp at xhdpi = 640x360 px.
$bmp, $g = New-Canvas 640 360
Fill-Background $g 640 360 0
Draw-Mark $g 150 180 110
$white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 232, 238, 245))
$teal = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 79, 209, 197))
$f1 = New-Object System.Drawing.Font 'Segoe UI', 46, ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
$f2 = New-Object System.Drawing.Font 'Segoe UI', 28, ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)
$g.DrawString('WebRTC', $f1, $white, 285, 112)
$g.DrawString('Bench', $f1, $white, 285, 166)
$g.DrawString('stream receiver', $f2, $teal, 288, 230)
$g.Dispose()
Save-Png $bmp "$root\android\app\src\main\res\drawable-xhdpi\banner.png"
"icons written"
