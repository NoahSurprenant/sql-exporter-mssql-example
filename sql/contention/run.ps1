# Windows counterpart of run.sh: a 20-second blocking chain and a deadlock, through sqlcmd.
param([string]$Server = "localhost")
$dir = $PSScriptRoot
function Start-Sa($file) {
  Start-Process sqlcmd -NoNewWindow -PassThru -RedirectStandardOutput "$env:TEMP\$(Split-Path $file -Leaf).out" `
    -ArgumentList "-S", $Server, "-U", "sa", "-P", $env:MSSQL_SA_PASSWORD, "-C", "-i", (Join-Path $dir $file)
}
$p = @(Start-Sa "blocker.sql")
Start-Sleep 2
$p += Start-Sa "blocked.sql"
$p += Start-Sa "deadlock_a.sql"
Start-Sleep 1
$p += Start-Sa "deadlock_b.sql"
$p | Wait-Process
"contention done"
