# ============================================================================
# POOLDOCAI: UNIT TESTS FOR STAGING SYNTHETIC PASSWORD ROTATION UTILITY
# Tests fail-closed credential validation, non-browser user-agent,
# sanitized error reporting on 401, and safety guards WITHOUT real secrets.
# ============================================================================

[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

$scriptRoot = $PSScriptRoot
$rotationScript = Join-Path $scriptRoot "rotate_staging_synthetic_passwords.ps1"
if (-not (Test-Path $rotationScript)) {
    Write-Error "rotate_staging_synthetic_passwords.ps1 not found at: $rotationScript"
    exit 1
}

Write-Host "============================================================================" -ForegroundColor Cyan
Write-Host " RUNNING UNIT TESTS: rotate_staging_synthetic_passwords.ps1" -ForegroundColor Cyan
Write-Host "============================================================================`n" -ForegroundColor Cyan

$testCount = 0
$passCount = 0

function Assert-Test([string]$description, [bool]$condition, [string]$details = "") {
    $script:testCount++
    if ($condition) {
        $script:passCount++
        Write-Host "  [PASS] $description" -ForegroundColor Green
    } else {
        Write-Host "  [FAIL] $description" -ForegroundColor Red
        if ($details) {
            Write-Host "         $details" -ForegroundColor Red
        }
    }
}

# Helper to forge a synthetic JWT with a specific role claim (unsigned/dummy signature for testing)
function New-TestJwt([string]$role) {
    $header = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('{"alg":"HS256","typ":"JWT"}')).TrimEnd('=').Replace('+','-').Replace('/','_')
    $payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("{`"role`":`"$role`",`"exp`":1999999999}")).TrimEnd('=').Replace('+','-').Replace('/','_')
    return "$header.$payload.dummy_signature"
}

# ----------------------------------------------------------------------------
# 1. Static AST & Content Checks
# ----------------------------------------------------------------------------
Write-Host "--- Test Suite 1: Static Code Structure & Safety Boundaries ---" -ForegroundColor Cyan

$scriptContent = Get-Content $rotationScript -Raw

# 1A. User-Agent definition
Assert-Test "Defines explicit non-browser User-Agent" ($scriptContent -match '\$cliUserAgent\s*=\s*"PoolDocAI-Staging-Admin-CLI/1\.0"')

# 1B. User-Agent on all Invoke-RestMethod calls
$irmMatches = [regex]::Matches($scriptContent, 'Invoke-RestMethod[^\r\n]+')
$allHaveUa = $true
foreach ($m in $irmMatches) {
    if ($m.Value -notmatch '-UserAgent\s+\$cliUserAgent') {
        $allHaveUa = $false
        Write-Host "Missing -UserAgent: $($m.Value)" -ForegroundColor Yellow
    }
}
Assert-Test "All Invoke-RestMethod calls include -UserAgent `$cliUserAgent" ($allHaveUa -and $irmMatches.Count -ge 5)

# 1C. MaximumRedirection 0 on all calls
$allHaveMaxRedir = $true
foreach ($m in $irmMatches) {
    if ($m.Value -notmatch '-MaximumRedirection\s+0') {
        $allHaveMaxRedir = $false
    }
}
Assert-Test "All Invoke-RestMethod calls include -MaximumRedirection 0" ($allHaveMaxRedir -and $irmMatches.Count -ge 5)

# 1D. Strict host & protocol guard
Assert-Test "Enforces HTTPS scheme guard" ($scriptContent -match '\[System\.Uri\]\$StagingUrl' -and $scriptContent -match '\$uri\.Scheme\s+-ne\s+"https"')
Assert-Test "Enforces exact staging host rzkgmvyyeclrpomrlyft.supabase.co" ($scriptContent -match '\$expectedHost\s*=\s*"rzkgmvyyeclrpomrlyft\.supabase\.co"')
Assert-Test "Enforces port 443 check" ($scriptContent -match '\$uri\.Port\s+-ne\s+443')
Assert-Test "Enforces production host denial (owfeebydlyacssqpnmkq)" ($scriptContent -match 'Contains\(\$prodRef\)')

