# The Windows standard-user leg (CI only; .github/workflows/ci.yml). Runs the
# bundle scripts/build-leg.ts made, in the package layout under
# C:\line-mcp-leg, as the elevated runner user and as a new standard account
# (scripts/windows-leg.ts names the phases). Windows PowerShell 5.1.
$ErrorActionPreference = 'Stop'
$leg = 'C:\line-mcp-leg'
$out = Join-Path $leg 'out'
$node = Join-Path $leg 'node.exe'
$entry = Join-Path $leg 'dist\leg.js'

function Assert-Exit([string]$what) {
	if ($LASTEXITCODE -ne 0) { throw "$what failed ($LASTEXITCODE)" }
}

# A local standard account with a random password, as a credential.
function New-StandardUser([string]$name) {
	# 14 characters: a longer password makes net user ask for confirmation.
	$password = 'Pp1!' + (-join (1..10 | ForEach-Object { '{0:x}' -f (Get-Random -Maximum 16) }))
	net user $name $password /add | Out-Null
	Assert-Exit "net user $name"
	New-Object System.Management.Automation.PSCredential($name, (ConvertTo-SecureString $password -AsPlainText -Force))
}

# Runs one phase as the runner user.
function Invoke-Admin([string]$phase, [string[]]$extra = @()) {
	& $node $entry $phase $out @extra
	Assert-Exit "leg $phase"
}

# Runs one phase as the standard account, with its own profile loaded.
function Invoke-Standard([string]$phase) {
	$stdout = Join-Path $out "$phase.out"
	$stderr = Join-Path $out "$phase.err"
	$process = Start-Process -FilePath $node -ArgumentList ('"' + $entry + '" ' + $phase + ' "' + $out + '"') `
		-Credential $script:tested -LoadUserProfile -WorkingDirectory $leg `
		-RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
	# The exit code is only kept once the handle was read.
	$null = $process.Handle
	if (-not $process.WaitForExit(600000)) { $process.Kill(); throw "leg $phase timed out" }
	Get-Content $stdout, $stderr
	if ($process.ExitCode -ne 0) { throw "leg $phase failed ($($process.ExitCode))" }
}

New-Item -ItemType Directory -Force -Path (Join-Path $leg 'dist'), $out | Out-Null
Copy-Item 'dist-leg\leg.js' $entry
Copy-Item -Recurse 'service' (Join-Path $leg 'service')
Copy-Item 'package.json' $leg
Copy-Item (Get-Command node).Source $node
icacls $leg /grant '*S-1-5-32-545:(OI)(CI)RX' /T /Q | Out-Null
Assert-Exit 'icacls grant Users read'

$script:tested = New-StandardUser 'lmcp-leg'
$null = New-StandardUser 'lmcp-other'
icacls $out /grant 'lmcp-leg:(OI)(CI)M' /Q | Out-Null
Assert-Exit 'icacls grant the tested account'

Invoke-Admin 'admin'
Invoke-Standard 'prepare'
Invoke-Admin 'plant' @('lmcp-other')
Invoke-Standard 'assert'
Invoke-Standard 'service'
