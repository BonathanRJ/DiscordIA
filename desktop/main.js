// DiscordIA — app desktop para Windows
// Abre o servidor do DiscordIA numa janela própria e adiciona o que o navegador não consegue:
// apertar para falar global (funciona com jogo em foco), atalhos globais, bandeja e voz minimizada.
const {
  app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, session, desktopCapturer,
  shell, nativeImage, net, Notification,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');

app.setAppUserModelId('com.discordia.app');
if (!app.requestSingleInstanceLock()) { app.quit(); return; }

// Não deixar o Windows/Chromium "economizar" quando o app está atrás de outra janela (Alt+Tab).
// Sem isso, a música (que roda num processo separado, o do player do YouTube) perde prioridade
// e fica lenta/picotada. O backgroundThrottling da janela só vale para a página principal.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
// O player do YouTube roda dentro do mesmo processo da página (que nunca perde prioridade). Separado, o Windows
// colocava esse processo em "modo de eficiência" quando o app ia para trás com o microfone mudo, e a música picotava.
app.commandLine.appendSwitch('disable-site-isolation-trials');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion,IntensiveWakeUpThrottling,UseEcoQoSForBackgroundProcess,IsolateOrigins,site-per-process');

// ---------- Configuração salva ----------
const CFG_PATH = path.join(app.getPath('userData'), 'config.json');
function loadCfg() {
  try { return JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')); } catch { return {}; }
}
let cfg = loadCfg();
const saveCfg = () => { try { fs.writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2)); } catch {} };
function defaultServer() {
  try { return fs.readFileSync(path.join(__dirname, 'default-server.txt'), 'utf8').replace(/^﻿/, '').trim(); } catch { return ''; }
}
function normalizeUrl(u) {
  u = String(u || '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  try { const x = new URL(u); return x.origin; } catch { return ''; }
}
const serverOrigin = () => normalizeUrl(cfg.server);

const ICON = path.join(__dirname, 'build', 'icon.ico');
const TRAY_ICON = path.join(__dirname, 'build', 'tray.png');

let win = null;
let tray = null;
let quitting = false;
let voiceState = { muted: false, deafened: false, inVoice: false };
let boundsTimer = null; // gravação pendente da posição da janela
const flushBounds = () => { if (boundsTimer) { clearTimeout(boundsTimer); boundsTimer = null; saveCfg(); } };

// ---------- Janela principal ----------
function createWindow() {
  const b = cfg.bounds || { width: 1280, height: 800 };
  win = new BrowserWindow({
    ...b,
    minWidth: 380,
    minHeight: 500,
    backgroundColor: '#121416',
    title: 'DiscordIA',
    icon: fs.existsSync(ICON) ? ICON : undefined,
    autoHideMenuBar: true,
    show: false,
    // barra de título própria (igual ao Discord); o Windows desenha só os botões de minimizar/maximizar/fechar
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0d0f11', symbolColor: '#c9cdd2', height: 36 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false, // voz continua com a janela minimizada
      spellcheck: true,
    },
  });
  Menu.setApplicationMenu(null);
  if (cfg.maximized) win.maximize();
  win.once('ready-to-show', () => { if (!process.argv.includes('--oculto')) win.show(); });

  // arrastar a janela dispara "move" sem parar: guarda a posição na hora, mas só grava no disco 500 ms depois do último
  const remember = () => {
    if (!win || win.isMinimized()) return;
    cfg.maximized = win.isMaximized();
    if (!cfg.maximized) cfg.bounds = win.getBounds();
    clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => { boundsTimer = null; saveCfg(); }, 500);
  };
  win.on('resize', remember);
  win.on('move', remember);
  win.on('session-end', flushBounds); // Windows desligando: grava a posição pendente

  // Fechar manda para a bandeja (a voz continua). Sair de verdade pela bandeja.
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
    if (!cfg.trayTipShown && Notification.isSupported()) {
      new Notification({ title: 'DiscordIA continua aberto', body: 'Ele fica na bandeja, perto do relógio. Para fechar de vez, clique com o botão direito no ícone e em Sair.' }).show();
      cfg.trayTipShown = true; saveCfg();
    }
  });

  // Links externos abrem no navegador padrão
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    const origin = serverOrigin();
    if (url.startsWith('file:')) return;
    if (origin && url.startsWith(origin)) return;
    e.preventDefault();
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });

  // Servidor fora do ar (PC desligado ou Tailscale desligado)
  win.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3 = navegação cancelada
    showLocal('setup.html', { erro: desc || String(code), servidor: cfg.server || '' });
  });

  // F12 / Ctrl+Shift+I = ferramentas de desenvolvedor; Ctrl+R = recarregar
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')) win.webContents.toggleDevTools();
    if (input.control && !input.shift && input.key.toLowerCase() === 'r') win.webContents.reload();
  });

  win.on('focus', () => { win.flashFrame(false); updateTrayMenu(); }); // mantém "Iniciar com o Windows" em dia no menu da bandeja
  openServer();
}

