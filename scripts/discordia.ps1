# DiscordIA - inicializador unico
# Faz tudo sozinho: instala o que faltar, gera o app desktop quando precisar,
# liga o servidor e abre o DiscordIA. So o que ja esta pronto e pulado.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
$Desk = Join-Path $Root 'desktop'
$Dist = Join-Path $Desk 'dist'
# A versao atual do app fica numa pasta propria (dist\DiscordIA-xxxxxxxx); o nome esta em dist\atual.txt
$atualArq = Join-Path $Dist 'atual.txt'
$AppDir = Join-Path $Dist 'DiscordIA-win32-x64'
if (Test-Path $atualArq) { $AppDir = Join-Path $Dist ((Get-Content $atualArq -Raw).Trim()) }
$AppExe = Join-Path $AppDir 'DiscordIA.exe'
$Port = 3000

function Passo($t) { Write-Host "  - $t" -ForegroundColor Gray }
function Ok($t) { Write-Host "  OK  $t" -ForegroundColor Green }
function Aviso($t) { Write-Host "  !!  $t" -ForegroundColor Yellow }
function Parar($t) { Write-Host ""; Write-Host "  XX  $t" -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Host "  ==================== DiscordIA ====================" -ForegroundColor DarkYellow
Write-Host "  Preparando... (na primeira vez demora alguns minutos)"
Write-Host ""

# ---------------------------------------------------------------- 0. Limpeza de arquivos de versoes antigas
foreach ($velho in @('DiscordIA-icone', 'INSTALAR.bat', 'INICIAR.bat', 'GERAR-APP-DESKTOP.bat', 'scripts\instalar.ps1', 'scripts\gerar-app.ps1')) {
  $alvo = Join-Path $Root $velho
  if (Test-Path $alvo) { Remove-Item $alvo -Recurse -Force -ErrorAction SilentlyContinue }
}
# versoes antigas do app (a atual fica; o que estiver travado sai numa proxima vez)
if (Test-Path $atualArq) {
  $atualNome = (Get-Content $atualArq -Raw).Trim()
  if ($atualNome -and (Test-Path (Join-Path $Dist $atualNome))) {
    Get-ChildItem $Dist -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne $atualNome } | ForEach-Object {
      Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}

# ---------------------------------------------------------------- 1. Node.js
function Atualizar-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}
function Node-Ok {
  $n = Get-Command node -ErrorAction SilentlyContinue
  if (-not $n) { return $false }
  $v = (& node -v).TrimStart('v').Split('.')
  return ([int]$v[0] -gt 22) -or ([int]$v[0] -eq 22 -and [int]$v[1] -ge 13)
}
if (-not (Node-Ok)) {
  Passo "Instalando o Node.js..."
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements | Out-Host
    Atualizar-Path
  }
  if (-not (Node-Ok)) {
    Start-Process 'https://nodejs.org/pt-br/download'
    Parar "Instale o Node.js LTS pelo site que abriu e depois abra o DiscordIA de novo."
  }
}
Ok "Node.js $(& node -v)"

# ---------------------------------------------------------------- 2. Ja esta rodando?
function Porta-Aberta {
  try { return [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop) } catch { return $false }
}
function Abrir-App($endereco) {
  if ((Test-Path $atualArq) -and (Test-Path $AppExe)) {
    # fecha versoes antigas do app que ainda estejam abertas (senao a antiga "segura" a janela)
    $velhos = @(Get-Process -Name 'DiscordIA' -ErrorAction SilentlyContinue |
      Where-Object { $_.Path -and -not $_.Path.StartsWith($AppDir, [StringComparison]::OrdinalIgnoreCase) })
    if ($velhos.Count) {
      $velhos | Stop-Process -Force -ErrorAction SilentlyContinue
      # espera fechar de vez (senao a versao nova briga pelo cache com a antiga)
      $velhos | Wait-Process -Timeout 8 -ErrorAction SilentlyContinue
    }
    # o app nao escreve os avisos internos dele nesta janela do servidor
    $env:ELECTRON_NO_ATTACH_CONSOLE = '1'
    Start-Process $AppExe
  }
  elseif ($endereco) { Start-Process $endereco }
  else { Start-Process "http://localhost:$Port" }
}
$enderecoArq = Join-Path $Root 'ENDERECO.txt'
$endereco = if (Test-Path $enderecoArq) { (Get-Content $enderecoArq -Raw).Trim().TrimStart([char]0xFEFF) } else { '' }
if (Porta-Aberta) {
  Ok "O servidor ja esta ligado em outra janela. Abrindo o DiscordIA..."
  Abrir-App $endereco
  Start-Sleep -Seconds 2
  exit 0
}

