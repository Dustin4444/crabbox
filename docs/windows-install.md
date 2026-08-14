# Install Crabbox on Windows

The currently supported Windows client setup uses the native `crabbox.exe`
from the latest GitHub Release and WSL2 Ubuntu's native Linux `rsync` and
OpenSSH client for repository transfer. Native Windows Git, OpenSSH
(`ssh.exe` and `ssh-keygen.exe`), and `curl.exe` must also be on `PATH`.

Crabbox invokes `wsl.exe` without naming a distribution, so it probes the
default WSL distribution. This guide configures Ubuntu as that default, but
Ubuntu is not a code requirement: another distribution works when it is the
default and provides native Linux `rsync` and `ssh` commands.

The automatic WSL transport selection documented here requires a build that
contains the direct-output detection fix: current `main` or Crabbox v0.42.1
and newer. Crabbox v0.42.0 and older can silently fall back to an incompatible
Windows shim even when the native WSL tools are installed.

A native no-WSL rsync/OpenSSH transport tuple is not yet supported. In
particular, do not pair MSYS2 or Cygwin rsync with native Windows OpenSSH:
rsync can exit while its SSH child remains connected. Crabbox therefore
prefers native WSL tools and rejects `.exe` files and tools resolved through
mounted Windows paths when probing WSL.

## Install the native Crabbox executable

