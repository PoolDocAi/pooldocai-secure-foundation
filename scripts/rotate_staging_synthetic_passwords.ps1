# ============================================================================
# POOLDOCAI TASK-008 PART-1C: ONE-TIME STAGING SYNTHETIC PASSWORD ROTATION & LIVE VERIFICATION
# Target: Dedicated Supabase Staging Project rzkgmvyyeclrpomrlyft ONLY
# Strictly Approved: Issue #15 Comment #6400745188 (Owner Authorization)
#
# Safety Boundaries:
# - Aborts immediately if host is NOT rzkgmvyyeclrpomrlyft.supabase.co
# - Aborts immediately if host contains owfeebydlyacssqpnmkq (production)
# - Rotates passwords ONLY for the four pre-approved synthetic test accounts
# - Never creates users, deletes users, or touches schemas
# - Accepts admin key via non-echoing prompt (Read-Host -AsSecureString)
# - Never echoes, logs, or transmits key material
# - Stores rotated passwords encrypted with Windows DPAPI outside the git repository
# ============================================================================

[CmdletBinding()]
param(
    [string]$StagingUrl = "https://rzkgmvyyeclrpomrlyft.supabase.co"
)

$ErrorActionPreference = "Stop"

Write-Host "============================================================================" -ForegroundColor Cyan
Write-Host " POOLDOCAI: STAGING SYNTHETIC PASSWORD ROTATION & LIVE TEST RUNNER" -ForegroundColor Cyan
Write-Host " Target: $StagingUrl" -ForegroundColor Cyan
Write-Host "============================================================================`n" -ForegroundColor Cyan

# 1. Strict Target Host Guard
$expectedHost = "rzkgmvyyeclrpomrlyft.supabase.co"
$prodRef = "owfeebydlyacssqpnmkq"

