# ============================================================================
# POOLDOCAI TASK-008 PART-1C: ONE-TIME STAGING SYNTHETIC PASSWORD ROTATION & LIVE TEST RUNNER
# Target: Dedicated Supabase Staging Project rzkgmvyyeclrpomrlyft ONLY
# Strictly Authorized: GitHub Issue #15 Comment #6400745188
#
# Safety Boundaries:
# - Aborts immediately if host is NOT rzkgmvyyeclrpomrlyft.supabase.co
# - Aborts immediately if host contains owfeebydlyacssqpnmkq (production)
# - Validates nonsecret credential types locally BEFORE making any network call:
#   * Rejects publishable keys (sb_publishable_) or anon JWTs for administrative operations
#   * Rejects secret keys (sb_secret_) for client/publishable key operations
#   * Parses JWT role claim without signature trust only for preliminary rejection
# - Uses explicit non-browser CLI User-Agent (PoolDocAI-Staging-Admin-CLI/1.0)
#   on ALL API requests to prevent Supabase 401 browser-block on sb_secret_ keys
# - Supports modern sb_secret_ admin keys (apikey header only, avoids Invalid JWT error)
#   as well as legacy service_role JWT keys (apikey + Authorization: Bearer).
# - Rotates passwords ONLY for the four pre-approved synthetic test accounts
# - Pre-mutation DPAPI persistence: saves encrypted passwords before first API call
# - Explicit -DryRun parameter for safe preflight with ZERO mutations
# - Never creates users, deletes users, or touches database schemas
# - Accepts admin key via non-echoing prompt (Read-Host -AsSecureString)
# - Never echoes, logs, or transmits key material; sanitized diagnostics on error
# ============================================================================

[CmdletBinding()]
param(
    [string]$StagingUrl = "https://rzkgmvyyeclrpomrlyft.supabase.co",
    [switch]$DryRun,
    [switch]$RotateOnly,
    [switch]$RunLiveTests,
    [System.Security.SecureString]$AdminKey = $null,
    [System.Security.SecureString]$AnonKey = $null
)

$ErrorActionPreference = "Stop"

# Parameter validation: exactly ONE explicit mode must be specified (Fail-closed)
$activeModes = @()
if ($DryRun) { $activeModes += "-DryRun" }
if ($RotateOnly) { $activeModes += "-RotateOnly" }
if ($RunLiveTests) { $activeModes += "-RunLiveTests" }

if ($activeModes.Count -eq 0) {
    Write-Host "`n============================================================================" -ForegroundColor Red
    Write-Host " [FATAL ERROR] No execution mode switch specified." -ForegroundColor Red
    Write-Host " PoolDocAI security policy requires an explicit mode flag to prevent accidental execution." -ForegroundColor Yellow
    Write-Host "`n USAGE:" -ForegroundColor Cyan
    Write-Host "   1. Non-mutating preflight validation (Zero mutations):" -ForegroundColor Cyan
    Write-Host "      powershell -ExecutionPolicy RemoteSigned -File .\scripts\rotate_staging_synthetic_passwords.ps1 -DryRun" -ForegroundColor White
    Write-Host "`n   2. Rotate synthetic passwords only (Isolated - Zero integration tests):" -ForegroundColor Cyan
    Write-Host "      powershell -ExecutionPolicy RemoteSigned -File .\scripts\rotate_staging_synthetic_passwords.ps1 -RotateOnly" -ForegroundColor White
    Write-Host "`n   3. Run live integration tests only (Using saved DPAPI credentials):" -ForegroundColor Cyan
    Write-Host "      powershell -ExecutionPolicy RemoteSigned -File .\scripts\rotate_staging_synthetic_passwords.ps1 -RunLiveTests" -ForegroundColor White
    Write-Host "============================================================================`n" -ForegroundColor Red
    exit 1
}

if ($activeModes.Count -gt 1) {
    Write-Error "[FATAL] Incompatible mode switches specified: $($activeModes -join ', '). Please specify only one mode."
    exit 1
}

# Non-browser CLI User-Agent to avoid Supabase sb_secret_ 401 browser block
$cliUserAgent = "PoolDocAI-Staging-Admin-CLI/1.0"
$stagingRef = "rzkgmvyyeclrpomrlyft"
$expectedHost = "rzkgmvyyeclrpomrlyft.supabase.co"
$prodRef = "owfeebydlyacssqpnmkq"

Write-Host "============================================================================" -ForegroundColor Cyan
Write-Host " POOLDOCAI: STAGING SYNTHETIC PASSWORD ROTATION & VERIFICATION UTILITY" -ForegroundColor Cyan
Write-Host " Target: $StagingUrl" -ForegroundColor Cyan
Write-Host " User-Agent: $cliUserAgent" -ForegroundColor Cyan
if ($DryRun) {
    Write-Host " MODE: DRY RUN (PREFLIGHT ONLY - ZERO MUTATIONS)" -ForegroundColor Yellow
} elseif ($RotateOnly) {
    Write-Host " MODE: ROTATE PASSWORDS ONLY (ISOLATED - ZERO INTEGRATION TESTS)" -ForegroundColor Magenta
} elseif ($RunLiveTests) {
    Write-Host " MODE: RUN LIVE TESTS ONLY (USING SAVED DPAPI CREDENTIALS)" -ForegroundColor Cyan
}
Write-Host "============================================================================`n" -ForegroundColor Cyan

# 1. Strict Target Host & Protocol Guard
$uri = [System.Uri]$StagingUrl
if ($uri.Scheme -ne "https") {
    Write-Error "[FATAL SECURITY VIOLATION] Target URL must use HTTPS protocol. Received: '$($uri.Scheme)'"
    exit 1
}
if ($uri.Host.ToLower() -ne $expectedHost) {
    Write-Error "[FATAL SECURITY VIOLATION] Target host '$($uri.Host)' does not match expected staging host '$expectedHost'."
    exit 1
}
if ($uri.Port -ne 443) {
    Write-Error "[FATAL SECURITY VIOLATION] Target port must be 443. Received: '$($uri.Port)'"
    exit 1
}
if ($StagingUrl.ToLower().Contains($prodRef)) {
    Write-Error "[FATAL SECURITY VIOLATION] Target URL references production project '$prodRef'. Aborting."
    exit 1
}

# 2. Approved Account Allowlist
$approvedAccounts = @(
    @{
        Role = "adminA"
        Id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        Email = "staging_admin_aquapure@pooldocai.test"
        CompanyId = "11111111-1111-4111-8111-111111111111"
        CompanyName = "AquaPure Commercial Pool Care"
    },
    @{
        Role = "techA"
        Id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
        Email = "staging_tech_aquapure@pooldocai.test"
        CompanyId = "11111111-1111-4111-8111-111111111111"
        CompanyName = "AquaPure Commercial Pool Care"
    },
    @{
        Role = "adminB"
        Id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
        Email = "staging_admin_bluewave@pooldocai.test"
        CompanyId = "22222222-2222-4222-8222-222222222222"
        CompanyName = "BlueWave Residential Pool Services"
    },
    @{
        Role = "techB"
        Id = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
        Email = "staging_tech_bluewave@pooldocai.test"
        CompanyId = "22222222-2222-4222-8222-222222222222"
        CompanyName = "BlueWave Residential Pool Services"
    }
)

