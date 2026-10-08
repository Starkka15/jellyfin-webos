# Package, install and relaunch the app on the connected device.
# Needs the Palm SDK and a Java runtime; set the two paths below for your machine.
# -Device picks one when several are attached, as palm-install -d does:
# "usb" for a TouchPad or phone on a cable, "tcp" for the emulator.
# -PackageOnly builds the .ipk in build\ and stops there.
param([string]$Device, [switch]$PackageOnly)
$env:JAVA_HOME = "G:\Java\jdk17"
$env:Path = "G:\Java\jdk17\bin;G:\webOS\PalmSDK\Current\bin;" + $env:Path
$root = Split-Path $PSScriptRoot -Parent
$build = Join-Path $root "build"
$d = ""
if ($Device) { $d = "-d $Device " }
New-Item -ItemType Directory -Force $build | Out-Null
Push-Location $build
# App, stream relay service and package description go into one .ipk.
cmd /c "palm-package.bat `"$root\app`" `"$root\service`" `"$root\package`" 2>&1" | Select-Object -Last 1
$ipk = Get-ChildItem "com.stark.jellyfin_*_all.ipk" | Sort-Object LastWriteTime | Select-Object -Last 1
# webOS runs pmPreRemove.script when the app is removed, and looks for it beside
# control.tar.gz in the .ipk (an ar archive). palm-package cannot put it there,
# so add everything in scripts\ with Windows' own tar (bsdtar).
$tar = Join-Path $env:SystemRoot "System32\tar.exe"
$work = Join-Path $build "repack"
if (Test-Path $work) { Remove-Item -Recurse -Force $work }
New-Item -ItemType Directory -Force $work | Out-Null
& $tar -xf $ipk.FullName -C $work
Copy-Item (Join-Path $root "scripts\*") $work
$scripts = @(Get-ChildItem (Join-Path $root "scripts") | ForEach-Object { $_.Name })
& $tar -cf $ipk.FullName --format=ar --uid 0 --gid 0 -C $work debian-binary control.tar.gz data.tar.gz @scripts
Remove-Item -Recurse -Force $work
# webOS runs the script as a program, so it must be marked executable, which
# files from Windows are not: set mode 755 on each script's header in the archive
# (60 bytes: name 16, time 12, owner 6, group 6, mode 8, size 10, end 2).
$bytes = [IO.File]::ReadAllBytes($ipk.FullName)
$ascii = [Text.Encoding]::ASCII
$at = 8
while ($at + 60 -le $bytes.Length) {
	$name = $ascii.GetString($bytes, $at, 16)
	$size = [int]$ascii.GetString($bytes, $at + 48, 10).Trim()
	if ($name -notmatch '^(debian-binary|control\.tar\.gz|data\.tar\.gz|//)') {
		$mode = $ascii.GetBytes("100755  ")
		[Array]::Copy($mode, 0, $bytes, $at + 40, 8)
	}
	$at += 60 + $size + ($size % 2)
}
[IO.File]::WriteAllBytes($ipk.FullName, $bytes)
if ($PackageOnly) { Pop-Location; "built $($ipk.FullName)"; return }
cmd /c "palm-install.bat $d$($ipk.Name) 2>&1" | Select-Object -Last 1
cmd /c "palm-launch.bat $d-c com.stark.jellyfin 2>&1" | Out-Null
cmd /c "palm-launch.bat $($d)com.stark.jellyfin 2>&1" | Select-Object -Last 1
Pop-Location