Run this block in ordinary, non-elevated PowerShell. It detects amd64 versus
arm64, queries the latest stable
[Crabbox GitHub Release](https://github.com/openclaw/crabbox/releases),
downloads the matching archive and `checksums.txt`, verifies SHA-256 before
extraction, and adds the install directory to your user `PATH`.

```powershell
$ErrorActionPreference = "Stop"
$minimumVersion = [version]"0.42.1"

$osArchitecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
$architecture = switch ($osArchitecture) {
    "x64"   { "amd64" }
    "arm64" { "arm64" }
    default { throw "Unsupported Windows architecture: $osArchitecture" }
}

$headers = @{
    Accept = "application/vnd.github+json"
    "User-Agent" = "Crabbox-Windows-Installer"
}
$release = Invoke-RestMethod `
    -Uri "https://api.github.com/repos/openclaw/crabbox/releases/latest" `
    -Headers $headers
if ($release.draft -or $release.prerelease) {
    throw "The GitHub latest-release endpoint returned a non-stable release."
}

$version = $release.tag_name -replace '^v', ''
$stableVersion = [version]$version
if ($stableVersion -lt $minimumVersion) {
    throw "Latest stable Crabbox release v$version is older than required v$minimumVersion. Use a build from current main or wait for Crabbox v$minimumVersion or newer."
}

$archiveName = "crabbox_${version}_windows_${architecture}.zip"
$archiveAsset = $release.assets | Where-Object { $_.name -eq $archiveName } | Select-Object -First 1
$checksumsAsset = $release.assets | Where-Object { $_.name -eq "checksums.txt" } | Select-Object -First 1
if ($null -eq $archiveAsset -or $null -eq $checksumsAsset) {
    throw "Release assets are missing $archiveName or checksums.txt."
}

$downloadDir = Join-Path ([IO.Path]::GetTempPath()) ("crabbox-install-" + [guid]::NewGuid())
$archivePath = Join-Path $downloadDir $archiveName
$checksumsPath = Join-Path $downloadDir "checksums.txt"
$installDir = Join-Path $env:LOCALAPPDATA "Programs\Crabbox"
New-Item -ItemType Directory -Path $downloadDir -Force | Out-Null

try {
    Invoke-WebRequest -Uri $archiveAsset.browser_download_url -OutFile $archivePath
    Invoke-WebRequest -Uri $checksumsAsset.browser_download_url -OutFile $checksumsPath

    $checksumPattern = '\s+\*?' + [regex]::Escape($archiveName) + '$'
    $checksumLine = Get-Content $checksumsPath |
        Where-Object { $_ -match $checksumPattern } |
        Select-Object -First 1
    if (-not $checksumLine) {
        throw "No checksum found for $archiveName."
    }
    $expectedHash = ($checksumLine.Trim() -split '\s+')[0]
    $actualHash = (Get-FileHash -Algorithm SHA256 -Path $archivePath).Hash
    if ($actualHash -ine $expectedHash) {
        throw "SHA-256 mismatch for $archiveName."
    }

    New-Item -ItemType Directory -Path $installDir -Force | Out-Null
    Expand-Archive -Path $archivePath -DestinationPath $installDir -Force
} finally {
    Remove-Item -LiteralPath $downloadDir -Recurse -Force -ErrorAction SilentlyContinue
}

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
$userPathParts = @($userPath -split ';' | Where-Object { $_ })
if ($userPathParts -notcontains $installDir) {
    $updatedUserPath = (@($userPathParts) + $installDir) -join ';'
    [Environment]::SetEnvironmentVariable("Path", $updatedUserPath, "User")
}
if (($env:Path -split ';') -notcontains $installDir) {
    $env:Path = "$installDir;$env:Path"
}
```

## Install Windows prerequisites

Git for Windows can be installed from an ordinary PowerShell session:

```powershell
winget install --id Git.Git --exact --source winget
```

Windows 11 includes `curl.exe`. Install the Windows OpenSSH Client capability
from an **elevated PowerShell** session; this also supplies `ssh-keygen.exe`:

```powershell
$openSSH = Get-WindowsCapability -Online -Name "OpenSSH.Client*"
if ($openSSH.State -ne "Installed") {
    Add-WindowsCapability -Online -Name "OpenSSH.Client~~~~0.0.1.0"
}
```

Close and reopen PowerShell after installation so the updated application and
user paths are visible.

## Install WSL2 transport tools

Install WSL2 with Ubuntu from an **elevated PowerShell** session. Windows may
require a restart before Ubuntu completes its first-launch setup.

```powershell
wsl.exe --install --distribution Ubuntu
```

After Ubuntu has initialized, make it the default distribution from an
ordinary, non-elevated PowerShell session. This must match Crabbox's
unqualified `wsl.exe` probe.

```powershell
wsl.exe --set-default Ubuntu
```

Then install Ubuntu's native Linux transfer tools from PowerShell. Ubuntu may
prompt for the Linux user's password for `sudo`.

```powershell
wsl.exe --distribution Ubuntu -- bash -lc 'sudo apt-get update && sudo apt-get install -y rsync openssh-client'
```

If you prefer another WSL distribution, set that distribution as the default
instead and install its native `rsync` and OpenSSH client packages there.

## Verify the installation

Open a fresh, ordinary PowerShell session. The first command checks the native
Windows tools. The second exactly matches Crabbox's unqualified
default-distribution probe and deliberately uses direct `command -v` output:
both paths must be Linux paths such as `/usr/bin/rsync` and `/usr/bin/ssh`,
never `.exe` files or paths below `/mnt/<drive>` or `/mnt/host/<drive>`.

```powershell
Get-Command crabbox.exe, git.exe, ssh.exe, ssh-keygen.exe, curl.exe
wsl.exe sh -c 'command -v rsync || exit 1; command -v ssh || exit 1'
crabbox --version
crabbox doctor
```

A provider-neutral `crabbox doctor` can report `no provider selected`. That is
expected until provider or broker configuration is added and is separate from
local installation readiness. Select and configure a provider before running a
remote lifecycle command.

## Optional Docker Desktop smoke

If Docker Desktop is already installed and running, this secretless local
container smoke creates and commits a fixture in a temporary repository, syncs
that repository through the configured default WSL transport, verifies the
fixture in the container, and removes both the container and local repository:

```powershell
docker info
if ($LASTEXITCODE -ne 0) {
    throw "Docker Desktop is not ready."
}

$smokeRepo = Join-Path ([IO.Path]::GetTempPath()) ("crabbox-windows-sync-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $smokeRepo | Out-Null

try {
    Set-Content -LiteralPath (Join-Path $smokeRepo "fixture.txt") -Value "crabbox-wsl-sync-ok" -NoNewline
    Push-Location $smokeRepo
    try {
        git init
        if ($LASTEXITCODE -ne 0) { throw "git init failed." }

        git add fixture.txt
        if ($LASTEXITCODE -ne 0) { throw "git add failed." }

        git -c 'user.name=Crabbox Sync Test' -c 'user.email=crabbox-sync-test@example.invalid' commit -m 'test: add sync fixture'
        if ($LASTEXITCODE -ne 0) { throw "git commit failed." }

        crabbox run --provider local-container --local-container-runtime docker --stop-after always -- sh -lc 'test "$(cat fixture.txt)" = "crabbox-wsl-sync-ok"'
        if ($LASTEXITCODE -ne 0) { throw "Crabbox repository sync smoke failed." }
    } finally {
        Pop-Location
    }
} finally {
    Remove-Item -LiteralPath $smokeRepo -Recurse -Force -ErrorAction SilentlyContinue
}
```

See [Getting Started](getting-started.md) when you are ready to configure a
provider or broker and run a project workload.