# Helper function: parse JWT payload role claim without signature trust (for pre-network validation only)
function Get-JwtPayloadRole([string]$jwt) {
    try {
        $parts = $jwt.Split('.')
        if ($parts.Length -lt 2) { return $null }
        $payloadBase64 = $parts[1].Replace('-', '+').Replace('_', '/')
        switch ($payloadBase64.Length % 4) {
            2 { $payloadBase64 += "=="; break }
            3 { $payloadBase64 += "="; break }
        }
        $bytes = [System.Convert]::FromBase64String($payloadBase64)
        $json = [System.Text.Encoding]::UTF8.GetString($bytes)
        $obj = $json | ConvertFrom-Json
        return $obj.role
    } catch {
        return $null
    }
}

# Helper function: safe, sanitized error reporting on API failure (zero secrets or headers leaked)
function Write-SanitizedApiError {
    param(
        [string]$Endpoint,
        [System.Management.Automation.ErrorRecord]$ErrorRecord,
        [string]$AdminKeyType,
        [string]$UserAgent,
        [string]$TargetHost,
        [string]$ProjectRef
    )

    $statusCode = $null
    $statusDesc = $null
    $sanitizedBody = $null

    if ($ErrorRecord.Exception.Response) {
        $statusCode = [int]$ErrorRecord.Exception.Response.StatusCode
        $statusDesc = $ErrorRecord.Exception.Response.StatusDescription
        try {
            $stream = $ErrorRecord.Exception.Response.GetResponseStream()
            if ($stream) {
                $reader = [System.IO.StreamReader]::new($stream)
                $raw = $reader.ReadToEnd()
                $reader.Close()
                $errJson = $raw | ConvertFrom-Json -ErrorAction SilentlyContinue
                if ($errJson) {
                    $parts = @()
                    if ($errJson.error) { $parts += "error=$($errJson.error)" }
                    if ($errJson.error_code) { $parts += "error_code=$($errJson.error_code)" }
                    if ($errJson.msg) { $parts += "msg=$($errJson.msg)" }
                    if ($errJson.message) { $parts += "message=$($errJson.message)" }
                    $sanitizedBody = $parts -join "; "
                } else {
                    $clean = ($raw -replace '[^\w\s\-\.\,\:\;\=]', '')
                    if ($clean.Length -gt 120) { $clean = $clean.Substring(0, 120) }
                    $sanitizedBody = $clean
                }
            }
        } catch {}
    } elseif ($ErrorRecord.Exception.Message -match '\((\d{3})\)\s*([^\.]*)') {
        $statusCode = [int]$Matches[1]
        $statusDesc = $Matches[2].Trim()
    }

    Write-Host "`n============================================================================" -ForegroundColor Red
    Write-Host " [PREFLIGHT ERROR]: Staging API Request Failed" -ForegroundColor Red
    Write-Host "============================================================================" -ForegroundColor Red
    Write-Host "  Project Ref:        $ProjectRef ($TargetHost)" -ForegroundColor Red
    Write-Host "  Endpoint:           $Endpoint" -ForegroundColor Red
    Write-Host "  HTTP Status:        $statusCode $statusDesc" -ForegroundColor Red
    Write-Host "  Admin Key Type:     $AdminKeyType" -ForegroundColor Red
    Write-Host "  Client User-Agent:  $UserAgent" -ForegroundColor Red
    if ($sanitizedBody) {
        Write-Host "  Sanitized Message:  $sanitizedBody" -ForegroundColor Red
    }
    Write-Host "`n  Security Note: Zero request/response headers, raw tokens, or passwords logged." -ForegroundColor Yellow
    Write-Host "  Diagnostics:" -ForegroundColor Yellow
    if ($statusCode -eq 401) {
        Write-Host "  - HTTP 401 Unauthorized returned by Supabase API gateway / GoTrue Auth service." -ForegroundColor Yellow
        Write-Host "  - Request was dispatched with User-Agent '$UserAgent' and key type '$AdminKeyType'." -ForegroundColor Yellow
        Write-Host "  - Verify that the administrative key was copied from the STAGING project ($ProjectRef)" -ForegroundColor Yellow
        Write-Host "    under Supabase Dashboard -> Project Settings -> API (Secret key or service_role secret)." -ForegroundColor Yellow
        Write-Host "  - Verify the key has not been revoked or regenerated." -ForegroundColor Yellow
        Write-Host "  - Manual review required before further credential entry." -ForegroundColor Yellow
    } elseif ($statusCode -eq 500) {
        Write-Host "  - HTTP 500 Database error returned by GoTrue Auth service." -ForegroundColor Yellow
        Write-Host "  - Root Cause: GoTrue parser failure on NULL token fields (email_change, recovery_token)" -ForegroundColor Yellow
        Write-Host "    in directly-seeded synthetic auth.users records (documented Supabase GoTrue scan behavior)." -ForegroundColor Yellow
        Write-Host "  - Resolution: Execute reviewed bounded data-repair script 06_repair_auth_users_null_tokens.sql" -ForegroundColor Yellow
        Write-Host "    in staging SQL editor after explicit owner authorization." -ForegroundColor Yellow
    } else {
        Write-Host "  - Unexpected HTTP error: $statusCode. Inspect network connection or Supabase status." -ForegroundColor Yellow
    }
    Write-Host "============================================================================`n" -ForegroundColor Red
}