function showLocal(file, query = {}) {
  win.loadFile(path.join(__dirname, file), { query });
}

function openServer() {
  if (!cfg.server) cfg.server = defaultServer();
  const origin = serverOrigin();
  if (!origin) return showLocal('setup.html', { servidor: cfg.server || '' });
  win.loadURL(origin + '/');
}

// ---------- Permissões (microfone, câmera, notificações, tela) ----------
function setupPermissions() {
  const ses = session.defaultSession;
  const allowed = new Set(['media', 'notifications', 'display-capture', 'clipboard-sanitized-write', 'fullscreen', 'speaker-selection']);
  const fromServer = (wc, origin) => {
    const o = serverOrigin();
    const u = origin || wc?.getURL() || '';
    return !!o && u.startsWith(o);
  };
  ses.setPermissionRequestHandler((wc, permission, cb, details) => cb(allowed.has(permission) && fromServer(wc, details?.requestingUrl)));
  ses.setPermissionCheckHandler((wc, permission, origin) => allowed.has(permission) && fromServer(wc, origin));

  // Compartilhar tela: abre um seletor de telas/janelas
  ses.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      // a página já mostrou o seletor dela (igual à janela da câmera) e escolheu a tela/janela
      const preset = presetSource && Date.now() - presetSource.at < 20000 ? presetSource : null;
      presetSource = null;
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: preset ? { width: 0, height: 0 } : { width: 320, height: 180 }, fetchWindowIcons: false });
      const choice = preset || await pickSource(sources);
      if (!choice) return callback({});
      const src = sources.find((s) => s.id === choice.id);
      if (!src) return callback({});
      // Som só na tela inteira. 'loopback' + restrictOwnAudio (pedido pela página) = som do PC SEM o som do
      // próprio DiscordIA, então ninguém se ouve de volta (precisa Windows 11).
      // Importante: não mandar a chave "audio" quando não tem som (senão dá "Invalid capture constraints").
      const out = { video: src };
      if (choice.audio && src.id.startsWith('screen') && request.audioRequested !== false) out.audio = 'loopback';
      callback(out);
    } catch (e) {
      console.error(e);
      callback({});
    }
  }, { useSystemPicker: false });
}

// Seletor de telas dentro da própria página (sem a barra branca do Windows)
let presetSource = null;
ipcMain.handle('desktop:screenSources', async () => {
  const s = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 400, height: 225 }, fetchWindowIcons: true });
  return s.filter((x) => x.id.startsWith('screen') || !/DiscordIA$/.test(x.name)) // a própria janela do app não aparece
    .map((x) => ({ id: x.id, name: x.name, thumb: x.thumbnail.toDataURL(), icon: x.appIcon && !x.appIcon.isEmpty() ? x.appIcon.toDataURL() : null, screen: x.id.startsWith('screen') }));
});
ipcMain.handle('desktop:chooseScreen', (_e, v) => {
  presetSource = v && v.id ? { id: String(v.id), audio: !!v.audio, at: Date.now() } : null;
  return true;
});

