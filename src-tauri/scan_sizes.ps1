Get-ChildItem 'D:\projects' -Directory | ForEach-Object {
    $folder = $_
    $sizeGB = [math]::Round((Get-ChildItem $folder.FullName -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum / 1GB, 2)
    $fileCount = (Get-ChildItem $folder.FullName -Recurse -File -ErrorAction SilentlyContinue | Measure-Object).Count
    Write-Host "$($folder.Name): $sizeGB GB ($fileCount files)"
}