# 3. Handle Independent Live Test Runner Mode (-RunLiveTests)
if ($RunLiveTests) {
    Write-Host "--- Mode: Run Live Staging Tests Using Saved DPAPI Credentials ---" -ForegroundColor Cyan
    $credPath = Join-Path $env:USERPROFILE ".pooldocai_staging_credentials.xml"
    if (-not (Test-Path $credPath)) {
        Write-Error "[FATAL] Saved DPAPI credential store not found at: $credPath`nPlease run with -RotateOnly first to rotate and store credentials."
        exit 1
    }

    # Prompt for Staging Publishable / Anon Key if not provided in environment
    $secureAnonKey = $null
    if ($null -ne $AnonKey) {
        $secureAnonKey = $AnonKey
        $bstrAnon = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureAnonKey)
        $anonKeyPlain = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($bstrAnon)
        [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstrAnon)
    } elseif ($env:STAGING_SUPABASE_ANON_KEY) {
        Write-Host "Using STAGING_SUPABASE_ANON_KEY from environment." -ForegroundColor Green
        $anonKeyPlain = $env:STAGING_SUPABASE_ANON_KEY
    } else {
        Write-Host "Please enter the Supabase Staging Publishable / Anon Key (from Staging API Settings)." -ForegroundColor Yellow
        $secureAnonKey = Read-Host "Staging Publishable/Anon Key" -AsSecureString
        if ($null -eq $secureAnonKey -or $secureAnonKey.Length -eq 0) {
            Write-Error "No publishable key provided. Aborting."
            exit 1
        }
        $bstrAnon = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureAnonKey)
        $anonKeyPlain = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($bstrAnon)
        [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstrAnon)
    }

    # Validate publishable key format
    if ($anonKeyPlain.StartsWith("sb_secret_")) {
        Write-Error "[FATAL SECURITY VIOLATION] Invalid client credential type: Received a secret key ('sb_secret_...') in the publishable/anon key prompt."
        exit 1
    }

    Write-Host "Loading DPAPI-encrypted credentials from: $credPath..." -ForegroundColor Cyan
    $savedStore = Import-Clixml -Path $credPath

    function Unprotect-Secret($sec) {
        $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
        $plain = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
        [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
        return $plain
    }

    Write-Host "Authenticating 4 synthetic users via GoTrue password grant..." -ForegroundColor Cyan
    $authTokens = @{}
    $tokenHeaders = @{
        "apikey" = $anonKeyPlain
        "Content-Type" = "application/json"
        "Accept" = "application/json"
    }
    if ($anonKeyPlain.StartsWith("eyJ")) {
        $tokenHeaders["Authorization"] = "Bearer $anonKeyPlain"
    }

    foreach ($acct in $approvedAccounts) {
        $userPwd = Unprotect-Secret $savedStore[$acct.Role]
        $loginUrl = "$StagingUrl/auth/v1/token?grant_type=password"
        $loginBody = @{
            email = $acct.Email
            password = $userPwd
        } | ConvertTo-Json

        try {
            $loginRes = Invoke-RestMethod -Uri $loginUrl -Method Post -Headers $tokenHeaders -Body $loginBody -UserAgent $cliUserAgent -MaximumRedirection 0
        } catch {
            Write-SanitizedApiError -Endpoint "/auth/v1/token?grant_type=password [POST]" -ErrorRecord $_ -AdminKeyType "none (publishable login)" -UserAgent $cliUserAgent -TargetHost $expectedHost -ProjectRef $stagingRef
            exit 1
        }

        if (-not $loginRes.access_token -or $loginRes.user.id -ne $acct.Id) {
            Write-Error "[FATAL] Invalid login response for $($acct.Email)"
            exit 1
        }

        $authTokens[$acct.Role] = $loginRes.access_token
        Write-Host "  [LOGIN SUCCESS] Verified session for $($acct.Email)" -ForegroundColor Green
    }

    # Execute Live Tenant-Isolation Test Suite
    Write-Host "`n============================================================================" -ForegroundColor Cyan
    Write-Host " EXECUTING REAL STAGING TENANT-ISOLATION SUITE (29 ASSERTIONS)" -ForegroundColor Cyan
    Write-Host "============================================================================`n" -ForegroundColor Cyan

    $env:STAGING_SUPABASE_URL = $StagingUrl
    $env:STAGING_SUPABASE_ANON_KEY = $anonKeyPlain
    $env:STAGING_AUTH_TOKENS = ($authTokens | ConvertTo-Json -Compress)
    $env:REQUIRE_LIVE_STAGING = "1"

    $repoRoot = Split-Path -Parent $PSScriptRoot
    Push-Location $repoRoot
    try {
        node website/tests/staging-live-tenant-isolation.test.cjs
        $testExit = $LASTEXITCODE
        if ($testExit -eq 0) {
            Write-Host "`n[TASK-008 PART-1C VERIFICATION]: ALL LIVE STAGING TESTS PASSED SUCCESSFULLY!" -ForegroundColor Green
        } else {
            Write-Error "[TASK-008 PART-1C VERIFICATION]: Live staging tests failed with exit code $testExit"
        }
        exit $testExit
    } finally {
        $env:STAGING_AUTH_TOKENS = $null
        $env:STAGING_SUPABASE_URL = $null
        $env:STAGING_SUPABASE_ANON_KEY = $null
        $env:REQUIRE_LIVE_STAGING = $null
        Pop-Location
    }
}

# 4. Prompt for Staging Administrative Key (Non-echoing)
$secureAdminKey = $null
if ($null -ne $AdminKey) {
    $secureAdminKey = $AdminKey
} else {
    Write-Host "Please enter the Supabase Staging Administrative Key (service_role or sb_secret_ key)." -ForegroundColor Yellow
    Write-Host "Input is completely masked and will not be echoed, logged, or saved to disk." -ForegroundColor Yellow
    $secureAdminKey = Read-Host "Staging Administrative Key" -AsSecureString
}

if ($null -eq $secureAdminKey -or $secureAdminKey.Length -eq 0) {
    Write-Error "No administrative key provided. Aborting."
    exit 1
}

# Convert admin key to transient string in memory for validation and header creation
$bstrAdmin = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureAdminKey)
$adminKeyPlain = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($bstrAdmin)
[System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstrAdmin)

# Nonsecret Credential-Type Validation for Administrative Key (Pre-network check)
$adminKeyType = $null
if ($adminKeyPlain.StartsWith("sb_publishable_")) {
    Write-Error "[FATAL SECURITY VIOLATION] Invalid administrative credential type: Received a publishable key ('sb_publishable_...'). Administrative operations require an elevated service_role secret key ('sb_secret_...' or legacy service_role JWT)."
    exit 1
} elseif ($adminKeyPlain.StartsWith("sb_secret_")) {
    $adminKeyType = "sb_secret_ (modern secret key)"
} elseif ($adminKeyPlain.StartsWith("eyJ")) {
    $role = Get-JwtPayloadRole -jwt $adminKeyPlain
    if ($role -eq "anon") {
        Write-Error "[FATAL SECURITY VIOLATION] Invalid administrative credential type: Received an anon JWT (role: 'anon'). Administrative operations require a service_role secret key."
        exit 1
    } elseif ($role -ne "service_role") {
        Write-Error "[FATAL SECURITY VIOLATION] Invalid administrative credential type: JWT role claim is '$role', expected 'service_role'. Administrative operations require a service_role secret key."
        exit 1
    }
    $adminKeyType = "service_role (legacy JWT)"
} else {
    Write-Error "[FATAL SECURITY VIOLATION] Invalid administrative credential format. Expected a modern secret key ('sb_secret_...') or a legacy service_role JWT ('eyJ...')."
    exit 1
}
Write-Host "  [CREDENTIAL CHECK] Staging administrative key validated as: $adminKeyType" -ForegroundColor Green

