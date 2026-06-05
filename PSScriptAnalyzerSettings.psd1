@{
    # Gate on real problems (warnings + errors).
    Severity = @('Warning', 'Error')

    # Rules this CLI's PowerShell glue intentionally violates:
    ExcludeRules = @(
        # Write-Host is the right tool for user-facing console output here.
        'PSAvoidUsingWriteHost',
        # Invoke-Expression only ever runs our own `copilot-api env` output
        # (controlled `$env:KEY = '...'` lines), not untrusted input.
        'PSAvoidUsingInvokeExpression',
        # -WhatIf/ShouldProcess is overkill for these small dot-sourced helpers.
        'PSUseShouldProcessForStateChangingFunctions',
        # We keep files UTF-8 *without* a BOM (see .editorconfig / .gitattributes).
        'PSUseBOMForUnicodeEncodedFile'
    )
}