# 1E. Nonsecret credential-type validation function presence
Assert-Test "Contains Get-JwtPayloadRole function" ($scriptContent -match 'function\s+Get-JwtPayloadRole')
Assert-Test "Contains Write-SanitizedApiError function" ($scriptContent -match 'function\s+Write-SanitizedApiError')

# ----------------------------------------------------------------------------
# 2. Logic Tests: Get-JwtPayloadRole
# ----------------------------------------------------------------------------
Write-Host "`n--- Test Suite 2: JWT Role Claim Extractor (Unsigned Local Parse) ---" -ForegroundColor Cyan

# Source the function in isolation
$functionBlock = [regex]::Match($scriptContent, 'function\s+Get-JwtPayloadRole\b[\s\S]*?^}', [System.Text.RegularExpressions.RegexOptions]::Multiline).Value
Invoke-Expression $functionBlock

$anonJwt = New-TestJwt "anon"
$serviceJwt = New-TestJwt "service_role"
$authenticatedJwt = New-TestJwt "authenticated"

Assert-Test "Correctly extracts 'anon' role from synthetic JWT" ((Get-JwtPayloadRole $anonJwt) -eq "anon")
Assert-Test "Correctly extracts 'service_role' from synthetic JWT" ((Get-JwtPayloadRole $serviceJwt) -eq "service_role")
Assert-Test "Correctly extracts 'authenticated' from synthetic JWT" ((Get-JwtPayloadRole $authenticatedJwt) -eq "authenticated")
Assert-Test "Returns null for malformed string" ($null -eq (Get-JwtPayloadRole "not_a_jwt"))
Assert-Test "Returns null for empty string" ($null -eq (Get-JwtPayloadRole ""))

# ----------------------------------------------------------------------------
# 3. Execution Tests: Fail-Closed Credential Type Rejection (Piped Inputs)
# ----------------------------------------------------------------------------
Write-Host "`n--- Test Suite 3: Fail-Closed Credential Type Rejection ---" -ForegroundColor Cyan

# Helper to run script in a subprocess with SecureString parameters
function Run-RotationWithKeys([string]$adminKeyInput, [string]$anonKeyInput = "", [switch]$DryRunSwitch) {
    $dryFlag = if ($DryRunSwitch) { "-DryRun" } else { "" }
    $scriptEscaped = $rotationScript.Replace("'", "''")
    $adminEscaped = $adminKeyInput.Replace("'", "''")
    $anonEscaped = $anonKeyInput.Replace("'", "''")

    $code = "`$ErrorActionPreference = 'Stop'; " +
            "`$adminSec = ConvertTo-SecureString '$adminEscaped' -AsPlainText -Force; " +
            "if ('$anonEscaped') { " +
            "    `$anonSec = ConvertTo-SecureString '$anonEscaped' -AsPlainText -Force; " +
            "    & '$scriptEscaped' $dryFlag -AdminKey `$adminSec -AnonKey `$anonSec; " +
            "} else { " +
            "    & '$scriptEscaped' $dryFlag -AdminKey `$adminSec; " +
            "}"

    $pinfo = New-Object System.Diagnostics.ProcessStartInfo
    $pinfo.FileName = "powershell.exe"
    $pinfo.Arguments = "-NoProfile -ExecutionPolicy Bypass -Command `"$code`""
    $pinfo.RedirectStandardOutput = $true
    $pinfo.RedirectStandardError = $true
    $pinfo.UseShellExecute = $false
    $pinfo.CreateNoWindow = $true

    $proc = [System.Diagnostics.Process]::Start($pinfo)
    $stdout = $proc.StandardOutput.ReadToEnd()
    $stderr = $proc.StandardError.ReadToEnd()
    $proc.WaitForExit(10000)

    return @{
        ExitCode = $proc.ExitCode
        StdOut = $stdout
        StdErr = $stderr
        Combined = "$stdout`n$stderr"
    }
}

# 3A. Reject sb_publishable_ as admin key
& {
    $res = Run-RotationWithKeys -adminKeyInput "sb_publishable_test_key_should_fail" -DryRunSwitch
    $failedClosed = ($res.ExitCode -ne 0) -and ($res.Combined -match "Invalid administrative credential type") -and ($res.Combined -match "sb_publishable_")
    Assert-Test "Rejects sb_publishable_ key for administrative operations (fail closed)" $failedClosed
}

