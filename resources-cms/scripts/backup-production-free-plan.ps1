# PoolDocAI Production database pre-migration logical backup.
# Windows PowerShell 5.1+ / PowerShell 7. PostgreSQL client pg_dump/pg_restore 17+
# Read-only: does not change Supabase. Never commit or upload the backup.
# Use the SESSION POOLER hostname shown by the dashboard's Connect menu.
$ErrorActionPreference = 'Stop'
$ProjectRef = 'owfeebydlyacssqpnmkq'
$PasswordPointer = [IntPtr]::Zero
$PreviousEnv = @{
  PGHOST = [Environment]::GetEnvironmentVariable('PGHOST', 'Process')
  PGPORT = [Environment]::GetEnvironmentVariable('PGPORT', 'Process')
  PGUSER = [Environment]::GetEnvironmentVariable('PGUSER', 'Process')
  PGDATABASE = [Environment]::GetEnvironmentVariable('PGDATABASE', 'Process')
  PGSSLMODE = [Environment]::GetEnvironmentVariable('PGSSLMODE', 'Process')
  PGPASSWORD = [Environment]::GetEnvironmentVariable('PGPASSWORD', 'Process')
}
try {
  foreach ($toolName in @('pg_dump', 'pg_restore')) {
    if (-not (Get-Command $toolName -ErrorAction SilentlyContinue)) {
      throw "$toolName not found. Install the PostgreSQL 17 client tools and reopen PowerShell."
    }
  }
  $ClientVersion = (& pg_dump --version) -join ' '
  if ($LASTEXITCODE -ne 0 -or $ClientVersion -notmatch '([0-9]+)\.[0-9]+') {
    throw "Cannot determine pg_dump version: $ClientVersion"
  }
  if ([int]$Matches[1] -lt 17) {
    throw "PostgreSQL 17 or newer client tools are required (server uses PostgreSQL 17)."
  }
  $PoolerHost = (Read-Host 'Supabase Connect > Session pooler hostname (hostname only)').Trim().ToLowerInvariant()
  if ($PoolerHost -notmatch '^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.pooler\.supabase\.com$') {
    throw 'Unexpected pooler hostname. Copy the Session pooler host from the correct Supabase project.'
  }

  $SecurePassword = Read-Host 'Production database password (not your Supabase login password)' -AsSecureString
  $PasswordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecurePassword)
  [Environment]::SetEnvironmentVariable('PGPASSWORD',
    [Runtime.InteropServices.Marshal]::PtrToStringBSTR($PasswordPointer), 'Process')
  [Environment]::SetEnvironmentVariable('PGHOST', $PoolerHost, 'Process')
  [Environment]::SetEnvironmentVariable('PGPORT', '5432', 'Process')
  [Environment]::SetEnvironmentVariable('PGUSER', "postgres.$ProjectRef", 'Process')
  [Environment]::SetEnvironmentVariable('PGDATABASE', 'postgres', 'Process')
  [Environment]::SetEnvironmentVariable('PGSSLMODE', 'require', 'Process')

  $Root = Join-Path (Get-Location).Path 'private-backups'
  New-Item -Path $Root -ItemType Directory -Force | Out-Null
  $Stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmssZ')
  $DumpFile = Join-Path $Root "PoolDocAI-production-$Stamp.dump"
  Write-Host 'Exporting a custom-format snapshot of the remote Production database.'
  Write-Host 'Backup stays on your local computer. This command makes no database changes.'
  & pg_dump --format=custom --blobs --file $DumpFile
  if ($LASTEXITCODE -ne 0) { throw 'pg_dump failed; backup cannot be trusted.' }

  $Items = @(& pg_restore --list $DumpFile)
  if ($LASTEXITCODE -ne 0) { throw 'pg_restore could not read the completed dump.' }
  if (-not ($Items | Where-Object { $_ -match 'TABLE DATA\s+auth\s+users\s' })) {
    throw 'Backup missing auth.users data metadata; do not use this backup for migration.'
  }
  if (-not ($Items | Where-Object { $_ -match 'TABLE DATA\s+public\s+' })) {
    throw 'Backup missing public table data metadata; do not use this backup for migration.'
  }
  if (-not ($Items | Where-Object { $_ -match 'TABLE DATA\s+storage\s+objects\s' })) {
    throw 'Backup missing storage.objects metadata; do not use this backup for migration.'
  }

  $File = Get-Item -LiteralPath $DumpFile
  if ($File.Length -lt 10240) { throw 'Dump is suspiciously small. Stop for inspection.' }
  $Digest = (Get-FileHash -LiteralPath $DumpFile -Algorithm SHA256).Hash
  $DigestPath = "$DumpFile.sha256.txt"
  "$Digest  $($File.Name)" | Set-Content -LiteralPath $DigestPath -Encoding Ascii
  Write-Host "PASS: archive readable and contains auth, public, storage metadata."
  Write-Host "File: $DumpFile"
  Write-Host "Size: $($File.Length) bytes"
  Write-Host "SHA-256: $Digest"
  Write-Host 'Do not commit, email, or upload the .dump file; it may contain customer and login data.'
  Write-Host 'IMPORTANT: Archive inspection is not a full restore test; Storage object bytes and project configuration are separate.'
} finally {
  if ($PasswordPointer -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($PasswordPointer)
  }
  foreach ($name in $PreviousEnv.Keys) {
    [Environment]::SetEnvironmentVariable($name, $PreviousEnv[$name], 'Process')
  }
}
