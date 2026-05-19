param(
  [Parameter(Mandatory = $true)][string]$InputDir,
  [Parameter(Mandatory = $true)][string]$OutputDir,
  [switch]$Force
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$inputRoot = (Resolve-Path -LiteralPath $InputDir).Path
if (-not (Test-Path -LiteralPath $OutputDir)) {
  New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
}
$outputRoot = (Resolve-Path -LiteralPath $OutputDir).Path

$exts = @(".jpg", ".jpeg", ".png", ".webp", ".bmp", ".heic", ".heif")
$files = Get-ChildItem -LiteralPath $inputRoot -Recurse -File | Where-Object {
  $exts -contains $_.Extension.ToLowerInvariant()
}

function Rotate-ByExifOrientation {
  param([System.Drawing.Bitmap]$Bitmap)
  try {
    $prop = $Bitmap.GetPropertyItem(0x0112)
    if ($null -eq $prop -or $prop.Value.Length -lt 2) { return }
    $orientation = [BitConverter]::ToUInt16($prop.Value, 0)
    switch ($orientation) {
      3 { $Bitmap.RotateFlip([System.Drawing.RotateFlipType]::Rotate180FlipNone) }
      6 { $Bitmap.RotateFlip([System.Drawing.RotateFlipType]::Rotate90FlipNone) }
      8 { $Bitmap.RotateFlip([System.Drawing.RotateFlipType]::Rotate270FlipNone) }
      default { }
    }
  } catch {
    # ignore missing EXIF
  }
}

function Get-Encoder {
  param([string]$MimeType)
  return [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object {
    $_.MimeType -eq $MimeType
  } | Select-Object -First 1
}

$jpegEncoder = Get-Encoder -MimeType "image/jpeg"
$qualityEncoder = [System.Drawing.Imaging.Encoder]::Quality

$processed = 0
$skipped = 0

foreach ($file in $files) {
  $relative = $file.FullName.Substring($inputRoot.Length).TrimStart('\')
  $targetRelative = [System.IO.Path]::ChangeExtension($relative, ".jpg")
  $target = Join-Path $outputRoot $targetRelative
  $targetDir = Split-Path -Parent $target
  if (-not (Test-Path -LiteralPath $targetDir)) {
    New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
  }

  if ((-not $Force) -and (Test-Path -LiteralPath $target)) {
    $skipped++
    continue
  }

  $src = [System.Drawing.Bitmap]::FromFile($file.FullName)
  try {
    Rotate-ByExifOrientation -Bitmap $src

    $maxW = 2200
    $maxH = 2200
    $scale = [Math]::Min($maxW / [double]$src.Width, $maxH / [double]$src.Height)
    if ($scale -gt 1.0) { $scale = 1.0 }
    $newW = [Math]::Max(1, [int]([Math]::Round($src.Width * $scale)))
    $newH = [Math]::Max(1, [int]([Math]::Round($src.Height * $scale)))

    $outBmp = New-Object System.Drawing.Bitmap($newW, $newH)
    try {
      $g = [System.Drawing.Graphics]::FromImage($outBmp)
      try {
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

        $imgAttr = New-Object System.Drawing.Imaging.ImageAttributes
        try {
          # grayscale + slight contrast boost
          $contrast = 1.30
          $translate = (1.0 - $contrast) / 2.0
          $matrix = New-Object System.Drawing.Imaging.ColorMatrix
          $matrix.Matrix00 = [single](0.299 * $contrast)
          $matrix.Matrix01 = [single](0.299 * $contrast)
          $matrix.Matrix02 = [single](0.299 * $contrast)
          $matrix.Matrix10 = [single](0.587 * $contrast)
          $matrix.Matrix11 = [single](0.587 * $contrast)
          $matrix.Matrix12 = [single](0.587 * $contrast)
          $matrix.Matrix20 = [single](0.114 * $contrast)
          $matrix.Matrix21 = [single](0.114 * $contrast)
          $matrix.Matrix22 = [single](0.114 * $contrast)
          $matrix.Matrix33 = [single]1.0
          $matrix.Matrix44 = [single]1.0
          $matrix.Matrix40 = [single]$translate
          $matrix.Matrix41 = [single]$translate
          $matrix.Matrix42 = [single]$translate
          $imgAttr.SetColorMatrix($matrix)
          $imgAttr.SetGamma(0.95)

          $rect = New-Object System.Drawing.Rectangle(0, 0, $newW, $newH)
          $g.DrawImage(
            $src,
            $rect,
            0,
            0,
            $src.Width,
            $src.Height,
            [System.Drawing.GraphicsUnit]::Pixel,
            $imgAttr
          )
        } finally {
          $imgAttr.Dispose()
        }
      } finally {
        $g.Dispose()
      }

      $encoderParams = New-Object System.Drawing.Imaging.EncoderParameters(1)
      $encoderParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter($qualityEncoder, 92L)
      try {
        $outBmp.Save($target, $jpegEncoder, $encoderParams)
      } finally {
        $encoderParams.Dispose()
      }
    } finally {
      $outBmp.Dispose()
    }
  } finally {
    $src.Dispose()
  }
  $processed++
}

Write-Output "preprocess processed=$processed skipped=$skipped output=$outputRoot"
