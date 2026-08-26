Get-ChildItem 'D:\projects' -Directory | ForEach-Object {
    $folder = $_
    Write-Host ""
    Write-Host "=== $($folder.Name) ==="
    Get-ChildItem $folder.FullName -Directory -ErrorAction SilentlyContinue | ForEach-Object {
        Write-Host "  $($_.Name)"
    }
}
