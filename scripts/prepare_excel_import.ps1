param(
    [Parameter(Mandatory = $true)]
    [string]$Source,
    [string]$Manifest = "$PSScriptRoot\..\data\import\furniture-catalog.json",
    [string]$ImageDirectory = "$PSScriptRoot\..\frontend\public\media\furniture\imported"
)

$ErrorActionPreference = 'Stop'
$sourcePath = (Resolve-Path -LiteralPath $Source).Path
$manifestPath = [System.IO.Path]::GetFullPath($Manifest)
$imagePath = [System.IO.Path]::GetFullPath($ImageDirectory)
$manifestDirectory = Split-Path -Parent $manifestPath
$stagingImagePath = "$imagePath.staging"
$stagingManifestPath = "$manifestPath.tmp"
New-Item -ItemType Directory -Force -Path $manifestDirectory, (Split-Path -Parent $imagePath) | Out-Null
Remove-Item -LiteralPath $stagingImagePath -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $stagingImagePath | Out-Null
Add-Type -AssemblyName System.Windows.Forms

$excel = $null
$workbook = $null
$powerPoint = $null
$presentation = $null

try {
    $excel = New-Object -ComObject Excel.Application
    $excel.Visible = $true
    $excel.DisplayAlerts = $false
    $workbook = $excel.Workbooks.Open($sourcePath, 0, $true)
    $sheet = $workbook.Worksheets.Item('BJW')
    $sheet.Activate()

    $powerPoint = New-Object -ComObject PowerPoint.Application
    $presentation = $powerPoint.Presentations.Add()
    $slide = $presentation.Slides.Add(1, 12)

    $headers = @{}
    for ($column = 1; $column -le $sheet.UsedRange.Columns.Count; $column++) {
        $header = [string]$sheet.Cells.Item(2, $column).Text
        $header = $header.Trim()
        if ($header) { $headers[$header] = $column }
    }
    foreach ($required in @('家具类别（中/英）', '数量')) {
        if (-not $headers.ContainsKey($required)) {
            throw "BJW row 2 is missing required column: $required"
        }
    }

    $shapesByRow = @{}
    foreach ($shape in $sheet.Shapes) {
        $shapesByRow[[int]$shape.TopLeftCell.Row] = $shape
    }

    $rows = @()
    $mainCategory = '其他'
    for ($row = 3; $row -le $sheet.UsedRange.Rows.Count; $row++) {
        $name = ([string]$sheet.Cells.Item($row, $headers['家具类别（中/英）']).Text).Trim()
        $quantityValue = $sheet.Cells.Item($row, $headers['数量']).Value2
        if (-not $name -and $null -eq $quantityValue) { continue }

        if ($headers.ContainsKey('类别')) {
            $categoryValue = ([string]$sheet.Cells.Item($row, $headers['类别']).Text).Trim()
            if ($categoryValue) { $mainCategory = $categoryValue }
        }

        $imageUrl = $null
        $imageStatus = ''
        if ($headers.ContainsKey('图片')) {
            $imageCell = $sheet.Cells.Item($row, $headers['图片'])
            $imageStatus = ([string]$imageCell.Text).Trim()
            $picture = $null
            if ($shapesByRow.ContainsKey($row)) {
                for ($attempt = 1; $attempt -le 8 -and $null -eq $picture; $attempt++) {
                    try {
                        $shapesByRow[$row].Copy()
                        [System.Windows.Forms.Application]::DoEvents()
                        $picture = $slide.Shapes.Paste().Item(1)
                    } catch {
                        [System.Windows.Forms.Application]::DoEvents()
                    }
                }
            } elseif ($null -ne $imageCell.Value2 -and $imageStatus -ne '无图片') {
                for ($attempt = 1; $attempt -le 8 -and $null -eq $picture; $attempt++) {
                    try {
                        $null = $imageCell.CopyPicture(1, 2)
                        [System.Windows.Forms.Application]::DoEvents()
                        $picture = $slide.Shapes.Paste().Item(1)
                    } catch {
                        [System.Windows.Forms.Application]::DoEvents()
                    }
                }
            }
            if ($null -ne $picture) {
                $fileName = "bjw-row-{0:D3}.png" -f $row
                $picture.Export((Join-Path $stagingImagePath $fileName), 2)
                $picture.Delete()
                $imageUrl = "/media/furniture/imported/$fileName"
                $imageStatus = '已从受保护工作簿恢复'
            } elseif ($shapesByRow.ContainsKey($row) -or ($null -ne $imageCell.Value2 -and $imageStatus -ne '无图片')) {
                throw "Unable to export the image in BJW row $row after 8 attempts."
            }
        }

        $metadata = @{}
        foreach ($header in $headers.Keys) {
            $metadata[$header] = ([string]$sheet.Cells.Item($row, $headers[$header]).Text).Trim()
        }
        $rows += [ordered]@{
            row = $row
            category = $mainCategory
            name = $name
            dimensions = if ($headers.ContainsKey('尺寸')) { ([string]$sheet.Cells.Item($row, $headers['尺寸']).Text).Trim() } else { '' }
            color = if ($headers.ContainsKey('颜色')) { ([string]$sheet.Cells.Item($row, $headers['颜色']).Text).Trim() } else { '' }
            material = if ($headers.ContainsKey('材质')) { ([string]$sheet.Cells.Item($row, $headers['材质']).Text).Trim() } else { '' }
            brand = if ($headers.ContainsKey('品牌')) { ([string]$sheet.Cells.Item($row, $headers['品牌']).Text).Trim() } else { '' }
            quantity = [int]$quantityValue
            image_url = $imageUrl
            image_reference = $imageStatus
            metadata = $metadata
        }
    }

    $sites = @()
    $siteSheet = $workbook.Worksheets.Item('Site POC')
    $siteHeaders = @{}
    for ($column = 1; $column -le $siteSheet.UsedRange.Columns.Count; $column++) {
        $header = ([string]$siteSheet.Cells.Item(2, $column).Text).Trim()
        if ($header) { $siteHeaders[$header] = $column }
    }
    if ($siteHeaders.ContainsKey('Site')) {
        for ($row = 3; $row -le $siteSheet.UsedRange.Rows.Count; $row++) {
            $siteName = ([string]$siteSheet.Cells.Item($row, $siteHeaders['Site']).Text).Trim()
            if (-not $siteName) { continue }
            $sites += [ordered]@{
                source_name = $siteName
                poc = if ($siteHeaders.ContainsKey('POC')) { ([string]$siteSheet.Cells.Item($row, $siteHeaders['POC']).Text).Trim() } else { '' }
                alias = if ($siteHeaders.ContainsKey('Alias')) { ([string]$siteSheet.Cells.Item($row, $siteHeaders['Alias']).Text).Trim() } else { '' }
            }
        }
    }

    $payload = [ordered]@{
        schema_version = 1
        source_workbook = [System.IO.Path]::GetFileName($sourcePath)
        source_sheet = 'BJW'
        exported_at = [DateTimeOffset]::UtcNow.ToString('o')
        sites = $sites
        rows = $rows
    }
    $payload | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $stagingManifestPath -Encoding utf8
    Remove-Item -LiteralPath $imagePath -Recurse -Force -ErrorAction SilentlyContinue
    Move-Item -LiteralPath $stagingImagePath -Destination $imagePath
    Move-Item -LiteralPath $stagingManifestPath -Destination $manifestPath -Force
    [pscustomobject]@{
        Manifest = $manifestPath
        Rows = $rows.Count
        Quantity = ($rows | ForEach-Object { $_['quantity'] } | Measure-Object -Sum).Sum
        Images = ($rows | Where-Object image_url).Count
        Sites = $sites.Count
        ImageDirectory = $imagePath
    }
}
finally {
    if ($null -ne $presentation) { $presentation.Close() }
    if ($null -ne $powerPoint) { $powerPoint.Quit() }
    if ($null -ne $workbook) { $workbook.Close($false) }
    if ($null -ne $excel) { $excel.Quit() }
    Remove-Item -LiteralPath $stagingImagePath -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $stagingManifestPath -Force -ErrorAction SilentlyContinue
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
}