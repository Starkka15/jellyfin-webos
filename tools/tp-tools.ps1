# Helpers for working on the TouchPad over novacom. Dot-source this file:
#     . H:\com.stark.jellyfin-dev\tp-tools.ps1
$script:Nov = "C:\Program Files\Palm, Inc\novacom.exe"

# Run a shell script on the TouchPad. Going through a file avoids PowerShell's quoting problems.
function Invoke-Tp([string]$Script) {
    $f = Join-Path $env:TEMP "tp-cmd.sh"
    [IO.File]::WriteAllText($f, ($Script -replace "`r`n", "`n") + "`n", (New-Object Text.UTF8Encoding $false))
    cmd /c "`"$script:Nov`" put file:///tmp/tp-cmd.sh < `"$f`"" | Out-Null
    & $script:Nov run file:///bin/sh /tmp/tp-cmd.sh 2>&1
}

# Copy a file from the TouchPad to this PC.
function Get-TpFile([string]$Remote, [string]$Local) {
    cmd /c "`"$script:Nov`" get file://$Remote > `"$Local`""
}

# Take a screenshot of the TouchPad. The image comes out in the panel's own orientation.
function Get-TpShot([string]$Out) {
    Invoke-Tp "luna-send -n 1 palm://com.palm.systemmanager/takeScreenShot '{`"file`":`"/media/internal/jf-shot.png`"}' >/dev/null 2>&1" | Out-Null
    Get-TpFile "/media/internal/jf-shot.png" $Out
}

# Start the app playing one item with given stream settings, wait, then report
# what the app and the TouchPad's media player logged.
#     Test-TpPlay '{"play":"<item id>","container":"ts","stream":{"profile":"baseline"}}' 25 shot.png
function Test-TpPlay([string]$ParamsJson, [int]$Seconds = 25, [string]$Shot = "") {
    $env:JAVA_HOME = "G:\Java\jdk17"
    $env:Path = "G:\Java\jdk17\bin;G:\webOS\PalmSDK\Current\bin;" + $env:Path
    cmd /c "palm-launch.bat -c com.stark.jellyfin 2>&1" | Out-Null
    $launch = '{"id":"com.stark.jellyfin","params":' + $ParamsJson + '}'
    $lines = @(
        'sleep 1',
        'wc -l < /var/log/messages > /tmp/jf-mark',
        "luna-send -n 1 palm://com.palm.applicationManager/launch '$launch' >/dev/null 2>&1",
        "sleep $Seconds",
        'luna-send -n 1 palm://com.palm.systemmanager/takeScreenShot ''{"file":"/media/internal/jf-shot.png"}'' >/dev/null 2>&1',
        'tail -n +$(cat /tmp/jf-mark) /var/log/messages > /tmp/jf-new.log',
        'echo "app:   $(grep -E "\[jellyfin\]" /tmp/jf-new.log | sed -e "s/.*\[jellyfin\] //" -e "s/, file:.*//" | tr "\n" ";" | cut -c1-1100)"',
        'echo "dropped-buffer warnings: $(grep -c "buffers are being dropped" /tmp/jf-new.log)   playing: $(grep -c "is now PLAYING" /tmp/jf-new.log)"',
        'grep -iE "media-pipeline" /tmp/jf-new.log | grep -iE "error|fail|resiz|caps|decoder|not-negotiated|missing|dropped" | grep -v "Query duration" | tail -n 5 | cut -c40-260'
    )
    Invoke-Tp ($lines -join "`n")
    if ($Shot) { Get-TpFile "/media/internal/jf-shot.png" $Shot }
}

# Relaunch the app with launch parameters, wait, and take a screenshot.
#     Show-TpScreen '{"search":"spirit"}' shot.png 8
function Show-TpScreen([string]$ParamsJson, [string]$Shot, [int]$Seconds = 8) {
    $env:JAVA_HOME = "G:\Java\jdk17"
    $env:Path = "G:\Java\jdk17\bin;G:\webOS\PalmSDK\Current\bin;" + $env:Path
    cmd /c "palm-launch.bat -c com.stark.jellyfin 2>&1" | Out-Null
    $launch = '{"id":"com.stark.jellyfin","params":' + $ParamsJson + '}'
    Invoke-Tp ("sleep 1`nluna-send -n 1 palm://com.palm.applicationManager/launch '$launch' >/dev/null 2>&1`nsleep $Seconds`ngrep -iE 'stark.jellyfin' /var/log/messages | grep -iE 'Uncaught' | tail -n 2 | cut -c12-24,110-300")
    Get-TpShot $Shot
}
