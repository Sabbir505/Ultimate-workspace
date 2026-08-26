Write-Host "=== Ultimate-workspace/src-tauri (172 GB) ==="
Get-ChildItem 'D:\projects\Ultimate-workspace\src-tauri' -Directory -ErrorAction SilentlyContinue | ForEach-Object {
    $sizeGB = [math]::Round((Get-ChildItem $_.FullName -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum / 1GB, 2)
    Write-Host "  $($_.Name): $sizeGB GB"
}
Write-Host ""
Write-Host "=== Content-management ==="
Get-ChildItem 'D:\projects\Content-management' -Directory -ErrorAction SilentlyContinue | ForEach-Object {
    $sizeGB = [math]::Round((Get-ChildItem $_.FullName -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum / 1GB, 2)
    Write-Host "  $($_.Name): $sizeGB GB"
}
