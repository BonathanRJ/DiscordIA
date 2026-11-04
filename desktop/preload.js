// Ponte segura entre a página do DiscordIA e o app desktop
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('discordiaDesktop', {
  isDesktop: true,
  titleBar: true, // a página desenha a barra de título (os botões da janela ficam à direita)
  // Liga/desliga o apertar para falar global. Retorna true se a tecla funciona no sistema todo.
  setPtt: (v) => ipcRenderer.invoke('desktop:setPtt', { enabled: !!v?.enabled, code: String(v?.code || '') }),
  // Comandos vindos de atalhos globais e da bandeja: 'mute', 'deafen', 'ptt-down', 'ptt-up', 'leave'
  onCommand: (cb) => {
    if (typeof cb !== 'function') return;
    ipcRenderer.on('desktop:command', (_e, cmd) => cb(String(cmd)));
  },
  state: (s) => ipcRenderer.send('desktop:state', { muted: !!s?.muted, deafened: !!s?.deafened, inVoice: !!s?.inVoice }),
  flash: () => ipcRenderer.send('desktop:flash'),
  // seletor de tela feito pela página: lista as telas/janelas e deixa escolhida a que vai ser transmitida
  screenSources: () => ipcRenderer.invoke('desktop:screenSources'),
  chooseScreen: (v) => ipcRenderer.invoke('desktop:chooseScreen', v ? { id: String(v.id || ''), audio: !!v.audio } : null),
});

// Só usado pela tela local de configuração do servidor
contextBridge.exposeInMainWorld('discordiaSetup', {
  save: (url) => ipcRenderer.invoke('setup:save', String(url || '')),
  retry: () => ipcRenderer.send('setup:retry'),
});
