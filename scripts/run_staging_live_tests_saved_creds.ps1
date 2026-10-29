# ============================================================================
# POOLDOCAI: RUN STAGING LIVE TESTS USING SAVED DPAPI CREDENTIALS
# Target: Dedicated Supabase Staging Project rzkgmvyyeclrpomrlyft ONLY
# Reads encrypted credentials from $env:USERPROFILE\.pooldocai_staging_credentials.xml
# and executes website/tests/staging-live-tenant-isolation.test.cjs
# NOTE: DPAPI credentials are user- and machine-scoped to the local Windows profile.
# ============================================================================

[CmdletBinding()]
param(
    [string]$StagingUrl = "https://rzkgmvyyeclrpomrlyft.supabase.co",
    [string]$PublishableKey = ""
)

$ErrorActionPreference = "Stop"

$expectedHost = "rzkgmvyyeclrpomrlyft.supabase.co"
$prodRef = "owfeebydlyacssqpnmkq"

$uri = [System.Uri]$StagingUrl
if ($uri.Scheme -ne "https" -or $uri.Host.ToLower() -ne $expectedHost -or $uri.Port -ne 443) {
    Write-Error "[FATAL SECURITY VIOLATION] Target URL must be HTTPS for $expectedHost on port 443."
    exit 1
}
if ($StagingUrl.ToLower().Contains($prodRef)) {
    Write-Error "[FATAL SECURITY VIOLATION] Target URL references production project '$prodRef'. Aborting."
    exit 1
}

$credPath = Join-Path $env:USERPROFILE ".pooldocai_staging_credentials.xml"
if (-not (Test-Path $credPath)) {
    Write-Error "Saved DPAPI credential file not found at: $credPath`nPlease run rotate_staging_synthetic_passwords.ps1 first."
    exit 1
}

$anonKey = $PublishableKey
if (-not $anonKey) {
    $anonKey = $env:STAGING_SUPABASE_ANON_KEY
}
if (-not $anonKey) {
    $secureAnon = Read-Host "Enter Staging Publishable / Anon Key (input hidden)" -AsSecureString
    $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureAnon)
    $anonKey = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
    [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
}

Write-Host "Loading DPAPI-encrypted credentials from: $credPath..." -ForegroundColor Cyan
$secureStore = Import-Clixml -Path $credPath

# Decrypt passwords to transient memory
function Unprotect-Secret($sec) {
    $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
    $plain = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
    [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    return $plain
}

$env:STAGING_SUPABASE_URL = $StagingUrl
$env:STAGING_SUPABASE_ANON_KEY = $anonKey
$env:STAGING_A_ADMIN_PASSWORD = Unprotect-Secret $secureStore["adminA"]
$env:STAGING_A_TECH_PASSWORD = Unprotect-Secret $secureStore["techA"]
$env:STAGING_B_ADMIN_PASSWORD = Unprotect-Secret $secureStore["adminB"]
$env:STAGING_B_TECH_PASSWORD = Unprotect-Secret $secureStore["techB"]
$env:REQUIRE_LIVE_STAGING = "1"

$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $repoRoot
try {
    node website/tests/staging-live-tenant-isolation.test.cjs
} finally {
    $env:STAGING_A_ADMIN_PASSWORD = $null
    $env:STAGING_A_TECH_PASSWORD = $null
    $env:STAGING_B_ADMIN_PASSWORD = $null
    $env:STAGING_B_TECH_PASSWORD = $null
    $env:REQUIRE_LIVE_STAGING = $null
    Pop-Location
}
