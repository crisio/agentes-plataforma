# Integración de punta a punta con procesos reales (bóveda + gateway) contra el esquema agentes_prueba.
# Antes:  node scripts/aplicar-sql.mjs sql/001-esquema-agentes.sql --esquema agentes_prueba
# Después: node scripts/aplicar-sql.mjs --borrar-esquema agentes_prueba
# Nunca toca el esquema «agentes». Las claves se generan al vuelo y no se guardan.
param(
  [int]$PuertoBoveda = 9945,
  [int]$PuertoGateway = 9942,
  [string]$Logs = (Join-Path $env:TEMP 'agentes-e2e')
)
$ErrorActionPreference = 'Stop'
$servicios = Split-Path -Parent $PSScriptRoot
New-Item -ItemType Directory -Force $Logs | Out-Null

foreach ($p in $PuertoBoveda, $PuertoGateway) {
  if (Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue) { throw "El puerto $p ya está en uso." }
}

# Entorno solo para estos procesos.
$env:AGENTES_SQL_ESQUEMA = 'agentes_prueba'
$claveBytes = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($claveBytes)
$env:AGENTES_CLAVE_SERVICIO = [Convert]::ToBase64String($claveBytes)
$pim = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($pim)
$env:AGENTES_PIMIENTA = [Convert]::ToBase64String($pim)
$env:AGENTES_CORREO_MODO = 'consola'
$env:AGENTES_BOVEDA_PUERTO = "$PuertoBoveda"
$env:AGENTES_GATEWAY_PUERTO = "$PuertoGateway"
$env:AGENTES_BOVEDA_URL = "http://127.0.0.1:$PuertoBoveda"

$correo = 'e2e@prueba.test'
$clave = 'clave-de-prueba-e2e-123'
$valorSecreto = 'valor-secreto-e2e-' + [guid]::NewGuid().ToString('N')
$pasos = New-Object System.Collections.ArrayList
$fallas = 0
function Paso($nombre, [bool]$ok, $extra = '') {
  if (-not $ok -and $script:ultimo) { $extra = "ultimo=" + $script:ultimo.Estado + " " + ([string]$script:ultimo.Texto).Substring(0, [Math]::Min(150, ([string]$script:ultimo.Texto).Length)) }
  [void]$pasos.Add([pscustomobject]@{ Paso = $nombre; Resultado = $(if ($ok) { 'OK' } else { 'FALLA' }); Detalle = $extra })
  if (-not $ok) { $script:fallas++ }
}
function B64Url([byte[]]$b) { [Convert]::ToBase64String($b).TrimEnd('=').Replace('+', '-').Replace('/', '_') }
function TokenEjecutor($svc, $usr, $acc) {
  $json = (@{ svc = $svc; usr = $usr; agt = $null; acc = $acc; exp = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() + 30; jti = [guid]::NewGuid().ToString('N') } | ConvertTo-Json -Compress)
  $cuerpo = B64Url ([Text.Encoding]::UTF8.GetBytes($json))
  $hmac = New-Object Security.Cryptography.HMACSHA256 (, $claveBytes)
  $mac = $hmac.ComputeHash([Text.Encoding]::ASCII.GetBytes($cuerpo))
  "$cuerpo." + (B64Url $mac)
}
function Llamar($metodo, $url, $cuerpo = $null, $sesion = $null, $cabeceras = @{}) {
  $h = @{ 'X-Agentes' = '1' } + $cabeceras
  $args2 = @{ Uri = $url; Method = $metodo; Headers = $h; UseBasicParsing = $true; ContentType = 'application/json' }
  if ($cuerpo -ne $null) { $args2.Body = (ConvertTo-Json -InputObject $cuerpo -Compress -Depth 6) }
  if ($sesion) { $args2.WebSession = $sesion }
  try {
    $r = Invoke-WebRequest @args2
    $script:ultimo = [pscustomobject]@{ Estado = [int]$r.StatusCode; Json = $(if ($r.Content) { $r.Content | ConvertFrom-Json } else { $null }); Texto = $r.Content }; return $script:ultimo
  } catch [System.Net.WebException] {
    $resp = $_.Exception.Response
    if (-not $resp) { throw }
    $texto = (New-Object IO.StreamReader($resp.GetResponseStream())).ReadToEnd()
    $j = $null; try { $j = $texto | ConvertFrom-Json } catch {}
    $script:ultimo = [pscustomobject]@{ Estado = [int]$resp.StatusCode; Json = $j; Texto = $texto }; return $script:ultimo
  }
}
function Esperar-Puerto($p) {
  for ($i = 0; $i -lt 60; $i++) { if (Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue) { return $true }; Start-Sleep -Milliseconds 500 }
  $false
}