function pickSource(sources) {
  return new Promise((resolve) => {
    const picker = new BrowserWindow({
      parent: win, modal: true, width: 760, height: 560, resizable: true, minimizable: false, maximizable: false,
      title: 'Compartilhar tela', backgroundColor: '#181b1e', autoHideMenuBar: true, show: false,
      titleBarStyle: 'hidden', titleBarOverlay: { color: '#181b1e', symbolColor: '#c9cdd2', height: 36 }, // sem a barra branca
      icon: fs.existsSync(ICON) ? ICON : undefined,
      webPreferences: { preload: path.join(__dirname, 'picker-preload.js'), contextIsolation: true, sandbox: true },
    });
    let done = false;
    const finish = (v) => { if (done) return; done = true; ipcMain.removeHandler('picker:list'); ipcMain.removeAllListeners('picker:choose'); resolve(v); if (!picker.isDestroyed()) picker.close(); };
    ipcMain.handle('picker:list', () => sources.map((s) => ({ id: s.id, name: s.name, thumb: s.thumbnail.toDataURL(), screen: s.id.startsWith('screen') })));
    ipcMain.once('picker:choose', (_e, v) => finish(v));
    picker.on('closed', () => finish(null));
    picker.once('ready-to-show', () => picker.show());
    picker.loadFile(path.join(__dirname, 'picker.html'));
  });
}

// ---------- Apertar para falar global (uiohook) ----------
let hook = null;
let hookKeys = null;
let ptt = { enabled: false, code: '' };
let pttDown = false;
try {
  const m = require('uiohook-napi');
  hook = m.uIOhook;
  hookKeys = m.UiohookKey;
} catch (e) {
  console.warn('Teclado global indisponível:', e.message);
}
// Converte o código de tecla do navegador (KeyboardEvent.code) para o código do uiohook
function codeToHook(code) {
  if (!hookKeys || !code) return null;
  if (code === 'Mouse4') return { mouse: 4 };
  if (code === 'Mouse5') return { mouse: 5 };
  const map = {
    ControlLeft: 'Ctrl', ControlRight: 'CtrlRight', ShiftLeft: 'Shift', ShiftRight: 'ShiftRight',
    AltLeft: 'Alt', AltRight: 'AltRight', MetaLeft: 'Meta', MetaRight: 'MetaRight',
  };
  let name = map[code] || code.replace(/^Key/, '').replace(/^Digit/, '');
  const k = hookKeys[name];
  return typeof k === 'number' ? { key: k } : null;
}
let hookStarted = false;
function applyPtt() {
  if (!hook) return false;
  const target = ptt.enabled ? codeToHook(ptt.code) : null;
  if (!target) {
    if (hookStarted) { try { hook.stop(); } catch {} hookStarted = false; }
    return false;
  }
  hook.removeAllListeners();
  const down = () => { if (!pttDown) { pttDown = true; send('ptt-down'); } };
  const up = () => { if (pttDown) { pttDown = false; send('ptt-up'); } };
  if (target.key != null) {
    hook.on('keydown', (e) => { if (e.keycode === target.key) down(); });
    hook.on('keyup', (e) => { if (e.keycode === target.key) up(); });
  } else {
    hook.on('mousedown', (e) => { if (e.button === target.mouse) down(); });
    hook.on('mouseup', (e) => { if (e.button === target.mouse) up(); });
  }
  if (!hookStarted) {
    try { hook.start(); hookStarted = true; } catch (e) { console.warn('Falha ao iniciar teclado global:', e.message); return false; }
  }
  return true;
}

function send(cmd) {
  if (win && !win.isDestroyed()) win.webContents.send('desktop:command', cmd);
}