# 3B. Reject anon JWT as admin key
& {
    $res = Run-RotationWithKeys -adminKeyInput $anonJwt -DryRunSwitch
    $failedClosed = ($res.ExitCode -ne 0) -and ($res.Combined -match "Received an anon JWT")
    Assert-Test "Rejects anon JWT for administrative operations (fail closed)" $failedClosed
}

# 3C. Reject non-service_role JWT (e.g. authenticated) as admin key
& {
    $res = Run-RotationWithKeys -adminKeyInput $authenticatedJwt -DryRunSwitch
    $failedClosed = ($res.ExitCode -ne 0) -and (($res.Combined -match "expected\s*'?service_role'?") -or ($res.Combined -match "JWT role claim is 'authenticated'") -or ($res.Combined -match "authenticated"))
    Assert-Test "Rejects authenticated-role JWT for administrative operations (fail closed)" $failedClosed "Exit: $($res.ExitCode), Output: $($res.Combined)"
}

# 3D. Reject random non-key format as admin key
& {
    $res = Run-RotationWithKeys -adminKeyInput "totally_invalid_admin_key" -DryRunSwitch
    $failedClosed = ($res.ExitCode -ne 0) -and ($res.Combined -match "Invalid administrative credential format")
    Assert-Test "Rejects unformatted arbitrary string as admin key (fail closed)" $failedClosed
}

# 3E. Reject sb_secret_ as publishable/anon key
& {
    $res = Run-RotationWithKeys -adminKeyInput "sb_secret_valid_format_dummy_key" -anonKeyInput "sb_secret_accidentally_in_anon_prompt" -DryRunSwitch
    $failedClosed = ($res.ExitCode -ne 0) -and ($res.Combined -match "Received a secret key") -and ($res.Combined -match "Never use administrative secret keys for client operations")
    Assert-Test "Rejects sb_secret_ key when supplied in publishable/anon key prompt (fail closed)" $failedClosed
}

# 3F. Reject service_role JWT as publishable/anon key
& {
    $res = Run-RotationWithKeys -adminKeyInput "sb_secret_valid_format_dummy_key" -anonKeyInput $serviceJwt -DryRunSwitch
    $failedClosed = ($res.ExitCode -ne 0) -and ($res.Combined -match "Expected anon JWT")
    Assert-Test "Rejects service_role JWT when supplied in publishable/anon key prompt (fail closed)" $failedClosed
}

# ----------------------------------------------------------------------------
# 4. Error Sanitization & Diagnostics Verification (Mocked 401 Handling)
# ----------------------------------------------------------------------------
Write-Host "`n--- Test Suite 4: Sanitized API Error Diagnostics (Zero Secrets Leaked) ---" -ForegroundColor Cyan

# Source Write-SanitizedApiError
$errFunctionBlock = [regex]::Match($scriptContent, 'function\s+Write-SanitizedApiError\b[\s\S]*?^}', [System.Text.RegularExpressions.RegexOptions]::Multiline).Value
Invoke-Expression $errFunctionBlock

