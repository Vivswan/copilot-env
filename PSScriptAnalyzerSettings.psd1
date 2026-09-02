@{
    # Gate on real problems (warnings + errors).
    Severity = @('Warning', 'Error')

    # Rules this CLI's PowerShell glue intentionally violates:
    ExcludeRules = @(
        # Write-Host is the right tool for user-facing console output here.
        'PSAvoidUsingWriteHost',
        # Invoke-Expression only ever runs our own `agent env` output
        # (controlled `$env:KEY = '...'` lines), not untrusted input.
        'PSAvoidUsingInvokeExpression',
        # -WhatIf/ShouldProcess is overkill for these small dot-sourced helpers.
        'PSUseShouldProcessForStateChangingFunctions',
        # We keep files UTF-8 *without* a BOM (see .editorconfig / .gitattributes).
        'PSUseBOMForUnicodeEncodedFile'
    )

    # Every script here must run on stock Windows PowerShell 5.1 AND pwsh 7:
    # install.ps1 is what the README one-liner runs under powershell.exe, and
    # the shell integration dot-sources into whichever PowerShell owns the
    # user's $PROFILE. The CI smokes only exercise pwsh, so 5.1 breaks are
    # otherwise invisible until a user hits them; these rules catch the static
    # class (7-only syntax, commands, parameters, types) at lint time. The two
    # profiles are PSScriptAnalyzer's bundled 5.1 baselines; Server 2016
    # carries the older .NET surface and is the floor. KNOWN GAP: the bundled
    # profiles were collected with .NET facade assemblies loaded, so a type
    # that stock 5.1 cannot resolve (e.g. [RuntimeInformation]) can still pass
    # the types rule -- runtime 5.1 coverage comes from the installer guard
    # tests driving the real powershell.exe (test/installer_pinning.test.ts).
    Rules = @{
        PSUseCompatibleSyntax = @{
            Enable = $true
            TargetVersions = @('5.1', '7.0')
        }
        PSUseCompatibleCommands = @{
            Enable = $true
            TargetProfiles = @(
                'win-8_x64_10.0.14393.0_5.1.14393.2791_x64_4.0.30319.42000_framework',
                'win-8_x64_10.0.17763.0_5.1.17763.316_x64_4.0.30319.42000_framework'
            )
        }
        PSUseCompatibleTypes = @{
            Enable = $true
            TargetProfiles = @(
                'win-8_x64_10.0.14393.0_5.1.14393.2791_x64_4.0.30319.42000_framework',
                'win-8_x64_10.0.17763.0_5.1.17763.316_x64_4.0.30319.42000_framework'
            )
        }
    }
}