# 4. Prompt for Staging Publishable / Anon Key (Non-echoing)
$secureAnonKey = $null
if ($null -ne $AnonKey) {
    $secureAnonKey = $AnonKey
    $bstrAnon = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureAnonKey)
    $anonKeyPlain = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($bstrAnon)
    [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstrAnon)
} elseif ($env:STAGING_SUPABASE_ANON_KEY) {
    Write-Host "`nUsing STAGING_SUPABASE_ANON_KEY from environment." -ForegroundColor Green
    $anonKeyPlain = $env:STAGING_SUPABASE_ANON_KEY
} else {
    Write-Host "`nPlease enter the Supabase Staging Publishable / Anon Key (from Staging API Settings)." -ForegroundColor Yellow
    $secureAnonKey = Read-Host "Staging Publishable/Anon Key" -AsSecureString
    if ($null -eq $secureAnonKey -or $secureAnonKey.Length -eq 0) {
        Write-Error "No publishable key provided. Aborting."
        exit 1
    }
    $bstrAnon = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureAnonKey)
    $anonKeyPlain = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($bstrAnon)
    [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstrAnon)
}

# Nonsecret Credential-Type Validation for Publishable / Anon Key (Pre-network check)
$anonKeyType = $null
if ($anonKeyPlain.StartsWith("sb_secret_")) {
    Write-Error "[FATAL SECURITY VIOLATION] Invalid client credential type: Received a secret key ('sb_secret_...') in the publishable/anon key prompt. Never use administrative secret keys for client operations."
    exit 1
} elseif ($anonKeyPlain.StartsWith("sb_publishable_")) {
    $anonKeyType = "sb_publishable_ (modern publishable key)"
} elseif ($anonKeyPlain.StartsWith("eyJ")) {
    $role = Get-JwtPayloadRole -jwt $anonKeyPlain
    if ($role -ne "anon") {
        Write-Error "[FATAL SECURITY VIOLATION] Invalid client credential type: Expected anon JWT, but JWT role claim is '$role'."
        exit 1
    }
    $anonKeyType = "anon (legacy JWT)"
} else {
    Write-Error "[FATAL SECURITY VIOLATION] Invalid publishable/anon key format. Expected a modern publishable key ('sb_publishable_...') or a legacy anon JWT ('eyJ...')."
    exit 1
}
Write-Host "  [CREDENTIAL CHECK] Staging publishable/anon key validated as: $anonKeyType" -ForegroundColor Green

# Helper function to build Admin Headers supporting modern sb_secret_ and legacy JWT keys
function Get-AdminHeaders([string]$adminKey) {
    $headers = @{
        "apikey" = $adminKey
        "Accept" = "application/json"
    }
    # Supabase documentation: modern sb_secret_ keys are NOT JWTs and must go on apikey only.
    # Legacy service_role JWT keys (starting with eyJ) require Authorization: Bearer.
    if ($adminKey.StartsWith("eyJ")) {
        $headers["Authorization"] = "Bearer $adminKey"
    }
    return $headers
}

# Helper function for generating CSPRNG passwords
function New-SecurePassword {
    param([int]$Length = 32)
    $bytes = New-Object byte[] $Length
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $rng.GetBytes($bytes)
    $chars = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%^&*()-_=+"
    $password = ""
    for ($i = 0; $i -lt $Length; $i++) {
        $password += $chars[$bytes[$i] % $chars.Length]
    }
    return $password
}