# ---------------------------------------------------------------- 3. Servidor de voz (LiveKit)
$lkExe = Join-Path $Root 'livekit\livekit-server.exe'
if (-not (Test-Path $lkExe)) {
  Passo "Baixando o servidor de voz..."
  $lkDir = Split-Path $lkExe
  New-Item -ItemType Directory -Force -Path $lkDir | Out-Null
  $rel = Invoke-RestMethod -Uri 'https://api.github.com/repos/livekit/livekit/releases/latest' -Headers @{ 'User-Agent' = 'discordia' }
  $asset = $rel.assets | Where-Object { $_.name -like '*windows_amd64.zip' } | Select-Object -First 1
  if (-not $asset) { Parar "Nao achei o servidor de voz para Windows. Tente de novo mais tarde." }
  $zip = Join-Path $env:TEMP $asset.name
  Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zip
  Expand-Archive -Path $zip -DestinationPath $lkDir -Force
  Remove-Item $zip -Force
  $found = Get-ChildItem -Path $lkDir -Recurse -Filter 'livekit-server.exe' | Select-Object -First 1
  if ($found -and $found.FullName -ne $lkExe) { Move-Item $found.FullName $lkExe -Force }
}
Ok "Servidor de voz"

# ---------------------------------------------------------------- 4. Biblioteca de voz do navegador
$lkc = Join-Path $Root 'public\vendor\livekit-client.umd.js'
if (-not (Test-Path $lkc) -or (Get-Item $lkc).Length -lt 100000) {
  Passo "Baixando a biblioteca de voz..."
  New-Item -ItemType Directory -Force -Path (Split-Path $lkc) | Out-Null
  try { Invoke-WebRequest -Uri 'https://cdn.jsdelivr.net/npm/livekit-client@2/dist/livekit-client.umd.js' -OutFile $lkc }
  catch { Aviso "Nao consegui baixar agora; o app vai buscar direto da internet." }
}
Ok "Biblioteca de voz"