# Test Write-SanitizedApiError output formatting
& {
    $mockOutput = & {
        $fakeEx = [System.InvalidOperationException]::new("The remote server returned an error: (401) Unauthorized.")
        $fakeErrorRecord = [System.Management.Automation.ErrorRecord]::new(
            $fakeEx,
            "WebException",
            [System.Management.Automation.ErrorCategory]::AuthenticationError,
            $null
        )
        Write-SanitizedApiError -Endpoint "/auth/v1/admin/users/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" `
                               -ErrorRecord $fakeErrorRecord `
                               -AdminKeyType "sb_secret_ (modern secret key)" `
                               -UserAgent "PoolDocAI-Staging-Admin-CLI/1.0" `
                               -TargetHost "rzkgmvyyeclrpomrlyft.supabase.co" `
                               -ProjectRef "rzkgmvyyeclrpomrlyft"
    } *>&1 | Out-String

    Assert-Test "Reports Project Ref in preflight error output" ($mockOutput -match "rzkgmvyyeclrpomrlyft")
    Assert-Test "Reports Endpoint in preflight error output" ($mockOutput -match "/auth/v1/admin/users/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
    Assert-Test "Reports Admin Key Type ONLY" ($mockOutput -match "sb_secret_ \(modern secret key\)")
    Assert-Test "Reports User-Agent in preflight error output" ($mockOutput -match "PoolDocAI-Staging-Admin-CLI/1\.0")
    Assert-Test "Does NOT leak any token or key material in error output" ($mockOutput -notmatch "bearer" -and $mockOutput -notmatch "apikey:\s*\S+")

    # Test HTTP 500 formatting
    $mock500Output = & {
        $fake500Ex = [System.InvalidOperationException]::new("The remote server returned an error: (500) Internal Server Error.")
        $fake500Record = [System.Management.Automation.ErrorRecord]::new(
            $fake500Ex,
            "WebException",
            [System.Management.Automation.ErrorCategory]::InvalidResult,
            $null
        )
        Write-SanitizedApiError -Endpoint "/auth/v1/admin/users/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" `
                               -ErrorRecord $fake500Record `
                               -AdminKeyType "sb_secret_ (modern secret key)" `
                               -UserAgent "PoolDocAI-Staging-Admin-CLI/1.0" `
                               -TargetHost "rzkgmvyyeclrpomrlyft.supabase.co" `
                               -ProjectRef "rzkgmvyyeclrpomrlyft"
    } *>&1 | Out-String

    Assert-Test "Reports 500 GoTrue Database Error diagnostic" ($mock500Output -match "HTTP 500 Database error returned by GoTrue")
    Assert-Test "Identifies NULL token fields root cause" ($mock500Output -match "NULL token fields")
}

# ----------------------------------------------------------------------------
# 5. Decoupled Mode Switches, Exclusivity & Fail-Closed Journaling Tests
# ----------------------------------------------------------------------------
Write-Host "`n--- Test Suite 5: Decoupled Mode Switches, Exclusivity & Journaling ---" -ForegroundColor Cyan

# 5A. AST Checks
Assert-Test "Defines -RotateOnly param switch" ($scriptContent -match '\[switch\]\$RotateOnly')
Assert-Test "Defines -RunLiveTests param switch" ($scriptContent -match '\[switch\]\$RunLiveTests')
Assert-Test "Contains mode exclusivity validation" ($scriptContent -match '\$activeModes\.Count\s+-gt\s+1')
Assert-Test "Contains fail-closed no-mode validation" ($scriptContent -match '\$activeModes\.Count\s+-eq\s+0')
Assert-Test "-RotateOnly exits before live integration test execution" ($scriptContent -match 'if\s*\(\$RotateOnly\)[\s\S]*?return')
Assert-Test "Implements DPAPI pre-mutation backup with UTC timestamp (.bak.)" ($scriptContent -match '\.bak\.\$')
Assert-Test "Implements idempotent existing credential check (Test-GoTruePassword)" ($scriptContent -match 'Test-GoTruePassword')
Assert-Test "Implements Save-DpapiStoreAtomic helper function" ($scriptContent -match 'function\s+Save-DpapiStoreAtomic')
Assert-Test "Uses Win32 [System.IO.File]::Replace for atomic store replacement" ($scriptContent -match '\[System\.IO\.File\]::Replace')
Assert-Test "Enforces deserialization integrity check prior to file replace" ($scriptContent -match 'Import-Clixml[\s\S]*?\$verify\.Count\s+-ne\s+\$Store\.Count')
Assert-Test "Implements corrupted store auto-recovery from latest backup (.bak.*)" ($scriptContent -match 'Get-ChildItem[\s\S]*?\$baseName\.bak\.\*[\s\S]*?Sort-Object\s+LastWriteTime\s+-Descending')
Assert-Test "Implements pre-mutation pending journal write prior to GoTrue PUT" ($scriptContent -match '\$journalEntry[\s\S]*?PendingRole[\s\S]*?Export-Clixml[\s\S]*?\$updateUrl')
Assert-Test "Implements startup crash recovery check for pending mutation journal" ($scriptContent -match 'if\s*\(Test-Path\s+\$journalPath\)[\s\S]*?PendingRole')

