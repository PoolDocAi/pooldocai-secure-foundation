# PoolDocAI manual backup integrity check (read-only; NO database connection).
# Validates one local PostgreSQL custom archive against its checksum sidecar.
# Streaming pg_restore to NUL verifies that archive data can be decompressed.
# This is NOT a restore rehearsal, encrypted backup or disaster recovery proof.
$ErrorActionPreference='Stop'
$folder=Join-Path (Get-Location).Path 'private-backups'
$files=@(Get-ChildItem -LiteralPath $folder -Filter 'PoolDocAI-production-*.dump' -File -ErrorAction Stop | Sort-Object LastWriteTimeUtc -Descending)
if ($files.Count -eq 0) {throw 'No Production backup found in .\private-backups'}
$file=$files[0]
if (-not (Get-Command pg_restore -ErrorAction SilentlyContinue)) {throw 'pg_restore missing: add C:\Program Files\PostgreSQL\18\bin to this PowerShell session PATH'}
if ($file.Length -lt 10240) {throw 'Backup file is suspiciously small'}
$sidecar="$($file.FullName).sha256.txt"
if (-not (Test-Path -LiteralPath $sidecar)) {throw 'SHA-256 sidecar missing'}
$expected=((Get-Content -LiteralPath $sidecar -Raw).Trim() -split '\s+')[0].ToUpperInvariant()
if ($expected -notmatch '^[A-F0-9]{64}$') {throw 'Invalid expected checksum'}
$actual=(Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToUpperInvariant()
if ($actual -ne $expected) {throw 'BACKUP CORRUPTED: SHA-256 does not match original'}
$items=@(& pg_restore --list $file.FullName)
if ($LASTEXITCODE -ne 0 -or $items.Count -lt 1) {throw 'PostgreSQL archive listing failed'}
foreach($pattern in @('TABLE DATA\s+auth\s+users\s','TABLE DATA\s+public\s+','TABLE DATA\s+storage\s+objects\s')){
 if (-not ($items | Where-Object {$_ -match $pattern})) {throw "Backup missing required metadata: $pattern"}
}
Write-Host 'Checking data decompression without restoring or opening a network connection.'
& pg_restore --file NUL $file.FullName
if ($LASTEXITCODE -ne 0) {throw 'Archive decompression failed'}
Write-Host "PASS: checksum verified, required table metadata found and archive decompressed"
Write-Host "Archive: $($file.Name)"
Write-Host "Size: $($file.Length) bytes"
Write-Host "SHA-256: $actual"
Write-Host 'NOT PROVEN: full restore into a separate database, encrypted storage, Supabase project settings or service-level recovery.'
