<#
Sets up Manimble for Windows from a checkout of this repository. Run it from anywhere:

    powershell -ExecutionPolicy Bypass -File apps\windows\setup.ps1

It installs nothing system-wide except Python 3.12 (through winget, for the current user) when no Python 3.11+ is
found, and TinyTeX (in %APPDATA%\TinyTeX) when no LaTeX is found. Everything else goes into .venv in the checkout.
Safe to run again: it only adds what is missing.
#>
param([switch]$NoShortcut, [switch]$NoLatex)

$ErrorActionPreference = "Stop"
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$venv = Join-Path $repo ".venv"
$py = Join-Path $venv "Scripts\python.exe"
function Step($m) { Write-Host "`n== $m" -ForegroundColor Cyan }

# ---- Python 3.11+ --------------------------------------------------------------------------------
function Find-Python {
    foreach ($v in "3.13", "3.12", "3.11") {
        $p = & py "-$v" -c "import sys; print(sys.executable)" 2>$null
        if ($LASTEXITCODE -eq 0 -and $p) { return $p.Trim() }
    }
    return $null
}
if (-not (Test-Path $py)) {
    Step "Python"
    $base = $null
    if (Get-Command py -ErrorAction SilentlyContinue) { $base = Find-Python }
    if (-not $base) {
        Write-Host "No Python 3.11+ found: installing Python 3.12 for this user with winget"
        winget install --id Python.Python.3.12 --scope user --silent --accept-package-agreements --accept-source-agreements --disable-interactivity
        $env:Path = "$env:LOCALAPPDATA\Programs\Python\Launcher;$env:WINDIR;" + $env:Path
        $base = Find-Python
        if (-not $base) { $base = "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe" }
    }
    if (-not (Test-Path $base)) { throw "Could not find or install Python 3.11+. Install it from python.org and run this again." }
    Write-Host "Using $base"
    & $base -m venv $venv
}

Step "Python packages (manim, the engine's and the app's)"
& $py -m pip install --upgrade pip --quiet
& $py -m pip install --quiet -r (Join-Path $repo "engine\requirements.txt") -r (Join-Path $repo "apps\windows\requirements.txt")
if ($LASTEXITCODE -ne 0) { throw "pip install failed" }

# ---- LaTeX (formulas) -----------------------------------------------------------------------------
if (-not $NoLatex) {
    Step "LaTeX"
    $tinyBin = Join-Path $env:APPDATA "TinyTeX\bin\windows"
    if ((Test-Path $tinyBin) -and ($env:Path -notlike "*$tinyBin*")) { $env:Path = "$tinyBin;$env:Path" }
    if (-not (Get-Command latex -ErrorAction SilentlyContinue)) {
        Write-Host "No LaTeX found: installing TinyTeX for this user (about 250 MB)"
        $zip = Join-Path $env:TEMP "TinyTeX-1.zip"
        Invoke-WebRequest "https://github.com/rstudio/tinytex-releases/releases/download/daily/TinyTeX-1.zip" -OutFile $zip
        Expand-Archive $zip -DestinationPath $env:APPDATA -Force
        Remove-Item $zip
        $env:Path = "$tinyBin;$env:Path"
        & (Join-Path $tinyBin "tlmgr.bat") path add
    }
    $pkgs = "latex-bin dvisvgm standalone preview babel-english doublestroke everysel fundus-calligra mathastext physics ragged2e relsize rsfs setspace tipa wasy wasysym xcolor xkeyval cbfonts-fd jknapltx microtype multitoc prelim2e count1to frcursive amsfonts amsmath".Split(" ")
    $have = (& kpsewhich standalone.cls preview.sty english.ldf dsfont.sty relsize.sty physics.sty 2>$null | Measure-Object -Line).Lines
    if ($have -lt 6 -or -not (Get-Command dvisvgm -ErrorAction SilentlyContinue)) {
        if (Get-Command tlmgr -ErrorAction SilentlyContinue) {
            Write-Host "Adding the LaTeX packages Manim uses"
            $ErrorActionPreference = "Continue"
            & tlmgr install @pkgs 2>&1 | Select-Object -Last 3
            if ($LASTEXITCODE -ne 0) {
                # an older TeX Live cannot install from this year's servers: use the archive of its own year
                $year = ((& tlmgr --version) -join " ") -replace '(?s).*version (\d{4}).*', '$1'
                $arch = "https://ftp.math.utah.edu/pub/tex/historic/systems/texlive/$year/tlnet-final"
                Write-Host "Retrying from the TeX Live $year archive"
                & tlmgr --repository $arch update --self 2>&1 | Select-Object -Last 1
                & tlmgr --repository $arch install @pkgs 2>&1 | Select-Object -Last 3
            }
            $ErrorActionPreference = "Stop"
        } else {
            Write-Warning "LaTeX is installed without tlmgr (MiKTeX?). If formulas fail, install these packages: $($pkgs -join ' ')"
        }
    } else { Write-Host "LaTeX packages are already there" }
}

# ---- shortcuts ------------------------------------------------------------------------------------
if (-not $NoShortcut) {
    Step "Shortcuts"
    $pyw = Join-Path $venv "Scripts\pythonw.exe"
    $run = Join-Path $repo "apps\windows\run.py"
    $ico = Join-Path $repo "apps\windows\manimble.ico"
    $sh = New-Object -ComObject WScript.Shell
    foreach ($dir in [Environment]::GetFolderPath("Desktop"), (Join-Path ([Environment]::GetFolderPath("Programs")) "")) {
        $lnk = $sh.CreateShortcut((Join-Path $dir "Manimble.lnk"))
        $lnk.TargetPath = $pyw
        $lnk.Arguments = "`"$run`""
        $lnk.WorkingDirectory = $repo
        $lnk.Description = "Manimble slide editor"
        if (Test-Path $ico) { $lnk.IconLocation = $ico }
        $lnk.Save()
    }
    Write-Host "Manimble is on the Desktop and in the Start menu"
}

Step "Checking the engine"
$ErrorActionPreference = "Continue"      # the renderer logs to stderr, which must not stop the script
$smoke = Join-Path $repo "apps\windows\tools\smoke_engine.py"
cmd /c "`"$py`" `"$smoke`" 2>nul" | Select-Object -Last 5
if ($LASTEXITCODE -ne 0) { Write-Warning "The sample deck did not render completely (see above). Text and shapes may still work; formulas need LaTeX." }
else { Write-Host "`nReady. Start Manimble from the Desktop shortcut, or:  .venv\Scripts\python.exe apps\windows\run.py" -ForegroundColor Green }
