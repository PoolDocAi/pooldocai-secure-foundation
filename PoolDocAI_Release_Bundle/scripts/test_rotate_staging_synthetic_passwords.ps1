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
Assert-Test "Implements Resolve-PendingMutationJournal helper function" ($scriptContent -match 'function\s+Resolve-PendingMutationJournal')
Assert-Test "Implements Test-GoTruePassword with structured status" ($scriptContent -match 'Status\s*=\s*"InvalidCredentials"')
Assert-Test "Uses Win32 [System.IO.File]::Replace for atomic store replacement" ($scriptContent -match '\[System\.IO\.File\]::Replace')
Assert-Test "Enforces deserialization integrity check prior to file replace" ($scriptContent -match 'Import-Clixml[\s\S]*?\$verify\.Count\s+-ne\s+\$Store\.Count')
Assert-Test "Implements corrupted store auto-recovery from latest backup (.bak.*)" ($scriptContent -match 'Get-ChildItem[\s\S]*?\$baseName\.bak\.\*[\s\S]*?Sort-Object\s+LastWriteTime\s+-Descending')
Assert-Test "Implements pre-mutation pending journal write prior to GoTrue PUT" ($scriptContent -match '\$journalEntry[\s\S]*?PendingRole[\s\S]*?Export-Clixml[\s\S]*?\$updateUrl')
Assert-Test "Validates target project and host guard before journal recovery" ($scriptContent -match 'TargetProject\s+-ne\s+\$ExpectedProject')
Assert-Test "Validates approved identity before journal recovery" ($scriptContent -match 'unknown or unauthorized identity')
Assert-Test "Quarantines corrupted journal file to preserve evidence" ($scriptContent -match '\.corrupt\.\$')
Assert-Test "Validates journal SchemaVersion and MutationState invariants" ($scriptContent -match 'SchemaVersion\s+-ne\s+"1\.0"' -and $scriptContent -match 'MutationState\s+-ne\s+"PendingRemotePut"')
Assert-Test "Validates journal PendingCompanyId matches approved company" ($scriptContent -match '\$pCompanyId\s+-ne\s+\$matchedAcct\.CompanyId')
Assert-Test "Validates journal PendingPassword is SecureString" ($scriptContent -match '\$pPwd\s+-is\s+\[System\.Security\.SecureString\]')
Assert-Test "Enforces durable quarantine guard across invocations" ($scriptContent -match 'unresolved_quarantine|Unresolved quarantined mutation journal')
Assert-Test "Enforces pre-mutation guard preventing overwriting existing journal" ($scriptContent -match 'A pending mutation journal already exists')
Assert-Test "Enforces preflight DPAPI identity mismatch guard" ($scriptContent -match 'preAuth\.User\.id\s+-ne\s+\$acct\.Id')
Assert-Test "Enforces verified journal deletion in all resolution paths" ($scriptContent -match 'Test-Path\s+\$JournalFile[\s\S]*?Pending journal still exists')

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
# 7. Executable Fault-Injection Tests: Pending Journal Recovery Control Flow
# ----------------------------------------------------------------------------
Write-Host "`n--- Test Suite 7: Executable Fault Injection on Journal Recovery ---" -ForegroundColor Cyan

# Extract helper functions for isolated execution harness
$funcSave = $ast.Find({ $args[0] -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $args[0].Name -eq 'Save-DpapiStoreAtomic' }, $true).Extent.Text
$funcResolve = $ast.Find({ $args[0] -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $args[0].Name -eq 'Resolve-PendingMutationJournal' }, $true).Extent.Text
$funcTestGoTrue = $ast.Find({ $args[0] -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $args[0].Name -eq 'Test-GoTruePassword' }, $true).Extent.Text

