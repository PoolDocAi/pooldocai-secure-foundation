# Restricted read-only PostgreSQL logical export for the isolated CMS source.
# Source is the CMS staging project ONLY. Never targets PoolDocAI core Production.
# The output is PLAINTEXT and is NOT an encrypted/complete/restore-verified backup.
# Actual Supabase Storage object bytes and independent empty-project restore remain required.
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$Destination,
  [switch]$AcknowledgeRestrictedPlaintext
)
$ErrorActionPreference='Stop'
$ProjectRef='rzkgmvyyeclrpomrlyft'
if(-not $AcknowledgeRestrictedPlaintext){
  throw 'Use -AcknowledgeRestrictedPlaintext only after selecting a restricted, encrypted local disk outside Git and understanding that this creates a sensitive plaintext dump.'
}
foreach($name in @('pg_dump','pg_restore')){
  if(-not (Get-Command $name -ErrorAction SilentlyContinue)){throw "$name missing; install PostgreSQL 17+ client tools."}
}
$Version=((& pg_dump --version) -join ' ')
$VersionMatch=[regex]::Match($Version,'(\d+)\.\d+')
if($LASTEXITCODE -ne 0 -or -not $VersionMatch.Success -or [int]$VersionMatch.Groups[1].Value -lt 17){
  throw 'pg_dump must be PostgreSQL 17 or newer.'
}
$Root=[IO.Path]::GetFullPath($Destination)
if($Root -match '[\\/]\.git(?:[\\/]|$)'){throw 'Backup destination cannot be inside Git.'}
# Reject a folder inside a repository, not only a directory literally named .git.
$Ancestor=$Root
while($true){
  if(Test-Path -LiteralPath (Join-Path $Ancestor '.git')){throw 'Choose a restricted backup location outside all Git repositories.'}
  $Parent=[IO.Directory]::GetParent($Ancestor)
  if($null -eq $Parent){break}
  $Ancestor=$Parent.FullName
}
New-Item -Path $Root -ItemType Directory -Force | Out-Null
$Previous=@{}
foreach($n in @('PGHOST','PGPORT','PGUSER','PGDATABASE','PGSSLMODE','PGPASSWORD')){
  $Previous[$n]=[Environment]::GetEnvironmentVariable($n,'Process')
}
$PasswordPointer=[IntPtr]::Zero
$Dump=$null
try{
  $Mode=(Read-Host 'Connection: [D]irect or [S]ession pooler (Enter for Direct)').Trim().ToUpperInvariant()
  if($Mode -notin @('','D','S')){throw 'Choose D or S.'}
  if($Mode -eq 'S'){
    $HostName=(Read-Host 'CMS Staging Supabase Connect > Session pooler hostname (hostname only)').Trim().ToLowerInvariant()
    if($HostName -notmatch '^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.pooler\.supabase\.com$'){throw 'Incorrect session pooler hostname.'}
    $User="postgres.$ProjectRef"
  }else{
    $HostName="db.$ProjectRef.supabase.co"
    $User='postgres'
  }
  Write-Host "READ ONLY: isolated CMS Staging $ProjectRef only. No database changes."
  $Secure=Read-Host 'CMS Staging database password (not your login password)' -AsSecureString
  $PasswordPointer=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure)
  [Environment]::SetEnvironmentVariable('PGPASSWORD',[Runtime.InteropServices.Marshal]::PtrToStringBSTR($PasswordPointer),'Process')
  foreach($setting in @(@('PGHOST',$HostName),@('PGPORT','5432'),@('PGUSER',$User),@('PGDATABASE','postgres'),@('PGSSLMODE','require'))){
    [Environment]::SetEnvironmentVariable($setting[0],$setting[1],'Process')
  }
  $Stamp=(Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmssZ')
  $Dump=Join-Path $Root "PoolDocAI-CMS-Staging-$Stamp.dump"
  if(Test-Path -LiteralPath $Dump){throw 'Refusing existing backup path.'}
  & pg_dump --format=custom --blobs --file $Dump
  if($LASTEXITCODE -ne 0){throw 'pg_dump failed. Do not trust the output.'}
  $Entries=@(& pg_restore --list $Dump)
  if($LASTEXITCODE -ne 0){throw 'pg_restore could not inspect the output.'}
  foreach($Pattern in @(
     'TABLE DATA\s+auth\s+users\s',
     'TABLE DATA\s+resources_cms\s+articles\s',
     'TABLE DATA\s+resources_cms\s+revisions\s',
     'TABLE DATA\s+resources_cms\s+editorial_holds\s',
     'TABLE DATA\s+storage\s+objects\s'
  )){
    if(-not ($Entries | Where-Object {$_ -match $Pattern})){throw "Dump misses essential catalog metadata; pattern $Pattern"}
  }
  $Info=Get-Item -LiteralPath $Dump
  if($Info.Length -lt 10240){throw 'Dump unexpectedly small.'}
  $Hash=(Get-FileHash -LiteralPath $Dump -Algorithm SHA256).Hash
  "$Hash  $($Info.Name)" | Set-Content -LiteralPath "$Dump.sha256.txt" -Encoding Ascii
  Write-Host 'CMS Staging logical dump created. This is NOT yet an encrypted/complete/restore-verified recovery package.'
  Write-Host "File: $Dump"
  Write-Host "Size (bytes): $($Info.Length)"
  Write-Host "SHA-256: $Hash"
  Write-Host 'DO NOT upload/send the plaintext dump. Export ALL Storage object bytes, seal a complete encrypted package, verify offsite, and independently restore into a separate empty project.'
}catch{
  if($Dump -and (Test-Path -LiteralPath $Dump)){
    Write-Warning 'An incomplete or unverified plaintext dump may remain on restricted local disk; treat it as sensitive and do not share.'
  }
  throw
}finally{
  if($PasswordPointer -ne [IntPtr]::Zero){[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($PasswordPointer)}
  foreach($n in $Previous.Keys){[Environment]::SetEnvironmentVariable($n,$Previous[$n],'Process')}
}