// ---------- Bandeja ----------
function buildTray() {
  const img = fs.existsSync(TRAY_ICON) ? nativeImage.createFromPath(TRAY_ICON) : nativeImage.createEmpty();
  tray = new Tray(img);
  tray.setToolTip('DiscordIA');
  tray.on('click', showWindow);
  updateTrayMenu();
}
function updateTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Abrir DiscordIA', click: showWindow },
    { type: 'separator' },
    { label: 'Microfone silenciado', type: 'checkbox', checked: voiceState.muted, click: () => send('mute') },
    { label: 'Áudio desligado', type: 'checkbox', checked: voiceState.deafened, click: () => send('deafen') },
    { label: 'Sair da sala de voz', enabled: voiceState.inVoice, click: () => send('leave') },
    { type: 'separator' },
    { label: 'Trocar endereço do servidor…', click: () => { showWindow(); showLocal('setup.html', { servidor: cfg.server || '', trocar: '1' }); } },
    { label: 'Iniciar com o Windows', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin, click: (i) => app.setLoginItemSettings({ openAtLogin: i.checked, args: ['--oculto'] }) },
    { type: 'separator' },
    { label: 'Sair', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.setToolTip(voiceState.inVoice ? `DiscordIA — na voz${voiceState.muted ? ' (mudo)' : ''}` : 'DiscordIA');
}
function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// ---------- Atalhos (Área de Trabalho e Menu Iniciar) ----------
// Mantém os atalhos apontando para este DiscordIA.exe, mesmo depois de uma atualização mudar a pasta.
// Um atalho que aponta para outra coisa (ex.: o DiscordIA.bat do servidor) não é mexido.
function ensureShortcuts() {
  if (process.platform !== 'win32' || !app.isPackaged) return;
  const target = process.execPath;
  const opts = { target, cwd: path.dirname(target), icon: target, iconIndex: 0, description: 'DiscordIA', appUserModelId: 'com.discordia.app' };
  const links = [
    path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'DiscordIA.lnk'),
    path.join(app.getPath('desktop'), 'DiscordIA.lnk'),
  ];
  for (const lnk of links) {
    try {
      if (fs.existsSync(lnk)) {
        let atual = '';
        try { atual = shell.readShortcutLink(lnk).target || ''; } catch {}
        if (/discordia\.exe$/i.test(atual) && atual.toLowerCase() !== target.toLowerCase()) shell.writeShortcutLink(lnk, 'replace', opts);
      } else if (!cfg.shortcutsCreated) {
        shell.writeShortcutLink(lnk, 'create', opts);
      }
    } catch (e) { console.warn(e); }
  }
  if (!cfg.shortcutsCreated) { cfg.shortcutsCreated = true; saveCfg(); }
}

// ---------- IPC ----------
ipcMain.handle('desktop:setPtt', (_e, v) => {
  ptt = { enabled: !!v?.enabled, code: String(v?.code || '') };
  return applyPtt();
});
ipcMain.on('desktop:state', (_e, s) => {
  const next = { muted: !!s?.muted, deafened: !!s?.deafened, inVoice: !!s?.inVoice };
  // a página manda o mesmo estado várias vezes (a cada aperto do apertar-para-falar): só refaz o menu se mudou
  if (next.muted === voiceState.muted && next.deafened === voiceState.deafened && next.inVoice === voiceState.inVoice) return;
  voiceState = next;
  updateTrayMenu();
});
ipcMain.on('desktop:flash', () => {
  if (win && !win.isFocused()) win.flashFrame(true);
});
ipcMain.handle('setup:save', async (_e, raw) => {
  const origin = normalizeUrl(raw);
  if (!origin) return { ok: false, error: 'Endereço inválido.' };
  try {
    const r = await net.fetch(origin + '/manifest.webmanifest', { cache: 'no-store' });
    const j = await r.json();
    if (!/discordia/i.test(j?.name || '')) return { ok: false, error: 'Esse endereço respondeu, mas não parece ser um servidor DiscordIA.' };
  } catch {
    return { ok: false, error: 'Não consegui conectar. Confira se o Tailscale está ligado e se o PC do servidor está com o DiscordIA aberto.' };
  }
  cfg.server = origin; saveCfg();
  openServer();
  return { ok: true };
});
ipcMain.on('setup:retry', () => openServer());

// ---------- Ciclo de vida ----------
app.on('second-instance', showWindow);
app.on('before-quit', () => { quitting = true; flushBounds(); });
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (hookStarted) { try { hook.stop(); } catch {} }
});
app.on('window-all-closed', () => { /* fica na bandeja */ });

app.whenReady().then(() => {
  ensureShortcuts(); // antes da janela: a barra de tarefas pega o ícone do atalho
  setupPermissions();
  createWindow();
  buildTray();
  globalShortcut.register('CommandOrControl+Shift+M', () => send('mute'));
  globalShortcut.register('CommandOrControl+Shift+D', () => send('deafen'));
});