# ---------------------------------------------------------------- 5. Firewall (so a rede do Tailscale)
function Regra-Existe($nomes) {
  foreach ($n in $nomes) { if (Get-NetFirewallRule -DisplayName $n -ErrorAction SilentlyContinue) { return $true } }
  return $false
}
$temUdp = Regra-Existe @('DiscordIA Voz UDP', 'Resenha Voz UDP')
$temTcp = Regra-Existe @('DiscordIA Voz TCP', 'Resenha Voz TCP')
if (-not ($temUdp -and $temTcp)) {
  Passo "Liberando a voz no Firewall (o Windows vai pedir permissao de administrador)..."
  $tmp = Join-Path $env:TEMP 'discordia-firewall.ps1'
  @(
    'netsh advfirewall firewall delete rule name="DiscordIA Voz UDP" | Out-Null',
    'netsh advfirewall firewall delete rule name="DiscordIA Voz TCP" | Out-Null',
    'netsh advfirewall firewall add rule name="DiscordIA Voz UDP" dir=in action=allow protocol=UDP localport=50000-50100 remoteip=100.64.0.0/10 profile=any | Out-Null',
    'netsh advfirewall firewall add rule name="DiscordIA Voz TCP" dir=in action=allow protocol=TCP localport=7881 remoteip=100.64.0.0/10 profile=any | Out-Null'
  ) | Set-Content -Path $tmp -Encoding ASCII
  try {
    Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$tmp`"")
    Ok "Firewall"
  } catch { Aviso "Permissao negada: seus amigos podem nao conseguir falar. Abra o DiscordIA de novo e aceite." }
} else { Ok "Firewall" }

# ---------------------------------------------------------------- 6. Tailscale
$ts = (Get-Command tailscale -ErrorAction SilentlyContinue).Source
if (-not $ts -and (Test-Path 'C:\Program Files\Tailscale\tailscale.exe')) { $ts = 'C:\Program Files\Tailscale\tailscale.exe' }
if (-not $ts) {
  Start-Process 'https://tailscale.com/download/windows'
  Parar "Instale o Tailscale pelo site que abriu, faca login e abra o DiscordIA de novo."
}
# Roda o tailscale e devolve so a saida normal (avisos dele nao viram erro aqui)
$script:tsCodigo = 0
function TS([string]$argumentos) {
  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = $ts
  $psi.Arguments = $argumentos
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.CreateNoWindow = $true
  $p = [Diagnostics.Process]::Start($psi)
  $outTask = $p.StandardOutput.ReadToEndAsync()
  $errTask = $p.StandardError.ReadToEndAsync()
  if (-not $p.WaitForExit(60000)) { try { $p.Kill() } catch {}; $script:tsCodigo = -1; $script:tsErro = 'o Tailscale nao respondeu'; return @() }
  $saida = $outTask.Result
  $script:tsCodigo = $p.ExitCode
  $script:tsErro = $errTask.Result
  return @($saida -split "`r?`n" | Where-Object { $_ })
}
$ip = (TS "ip -4" | Select-Object -First 1)
if (-not $ip) { Parar "O Tailscale esta desligado. Abra o Tailscale (icone perto do relogio), conecte e abra o DiscordIA de novo." }
$serve = (TS "serve status") -join "`n"
if ($serve -notmatch "127\.0\.0\.1:$Port") {
  Passo "Publicando o DiscordIA na sua rede Tailscale..."
  $null = TS "serve --bg $Port"
  if ($script:tsCodigo -ne 0) {
    if ($script:tsErro) { Write-Host "  $($script:tsErro.Trim())" -ForegroundColor DarkGray }
    Start-Process 'https://login.tailscale.com/admin/dns'
    Parar "Ative 'MagicDNS' e 'HTTPS Certificates' na pagina que abriu e abra o DiscordIA de novo."
  }
}
$dns = (((TS 'status --json') -join "`n" | ConvertFrom-Json).Self.DNSName).TrimEnd('.')
$endereco = "https://$dns"
if ($endereco -ne ((Get-Content $enderecoArq -Raw -ErrorAction SilentlyContinue) + '').Trim().TrimStart([char]0xFEFF)) {
  Set-Content -Path $enderecoArq -Value $endereco -Encoding ASCII
}
Ok "Tailscale ($endereco)"

# ---------------------------------------------------------------- 7. App desktop (so gera quando algo mudou)
function Versao-App {
  $arqs = @(Get-ChildItem $Desk -File | Where-Object { $_.Extension -in '.js', '.mjs', '.html', '.json' -and $_.Name -ne 'package-lock.json' }) +
          @(Get-ChildItem (Join-Path $Desk 'build') -File -Include *.ico, *.png -Recurse)
  $txt = ($arqs | Sort-Object Name | ForEach-Object { (Get-FileHash $_.FullName -Algorithm SHA256).Hash }) -join ''
  $txt += $endereco
  $sha = [Security.Cryptography.SHA256]::Create()
  return [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($txt))).Replace('-', '')
}
function App-Integro {
  $asar = Join-Path $AppDir 'resources\app.asar'
  return (Test-Path $atualArq) -and (Test-Path $AppExe) -and (Test-Path $asar) -and ((New-Object IO.FileInfo $asar).Length -gt 10000)
}
$versaoArq = Join-Path $Dist 'versao.txt'
$versao = Versao-App
$zipAmigos = Join-Path $Root 'public\download\DiscordIA-Windows.zip'
$precisa = -not (App-Integro) -or -not (Test-Path $zipAmigos) -or -not (Test-Path $versaoArq) -or ((Get-Content $versaoArq -Raw).Trim() -ne $versao)

if ($precisa) {
  Write-Host ""
  Passo "Gerando o app para Windows (so acontece quando o app muda; pode levar alguns minutos)..."
  try {
    Set-Content -Path (Join-Path $Desk 'default-server.txt') -Value $endereco -Encoding ASCII
    Push-Location $Desk
    try {
      & npm install --no-audit --no-fund --loglevel=error | Out-Host
      if ($LASTEXITCODE -ne 0) { throw "falha ao baixar o Electron" }
      $build = Join-Path $env:TEMP 'discordia-build'
      if (Test-Path $build) { Remove-Item $build -Recurse -Force -ErrorAction SilentlyContinue }
      & node empacotar.mjs $build | Out-Host
      if ($LASTEXITCODE -ne 0) { throw "falha ao montar o app" }
    } finally { Pop-Location }
    $novo = Join-Path $build 'DiscordIA-win32-x64'
    if (-not (Test-Path (Join-Path $novo 'DiscordIA.exe'))) { throw "o DiscordIA.exe nao foi gerado" }

    # zip para os amigos
    $stage = Join-Path $build 'zip'
    New-Item -ItemType Directory -Force -Path $stage | Out-Null
    Copy-Item $novo (Join-Path $stage 'DiscordIA') -Recurse
    $tmpZip = Join-Path $build 'DiscordIA-Windows.zip'
    Compress-Archive -Path (Join-Path $stage 'DiscordIA') -DestinationPath $tmpZip -CompressionLevel Optimal
    New-Item -ItemType Directory -Force -Path (Split-Path $zipAmigos) | Out-Null
    Move-Item $tmpZip $zipAmigos -Force

    # sua copia local: vai para uma pasta nova (arquivo travado na pasta antiga nao atrapalha)
    Get-Process -Name 'DiscordIA' -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($Dist, [StringComparison]::OrdinalIgnoreCase) } | Stop-Process -Force
    Start-Sleep -Seconds 2
    New-Item -ItemType Directory -Force -Path $Dist | Out-Null
    $nomeNovo = 'DiscordIA-' + $versao.Substring(0, 8) + '-' + (Get-Date -Format 'HHmmss')
    $AppDir = Join-Path $Dist $nomeNovo
    $AppExe = Join-Path $AppDir 'DiscordIA.exe'
    Copy-Item $novo $AppDir -Recurse
    Set-Content -Path $atualArq -Value $nomeNovo -Encoding ASCII
    # limpa versoes antigas (o que estiver travado fica para a proxima vez)
    Get-ChildItem $Dist -Directory | Where-Object { $_.Name -ne $nomeNovo } | ForEach-Object {
      Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
    }
    Set-Content -Path $versaoArq -Value $versao -Encoding ASCII
    Remove-Item $build -Recurse -Force -ErrorAction SilentlyContinue
    Ok "App para Windows gerado (seus amigos baixam pela engrenagem)"
  } catch {
    Aviso "Nao consegui gerar o app: $($_.Exception.Message)"
    Aviso "Sem problema: o DiscordIA vai abrir no navegador desta vez."
  }
} else { Ok "App para Windows" }