try {
    # 5. Preflight Verification: Verify all 4 accounts via Auth Admin API & check memberships
    Write-Host "`n--- Step 1: Preflight Verification via Staging Auth Admin API ---" -ForegroundColor Cyan
    $adminHeaders = Get-AdminHeaders -adminKey $adminKeyPlain

    foreach ($acct in $approvedAccounts) {
        $userUrl = "$StagingUrl/auth/v1/admin/users/$($acct.Id)"
        try {
            $userRes = Invoke-RestMethod -Uri $userUrl -Method Get -Headers $adminHeaders -UserAgent $cliUserAgent -MaximumRedirection 0
        } catch {
            Write-SanitizedApiError -Endpoint "/auth/v1/admin/users/$($acct.Id)" -ErrorRecord $_ -AdminKeyType $adminKeyType -UserAgent $cliUserAgent -TargetHost $expectedHost -ProjectRef $stagingRef
            exit 1
        }

        if ($userRes.id -ne $acct.Id -or $userRes.email -ne $acct.Email) {
            Write-Error "[FATAL] Allowlist mismatch! Expected: $($acct.Id) / $($acct.Email), Found: $($userRes.id) / $($userRes.email)"
            exit 1
        }

        # Verify company membership
        $memberUrl = "$StagingUrl/rest/v1/company_members?user_id=eq.$($acct.Id)&select=id,company_id,role"
        try {
            $memberRes = Invoke-RestMethod -Uri $memberUrl -Method Get -Headers $adminHeaders -UserAgent $cliUserAgent -MaximumRedirection 0
        } catch {
            Write-SanitizedApiError -Endpoint "/rest/v1/company_members?user_id=eq.$($acct.Id)" -ErrorRecord $_ -AdminKeyType $adminKeyType -UserAgent $cliUserAgent -TargetHost $expectedHost -ProjectRef $stagingRef
            exit 1
        }

        if ($memberRes.Count -eq 0 -or $memberRes[0].company_id -ne $acct.CompanyId) {
            Write-Error "[FATAL] Membership mismatch for user $($acct.Email)! Expected company $($acct.CompanyId)"
            exit 1
        }

        Write-Host "  [PREFLIGHT PASS] $($acct.Email) ($($acct.Id)) verified in $($acct.CompanyName)" -ForegroundColor Green
    }

    if ($DryRun) {
        Write-Host "`n============================================================================" -ForegroundColor Green
        Write-Host " [DRY RUN COMPLETE]: All 4 synthetic accounts confirmed with correct UUIDs," -ForegroundColor Green
        Write-Host " emails, and company memberships in project $expectedHost." -ForegroundColor Green
        Write-Host " Preflight executed with Admin Key Type: $adminKeyType" -ForegroundColor Green
        Write-Host " Client User-Agent: $cliUserAgent" -ForegroundColor Green
        Write-Host " ZERO MUTATIONS PERFORMED. Ready for authorized rotation execution." -ForegroundColor Green
        Write-Host "============================================================================`n" -ForegroundColor Green
        return
    }

    # 6. Pre-mutation DPAPI Backup, Atomic Replace Helper & Journal Recovery
    Write-Host "`n--- Step 2: DPAPI Credential Store Pre-Check & Atomic Backup ---" -ForegroundColor Cyan
    $credPath = Join-Path $env:USERPROFILE ".pooldocai_staging_credentials.xml"
    $journalPath = "$credPath.journal.xml"
    $credStore = [System.Collections.Generic.Dictionary[string, System.Security.SecureString]]::new()

    # Helper function for atomic temp-file commit and replace with Win32 ReplaceFile
    function Save-DpapiStoreAtomic {
        param(
            [System.Collections.Generic.Dictionary[string, System.Security.SecureString]]$Store,
            [string]$DestinationPath
        )
        $tempPath = "$DestinationPath.tmp.$([System.Guid]::NewGuid().ToString('N'))"
        try {
            $Store | Export-Clixml -Path $tempPath
            if (-not (Test-Path $tempPath) -or (Get-Item $tempPath).Length -eq 0) {
                throw "Temporary DPAPI export file is missing or zero-length: $tempPath"
            }
            # Deserialization integrity check
            $verify = Import-Clixml -Path $tempPath
            if ($null -eq $verify -or $verify.Count -ne $Store.Count) {
                throw "Integrity verification failed for temporary DPAPI export: $tempPath"
            }

            if (Test-Path $DestinationPath) {
                $backupPath = "$DestinationPath.bak.$([DateTime]::UtcNow.ToString('yyyyMMddTHHmmssffffZ'))"
                # Win32 atomic file replace with backup creation
                [System.IO.File]::Replace($tempPath, $DestinationPath, $backupPath)
            } else {
                [System.IO.File]::Move($tempPath, $DestinationPath)
            }
        } finally {
            if (Test-Path $tempPath) {
                Remove-Item -Path $tempPath -Force -ErrorAction SilentlyContinue
            }
        }
    }

    if (Test-Path $credPath) {
        $loadSuccess = $false
        try {
            $existing = Import-Clixml -Path $credPath
            if ($null -ne $existing) {
                foreach ($k in $existing.Keys) {
                    $credStore[$k] = $existing[$k]
                }
                $loadSuccess = $true
                Write-Host "  [DPAPI JOURNAL] Loaded $($credStore.Count) existing credentials for safe resume check." -ForegroundColor Cyan
            }
        } catch {
            Write-Warning "Primary DPAPI credential store at $credPath is corrupted or unreadable: $_"
        }

        if (-not $loadSuccess) {
            Write-Host "  [RECOVERY ATTEMPT] Attempting automatic recovery from latest valid backup..." -ForegroundColor Yellow
            $parentDir = Split-Path -Parent $credPath
            $baseName = Split-Path -Leaf $credPath
            $backups = Get-ChildItem -Path $parentDir -Filter "$baseName.bak.*" | Sort-Object LastWriteTime -Descending
            $recovered = $false
            foreach ($bak in $backups) {
                try {
                    $bakStore = Import-Clixml -Path $bak.FullName
                    if ($null -ne $bakStore -and $bakStore.Count -gt 0) {
                        foreach ($k in $bakStore.Keys) {
                            $credStore[$k] = $bakStore[$k]
                        }
                        Save-DpapiStoreAtomic -Store $credStore -DestinationPath $credPath
                        Write-Host "  [DPAPI RECOVERED] Successfully recovered valid DPAPI store from backup: $($bak.Name)" -ForegroundColor Green
                        $recovered = $true
                        break
                    }
                } catch {}
            }
            if (-not $recovered) {
                Write-Error "[FATAL] DPAPI credential store at $credPath is corrupted and no valid backup could be recovered. Failing closed to prevent data loss."
                exit 1
            }
        }
    } else {
        Write-Host "  [DPAPI STORE] Initializing new store at: $credPath" -ForegroundColor Cyan
    }

    # 7. Perform Incremental, Journaled Rotation & Immediate GoTrue Verification
    Write-Host "`n--- Step 3: Journaled Password Rotation & GoTrue Login Verification ---" -ForegroundColor Cyan
    $authTokens = @{}

    $tokenHeaders = @{
        "apikey" = $anonKeyPlain
        "Content-Type" = "application/json"
        "Accept" = "application/json"
    }
    if ($anonKeyPlain.StartsWith("eyJ")) {
        $tokenHeaders["Authorization"] = "Bearer $anonKeyPlain"
    }

    $loginUrl = "$StagingUrl/auth/v1/token?grant_type=password"

    function Test-GoTruePassword {
        param(
            [string]$Email,
            [System.Security.SecureString]$SecurePwd,
            [string]$TargetUrl,
            [hashtable]$Headers,
            [string]$UserAgent = $cliUserAgent
        )
        if ($null -eq $SecurePwd) {
            return @{
                Status = "NoPassword"
                AccessToken = $null
                User = $null
                StatusCode = $null
                ErrorCode = $null
                Error = "Null password provided"
            }
        }
        $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecurePwd)
        $plain = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
        [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)

        $body = @{ email = $Email; password = $plain } | ConvertTo-Json
        $plain = $null
        try {
            $res = Invoke-RestMethod -Uri $TargetUrl -Method Post -Headers $Headers -Body $body -UserAgent $cliUserAgent -MaximumRedirection 0
            if ($res.access_token) {
                return @{
                    Status = "Success"
                    AccessToken = $res.access_token
                    User = $res.user
                    StatusCode = 200
                    ErrorCode = $null
                    Error = $null
                }
            } else {
                return @{
                    Status = "Indeterminate"
                    AccessToken = $null
                    User = $null
                    StatusCode = 200
                    ErrorCode = "MISSING_ACCESS_TOKEN"
                    Error = "HTTP 200 response missing access_token claim"
                }
            }
        } catch {
            $ex = $_.Exception
            $statusCode = $null
            $responseBody = ""
            if ($_.Exception.Response) {
                try {
                    $statusCode = [int]$_.Exception.Response.StatusCode
                    $stream = $_.Exception.Response.GetResponseStream()
                    if ($null -ne $stream) {
                        $reader = [System.IO.StreamReader]::new($stream)
                        $responseBody = $reader.ReadToEnd()
                    }
                } catch {}
            }

            # Attempt safe local parse of GoTrue error response JSON
            $parsedJson = $null
            if (-not [string]::IsNullOrWhiteSpace($responseBody)) {
                try {
                    $parsedJson = $responseBody | ConvertFrom-Json
                } catch {}
            }

            # Finite allowlist of documented, safe GoTrue error codes (https://supabase.com/docs/guides/auth/debugging/error-codes)
            $knownSafeErrorCodes = @(
                "invalid_credentials",
                "invalid_grant",
                "invalid_request",
                "unsupported_grant_type",
                "validation_failed",
                "bad_json",
                "bad_jwt",
                "user_not_found",
                "email_not_confirmed",
                "over_request_rate_limit",
                "over_email_send_rate_limit",
                "rate_limit_exceeded",
                "unexpected_failure"
            )

            # Strict GoTrue Credential Rejection Classification:
            # ONLY classify as definitive InvalidCredentials if HTTP 400 AND body explicitly contains documented GoTrue credential rejection code
            $isDefinitiveCredentialRejection = $false
            if ($statusCode -eq 400 -and $null -ne $parsedJson) {
                $rawCode = if ($parsedJson.error_code) { [string]$parsedJson.error_code } else { "" }
                $rawErr  = if ($parsedJson.error) { [string]$parsedJson.error } else { "" }
                $rawDesc = if ($parsedJson.error_description) { [string]$parsedJson.error_description } else { "" }
                $rawMsg  = if ($parsedJson.msg) { [string]$parsedJson.msg } else { "" }

                if ($rawCode -eq "invalid_credentials" -or
                    ($rawErr -eq "invalid_grant" -and ($rawDesc -match "Invalid login credentials" -or $rawMsg -match "Invalid login credentials"))) {
                    $isDefinitiveCredentialRejection = $true
                }
            }

            if ($isDefinitiveCredentialRejection) {
                return @{
                    Status = "InvalidCredentials"
                    AccessToken = $null
                    User = $null
                    StatusCode = 400
                    ErrorCode = "invalid_credentials"
                    Error = "GoTrue definitively rejected credentials (Status: 400, Code: invalid_credentials)"
                }
            }

            # All other outcomes are strictly INDETERMINATE (non-credential 400, 401, 422, 429, 5xx, timeouts, drops, unparseable bodies).
            # Sanitized error message: Map server codes to allowlist; never echo arbitrary or secret-like provider text.
            $safeErrorClass = if ($null -eq $statusCode) { "TransportTimeout" } else { "HTTP_$statusCode" }
            $rawServerCode = if ($null -ne $parsedJson) {
                if ($parsedJson.error_code) { [string]$parsedJson.error_code }
                elseif ($parsedJson.error) { [string]$parsedJson.error }
                else { $null }
            } else { $null }

            $safeReportedCode = if ($null -ne $rawServerCode -and $knownSafeErrorCodes -contains $rawServerCode) {
                $rawServerCode
            } elseif ($null -ne $rawServerCode) {
                "UNRECOGNIZED_PROVIDER_ERROR"
            } else {
                $safeErrorClass
            }

            return @{
                Status = "Indeterminate"
                AccessToken = $null
                User = $null
                StatusCode = $statusCode
                ErrorCode = $safeReportedCode
                Error = "Indeterminate GoTrue response (Classification: $safeErrorClass, Code: $safeReportedCode). State preserved."
            }
        }
    }

    # Dedicated Helper for Resumable, Fail-Closed Pending Mutation Journal Recovery
    function Resolve-PendingMutationJournal {
        param(
            [string]$JournalFile,
            [string]$TargetCredFile,
            [System.Collections.Generic.Dictionary[string, System.Security.SecureString]]$Store,
            [array]$ApprovedAccountsList,
            [string]$TargetUrl,
            [hashtable]$Headers,
            [string]$UserAgent,
            [string]$ExpectedHostName,
            [string]$ExpectedProject
        )

        $credDir = Split-Path -Parent $JournalFile
        $journalBaseName = Split-Path -Leaf $JournalFile
        $quarantineMarker = "$JournalFile.unresolved_quarantine"
        $existingQuarantines = if (Test-Path $credDir) {
            Get-ChildItem -Path $credDir -Filter "$journalBaseName.corrupt.*" -ErrorAction SilentlyContinue
        } else { $null }

        # Durable Quarantine Guard: If prior corrupted/unauthorized evidence exists, refuse execution across runs
        if ((Test-Path $quarantineMarker) -or ($null -ne $existingQuarantines -and $existingQuarantines.Count -gt 0)) {
            Write-Error "[FATAL SAFETY GUARD] Unresolved quarantined mutation journal evidence detected in $credDir. Previous corrupted or unauthorized journal evidence must be manually reconciled before rotation can proceed. Refusing mutation and failing closed."
            exit 1
        }

        if (-not (Test-Path $JournalFile)) {
            return $null
        }

        Write-Host "  [RECOVERY CHECK] Found pending mutation journal at: $JournalFile" -ForegroundColor Yellow

        # Step 1: Read & validate journal integrity
        $pendingJournal = $null
        try {
            $pendingJournal = Import-Clixml -Path $JournalFile
        } catch {
            # Corrupted Clixml: DO NOT delete; quarantine for forensics and set durable marker
            $quarantinePath = "$JournalFile.corrupt.$([DateTime]::UtcNow.ToString('yyyyMMddTHHmmssffffZ'))"
            Move-Item -Path $JournalFile -Destination $quarantinePath -Force -ErrorAction SilentlyContinue
            [System.IO.File]::WriteAllText($quarantineMarker, "Unresolved quarantined journal at $quarantinePath at $([DateTime]::UtcNow.ToString('o'))")
            Write-Error "[FATAL] Pending mutation journal at $JournalFile is corrupted and could not be deserialized. Quarantined to $quarantinePath. Preserving evidence and failing closed."
            exit 1
        }

        if ($null -eq $pendingJournal -or -not ($pendingJournal -is [hashtable])) {
            $quarantinePath = "$JournalFile.corrupt.$([DateTime]::UtcNow.ToString('yyyyMMddTHHmmssffffZ'))"
            Move-Item -Path $JournalFile -Destination $quarantinePath -Force -ErrorAction SilentlyContinue
            [System.IO.File]::WriteAllText($quarantineMarker, "Unresolved quarantined journal at $quarantinePath at $([DateTime]::UtcNow.ToString('o'))")
            Write-Error "[FATAL] Pending mutation journal at $JournalFile does not contain valid hashtable structure. Quarantined to $quarantinePath. Failing closed."
            exit 1
        }

        # Step 2: Validate SchemaVersion & MutationState Invariants
        if ($pendingJournal.SchemaVersion -ne "1.0") {
            Write-Error "[FATAL SECURITY VIOLATION] Pending mutation journal unsupported SchemaVersion '$($pendingJournal.SchemaVersion)' (expected '1.0'). Preserving journal at $JournalFile and failing closed."
            exit 1
        }

        if ($pendingJournal.MutationState -ne "PendingRemotePut") {
            Write-Error "[FATAL SECURITY VIOLATION] Pending mutation journal unsupported MutationState '$($pendingJournal.MutationState)' (expected 'PendingRemotePut'). Preserving journal at $JournalFile and failing closed."
            exit 1
        }

        if ([string]::IsNullOrWhiteSpace($pendingJournal.Timestamp)) {
            Write-Error "[FATAL SECURITY VIOLATION] Pending mutation journal missing required Timestamp. Preserving journal at $JournalFile and failing closed."
            exit 1
        }

        # Step 3: Validate Target Host & Project Guard
        if ($pendingJournal.TargetProject -ne $ExpectedProject -or $pendingJournal.TargetHost -ne $ExpectedHostName) {
            Write-Error "[FATAL SECURITY VIOLATION] Pending mutation journal target project mismatch! Journal project: '$($pendingJournal.TargetProject)' (expected: '$ExpectedProject'), Host: '$($pendingJournal.TargetHost)' (expected: '$ExpectedHostName'). Preserving journal at $JournalFile and failing closed."
            exit 1
        }

        # Step 4: Validate Role, Account UUID, Email, Company ID, and SecureString Password
        $pRole = $pendingJournal.PendingRole
        $pUserId = $pendingJournal.PendingUserId
        $pEmail = $pendingJournal.PendingEmail
        $pCompanyId = $pendingJournal.PendingCompanyId
        $pPwd = $pendingJournal.PendingPassword

        if (-not $pRole -or -not $pUserId -or -not $pEmail -or -not $pCompanyId -or -not $pPwd) {
            Write-Error "[FATAL SECURITY VIOLATION] Pending mutation journal missing required identity fields (Role: '$pRole', UserId: '$pUserId', Email: '$pEmail', CompanyId: '$pCompanyId'). Preserving journal at $JournalFile and failing closed."
            exit 1
        }

        if (-not ($pPwd -is [System.Security.SecureString])) {
            Write-Error "[FATAL SECURITY VIOLATION] Pending mutation journal PendingPassword is not a valid SecureString. Preserving journal at $JournalFile and failing closed."
            exit 1
        }

        $matchedAcct = $ApprovedAccountsList | Where-Object { $_.Role -eq $pRole -and $_.Id -eq $pUserId -and $_.Email -eq $pEmail }
        if (-not $matchedAcct) {
            Write-Error "[FATAL SECURITY VIOLATION] Pending mutation journal references unknown or unauthorized identity ($pRole / $pUserId / $pEmail). Preserving journal at $JournalFile and failing closed."
            exit 1
        }

        if ($pCompanyId -ne $matchedAcct.CompanyId) {
            Write-Error "[FATAL SECURITY VIOLATION] Pending mutation journal PendingCompanyId '$pCompanyId' does not match approved company ID '$($matchedAcct.CompanyId)' for $($matchedAcct.Email). Preserving journal at $JournalFile and failing closed."
            exit 1
        }

        # Step 5: Interrogate GoTrue with the pending password
        Write-Host "  Verifying if interrupted mutation for $($matchedAcct.Email) ($pRole) succeeded remotely..." -ForegroundColor Cyan
        $verifyAuth = Test-GoTruePassword -Email $matchedAcct.Email -SecurePwd $pPwd -TargetUrl $TargetUrl -Headers $Headers -UserAgent $UserAgent

        if ($verifyAuth.Status -eq "Success" -and $verifyAuth.User.id -eq $matchedAcct.Id) {
            Write-Host "  [JOURNAL RECOVERED] Interrupted mutation for $($matchedAcct.Email) succeeded remotely. Committing to primary DPAPI store." -ForegroundColor Green
            $Store[$pRole] = $pPwd
            # Commit to DPAPI store BEFORE deleting journal
            Save-DpapiStoreAtomic -Store $Store -DestinationPath $TargetCredFile
            # Verified journal deletion: fail closed if deletion fails or file remains
            try {
                Remove-Item -Path $JournalFile -Force -ErrorAction Stop
            } catch {
                Write-Error "[FATAL] Failed to delete pending journal at $JournalFile after DPAPI store commit: $($_.Exception.Message). Preserving file and failing closed."
                exit 1
            }
            if (Test-Path $JournalFile) {
                Write-Error "[FATAL] Pending journal still exists at $JournalFile after deletion attempt. Failing closed."
                exit 1
            }
            Write-Host "  [JOURNAL RESOLVED] Successfully committed recovered credential to DPAPI and removed pending journal." -ForegroundColor Green
            return @{
                Status = "Recovered"
                Role = $pRole
                AccessToken = $verifyAuth.AccessToken
            }
        } elseif ($verifyAuth.Status -eq "InvalidCredentials") {
            # Definitive proof that the pending password was NOT applied to GoTrue
            Write-Host "  [JOURNAL DISCARD] Interrupted mutation for $($matchedAcct.Email) did not take effect remotely (GoTrue definitively rejected pending password with code $($verifyAuth.ErrorCode)). Safely clearing pending journal." -ForegroundColor Yellow
            try {
                Remove-Item -Path $JournalFile -Force -ErrorAction Stop
            } catch {
                Write-Error "[FATAL] Failed to delete pending journal at $JournalFile during discard: $($_.Exception.Message). Preserving file and failing closed."
                exit 1
            }
            if (Test-Path $JournalFile) {
                Write-Error "[FATAL] Pending journal still exists at $JournalFile after discard deletion attempt. Failing closed."
                exit 1
            }
            return @{
                Status = "Discarded"
                Role = $pRole
            }
        } else {
            # Indeterminate status (timeout, 5xx, transport drop, non-credential 400, etc.)
            # DO NOT DELETE THE JOURNAL! Fail closed to preserve recovery evidence.
            Write-Error "[FATAL] Unable to determine if interrupted mutation for $($matchedAcct.Email) took effect remotely ($($verifyAuth.Error)). Preserving journal at $JournalFile for recovery. Failing closed."
            exit 1
        }
    }

    # Crash recovery: Check if an interrupted pending mutation journal exists from prior aborted run
    $recoveredResult = Resolve-PendingMutationJournal `
        -JournalFile $journalPath `
        -TargetCredFile $credPath `
        -Store $credStore `
        -ApprovedAccountsList $approvedAccounts `
        -TargetUrl $loginUrl `
        -Headers $tokenHeaders `
        -UserAgent $cliUserAgent `
        -ExpectedHostName $expectedHost `
        -ExpectedProject $stagingRef

    if ($null -ne $recoveredResult -and $recoveredResult.Status -eq "Recovered") {
        $authTokens[$recoveredResult.Role] = $recoveredResult.AccessToken
    }

    foreach ($acct in $approvedAccounts) {
        # Check if user already authenticates with existing DPAPI-stored password
        if ($credStore.ContainsKey($acct.Role) -and ($null -ne $credStore[$acct.Role])) {
            Write-Host "  Checking existing DPAPI credentials for $($acct.Email)..." -ForegroundColor Cyan
            $preAuth = Test-GoTruePassword -Email $acct.Email -SecurePwd $credStore[$acct.Role] -TargetUrl $loginUrl -Headers $tokenHeaders -UserAgent $cliUserAgent
            if ($preAuth.Status -eq "Success") {
                if ($preAuth.User.id -ne $acct.Id) {
                    Write-Error "[FATAL SECURITY VIOLATION] Existing DPAPI credential authenticated successfully as user '$($preAuth.User.id)', but expected synthetic account ID '$($acct.Id)' ($($acct.Email))! Identity mismatch detected. Failing closed."
                    exit 1
                }
                Write-Host "  [IDEMPOTENT / VERIFIED] User $($acct.Email) ($($acct.Role)) already has verified credentials in DPAPI store and logs in successfully." -ForegroundColor Green
                $authTokens[$acct.Role] = $preAuth.AccessToken
                continue
            } elseif ($preAuth.Status -eq "Indeterminate") {
                Write-Error "[FATAL] Preflight authentication check for $($acct.Email) failed with indeterminate error ($($preAuth.Error)). Preserving state and failing closed."
                exit 1
            }
        }

        # User requires rotation: generate new random 32-char password
        Write-Host "  Rotating password for $($acct.Email) ($($acct.Role))..." -ForegroundColor Cyan
        $newPwd = New-SecurePassword -Length 32

        # Pre-mutation guard: Never overwrite an existing pending journal!
        if (Test-Path $journalPath) {
            Write-Error "[FATAL INTEGRITY VIOLATION] A pending mutation journal already exists at $journalPath. Refusing to overwrite journal for $($acct.Email). Failing closed."
            exit 1
        }

        # Step A: Record pending mutation journal BEFORE remote Admin PUT
        $journalEntry = @{
            SchemaVersion = "1.0"
            TargetHost = $expectedHost
            TargetProject = $stagingRef
            PendingRole = $acct.Role
            PendingUserId = $acct.Id
            PendingEmail = $acct.Email
            PendingCompanyId = $acct.CompanyId
            PendingPassword = ConvertTo-SecureString $newPwd -AsPlainText -Force
            Timestamp = [DateTime]::UtcNow.ToString("o")
            MutationState = "PendingRemotePut"
        }
        $jTmp = "$journalPath.tmp.$([System.Guid]::NewGuid().ToString('N'))"
        try {
            $journalEntry | Export-Clixml -Path $jTmp
            if (-not (Test-Path $jTmp) -or (Get-Item $jTmp).Length -eq 0) {
                throw "Temporary journal file missing or zero-length: $jTmp"
            }
            if (Test-Path $journalPath) {
                [System.IO.File]::Replace($jTmp, $journalPath, $null)
            } else {
                [System.IO.File]::Move($jTmp, $journalPath)
            }
        } finally {
            if (Test-Path $jTmp) {
                Remove-Item -Path $jTmp -Force -ErrorAction SilentlyContinue
            }
        }

        # Step B: Perform Auth Admin PUT
        $updateUrl = "$StagingUrl/auth/v1/admin/users/$($acct.Id)"
        $updateBody = @{ password = $newPwd } | ConvertTo-Json
        $updateHeaders = Get-AdminHeaders -adminKey $adminKeyPlain
        $updateHeaders["Content-Type"] = "application/json"

        try {
            $updateRes = Invoke-RestMethod -Uri $updateUrl -Method Put -Headers $updateHeaders -Body $updateBody -UserAgent $cliUserAgent -MaximumRedirection 0
        } catch {
            Write-SanitizedApiError -Endpoint "/auth/v1/admin/users/$($acct.Id) [PUT]" -ErrorRecord $_ -AdminKeyType $adminKeyType -UserAgent $cliUserAgent -TargetHost $expectedHost -ProjectRef $stagingRef
            exit 1
        }

        if ($updateRes.id -ne $acct.Id) {
            Write-Error "[FATAL] Unexpected response when updating $($acct.Email). Preserving pending mutation journal at $journalPath."
            exit 1
        }

        # Step C: Immediate login verification with publishable key
        $postAuth = Test-GoTruePassword -Email $acct.Email -SecurePwd (ConvertTo-SecureString $newPwd -AsPlainText -Force) -TargetUrl $loginUrl -Headers $tokenHeaders -UserAgent $cliUserAgent
        if ($postAuth.Status -ne "Success" -or $postAuth.User.id -ne $acct.Id) {
            Write-Error "[FATAL] Post-rotation login verification failed for $($acct.Email): $($postAuth.Error). Preserving pending mutation journal at $journalPath for recovery."
            exit 1
        }

        # Step D: Re-verify company membership unchanged post-rotation
        $postMemberUrl = "$StagingUrl/rest/v1/company_members?user_id=eq.$($acct.Id)&select=id,company_id,role"
        try {
            $postMemberRes = Invoke-RestMethod -Uri $postMemberUrl -Method Get -Headers (Get-AdminHeaders -adminKey $adminKeyPlain) -UserAgent $cliUserAgent -MaximumRedirection 0
        } catch {
            Write-SanitizedApiError -Endpoint "/rest/v1/company_members?user_id=eq.$($acct.Id) [POST-CHECK]" -ErrorRecord $_ -AdminKeyType $adminKeyType -UserAgent $cliUserAgent -TargetHost $expectedHost -ProjectRef $stagingRef
            exit 1
        }

        if ($postMemberRes.Count -eq 0 -or $postMemberRes[0].company_id -ne $acct.CompanyId) {
            Write-Error "[FATAL] Post-rotation membership altered for $($acct.Email)! Preserving pending mutation journal at $journalPath."
            exit 1
        }

        # Step E: Atomic commit to primary DPAPI store & remove pending journal
        $credStore[$acct.Role] = ConvertTo-SecureString $newPwd -AsPlainText -Force
        Save-DpapiStoreAtomic -Store $credStore -DestinationPath $credPath
        # Verified journal removal: fail closed if deletion fails or file remains
        try {
            Remove-Item -Path $journalPath -Force -ErrorAction Stop
        } catch {
            Write-Error "[FATAL] Failed to remove pending mutation journal at $journalPath after store commit: $($_.Exception.Message). Failing closed."
            exit 1
        }
        if (Test-Path $journalPath) {
            Write-Error "[FATAL] Pending mutation journal still exists at $journalPath after deletion attempt. Failing closed."
            exit 1
        }
        Write-Host "  [ROTATED, VERIFIED & COMMITTED] $($acct.Email) password rotated, authenticated via GoTrue, and committed to DPAPI store." -ForegroundColor Green

        $authTokens[$acct.Role] = $postAuth.AccessToken
        $newPwd = $null
    }

    Write-Host "`nAll 4 synthetic user accounts verified/rotated in GoTrue and stored in DPAPI." -ForegroundColor Green

} finally {
    # 8. Clean Up Administrative Key from Memory Immediately
    $adminKeyPlain = $null
    $secureAdminKey = $null
    [System.GC]::Collect()
}

# 9. Handle RotateOnly Mode: Clean exit with zero integration tests
if ($RotateOnly) {
    Write-Host "`n============================================================================" -ForegroundColor Green
    Write-Host " [PASSWORD ROTATION COMPLETE]: All 4 synthetic passwords successfully verified" -ForegroundColor Green
    Write-Host " and authenticated via genuine GoTrue login in project $expectedHost." -ForegroundColor Green
    Write-Host " Encrypted credentials persisted to: $credPath" -ForegroundColor Green
    Write-Host " ZERO INTEGRATION TESTS EXECUTED (-RotateOnly mode)." -ForegroundColor Green
    Write-Host " To execute live integration tests independently, run:" -ForegroundColor Green
    Write-Host "   powershell -NoProfile -ExecutionPolicy RemoteSigned -File `".\scripts\rotate_staging_synthetic_passwords.ps1`" -RunLiveTests" -ForegroundColor Green
    Write-Host "============================================================================`n" -ForegroundColor Green
    return
}