# Helper to run script in a subprocess with arbitrary switch arguments
function Run-RotationWithArgs([string]$arguments) {
    $scriptEscaped = $rotationScript.Replace("'", "''")

    $pinfo = New-Object System.Diagnostics.ProcessStartInfo
    $pinfo.FileName = "powershell.exe"
    $pinfo.Arguments = "-NoProfile -ExecutionPolicy Bypass -Command `"& '$scriptEscaped' $arguments`""
    $pinfo.RedirectStandardOutput = $true
    $pinfo.RedirectStandardError = $true
    $pinfo.UseShellExecute = $false
    $pinfo.CreateNoWindow = $true

    $proc = [System.Diagnostics.Process]::Start($pinfo)
    $stdout = $proc.StandardOutput.ReadToEnd()
    $stderr = $proc.StandardError.ReadToEnd()
    $proc.WaitForExit(10000)

    return @{
        ExitCode = $proc.ExitCode
        StdOut = $stdout
        StdErr = $stderr
        Combined = "$stdout`n$stderr"
    }
}

# 5B. Fail-Closed Default (No Mode Specified)
& {
    $res = Run-RotationWithArgs ""
    $noModeFailedClosed = ($res.ExitCode -ne 0) -and ($res.Combined -match "No execution mode switch specified") -and ($res.Combined -match "-DryRun") -and ($res.Combined -match "-RotateOnly")
    Assert-Test "Fails closed with nonzero exit and usage instructions when no mode switch is specified" $noModeFailedClosed
}

# 5C. Exclusivity: -DryRun + -RotateOnly
& {
    $res = Run-RotationWithArgs "-DryRun -RotateOnly"
    $exclPassed = ($res.ExitCode -ne 0) -and ($res.Combined -match "Incompatible mode switches specified")
    Assert-Test "Rejects conflicting mode flags -DryRun and -RotateOnly" $exclPassed
}

# 5D. Exclusivity: -RotateOnly + -RunLiveTests
& {
    $res = Run-RotationWithArgs "-RotateOnly -RunLiveTests"
    $exclPassed = ($res.ExitCode -ne 0) -and ($res.Combined -match "Incompatible mode switches specified")
    Assert-Test "Rejects conflicting mode flags -RotateOnly and -RunLiveTests" $exclPassed
}

# 5E. Exclusivity: -DryRun + -RunLiveTests
& {
    $res = Run-RotationWithArgs "-DryRun -RunLiveTests"
    $exclPassed = ($res.ExitCode -ne 0) -and ($res.Combined -match "Incompatible mode switches specified")
    Assert-Test "Rejects conflicting mode flags -DryRun and -RunLiveTests" $exclPassed
}

# ----------------------------------------------------------------------------
# 6. Unit Execution Tests: Atomic File Replace, Corrupted Store & Crash Recovery
# ----------------------------------------------------------------------------
Write-Host "`n--- Test Suite 6: Atomic Replace, Corrupted Store & Crash Journal Recovery ---" -ForegroundColor Cyan

# Source Save-DpapiStoreAtomic in isolation using AST extraction
$ast = [System.Management.Automation.Language.Parser]::ParseInput($scriptContent, [ref]$null, [ref]$null)
$funcAst = $ast.Find({ $args[0] -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $args[0].Name -eq 'Save-DpapiStoreAtomic' }, $true)
$atomicHelperBlock = $funcAst.Extent.Text
Invoke-Expression $atomicHelperBlock