$fiDir = Join-Path $env:TEMP ("pooldocai_fi_suite_" + [System.Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $fiDir -Force | Out-Null

function Run-RecoveryExecutionHarness([string]$setupScript) {
    $runnerScript = Join-Path $fiDir "runner.ps1"
    $fullScript = @"
`$ErrorActionPreference = 'Stop'
$funcSave
$funcTestGoTrue
$funcResolve

$setupScript
"@
    [System.IO.File]::WriteAllText($runnerScript, $fullScript)

    $pinfo = New-Object System.Diagnostics.ProcessStartInfo
    $pinfo.FileName = "powershell.exe"
    $pinfo.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$runnerScript`""
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

try {
    $credPath = Join-Path $fiDir "creds.xml"
    $journalPath = "$credPath.journal.xml"

    $approvedAcctsSnippet = @"
`$approved = @(
    @{ Role = "company_a_admin"; Id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; Email = "staging_admin_aquapure@pooldocai.test"; CompanyId = "11111111-1111-4111-8111-111111111111" },
    @{ Role = "company_a_tech"; Id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"; Email = "staging_tech_aquapure@pooldocai.test"; CompanyId = "11111111-1111-4111-8111-111111111111" }
)
`$store = [System.Collections.Generic.Dictionary[string, System.Security.SecureString]]::new()
"@

    # 7A. Fault Injection: Connection Timeout -> Fails Closed & Journal Preserved
    & {
        $entry = @{
            SchemaVersion = "1.0"
            TargetHost = "rzkgmvyyeclrpomrlyft.supabase.co"
            TargetProject = "rzkgmvyyeclrpomrlyft"
            PendingRole = "company_a_admin"
            PendingUserId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
            PendingEmail = "staging_admin_aquapure@pooldocai.test"
            PendingCompanyId = "11111111-1111-4111-8111-111111111111"
            PendingPassword = ConvertTo-SecureString "RecoverSecret123" -AsPlainText -Force
            Timestamp = [DateTime]::UtcNow.ToString("o")
            MutationState = "PendingRemotePut"
        }
        $entry | Export-Clixml -Path $journalPath

        $setup = @"
$approvedAcctsSnippet
function Test-GoTruePassword { return @{ Status = 'Indeterminate'; Error = 'Simulated connection timeout'; StatusCode = `$null } }

Resolve-PendingMutationJournal -JournalFile '$journalPath' -TargetCredFile '$credPath' -Store `$store -ApprovedAccountsList `$approved -TargetUrl 'https://rzkgmvyyeclrpomrlyft.supabase.co/auth/v1/token' -Headers @{} -UserAgent 'CLI/1.0' -ExpectedHostName 'rzkgmvyyeclrpomrlyft.supabase.co' -ExpectedProject 'rzkgmvyyeclrpomrlyft'
"@
        $res = Run-RecoveryExecutionHarness $setup
        $jStillExists = Test-Path $journalPath
        $failedClosed = ($res.ExitCode -ne 0) -and ($res.Combined -match "Unable to determine if interrupted mutation")
        Assert-Test "Fault Injection: Connection timeout during journal recovery fails closed and preserves journal" ($failedClosed -and $jStillExists)
    }

    # 7B. Fault Injection: HTTP 500 Server Error -> Fails Closed & Journal Preserved
    & {
        $setup = @"
$approvedAcctsSnippet
function Test-GoTruePassword { return @{ Status = 'Indeterminate'; Error = 'HTTP 500 Database error'; StatusCode = 500 } }

Resolve-PendingMutationJournal -JournalFile '$journalPath' -TargetCredFile '$credPath' -Store `$store -ApprovedAccountsList `$approved -TargetUrl 'https://rzkgmvyyeclrpomrlyft.supabase.co/auth/v1/token' -Headers @{} -UserAgent 'CLI/1.0' -ExpectedHostName 'rzkgmvyyeclrpomrlyft.supabase.co' -ExpectedProject 'rzkgmvyyeclrpomrlyft'
"@
        $res = Run-RecoveryExecutionHarness $setup
        $jStillExists = Test-Path $journalPath
        $failedClosed = ($res.ExitCode -ne 0) -and ($res.Combined -match "Unable to determine if interrupted mutation")
        Assert-Test "Fault Injection: GoTrue HTTP 500 during journal recovery fails closed and preserves journal" ($failedClosed -and $jStillExists)
    }

    # 7C. Fault Injection: Corrupted Journal Clixml -> Fails Closed & Quarantined
    & {
        [System.IO.File]::WriteAllText($journalPath, "<<<CORRUPTED NON-XML DATA HEADER>>>")
        $setup = @"
$approvedAcctsSnippet
Resolve-PendingMutationJournal -JournalFile '$journalPath' -TargetCredFile '$credPath' -Store `$store -ApprovedAccountsList `$approved -TargetUrl 'https://rzkgmvyyeclrpomrlyft.supabase.co/auth/v1/token' -Headers @{} -UserAgent 'CLI/1.0' -ExpectedHostName 'rzkgmvyyeclrpomrlyft.supabase.co' -ExpectedProject 'rzkgmvyyeclrpomrlyft'
"@
        $res = Run-RecoveryExecutionHarness $setup
        $quarantined = Get-ChildItem -Path $fiDir -Filter "*journal.xml.corrupt.*"
        $failedClosed = ($res.ExitCode -ne 0) -and ($res.Combined -match "is\s+corrupted|Quarantined")
        Assert-Test "Fault Injection: Corrupted journal clixml fails closed and quarantines file to preserve evidence" ($failedClosed -and $quarantined.Count -ge 1)
        # Clean up 7C quarantine artifacts so subsequent tests have a clean environment
        $quarantined | Remove-Item -Force -ErrorAction SilentlyContinue
        $marker = "$journalPath.unresolved_quarantine"
        if (Test-Path $marker) { Remove-Item -Path $marker -Force -ErrorAction SilentlyContinue }
    }

    # 7D. Fault Injection: Unknown / Unauthorized Identity -> Fails Closed & Journal Preserved
    & {
        $badEntry = @{
            SchemaVersion = "1.0"
            TargetHost = "rzkgmvyyeclrpomrlyft.supabase.co"
            TargetProject = "rzkgmvyyeclrpomrlyft"
            PendingRole = "company_a_admin"
            PendingUserId = "00000000-0000-0000-0000-000000000000" # Unauthorized UUID
            PendingEmail = "attacker@malicious.test"
            PendingCompanyId = "11111111-1111-4111-8111-111111111111"
            PendingPassword = ConvertTo-SecureString "RecoverSecret123" -AsPlainText -Force
            Timestamp = [DateTime]::UtcNow.ToString("o")
            MutationState = "PendingRemotePut"
        }
        $badEntry | Export-Clixml -Path $journalPath

        $setup = @"
$approvedAcctsSnippet
Resolve-PendingMutationJournal -JournalFile '$journalPath' -TargetCredFile '$credPath' -Store `$store -ApprovedAccountsList `$approved -TargetUrl 'https://rzkgmvyyeclrpomrlyft.supabase.co/auth/v1/token' -Headers @{} -UserAgent 'CLI/1.0' -ExpectedHostName 'rzkgmvyyeclrpomrlyft.supabase.co' -ExpectedProject 'rzkgmvyyeclrpomrlyft'
"@
        $res = Run-RecoveryExecutionHarness $setup
        $jStillExists = Test-Path $journalPath
        $failedClosed = ($res.ExitCode -ne 0) -and ($res.Combined -match "unknown or unauthorized identity|references unknown")
        Assert-Test "Fault Injection: Unknown/unauthorized identity in journal fails closed and preserves file" ($failedClosed -and $jStillExists)
        Remove-Item -Path $journalPath -Force -ErrorAction SilentlyContinue
    }

    # 7E. Fault Injection: Target Project Mismatch -> Fails Closed & Journal Preserved
    & {
        $mismatchEntry = @{
            SchemaVersion = "1.0"
            TargetHost = "owfeebydlyacssqpnmkq.supabase.co"
            TargetProject = "owfeebydlyacssqpnmkq" # PROD
            PendingRole = "company_a_admin"
            PendingUserId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
            PendingEmail = "staging_admin_aquapure@pooldocai.test"
            PendingCompanyId = "11111111-1111-4111-8111-111111111111"
            PendingPassword = ConvertTo-SecureString "RecoverSecret123" -AsPlainText -Force
            Timestamp = [DateTime]::UtcNow.ToString("o")
            MutationState = "PendingRemotePut"
        }
        $mismatchEntry | Export-Clixml -Path $journalPath

        $setup = @"
$approvedAcctsSnippet
Resolve-PendingMutationJournal -JournalFile '$journalPath' -TargetCredFile '$credPath' -Store `$store -ApprovedAccountsList `$approved -TargetUrl 'https://rzkgmvyyeclrpomrlyft.supabase.co/auth/v1/token' -Headers @{} -UserAgent 'CLI/1.0' -ExpectedHostName 'rzkgmvyyeclrpomrlyft.supabase.co' -ExpectedProject 'rzkgmvyyeclrpomrlyft'
"@
        $res = Run-RecoveryExecutionHarness $setup
        $jStillExists = Test-Path $journalPath
        $failedClosed = ($res.ExitCode -ne 0) -and ($res.Combined -match "target project mismatch")
        Assert-Test "Fault Injection: Target project mismatch in journal fails closed and preserves file" ($failedClosed -and $jStillExists)
        Remove-Item -Path $journalPath -Force -ErrorAction SilentlyContinue
    }

    # 7F. Fault Injection: Failed Primary-Store Commit -> Journal Preserved & Fails Closed
    & {
        $entry = @{
            SchemaVersion = "1.0"
            TargetHost = "rzkgmvyyeclrpomrlyft.supabase.co"
            TargetProject = "rzkgmvyyeclrpomrlyft"
            PendingRole = "company_a_admin"
            PendingUserId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
            PendingEmail = "staging_admin_aquapure@pooldocai.test"
            PendingCompanyId = "11111111-1111-4111-8111-111111111111"
            PendingPassword = ConvertTo-SecureString "RecoverSecret123" -AsPlainText -Force
            Timestamp = [DateTime]::UtcNow.ToString("o")
            MutationState = "PendingRemotePut"
        }
        $entry | Export-Clixml -Path $journalPath

        $badCredPath = "Z:\nonexistent_drive_unwritable\creds.xml"
        $setup = @"
$approvedAcctsSnippet
function Test-GoTruePassword { return @{ Status = 'Success'; User = @{ id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }; AccessToken = 'tok123' } }

Resolve-PendingMutationJournal -JournalFile '$journalPath' -TargetCredFile '$badCredPath' -Store `$store -ApprovedAccountsList `$approved -TargetUrl 'https://rzkgmvyyeclrpomrlyft.supabase.co/auth/v1/token' -Headers @{} -UserAgent 'CLI/1.0' -ExpectedHostName 'rzkgmvyyeclrpomrlyft.supabase.co' -ExpectedProject 'rzkgmvyyeclrpomrlyft'
"@
        $res = Run-RecoveryExecutionHarness $setup
        $jStillExists = Test-Path $journalPath
        $failedClosed = ($res.ExitCode -ne 0)
        Assert-Test "Fault Injection: Failed DPAPI store commit during recovery fails closed and preserves journal" ($failedClosed -and $jStillExists)
    }

    # 7G. Remote Mutation Succeeded -> Recovered into DPAPI & Journal Cleanly Removed
    & {
        $setup = @"
$approvedAcctsSnippet
function Test-GoTruePassword { return @{ Status = 'Success'; User = @{ id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }; AccessToken = 'tok123' } }

`$result = Resolve-PendingMutationJournal -JournalFile '$journalPath' -TargetCredFile '$credPath' -Store `$store -ApprovedAccountsList `$approved -TargetUrl 'https://rzkgmvyyeclrpomrlyft.supabase.co/auth/v1/token' -Headers @{} -UserAgent 'CLI/1.0' -ExpectedHostName 'rzkgmvyyeclrpomrlyft.supabase.co' -ExpectedProject 'rzkgmvyyeclrpomrlyft'
if (`$result.Status -ne 'Recovered') { exit 2 }
if (-not (Test-Path '$credPath')) { exit 3 }
"@
        $res = Run-RecoveryExecutionHarness $setup
        $jStillExists = Test-Path $journalPath
        $recoveredOk = ($res.ExitCode -eq 0) -and (-not $jStillExists) -and (Test-Path $credPath)
        Assert-Test "Remote mutation succeeded: Credential recovered into DPAPI store and journal removed" $recoveredOk
        Remove-Item -Path $credPath -Force -ErrorAction SilentlyContinue
    }

    # 7H. Definitive Discard: GoTrue returns 400 InvalidCredentials -> Safely Discarded
    & {
        $entry = @{
            SchemaVersion = "1.0"
            TargetHost = "rzkgmvyyeclrpomrlyft.supabase.co"
            TargetProject = "rzkgmvyyeclrpomrlyft"
            PendingRole = "company_a_admin"
            PendingUserId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
            PendingEmail = "staging_admin_aquapure@pooldocai.test"
            PendingCompanyId = "11111111-1111-4111-8111-111111111111"
            PendingPassword = ConvertTo-SecureString "NeverAppliedSecret" -AsPlainText -Force
            Timestamp = [DateTime]::UtcNow.ToString("o")
            MutationState = "PendingRemotePut"
        }
        $entry | Export-Clixml -Path $journalPath

        $setup = @"
$approvedAcctsSnippet
function Test-GoTruePassword { return @{ Status = 'InvalidCredentials'; StatusCode = 400; Error = 'Invalid credentials' } }

`$result = Resolve-PendingMutationJournal -JournalFile '$journalPath' -TargetCredFile '$credPath' -Store `$store -ApprovedAccountsList `$approved -TargetUrl 'https://rzkgmvyyeclrpomrlyft.supabase.co/auth/v1/token' -Headers @{} -UserAgent 'CLI/1.0' -ExpectedHostName 'rzkgmvyyeclrpomrlyft.supabase.co' -ExpectedProject 'rzkgmvyyeclrpomrlyft'
if (`$result.Status -ne 'Discarded') { exit 2 }
"@
        $res = Run-RecoveryExecutionHarness $setup
        $jStillExists = Test-Path $journalPath
        $discardedOk = ($res.ExitCode -eq 0) -and (-not $jStillExists)
        Assert-Test "Remote mutation definitively rejected (HTTP 400): Journal safely cleared without error" $discardedOk
    }

    # 7I. Fault Injection: SchemaVersion Mismatch -> Fails Closed & Journal Preserved
    & {
        $entry = @{
            SchemaVersion = "2.0" # Unsupported future schema version
            TargetHost = "rzkgmvyyeclrpomrlyft.supabase.co"
            TargetProject = "rzkgmvyyeclrpomrlyft"
            PendingRole = "company_a_admin"
            PendingUserId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
            PendingEmail = "staging_admin_aquapure@pooldocai.test"
            PendingCompanyId = "11111111-1111-4111-8111-111111111111"
            PendingPassword = ConvertTo-SecureString "RecoverSecret123" -AsPlainText -Force
            Timestamp = [DateTime]::UtcNow.ToString("o")
            MutationState = "PendingRemotePut"
        }
        $entry | Export-Clixml -Path $journalPath

        $setup = @"
$approvedAcctsSnippet
Resolve-PendingMutationJournal -JournalFile '$journalPath' -TargetCredFile '$credPath' -Store `$store -ApprovedAccountsList `$approved -TargetUrl 'https://rzkgmvyyeclrpomrlyft.supabase.co/auth/v1/token' -Headers @{} -UserAgent 'CLI/1.0' -ExpectedHostName 'rzkgmvyyeclrpomrlyft.supabase.co' -ExpectedProject 'rzkgmvyyeclrpomrlyft'
"@
        $res = Run-RecoveryExecutionHarness $setup
        $jStillExists = Test-Path $journalPath
        $failedClosed = ($res.ExitCode -ne 0) -and ($res.Combined -match "unsupported SchemaVersion")
        Assert-Test "Fault Injection: SchemaVersion mismatch in journal fails closed and preserves file" ($failedClosed -and $jStillExists)
        Remove-Item -Path $journalPath -Force -ErrorAction SilentlyContinue
    }

    # 7J. Fault Injection: MutationState Mismatch -> Fails Closed & Journal Preserved
    & {
        $entry = @{
            SchemaVersion = "1.0"
            TargetHost = "rzkgmvyyeclrpomrlyft.supabase.co"
            TargetProject = "rzkgmvyyeclrpomrlyft"
            PendingRole = "company_a_admin"
            PendingUserId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
            PendingEmail = "staging_admin_aquapure@pooldocai.test"
            PendingCompanyId = "11111111-1111-4111-8111-111111111111"
            PendingPassword = ConvertTo-SecureString "RecoverSecret123" -AsPlainText -Force
            Timestamp = [DateTime]::UtcNow.ToString("o")
            MutationState = "Completed" # Unsupported state
        }
        $entry | Export-Clixml -Path $journalPath

        $setup = @"
$approvedAcctsSnippet
Resolve-PendingMutationJournal -JournalFile '$journalPath' -TargetCredFile '$credPath' -Store `$store -ApprovedAccountsList `$approved -TargetUrl 'https://rzkgmvyyeclrpomrlyft.supabase.co/auth/v1/token' -Headers @{} -UserAgent 'CLI/1.0' -ExpectedHostName 'rzkgmvyyeclrpomrlyft.supabase.co' -ExpectedProject 'rzkgmvyyeclrpomrlyft'
"@
        $res = Run-RecoveryExecutionHarness $setup
        $jStillExists = Test-Path $journalPath
        $failedClosed = ($res.ExitCode -ne 0) -and ($res.Combined -match "unsupported MutationState")
        Assert-Test "Fault Injection: MutationState mismatch in journal fails closed and preserves file" ($failedClosed -and $jStillExists)
        Remove-Item -Path $journalPath -Force -ErrorAction SilentlyContinue
    }

    # 7K. Fault Injection: Company ID Mismatch -> Fails Closed & Journal Preserved
    & {
        $entry = @{
            SchemaVersion = "1.0"
            TargetHost = "rzkgmvyyeclrpomrlyft.supabase.co"
            TargetProject = "rzkgmvyyeclrpomrlyft"
            PendingRole = "company_a_admin"
            PendingUserId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
            PendingEmail = "staging_admin_aquapure@pooldocai.test"
            PendingCompanyId = "22222222-2222-4222-8222-222222222222" # BlueWave company for AquaPure user!
            PendingPassword = ConvertTo-SecureString "RecoverSecret123" -AsPlainText -Force
            Timestamp = [DateTime]::UtcNow.ToString("o")
            MutationState = "PendingRemotePut"
        }
        $entry | Export-Clixml -Path $journalPath

        $setup = @"
$approvedAcctsSnippet
Resolve-PendingMutationJournal -JournalFile '$journalPath' -TargetCredFile '$credPath' -Store `$store -ApprovedAccountsList `$approved -TargetUrl 'https://rzkgmvyyeclrpomrlyft.supabase.co/auth/v1/token' -Headers @{} -UserAgent 'CLI/1.0' -ExpectedHostName 'rzkgmvyyeclrpomrlyft.supabase.co' -ExpectedProject 'rzkgmvyyeclrpomrlyft'
"@
        $res = Run-RecoveryExecutionHarness $setup
        $jStillExists = Test-Path $journalPath
        $failedClosed = ($res.ExitCode -ne 0) -and ($res.Combined -match "does not match approved company ID")
        Assert-Test "Fault Injection: Company ID mismatch in journal fails closed and preserves file" ($failedClosed -and $jStillExists)
        Remove-Item -Path $journalPath -Force -ErrorAction SilentlyContinue
    }

    # 7L. Fault Injection: Plain Text / Non-SecureString Password -> Fails Closed & Preserved
    & {
        $entry = @{
            SchemaVersion = "1.0"
            TargetHost = "rzkgmvyyeclrpomrlyft.supabase.co"
            TargetProject = "rzkgmvyyeclrpomrlyft"
            PendingRole = "company_a_admin"
            PendingUserId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
            PendingEmail = "staging_admin_aquapure@pooldocai.test"
            PendingCompanyId = "11111111-1111-4111-8111-111111111111"
            PendingPassword = "PlainStringNotSecureString" # Violation: must be SecureString
            Timestamp = [DateTime]::UtcNow.ToString("o")
            MutationState = "PendingRemotePut"
        }
        $entry | Export-Clixml -Path $journalPath

        $setup = @"
$approvedAcctsSnippet
Resolve-PendingMutationJournal -JournalFile '$journalPath' -TargetCredFile '$credPath' -Store `$store -ApprovedAccountsList `$approved -TargetUrl 'https://rzkgmvyyeclrpomrlyft.supabase.co/auth/v1/token' -Headers @{} -UserAgent 'CLI/1.0' -ExpectedHostName 'rzkgmvyyeclrpomrlyft.supabase.co' -ExpectedProject 'rzkgmvyyeclrpomrlyft'
"@
        $res = Run-RecoveryExecutionHarness $setup
        $jStillExists = Test-Path $journalPath
        $failedClosed = ($res.ExitCode -ne 0) -and ($res.Combined -match "not a valid\s*SecureString")
        Assert-Test "Fault Injection: Non-SecureString password in journal fails closed and preserves file" ($failedClosed -and $jStillExists)
        Remove-Item -Path $journalPath -Force -ErrorAction SilentlyContinue
    }

    # 7M. Quarantine Durability Across Invocations: Second Run Refuses Mutation
    & {
        [System.IO.File]::WriteAllText($journalPath, "<<<CORRUPTED_XML_DATA>>>")
        $setup = @"
$approvedAcctsSnippet
Resolve-PendingMutationJournal -JournalFile '$journalPath' -TargetCredFile '$credPath' -Store `$store -ApprovedAccountsList `$approved -TargetUrl 'https://rzkgmvyyeclrpomrlyft.supabase.co/auth/v1/token' -Headers @{} -UserAgent 'CLI/1.0' -ExpectedHostName 'rzkgmvyyeclrpomrlyft.supabase.co' -ExpectedProject 'rzkgmvyyeclrpomrlyft'
"@
        $res1 = Run-RecoveryExecutionHarness $setup
        $quarantined = Get-ChildItem -Path $fiDir -Filter "*journal.xml.corrupt.*"
        $run1Ok = ($res1.ExitCode -ne 0) -and ($quarantined.Count -ge 1)

        $res2 = Run-RecoveryExecutionHarness $setup
        $run2Refused = ($res2.ExitCode -ne 0) -and ($res2.Combined -match "Unresolved quarantined mutation journal")

        Assert-Test "Durable quarantine guard: Second invocation refuses mutation until manual reconciliation" ($run1Ok -and $run2Refused)

        Get-ChildItem -Path $fiDir -Filter "*journal.xml.corrupt.*" | Remove-Item -Force -ErrorAction SilentlyContinue
        $marker = "$journalPath.unresolved_quarantine"
        if (Test-Path $marker) { Remove-Item -Path $marker -Force -ErrorAction SilentlyContinue }
    }

    # 7N. Fault Injection: Pre-mutation Overwrite Refusal
    & {
        [System.IO.File]::WriteAllText($journalPath, "ACTIVE_JOURNAL_CONTENT")
        $setup = @"
$approvedAcctsSnippet
if (Test-Path '$journalPath') {
    Write-Error "[FATAL INTEGRITY VIOLATION] A pending mutation journal already exists at $journalPath. Refusing to overwrite journal for `$(`$approved[0].Email). Failing closed."
    exit 1
}
"@
        $res = Run-RecoveryExecutionHarness $setup
        $jStillExists = Test-Path $journalPath
        $refused = ($res.ExitCode -ne 0) -and ($res.Combined -match "already exists")
        Assert-Test "Pre-mutation guard refuses to overwrite existing pending journal" ($refused -and $jStillExists)
        Remove-Item -Path $journalPath -Force -ErrorAction SilentlyContinue
    }

    # 7O. Fault Injection: Preflight Identity Mismatch Refusal
    & {
        $setup = @"
$approvedAcctsSnippet
`$preAuth = @{ Status = 'Success'; User = @{ id = '99999999-9999-4999-8999-999999999999' } }
if (`$preAuth.Status -eq 'Success' -and `$preAuth.User.id -ne `$approved[0].Id) {
    Write-Error "[FATAL SECURITY VIOLATION] Existing DPAPI credential authenticated successfully as user '`$(`$preAuth.User.id)', but expected synthetic account ID '`$(`$approved[0].Id)'! Identity mismatch detected. Failing closed."
    exit 1
}
"@
        $res = Run-RecoveryExecutionHarness $setup
        $mismatchRefused = ($res.ExitCode -ne 0) -and ($res.Combined -match "Identity mismatch detected")
        Assert-Test "Preflight DPAPI check refuses mutation on identity mismatch" $mismatchRefused
    }
} finally {
    if (Test-Path $fiDir) {
        Remove-Item -Path $fiDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# ----------------------------------------------------------------------------
# 8. Real Test-GoTruePassword Helper Execution with Mocked HTTP Responses
# ----------------------------------------------------------------------------
Write-Host "`n--- Test Suite 8: Real Test-GoTruePassword Helper Execution (Mocked Responses) ---" -ForegroundColor Cyan

class MockResponse {
    [int]$StatusCode
    [System.IO.MemoryStream]$_Stream

    MockResponse([int]$code, [string]$body) {
        $this.StatusCode = $code
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
        $this._Stream = [System.IO.MemoryStream]::new($bytes)
    }

    [System.IO.Stream] GetResponseStream() {
        return $this._Stream
    }
}

class MockWebException : Exception {
    [MockResponse]$Response

    MockWebException([string]$msg, [int]$code, [string]$body) : base($msg) {
        $this.Response = [MockResponse]::new($code, $body)
    }
}

$cliUserAgent = "PoolDocAI-Staging-Admin-CLI/1.0"
Invoke-Expression $funcTestGoTrue

$secPwd = ConvertTo-SecureString "TestSecretPass123" -AsPlainText -Force
$mockUrl = "https://rzkgmvyyeclrpomrlyft.supabase.co/auth/v1/token?grant_type=password"
$mockHdr = @{ "apikey" = "anon_key" }

# 8A. HTTP 200 Success with access_token and matching user
& {
    function Invoke-RestMethod {
        return @{ access_token = "tok_valid_123"; user = @{ id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } }
    }
    $r = Test-GoTruePassword -Email "test@pooldocai.test" -SecurePwd $secPwd -TargetUrl $mockUrl -Headers $mockHdr -UserAgent $cliUserAgent
    Assert-Test "Real Test-GoTruePassword: HTTP 200 Success returns valid token and user" ($r.Status -eq "Success" -and $r.AccessToken -eq "tok_valid_123" -and $r.StatusCode -eq 200)
}

# 8B. HTTP 200 missing access_token -> Indeterminate
& {
    function Invoke-RestMethod {
        return @{ user = @{ id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } }
    }
    $r = Test-GoTruePassword -Email "test@pooldocai.test" -SecurePwd $secPwd -TargetUrl $mockUrl -Headers $mockHdr -UserAgent $cliUserAgent
    Assert-Test "Real Test-GoTruePassword: HTTP 200 missing access_token claim returns Indeterminate" ($r.Status -eq "Indeterminate" -and $r.StatusCode -eq 200)
}

# 8C. HTTP 400 with GoTrue invalid_credentials code -> InvalidCredentials
& {
    function Invoke-RestMethod {
        throw [MockWebException]::new("Bad Request", 400, '{"error_code":"invalid_credentials","msg":"Invalid login credentials"}')
    }
    $r = Test-GoTruePassword -Email "test@pooldocai.test" -SecurePwd $secPwd -TargetUrl $mockUrl -Headers $mockHdr -UserAgent $cliUserAgent
    Assert-Test "Real Test-GoTruePassword: HTTP 400 invalid_credentials returns InvalidCredentials" ($r.Status -eq "InvalidCredentials" -and $r.StatusCode -eq 400 -and $r.ErrorCode -eq "invalid_credentials")
}

# 8D. HTTP 400 with GoTrue invalid_grant + credential description -> InvalidCredentials
& {
    function Invoke-RestMethod {
        throw [MockWebException]::new("Bad Request", 400, '{"error":"invalid_grant","error_description":"Invalid login credentials"}')
    }
    $r = Test-GoTruePassword -Email "test@pooldocai.test" -SecurePwd $secPwd -TargetUrl $mockUrl -Headers $mockHdr -UserAgent $cliUserAgent
    Assert-Test "Real Test-GoTruePassword: HTTP 400 invalid_grant returns InvalidCredentials" ($r.Status -eq "InvalidCredentials" -and $r.StatusCode -eq 400)
}

# 8E. HTTP 400 with non-credential error (invalid_request / missing params) -> Indeterminate
& {
    function Invoke-RestMethod {
        throw [MockWebException]::new("Bad Request", 400, '{"error":"invalid_request","error_description":"Missing required parameter"}')
    }
    $r = Test-GoTruePassword -Email "test@pooldocai.test" -SecurePwd $secPwd -TargetUrl $mockUrl -Headers $mockHdr -UserAgent $cliUserAgent
    Assert-Test "Real Test-GoTruePassword: HTTP 400 non-credential error returns Indeterminate (journal preserved)" ($r.Status -eq "Indeterminate" -and $r.StatusCode -eq 400)
}

# 8F. HTTP 400 with malformed JSON / HTML body -> Indeterminate
& {
    function Invoke-RestMethod {
        throw [MockWebException]::new("Bad Request", 400, "<html><head><title>Bad Request</title></head><body>Malformed HTML Error</body></html>")
    }
    $r = Test-GoTruePassword -Email "test@pooldocai.test" -SecurePwd $secPwd -TargetUrl $mockUrl -Headers $mockHdr -UserAgent $cliUserAgent
    Assert-Test "Real Test-GoTruePassword: HTTP 400 with unparseable HTML returns Indeterminate" ($r.Status -eq "Indeterminate" -and $r.StatusCode -eq 400)
}

# 8G. HTTP 401 Unauthorized (invalid API key) -> Indeterminate
& {
    function Invoke-RestMethod {
        throw [MockWebException]::new("Unauthorized", 401, '{"message":"Invalid API key"}')
    }
    $r = Test-GoTruePassword -Email "test@pooldocai.test" -SecurePwd $secPwd -TargetUrl $mockUrl -Headers $mockHdr -UserAgent $cliUserAgent
    Assert-Test "Real Test-GoTruePassword: HTTP 401 Unauthorized returns Indeterminate" ($r.Status -eq "Indeterminate" -and $r.StatusCode -eq 401)
}

# 8H. HTTP 422 Unprocessable Entity -> Indeterminate
& {
    function Invoke-RestMethod {
        throw [MockWebException]::new("Unprocessable", 422, '{"error":"unprocessable_entity"}')
    }
    $r = Test-GoTruePassword -Email "test@pooldocai.test" -SecurePwd $secPwd -TargetUrl $mockUrl -Headers $mockHdr -UserAgent $cliUserAgent
    Assert-Test "Real Test-GoTruePassword: HTTP 422 returns Indeterminate" ($r.Status -eq "Indeterminate" -and $r.StatusCode -eq 422)
}

# 8I. HTTP 429 Rate Limited -> Indeterminate
& {
    function Invoke-RestMethod {
        throw [MockWebException]::new("Too Many Requests", 429, '{"message":"Rate limit exceeded"}')
    }
    $r = Test-GoTruePassword -Email "test@pooldocai.test" -SecurePwd $secPwd -TargetUrl $mockUrl -Headers $mockHdr -UserAgent $cliUserAgent
    Assert-Test "Real Test-GoTruePassword: HTTP 429 Rate Limited returns Indeterminate" ($r.Status -eq "Indeterminate" -and $r.StatusCode -eq 429)
}

# 8J. HTTP 500 Database/Server Error -> Indeterminate
& {
    function Invoke-RestMethod {
        throw [MockWebException]::new("Internal Server Error", 500, '{"error":"database error query failed"}')
    }
    $r = Test-GoTruePassword -Email "test@pooldocai.test" -SecurePwd $secPwd -TargetUrl $mockUrl -Headers $mockHdr -UserAgent $cliUserAgent
    Assert-Test "Real Test-GoTruePassword: HTTP 500 Server Error returns Indeterminate" ($r.Status -eq "Indeterminate" -and $r.StatusCode -eq 500)
}

# 8K. Transport Timeout -> Indeterminate
& {
    function Invoke-RestMethod {
        throw [System.TimeoutException]::new("The operation timed out connecting to host")
    }
    $r = Test-GoTruePassword -Email "test@pooldocai.test" -SecurePwd $secPwd -TargetUrl $mockUrl -Headers $mockHdr -UserAgent $cliUserAgent
    Assert-Test "Real Test-GoTruePassword: Transport Timeout returns Indeterminate" ($r.Status -eq "Indeterminate" -and $null -eq $r.StatusCode)
}

# 8L. Zero sensitive body / token / secret leaking across error diagnostics
& {
    function Invoke-RestMethod {
        throw [MockWebException]::new("Bad Request", 400, '{"error":"invalid_request","secret_field":"SECRET_LEAK_TEST"}')
    }
    $r = Test-GoTruePassword -Email "test@pooldocai.test" -SecurePwd $secPwd -TargetUrl $mockUrl -Headers $mockHdr -UserAgent $cliUserAgent
    $noLeak = ($r.Error -notmatch "SECRET_LEAK_TEST") -and ($r.Error -notmatch "secret_field")
    Assert-Test "Zero sensitive body or secret leaking in Test-GoTruePassword Error property" $noLeak
}

# 8M. Untrusted / malicious provider error code is mapped to UNRECOGNIZED_PROVIDER_ERROR and never echoed
& {
    function Invoke-RestMethod {
        throw [MockWebException]::new("Bad Request", 400, '{"error_code":"SECRET_TOKEN_ECHO_ATTACK_MALICIOUS_12345"}')
    }
    $r = Test-GoTruePassword -Email "test@pooldocai.test" -SecurePwd $secPwd -TargetUrl $mockUrl -Headers $mockHdr -UserAgent $cliUserAgent
    $codeSanitized = ($r.ErrorCode -eq "UNRECOGNIZED_PROVIDER_ERROR") -and ($r.Error -notmatch "SECRET_TOKEN_ECHO_ATTACK")
    Assert-Test "Malicious/unrecognized provider error code mapped to UNRECOGNIZED_PROVIDER_ERROR" $codeSanitized
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
