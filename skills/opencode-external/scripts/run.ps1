#requires -version 5
<#
.SYNOPSIS
  External OpenCode caller (CLI path). Starts or continues a conversation with a model from models.json.

.EXAMPLE
  ./run.ps1 deepseek "Explain this repository"
  ./run.ps1 -Model tier2 -Title review "Review src/"
  ./run.ps1 -Model glm -Continue "Now handle the edge case"
  ./run.ps1 -Model opencode/longcat-2.5-preview-free -Json "List TODOs"
  ./run.ps1 -Dir "D:\proj" -Session ses_abc123 "continue"
  ./run.ps1 -Model deepseek -PromptFile prompt.txt    # read prompt from a UTF-8 file (avoids 乱码)
  Get-Content -Raw -Encoding UTF8 p.txt | ./run.ps1 -Model deepseek -PromptStdin
  ./run.ps1 -List
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0, ValueFromRemainingArguments = $true)]
  [string[]]$Prompt,

  [string]$Model,
  [string]$Tier,
  [string]$Variant,
  [string]$Agent,
  [string]$Session,
  [switch]$Continue,
  [string]$Title,
  [switch]$Json,
  [string]$Dir,
  [switch]$List,
  [switch]$DryRun,
  [string]$PromptFile,
  [switch]$PromptStdin
)

$ErrorActionPreference = 'Stop'

$skillDir = Split-Path -Parent $PSScriptRoot
$catalog = Get-Content (Join-Path $skillDir 'models.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$bin = if ($env:OPENCODE_BIN) { $env:OPENCODE_BIN } else { 'opencode' }

$models = @()
foreach ($t in $catalog.tiers) {
  foreach ($m in $t.models) {
    $models += [pscustomobject]@{
      Tier = $t.id; Alias = $m.alias; ProviderID = $m.providerID; ModelID = $m.modelID
      Id = $m.id; Variant = $m.variant; Concurrency = $m.concurrency; Desc = $m.desc
    }
  }
}

if ($List) {
  $models | Format-Table Tier, Alias, Id, Variant, Concurrency, Desc -AutoSize | Out-String -Width 220 | Write-Output
  return
}

function Resolve-Model([string]$key, [string]$tier) {
  if ($tier) {
    $t = @($models | Where-Object { $_.Tier -eq $tier })
    if ($t.Count -eq 0) { throw "unknown tier: $tier" }
    return $t[0]
  }
  if (-not $key) {
    $d = @($models | Where-Object { $_.Id -eq $catalog.default })
    if ($d.Count -gt 0) { return $d[0] }
    return @($models | Where-Object { $_.Tier -eq $catalog.tiers[0].id })[0]
  }
  $hit = @($models | Where-Object { $_.Alias -eq $key })
  if ($hit.Count -gt 0) { return $hit[0] }
  $hit = @($models | Where-Object { $_.Tier -eq $key })
  if ($hit.Count -gt 0) { return $hit[0] }
  $hit = @($models | Where-Object { $_.Id -eq $key })
  if ($hit.Count -gt 0) { return $hit[0] }
  if ($key -match '/') {
    $p = $key -split '/', 2
    return [pscustomobject]@{ Tier = 'custom'; Alias = $key; ProviderID = $p[0]; ModelID = $p[1]; Id = $key; Variant = ''; Desc = 'explicit' }
  }
  $hit = @($models | Where-Object { $_.Id -like "*$key*" -or $_.Alias -like "*$key*" })
  if ($hit.Count -gt 0) { return $hit[0] }
  throw "cannot resolve model: $key"
}

$sel = Resolve-Model $Model $Tier
$explicitVariant = $Variant
$v = if ($Variant) { $Variant } else { $sel.Variant }

$ver = (& $bin --version 2>&1 | Out-String)
$isV2 = $ver -match 'v2\.'

$modelArg = "$($sel.ProviderID)/$($sel.ModelID)"
if ($isV2 -and $v) { $modelArg = "$modelArg#$v" }

$agentArg = if ($Agent) { $Agent } else { $catalog.defaultAgent }

$cliArgs = @('run')
$cliArgs += @('--agent', $agentArg)
$cliArgs += @('--model', $modelArg)
# V1: variants are provider-dependent and some upstreams reject them, so only
# pass --variant when the caller explicitly asked for it.
if ((-not $isV2) -and $explicitVariant) { $cliArgs += @('--variant', $explicitVariant) }
if ($Title) { $cliArgs += @('--title', $Title) }
if ($Session) { $cliArgs += @('--session', $Session) }
elseif ($Continue) { $cliArgs += @('--continue') }
if ($Json) { $cliArgs += @('--format', 'json') }
if ($PromptFile) {
  # Read the prompt file as UTF-8 ourselves. Get-Content without -Encoding UTF8
  # on PowerShell 5.1 decodes a BOM-less UTF-8 file as GBK and mojibakes 中文.
  $PromptText = [System.IO.File]::ReadAllText((Resolve-Path -LiteralPath $PromptFile).Path, [System.Text.Encoding]::UTF8)
} elseif ($PromptStdin) {
  $stdin = [Console]::OpenStandardInput()
  $ms = New-Object System.IO.MemoryStream
  $stdin.CopyTo($ms)
  $PromptText = [System.Text.Encoding]::UTF8.GetString($ms.ToArray())
} else {
  $PromptText = ($Prompt -join ' ')
}
if ($PromptText) { $cliArgs += @($PromptText) }

if ($Dir) { Set-Location -LiteralPath $Dir }

if ($DryRun) {
  Write-Output ($bin + ' ' + ($cliArgs -join ' '))
  return
}

& $bin @cliArgs
exit $LASTEXITCODE
