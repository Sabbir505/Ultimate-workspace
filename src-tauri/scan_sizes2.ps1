Get-ChildItem 'D:\projects\Ultimate-workspace' -Directory -ErrorAction SilentlyContinue | ForEach-Object {
    $sizeGB = [math]::Round((Get-ChildItem $_.FullName -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum / 1GB, 2)
    Write-Host "$($_.Name): $sizeGB GB"
}
Write-Host ""
Write-Host "=== EyeShield ==="
Get-ChildItem 'D:\projects\EyeShield' -Directory -ErrorAction SilentlyContinue | ForEach-Object {
    $sizeGB = [math]::Round((Get-ChildItem $_.FullName -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum / 1GB, 2)
    Write-Host "$($_.Name): $sizeGB GB"
}
Write-Host ""
Write-Host "=== artifacts ==="
Get-ChildItem 'D:\projects\artifacts' -Directory -ErrorAction SilentlyContinue | ForEach-Object {
    $sizeGB = [math]::Round((Get-ChildItem $_.FullName -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum / 1GB, 2)
    Write-Host "$($_.Name): $sizeGB GB"
}