# ---------------------------------------------------------------- 8. Atalhos
# Menu Iniciar: aponta para a versao atual do app (com o icone dela)
try {
  $menu = Join-Path ([Environment]::GetFolderPath('Programs')) 'DiscordIA.lnk'
  if ((Test-Path $menu) -and (Test-Path $atualArq) -and (Test-Path $AppExe)) {
    $sh = New-Object -ComObject WScript.Shell
    $m = $sh.CreateShortcut($menu)
    if ($m.TargetPath -like '*DiscordIA.exe' -and $m.TargetPath -ne $AppExe) {
      $m.TargetPath = $AppExe
      $m.WorkingDirectory = $AppDir
      $m.IconLocation = "$AppExe,0"
      $m.Save()
    }
  }
} catch {}
# Area de Trabalho: liga o servidor e abre o app
try {
  $lnk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'DiscordIA.lnk'
  $sh = New-Object -ComObject WScript.Shell
  $s = $sh.CreateShortcut($lnk)
  $alvo = Join-Path $Root 'DiscordIA.bat'
  if ($s.TargetPath -ne $alvo) {
    $s.TargetPath = $alvo
    $s.WorkingDirectory = $Root
    $s.IconLocation = (Join-Path $Desk 'build\icon.ico') + ',0'
    $s.WindowStyle = 7
    $s.Description = 'Liga o servidor e abre o DiscordIA'
    $s.Save()
  }
} catch {}

# ---------------------------------------------------------------- 9. Liga o servidor e abre o app
Write-Host ""
$node = (Get-Command node).Source
$srv = Start-Process -FilePath $node -ArgumentList @('--disable-warning=ExperimentalWarning', 'server\index.js') -WorkingDirectory $Root -NoNewWindow -PassThru
$null = $srv.Handle
for ($i = 0; $i -lt 40 -and -not (Porta-Aberta); $i++) {
  if ($srv.HasExited) { Parar "O servidor fechou sozinho. Veja a mensagem acima." }
  Start-Sleep -Milliseconds 500
}
Abrir-App $endereco
Write-Host "  Endereco para a galera: $endereco" -ForegroundColor Cyan
Write-Host "  Deixe esta janela aberta (pode minimizar). Fechar = desligar o DiscordIA." -ForegroundColor DarkGray
Write-Host ""
$srv.WaitForExit()
exit $srv.ExitCode