$procBoveda = $null; $procGateway = $null
try {
  $gw = "http://127.0.0.1:$PuertoGateway"
  $bv = "http://127.0.0.1:$PuertoBoveda"
  $dllBoveda = Join-Path $servicios 'Agentes.Boveda\bin\Debug\net10.0\Agentes.Boveda.dll'
  $dllGateway = Join-Path $servicios 'Agentes.Gateway\bin\Debug\net10.0\Agentes.Gateway.dll'

  # 1. Crear admin (CLI)
  $salidaAdmin = & dotnet $dllGateway --crear-admin $correo 'Admin E2E' 2>&1 | Out-String
  Paso 'Crear admin (--crear-admin)' ($LASTEXITCODE -eq 0 -and $salidaAdmin -match 'creado') ($salidaAdmin.Trim())

  # Arrancar servicios
  $procBoveda = Start-Process dotnet -ArgumentList "`"$dllBoveda`"" -PassThru -WindowStyle Hidden -RedirectStandardOutput "$Logs\boveda.log" -RedirectStandardError "$Logs\boveda.err"
  $procGateway = Start-Process dotnet -ArgumentList "`"$dllGateway`"" -PassThru -WindowStyle Hidden -RedirectStandardOutput "$Logs\gateway.log" -RedirectStandardError "$Logs\gateway.err"
  Paso 'Arrancan bóveda y gateway' ((Esperar-Puerto $PuertoBoveda) -and (Esperar-Puerto $PuertoGateway))

  $estado = Llamar GET "$bv/v1/estado"
  Paso 'Bóveda arranca sin inicializar y sellada' ($estado.Json.inicializada -eq $false -and $estado.Json.sellada -eq $true)

  # 2. Pedir código (modo consola)
  $sesion = New-Object Microsoft.PowerShell.Commands.WebRequestSession
  $r = Llamar POST "$gw/api/acceso/codigo" @{ correo = $correo } $sesion
  Paso 'Pedir código responde {enviado:true}' ($r.Estado -eq 200 -and $r.Json.enviado -eq $true)
  $codigo = $null
  for ($i = 0; $i -lt 40 -and -not $codigo; $i++) {
    if (Test-Path "$Logs\gateway.log") {
      $m = Select-String -Path "$Logs\gateway.log" -Pattern "correo=$correo proposito=crear_clave codigo=(\d{6})" | Select-Object -Last 1
      if ($m) { $codigo = $m.Matches[0].Groups[1].Value }
    }
    if (-not $codigo) { Start-Sleep -Milliseconds 250 }
  }
  Paso 'El código aparece en el log (consola)' ([bool]$codigo)

  # 3. Verificar (crea clave) y abre sesión
  $r = Llamar POST "$gw/api/acceso/verificar" @{ correo = $correo; codigo = $codigo; claveNueva = $clave } $sesion
  Paso 'Verificar código + crear clave abre sesión' ($r.Estado -eq 200 -and $r.Json.correo -eq $correo)
  $cookie = $sesion.Cookies.GetCookies($gw)['agc_sesion']
  Paso 'Cookie agc_sesion HttpOnly, SameSite=Strict' ($cookie -ne $null -and $cookie.HttpOnly)

  # 4. /api/yo y /api/agentes
  $yo = Llamar GET "$gw/api/yo" $null $sesion
  Paso '/api/yo' ($yo.Estado -eq 200 -and $yo.Json.roles.Count -eq 4 -and $yo.Json.agentes.Count -eq 3) ("roles=" + ($yo.Json.roles -join ','))
  $ag = Llamar GET "$gw/api/agentes" $null $sesion
  Paso '/api/agentes (roster)' ($ag.Estado -eq 200 -and @($ag.Json).Count -eq 3) ((@($ag.Json) | ForEach-Object { $_.clave }) -join ',')
  $sinSesion = Llamar GET "$gw/api/yo"
  Paso 'Sin sesión /api/yo da 401' ($sinSesion.Estado -eq 401)

  # 5. Inicializar bóveda 1 de 1
  $r = Llamar POST "$gw/api/boveda/inicializar" @{ umbral = 1; partes = 1 } $sesion
  $parte = $null; if ($r.Json) { $parte = @($r.Json.partes)[0] }
  Paso 'Inicializar bóveda 1 de 1 devuelve la parte' ($r.Estado -eq 200 -and $parte -and [Convert]::FromBase64String($parte).Length -eq 33)
  $r2 = Llamar POST "$gw/api/boveda/inicializar" @{ umbral = 1; partes = 1 } $sesion
  Paso 'Segunda inicialización rechazada (409)' ($r2.Estado -eq 409)
  $e = Llamar GET "$gw/api/boveda/estado" $null $sesion
  Paso 'Estado: inicializada y abierta' ($e.Json.inicializada -and -not $e.Json.sellada)

  # 6. Crear secreto
  $r = Llamar POST "$gw/api/boveda/secretos" @{ nombre = 'sql/prueba-e2e/lectura'; tipo = 'password'; descripcion = 'secreto de la prueba e2e'; valor = $valorSecreto } $sesion
  Paso 'Crear secreto' ($r.Estado -eq 201 -and $r.Json.version -eq 1)
  $r = Llamar POST "$gw/api/boveda/secretos" @{ nombre = 'sql/prueba-e2e/lectura'; tipo = 'password'; valor = 'otro' } $sesion
  Paso 'Crear secreto repetido da 409' ($r.Estado -eq 409)
  $r = Llamar PUT "$gw/api/boveda/secretos/sql/prueba-e2e/lectura/politicas" @(@{ agente = 'hilo'; ttlSegundos = 30; horaDesde = $null; horaHasta = $null }) $sesion
  Paso 'Política para hilo' ($r.Estado -eq 200)
  $lista = Llamar GET "$gw/api/boveda/secretos" $null $sesion
  $item = @($lista.Json)[0]
  Paso 'Lista de secretos: solo metadatos' ($lista.Estado -eq 200 -and $item.nombre -eq 'sql/prueba-e2e/lectura' -and $lista.Texto -notmatch [regex]::Escape($valorSecreto) -and $item.politicas.Count -eq 1)
  $rot = Llamar POST "$gw/api/boveda/secretos/sql/prueba-e2e/lectura/rotar" @{ valor = $valorSecreto } $sesion
  Paso 'Rotar a versión 2' ($rot.Estado -eq 200 -and $rot.Json.version -eq 2)

  # 7. Entrega con la bóveda abierta (antes de sellar)
  $tk = TokenEjecutor 'ejecutor' $yo.Json.id 'entregar'
  $ent = Llamar POST "$bv/v1/entregar" @{ secreto = 'sql/prueba-e2e/lectura'; agente = 'hilo'; herramienta = 'prueba' } $null @{ Authorization = "Servicio $tk" }
  Paso 'Entregar con token de ejecutor (abierta)' ($ent.Estado -eq 200 -and $ent.Json.valor -ceq $valorSecreto -and $ent.Json.venceUtc)

  # 8. Sellar
  $r = Llamar POST "$gw/api/boveda/sellar" @{} $sesion
  Paso 'Sellar' ($r.Estado -eq 200 -and $r.Json.sellada -eq $true)
  $tk = TokenEjecutor 'ejecutor' $yo.Json.id 'entregar'
  $ent = Llamar POST "$bv/v1/entregar" @{ secreto = 'sql/prueba-e2e/lectura'; agente = 'hilo'; herramienta = 'prueba' } $null @{ Authorization = "Servicio $tk" }
  Paso 'Entregar sellada da 423' ($ent.Estado -eq 423 -and $ent.Texto -notmatch [regex]::Escape($valorSecreto))

  # 9. Abrir con la parte (también una parte mala primero)
  $mala = [Convert]::ToBase64String((New-Object byte[] 33))
  $r = Llamar POST "$gw/api/boveda/abrir" @{ parte = $mala } $sesion
  Paso 'Parte falsa rechazada' ($r.Estado -eq 400 -or $r.Estado -eq 422)
  $r = Llamar POST "$gw/api/boveda/abrir" @{ parte = $parte } $sesion
  Paso 'Abrir con la parte' ($r.Estado -eq 200 -and $r.Json.abierta -eq $true)

  # 10. Entregar: ejecutor sí, gateway no, agente sin política no, jti repetido no
  $tk = TokenEjecutor 'ejecutor' $yo.Json.id 'entregar'
  $ent = Llamar POST "$bv/v1/entregar" @{ secreto = 'sql/prueba-e2e/lectura'; agente = 'hilo'; herramienta = 'prueba' } $null @{ Authorization = "Servicio $tk" }
  Paso 'Entregar con token de ejecutor' ($ent.Estado -eq 200 -and $ent.Json.valor -ceq $valorSecreto)
  $rep = Llamar POST "$bv/v1/entregar" @{ secreto = 'sql/prueba-e2e/lectura'; agente = 'hilo'; herramienta = 'prueba' } $null @{ Authorization = "Servicio $tk" }
  Paso 'Token repetido (jti) rechazado' ($rep.Estado -eq 401)
  $tkG = TokenEjecutor 'gateway' $yo.Json.id 'entregar'
  $g = Llamar POST "$bv/v1/entregar" @{ secreto = 'sql/prueba-e2e/lectura'; agente = 'hilo'; herramienta = 'prueba' } $null @{ Authorization = "Servicio $tkG" }
  Paso 'Token de gateway rechazado en entregar' ($g.Estado -eq 401 -and $g.Texto -notmatch [regex]::Escape($valorSecreto))
  $sin = Llamar POST "$bv/v1/entregar" @{ secreto = 'sql/prueba-e2e/lectura'; agente = 'hilo'; herramienta = 'prueba' }
  Paso 'Sin token rechazado' ($sin.Estado -eq 401)
  $tk = TokenEjecutor 'ejecutor' $yo.Json.id 'entregar'
  $den = Llamar POST "$bv/v1/entregar" @{ secreto = 'sql/prueba-e2e/lectura'; agente = 'tino'; herramienta = 'prueba' } $null @{ Authorization = "Servicio $tk" }
  Paso 'Agente sin política denegado (403)' ($den.Estado -eq 403)
  $rv = Llamar POST "$gw/api/boveda/secretos/sql/prueba-e2e/lectura/revocar" @{} $sesion
  $tk = TokenEjecutor 'ejecutor' $yo.Json.id 'entregar'
  $den2 = Llamar POST "$bv/v1/entregar" @{ secreto = 'sql/prueba-e2e/lectura'; agente = 'hilo'; herramienta = 'prueba' } $null @{ Authorization = "Servicio $tk" }
  Paso 'Revocado: ya no se entrega' ($rv.Estado -eq 200 -and $den2.Estado -eq 403)

  # 11. Anti-CSRF y usuarios
  $s2 = New-Object Microsoft.PowerShell.Commands.WebRequestSession; $s2.Cookies.Add($cookie)
  try { Invoke-WebRequest -Uri "$gw/api/acceso/salir" -Method POST -WebSession $s2 -UseBasicParsing | Out-Null; $csrf = 200 } catch { $csrf = [int]$_.Exception.Response.StatusCode }
  Paso 'POST sin X-Agentes da 403' ($csrf -eq 403)
  $nu = Llamar POST "$gw/api/usuarios" @{ correo = 'otro@prueba.test'; nombre = 'Otra Persona'; roles = @('auditor'); permisos = @(@{ agente = 'tino'; rol = 'usuario' }) } $sesion
  Paso 'Crear usuario' ($nu.Estado -eq 201 -and $nu.Json.permisos.Count -eq 1)
  $mal = Llamar POST "$gw/api/usuarios" @{ correo = 'malo@prueba.test'; nombre = 'Mal Rol'; roles = @('admin_plataforma', 'admin_boveda') } $sesion
  Paso 'Regla: admin_plataforma + admin_boveda juntos da 409' ($mal.Estado -eq 409)

  # 12. Auditoría íntegra
  $ver = Llamar GET "$gw/api/auditoria/verificar" $null $sesion
  Paso '/api/auditoria/verificar sana' ($ver.Estado -eq 200 -and $ver.Json.sana -eq $true)
  $aud = Llamar GET "$gw/api/auditoria?limite=50" $null $sesion
  $tipos = @($aud.Json.eventos | ForEach-Object { $_.tipo }) | Sort-Object -Unique
  Paso 'Auditoría lista eventos' ($aud.Estado -eq 200 -and $aud.Json.eventos.Count -gt 5) ($tipos -join ',')
  Paso 'La auditoría no contiene el valor del secreto ni el código ni la parte' ($aud.Texto -notmatch [regex]::Escape($valorSecreto) -and $aud.Texto -notmatch $codigo -and $aud.Texto -notmatch [regex]::Escape($parte))
  $logs = (Get-Content "$Logs\boveda.log", "$Logs\boveda.err", "$Logs\gateway.err" -Raw -ErrorAction SilentlyContinue) -join "`n"
  Paso 'Los logs de la bóveda no contienen valor ni parte' ($logs -notmatch [regex]::Escape($valorSecreto) -and $logs -notmatch [regex]::Escape($parte))

  # 13. Salir
  $s = Llamar POST "$gw/api/acceso/salir" @{} $sesion
  $despues = Llamar GET "$gw/api/yo" $null $sesion
  Paso 'Salir revoca la sesión' ($s.Estado -eq 200 -and $despues.Estado -eq 401)
}
finally {
  foreach ($p in $procGateway, $procBoveda) { if ($p -and -not $p.HasExited) { Stop-Process -Id $p.Id -Force } }
  Remove-Item "$Logs\*.log", "$Logs\*.err" -ErrorAction SilentlyContinue
}
$pasos | Format-Table -AutoSize -Wrap | Out-String -Width 200 | Write-Host
Write-Host ("Pasos: {0}, fallas: {1}" -f $pasos.Count, $fallas)
exit $(if ($fallas -eq 0) { 0 } else { 1 })
