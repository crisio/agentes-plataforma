<#
  Arranca Agentes GC contra el esquema real `agentes` de la base de datos configurada.
    .\deploy\arrancar.ps1            â†’ publica y (re)arranca bÃ³veda, gateway y app
    .\deploy\arrancar.ps1 -SoloApp   â†’ solo recompila y reinicia la app
  Los servicios .NET corren desde deploy\publicado\ (no desde bin\), para que editar el cÃ³digo no rompa lo que corre.
  Secretos: AGENTES_CLAVE_SERVICIO y AGENTES_PIMIENTA son variables de usuario de Windows; Resend usa
  Mcp__Resend__ApiKey (la misma de Hilo). Nada de eso se escribe en el repo.
  Ojo: reiniciar la bÃ³veda la deja SELLADA; hay que abrirla con la parte desde la app.
#>
param([switch]$SoloApp, [switch]$SinBoveda)
$ErrorActionPreference = 'Stop'
$raiz = Split-Path $PSScriptRoot -Parent
$pub = Join-Path $PSScriptRoot 'publicado'
$logs = Join-Path $PSScriptRoot 'logs'
New-Item -ItemType Directory -Force $pub, $logs | Out-Null

function VarUsuario($n) { $v = [Environment]::GetEnvironmentVariable($n, 'User'); if (-not $v) { throw "Falta la variable de usuario $n" }; $v }
$env:AGENTES_CLAVE_SERVICIO = VarUsuario 'AGENTES_CLAVE_SERVICIO'
$env:AGENTES_PIMIENTA = VarUsuario 'AGENTES_PIMIENTA'
$env:RESEND_API_KEY = VarUsuario 'Mcp__Resend__ApiKey'
$env:AGENTES_CORREO_MODO = 'resend'
$env:AGENTES_CORREO_REMITENTE = 'Agentes GC <acceso@ejemplo.com>'
$env:AGENTES_SQL_ESQUEMA = 'agentes'
$env:AGENTES_EXCEPCION_ADMIN_UNICO = '1'   # excepción temporal: un solo administrador

function Detener($puerto, $patron) {
  $c = Get-NetTCPConnection -LocalPort $puerto -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $c) { return }
  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)"
  if ($p.CommandLine -notmatch $patron) { throw "El puerto $puerto lo usa otro proceso ($($p.ProcessId)): no lo toco." }
  Stop-Process -Id $p.ProcessId -Force; Start-Sleep 1
}

function Esperar($url) {
  foreach ($i in 1..30) {
    try { Invoke-WebRequest $url -UseBasicParsing -TimeoutSec 3 | Out-Null; return }
    catch { if ($_.Exception.Response) { return } ; Start-Sleep 1 }   # 401 tambiÃ©n cuenta: estÃ¡ vivo
  }
  throw "No respondiÃ³ $url"
}

if (-not $SoloApp) {
  # -SinBoveda: no publica ni reinicia la bóveda, así no queda sellada.
  $servicios = if ($SinBoveda) { @('Gateway') } else { @('Boveda', 'Gateway') }
  foreach ($s in $servicios) {
    dotnet publish (Join-Path $raiz "servicios\Agentes.$s") -c Release -o (Join-Path $pub "tmp-$s") --nologo -v q
    if ($LASTEXITCODE) { throw "FallÃ³ la publicaciÃ³n de $s" }
  }
  Detener 9942 'Agentes\.Gateway'
  # Ruta completa en la línea de comando para distinguir ejecutor y orquestador (el patrón viejo «src\principal.ts»
  # sigue valiendo para el ejecutor arrancado antes de este cambio).
  Detener 9943 'orquestador\\src\\principal\.ts'
  Detener 9944 'ejecutor\\src\\principal\.ts|\ssrc\\principal\.ts'
  if (-not $SinBoveda) { Detener 9945 'Agentes\.Boveda' }
  foreach ($s in $servicios) {
    $dest = Join-Path $pub $s
    if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
    Move-Item (Join-Path $pub "tmp-$s") $dest
  }
  Copy-Item (Join-Path $raiz '.env.local') (Join-Path $pub '.env.local') -Force   # credenciales SQL, fuera de git
  if (-not $SinBoveda) {
    Start-Process cmd.exe -ArgumentList '/c', "dotnet Agentes.Boveda.dll >> `"$logs\boveda.log`" 2>&1" -WorkingDirectory (Join-Path $pub 'Boveda') -WindowStyle Hidden
    Esperar 'http://127.0.0.1:9945/v1/estado'
  }
  # Ejecutor y orquestador corren el TypeScript directo (Node 24): reiniciarlos es lo que toma los cambios.
  Start-Process cmd.exe -ArgumentList '/c', "node `"$raiz\ejecutor\src\principal.ts`" >> `"$logs\ejecutor.log`" 2>&1" -WorkingDirectory (Join-Path $raiz 'ejecutor') -WindowStyle Hidden
  Esperar 'http://127.0.0.1:9944/v1/salud'
  # AGENTES_MODELO: DeepSeek V4.1 Flash por OpenRouter (con ZDR). Cambiarlo aquí si se cambia de modelo.
  $env:AGENTES_MODELO = 'deepseek/deepseek-v4.1-flash'
  Start-Process cmd.exe -ArgumentList '/c', "node `"$raiz\orquestador\src\principal.ts`" >> `"$logs\orquestador.log`" 2>&1" -WorkingDirectory (Join-Path $raiz 'orquestador') -WindowStyle Hidden
  Esperar 'http://127.0.0.1:9943/v1/salud'
  Start-Process cmd.exe -ArgumentList '/c', "dotnet Agentes.Gateway.dll >> `"$logs\gateway.log`" 2>&1" -WorkingDirectory (Join-Path $pub 'Gateway') -WindowStyle Hidden
  Esperar 'http://127.0.0.1:9942/api/boveda/estado'
  dotnet build-server shutdown | Out-Null
}

Push-Location (Join-Path $raiz 'app')
try {
  npm run build --silent
  if ($LASTEXITCODE) { throw 'FallÃ³ el build de la app' }
  Detener 9941 'next|server'
  Start-Process cmd.exe -ArgumentList '/c', "npm start >> `"$logs\app.log`" 2>&1" -WorkingDirectory (Get-Location) -WindowStyle Hidden
  Esperar 'http://127.0.0.1:9941/entrar'
} finally { Pop-Location }

'Agentes GC arriba: app http://127.0.0.1:9941 Â· gateway 127.0.0.1:9942 Â· orquestador 127.0.0.1:9943 Â· ejecutor 127.0.0.1:9944 Â· bÃ³veda 127.0.0.1:9945 (sellada)'