$uri = [System.Uri]$StagingUrl
if ($uri.Host.ToLower() -ne $expectedHost) {
    Write-Error "[FATAL SECURITY VIOLATION] Target host '$($uri.Host)' does not match expected staging host '$expectedHost'. Aborting."
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

# 3. Prompt for Staging Service-Role Admin Key (Non-echoing)
Write-Host "Please enter the Supabase Staging Administrative Key (Service Role / Secret Key)." -ForegroundColor Yellow
Write-Host "Input is completely masked and will not be echoed, logged, or saved to disk." -ForegroundColor Yellow
$secureAdminKey = Read-Host "Staging Service Role Key" -AsSecureString

if ($null -eq $secureAdminKey -or $secureAdminKey.Length -eq 0) {
    Write-Error "No administrative key provided. Aborting."
    exit 1
}

# 4. Prompt for Staging Publishable / Anon Key (Non-echoing)
$secureAnonKey = $null
if ($env:STAGING_SUPABASE_ANON_KEY) {
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

# Convert admin key to transient string
$bstrAdmin = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureAdminKey)
$adminKeyPlain = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($bstrAdmin)
[System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstrAdmin)

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
    # 5. Preflight Verification: Check all 4 accounts via Auth Admin API
    Write-Host "`n--- Step 1: Preflight Verification via Staging Auth Admin API ---" -ForegroundColor Cyan
    $adminHeaders = @{
        "apikey" = $adminKeyPlain
        "Authorization" = "Bearer $adminKeyPlain"
        "Accept" = "application/json"
    }

    foreach ($acct in $approvedAccounts) {
        $userUrl = "$StagingUrl/auth/v1/admin/users/$($acct.Id)"
        try {
            $userRes = Invoke-RestMethod -Uri $userUrl -Method Get -Headers $adminHeaders
        } catch {
            Write-Error "[FATAL] Failed to fetch user $($acct.Email) via Auth Admin: $($_.Exception.Message)"
            exit 1
        }

        if ($userRes.id -ne $acct.Id -or $userRes.email -ne $acct.Email) {
            Write-Error "[FATAL] Allowlist mismatch! Expected: $($acct.Id) / $($acct.Email), Found: $($userRes.id) / $($userRes.email)"
            exit 1
        }

        # Verify company membership
        $memberUrl = "$StagingUrl/rest/v1/company_members?user_id=eq.$($acct.Id)&select=id,company_id,role"
        $memberRes = Invoke-RestMethod -Uri $memberUrl -Method Get -Headers $adminHeaders
        if ($memberRes.Count -eq 0 -or $memberRes[0].company_id -ne $acct.CompanyId) {
            Write-Error "[FATAL] Membership mismatch for user $($acct.Email)! Expected company $($acct.CompanyId)"
            exit 1
        }

        Write-Host "  [PREFLIGHT PASS] $($acct.Email) ($($acct.Id)) confirmed in $($acct.CompanyName)" -ForegroundColor Green
    }

    # 6. Generate 4 Independent Secure Passwords & Rotate
    Write-Host "`n--- Step 2: Generating Secure Passwords & Rotating via Auth Admin ---" -ForegroundColor Cyan
    $passwords = @{}
    $secureStore = [System.Collections.Generic.Dictionary[string, System.Security.SecureString]]::new()

    foreach ($acct in $approvedAccounts) {
        $newPwd = New-SecurePassword -Length 32
        $passwords[$acct.Role] = $newPwd
        $secureStore[$acct.Role] = ConvertTo-SecureString $newPwd -AsPlainText -Force

        $updateUrl = "$StagingUrl/auth/v1/admin/users/$($acct.Id)"
        $updateBody = @{ password = $newPwd } | ConvertTo-Json
        $updateHeaders = @{
            "apikey" = $adminKeyPlain
            "Authorization" = "Bearer $adminKeyPlain"
            "Content-Type" = "application/json"
            "Accept" = "application/json"
        }

        try {
            $updateRes = Invoke-RestMethod -Uri $updateUrl -Method Put -Headers $updateHeaders -Body $updateBody
        } catch {
            Write-Error "[FATAL] Failed to update password for $($acct.Email): $($_.Exception.Message)"
            exit 1
        }

        if ($updateRes.id -ne $acct.Id) {
            Write-Error "[FATAL] Unexpected response when updating $($acct.Email)"
            exit 1
        }

        Write-Host "  [ROTATION SUCCESS] Rotated password for $($acct.Email) ($($acct.Id))" -ForegroundColor Green
    }

    # 7. Post-Rotation Verification: Perform Genuine GoTrue Password Sign-ins
    Write-Host "`n--- Step 3: Verifying Authentic GoTrue Logins with Staging Publishable Key ---" -ForegroundColor Cyan
    $authTokens = @{}
    $tokenHeaders = @{
        "apikey" = $anonKeyPlain
        "Content-Type" = "application/json"
        "Accept" = "application/json"
    }

    foreach ($acct in $approvedAccounts) {
        $loginUrl = "$StagingUrl/auth/v1/token?grant_type=password"
        $loginBody = @{
            email = $acct.Email
            password = $passwords[$acct.Role]
        } | ConvertTo-Json

        try {
            $loginRes = Invoke-RestMethod -Uri $loginUrl -Method Post -Headers $tokenHeaders -Body $loginBody
        } catch {
            Write-Error "[FATAL] GoTrue login failed for $($acct.Email): $($_.Exception.Message)"
            exit 1
        }

        if (-not $loginRes.access_token -or $loginRes.user.id -ne $acct.Id) {
            Write-Error "[FATAL] Invalid login response for $($acct.Email)"
            exit 1
        }

        $authTokens[$acct.Role] = $loginRes.access_token
        Write-Host "  [LOGIN VERIFIED] Authentic GoTrue token received for $($acct.Email)" -ForegroundColor Green
    }

    # 8. Save Rotated Passwords Encrypted with Windows DPAPI Outside Git Repo
    Write-Host "`n--- Step 4: Storing Credentials with Windows DPAPI (Outside Repo) ---" -ForegroundColor Cyan
    $credPath = Join-Path $env:USERPROFILE ".pooldocai_staging_credentials.xml"
    $secureStore | Export-Clixml -Path $credPath
    Write-Host "  [DPAPI SAVED] Passwords encrypted and saved to: $credPath" -ForegroundColor Green

} finally {
    # 9. Clean Up Administrative Secrets from Memory Immediately
    $adminKeyPlain = $null
    $secureAdminKey = $null
    [System.GC]::Collect()
}

# 10. Execute Live Tenant-Isolation Test Suite with Verified Tokens
Write-Host "`n============================================================================" -ForegroundColor Cyan
Write-Host " EXECUTING REAL STAGING TENANT-ISOLATION SUITE (29 ASSERTIONS)" -ForegroundColor Cyan
Write-Host "============================================================================`n" -ForegroundColor Cyan

$env:STAGING_SUPABASE_URL = $StagingUrl
$env:STAGING_SUPABASE_ANON_KEY = $anonKeyPlain
$env:STAGING_AUTH_TOKENS = ($authTokens | ConvertTo-Json -Compress)
$env:REQUIRE_LIVE_STAGING = "1"

# Run the test suite
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
} finally {
    Pop-Location
}