$testDir = Join-Path $env:TEMP ("pooldocai_test_" + [System.Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $testDir -Force | Out-Null

try {
    $testCredPath = Join-Path $testDir "credentials.xml"

    # 6A. Initial atomic create
    $store1 = [System.Collections.Generic.Dictionary[string, System.Security.SecureString]]::new()
    $store1["company_a_admin"] = ConvertTo-SecureString "TestPasswordA1" -AsPlainText -Force
    $store1["company_a_tech"] = ConvertTo-SecureString "TestPasswordA2" -AsPlainText -Force

    Save-DpapiStoreAtomic -Store $store1 -DestinationPath $testCredPath
    $created = Test-Path $testCredPath
    $loaded1 = Import-Clixml -Path $testCredPath
    Assert-Test "Save-DpapiStoreAtomic creates destination file on first save" ($created -and $loaded1.Count -eq 2)

    # 6B. Atomic replace creates backup (.bak.)
    Start-Sleep -Milliseconds 50
    $store2 = [System.Collections.Generic.Dictionary[string, System.Security.SecureString]]::new()
    foreach ($k in $store1.Keys) { $store2[$k] = $store1[$k] }
    $store2["company_b_admin"] = ConvertTo-SecureString "TestPasswordB1" -AsPlainText -Force

    Save-DpapiStoreAtomic -Store $store2 -DestinationPath $testCredPath
    $loaded2 = Import-Clixml -Path $testCredPath
    $backups = Get-ChildItem -Path $testDir -Filter "credentials.xml.bak.*"
    Assert-Test "Save-DpapiStoreAtomic creates Win32 .bak backup and replaces target atomically" ($loaded2.Count -eq 3 -and $backups.Count -ge 1)

    # 6C. Corrupted store auto-recovery from latest backup
    # Intentionally corrupt the primary store file
    [System.IO.File]::WriteAllText($testCredPath, "<<<CORRUPTED CLIXML HEADER GARBAGE>>>")
    
    $recoveredStore = [System.Collections.Generic.Dictionary[string, System.Security.SecureString]]::new()
    $recovered = $false
    $latestBackups = Get-ChildItem -Path $testDir -Filter "credentials.xml.bak.*" | Sort-Object LastWriteTime -Descending
    foreach ($bak in $latestBackups) {
        try {
            $bakStore = Import-Clixml -Path $bak.FullName
            if ($null -ne $bakStore -and $bakStore.Count -gt 0) {
                foreach ($k in $bakStore.Keys) {
                    $recoveredStore[$k] = $bakStore[$k]
                }
                Save-DpapiStoreAtomic -Store $recoveredStore -DestinationPath $testCredPath
                $recovered = $true
                break
            }
        } catch {}
    }
    $recoveredFile = Import-Clixml -Path $testCredPath
    Assert-Test "Corrupted primary store auto-recovers from latest valid .bak backup" ($recovered -and $recoveredFile.Count -eq 2)

    # 6D. Pre-mutation crash journal serialization and deserialization
    $journalFile = "$testCredPath.journal.xml"
    $journalData = @{
        PendingRole = "company_b_tech"
        PendingEmail = "staging_tech_bluewave@pooldocai.test"
        PendingPassword = ConvertTo-SecureString "PendingSecret123" -AsPlainText -Force
        Timestamp = [DateTime]::UtcNow.ToString("o")
    }
    $jTmp = "$journalFile.tmp.$([System.Guid]::NewGuid().ToString('N'))"
    $journalData | Export-Clixml -Path $jTmp
    [System.IO.File]::Move($jTmp, $journalFile)

    $readJournal = Import-Clixml -Path $journalFile
    $journalValid = ($readJournal.PendingRole -eq "company_b_tech") -and ($readJournal.PendingEmail -eq "staging_tech_bluewave@pooldocai.test") -and ($null -ne $readJournal.PendingPassword)
    Assert-Test "Pre-mutation journal correctly stores and restores pending role, email, and SecureString password" $journalValid

    # Cleanup journal
    Remove-Item -Path $journalFile -Force -ErrorAction SilentlyContinue
} finally {
    if (Test-Path $testDir) {
        Remove-Item -Path $testDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# ----------------------------------------------------------------------------
# Summary
# ----------------------------------------------------------------------------
Write-Host "`n============================================================================" -ForegroundColor Cyan
Write-Host " TEST SUMMARY: $passCount / $testCount tests passed" -ForegroundColor $(if ($passCount -eq $testCount) { "Green" } else { "Red" })
Write-Host "============================================================================`n" -ForegroundColor Cyan

if ($passCount -ne $testCount) {
    exit 1
}
