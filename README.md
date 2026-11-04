# DiscordIA

Chat de texto e voz no estilo Discord para um grupo pequeno de amigos (até ~10). Roda no **PC Windows do Jonathan** e é acessado pelo **Tailscale** em `https://fdm-n-041.tailb26d1d.ts.net` (IP do Tailscale do PC: `100.96.31.27`). O app se chama **DiscordIA**. Os servidores dentro dele têm nome próprio; o principal é **SÓ OS CRIA**.

- Este arquivo tem duas partes. A primeira é o **manual de uso**. A segunda, **"Contexto para continuar o desenvolvimento"**, resume tudo o que foi construído e decidido, para quem for continuar o projeto começar um chat novo a partir daqui.
- A pasta de verdade do projeto é **`C:\DiscordIA`** no PC do Jonathan. É ela que roda e é dela que se deve partir.

---

## Parte 1: manual de uso

### Para o dono do servidor

Só existe um arquivo para clicar: **`DiscordIA.bat`**. Na primeira vez, ele cria o atalho **DiscordIA** na Área de Trabalho.

Toda vez que abre, ele confere e resolve sozinho o que faltar:

1. Node.js
2. Servidor de voz (LiveKit)
3. Firewall (pede administrador só na primeira vez)
4. Tailscale e o HTTPS
5. App para Windows: só gera de novo quando algo na pasta `desktop` mudou
6. Liga o servidor e abre o app

**A janela preta é o servidor:** deixe aberta (pode minimizar). Fechar a janela desliga o DiscordIA para todo mundo.

**Depois de mexer em `server/`,** feche a janela preta e abra o `DiscordIA.bat` de novo. Se só `public/` mudou, basta **Ctrl+R** no app.

### Chamar um amigo

1. O amigo instala o Tailscale e cria a conta dele.
2. Em https://login.tailscale.com/admin/machines, clique em **"…"** no PC, depois em **Share…**, e mande o link para ele aceitar.
3. Mande o **link de convite** do servidor. Ele fica no menu do nome do servidor, em **Convidar para o servidor**, e só o administrador vê. O link já leva o código e cria a conta direto naquele servidor.

### Para os amigos

- Tailscale instalado, logado e ligado, com o compartilhamento aceito.
- Abrir o link de convite e criar a conta.
- No PC, o app para Windows é opcional: **engrenagem → Baixar app para Windows**. No celular é só o navegador.

### App para Windows x navegador

| | Navegador | App |
|---|---|---|
| Apertar para falar | só com a aba em foco | funciona dentro do jogo (tecla ou botão lateral do mouse) |
| Silenciar / desligar áudio | botões | botões + **Ctrl+Shift+M** / **Ctrl+Shift+D** em qualquer lugar |
| Fechar a janela | sai da voz | vai para a bandeja e continua na voz |
| Som da tela compartilhada | depende do navegador | som do PC **sem** o som do próprio app (Windows 11) |

### Atalhos

| Ação | Como |
|---|---|
| Enviar / quebrar linha | Enter / Shift + Enter |
| Editar última mensagem | Seta ↑ com a caixa vazia |
| Buscar mensagens | Ctrl + F |
| Voltar / avançar | Alt + ← / Alt + → (ou as setas da barra de cima) |
| Enviar imagem | Ctrl + V, arrastar ou clipe |

### Comandos no chat

- **Música, só no canal `#tempo` da categoria Músicas:**
  - `/play link` (ou `/tocar`), `/pause`, `/resume`, `/skip` (ou `/pular`)
  - `/loop` (`música` / `fila` / `off`), `/fila`, `/tocando`, `/remover n`, `/embaralhar`, `/limpar`
  - `/stop` (ou `/parar`), `/ajuda`
- **`@all`** (também `@todos` / `@everyone`): marca todo mundo. Não vale no `#tempo`.
- **`/clean`** (só administrador): apaga todas as mensagens do canal, com confirmação.

### Problemas comuns

- **"Não é possível acessar esse site":** o Tailscale do amigo está ligado? Ele aceitou o compartilhamento? O DiscordIA está aberto? No Android, desligue o **DNS privado**.
- **Microfone não liga no navegador:** use o endereço `https://…ts.net`, nunca o IP `100.x.x.x`.
- **Erro "Ação desconhecida":** o servidor está desatualizado. Feche a janela preta e abra o `DiscordIA.bat` de novo.

### Pastas

| Pasta | O que é |
|---|---|
| `data` | banco de dados (`resenha.db`), `config.json` e arquivos enviados (`uploads`). **Faça backup** com o DiscordIA fechado |
| `server` | servidor Node.js |
| `public` | o app (HTML/CSS/JS) que o navegador e o app desktop carregam |
| `desktop` | app Electron para Windows (`dist` é gerado sozinho) |
| `livekit` | servidor de voz (baixado sozinho) |
| `scripts` | o que o `DiscordIA.bat` usa por baixo (`discordia.ps1`) |

---

## Parte 2: contexto para continuar o desenvolvimento

### Quem e como

- **Usuário:** Jonathan (Bonathan no app), administrador e primeira conta. Fala português e pede tudo **igual ao Discord**, mandando prints do Discord de referência.
  - Riscos em vermelho nos prints significam **"não quero isso"**.
  - Quando ele diz "caso não tenha no print, deixe vazio", a opção fica como placeholder.
- **Respostas para ele:** em português, com linguagem simples e sem jargão.
  - No fim de cada entrega, dizer se precisa **reiniciar o DiscordIA.bat** (mudou `server/`), **refazer o app** (mudou `desktop/`; o `.bat` refaz sozinho) ou só **Ctrl+R** (mudou `public/`).
- **Fluxo de trabalho usado até aqui:**
  - edita-se uma cópia local;
  - testa-se com Chrome headless (Playwright) e várias contas;
  - copiam-se os arquivos para `C:\DiscordIA\...` no PC e confere-se o sha256 do arquivo gravado.
- **O que não dá para testar fora do PC:** o LiveKit não roda no ambiente de desenvolvimento usado até agora. Voz real, transmissão e música do YouTube só foram testadas por simulação (mocks); os testes reais são do Jonathan.

### Pilha técnica

- **Servidor (`server/index.js`, `server/db.js`):**
  - Node.js 22.13+ em ESM, **sem frameworks** (`node:http`, `node:sqlite` DatabaseSync).
  - Tempo real por **Server-Sent Events** em `/api/events`; `broadcast` / `sendTo` / `emit(canal, …)` respeitam quem pode ver.
  - API de leitura com `GET /api/state`, `/api/messages`, `/api/search`, `/api/invite-info` e `/api/voice-token`.
  - Quase tudo que muda dados é `POST /api/action { type, ... }`, num `switch` dentro de `action(user, b)`.
  - Uploads por `POST /api/upload`, servidos em `/uploads/...` só para quem está logado.
  - Arquivos estáticos com ETag; `/vendor/*` com cache de 1 dia.
- **Banco:**
  - Tabelas: `users`, `sessions`, `servers`, `server_members`, `categories`, `channels` (também guarda as DMs: `dm_a` / `dm_b`), `messages` (colunas extras `reply_to`, `forward`, `call`, `sys`), `reactions`, `reads`, `friends`, `dm_closed`, `access` (quem vê canal/categoria privada) e `meta`.
  - As migrações são feitas com `addColumn` no `db.js` e no início do `index.js` (criação do servidor nº 1 a partir do `config.json` antigo).
- **Cliente (`public/app.js`, `public/app.css`, `public/index.html`):**
  - JavaScript puro, num único arquivo grande, com o helper `h(tag, attrs, ...filhos)`.
  - Estado global em `S` (dados) e `V` (voz); preferências locais em `prefs` (localStorage `discordia.prefs`).
  - Ícones são `<symbol>` SVG no `index.html` (`icon('nome')`).
  - Janelas no estilo Discord usam `openModal` + classe `mx` (`modalHead`, `switchEl`, `memberPicker`, …).
  - `window.__dia` expõe `S`, `V` e algumas funções **só para os testes automáticos**.
- **Voz:**
  - LiveKit (binário Go em `livekit/`, iniciado pelo servidor com yaml gerado: `node_ip` = IP do Tailscale, UDP 50000–50100, TCP 7881). A sinalização passa pelo proxy `/livekit`.
  - Cliente `public/vendor/livekit-client.umd.js` (2.23), com `webAudioMix` para volume por pessoa acima de 100%.
  - Microfone com `MicProcessor` (`public/audio/engine.js`) + AudioWorklet (`mic-worklet.js`): RNNoise (`vendor/rnnoise`), noise gate com sensibilidade automática e ganho.
- **App desktop (`desktop/`):**
  - Electron 45 com `uiohook-napi` (apertar para falar global), bandeja, atalhos globais e barra de título própria (`titleBarStyle: hidden`).
  - Seletor de tela feito pela própria página (`desk.screenSources` / `desk.chooseScreen`).
  - Switches que impedem o Windows de "economizar" o app em segundo plano; site isolation desligado para o player do YouTube rodar no mesmo processo.
  - Empacotado por `desktop/empacotar.mjs` numa pasta versionada `dist\DiscordIA-<hash>`; o `.bat` refaz quando o hash dos arquivos de `desktop` muda.

### Tudo o que já existe

**Contas e perfis**
- Cadastro só com convite; senha com scrypt.
- Perfil com nome, cor, **foto** e **banner** (imagem ou cor). As imagens são recortadas no navegador e enviadas como webp.
- Cartão de perfil ao clicar no nome ou na foto.
- Administrador (★): é a primeira conta e entra automaticamente em todos os servidores.

**Vários servidores**
- Barra da esquerda com o botão de DMs, os servidores (com balão de nome ao passar o mouse) e o **+** para criar servidor, que só o administrador vê.
- Cada servidor tem nome, **imagem** (ou iniciais, ou o ícone do app), convite próprio (com validade e limite de usos), membros, categorias, canais e o próprio `#tempo`.
- Entrada só por convite: ao abrir o link logado, o app pergunta se quer entrar.
- Menu do nome do servidor: **Convidar**, **Config. do servidor** (imagem, nome, excluir), **Criar canal**, **Criar categoria**, **Config. de notificação** e **Excluir servidor**.

**Canais**
- Canais de texto e de voz dentro de **categorias** recolhíveis.
- **Canal ou categoria privada** com lista de quem vê.
- **Arrastar** canais entre categorias e reordenar categorias (só administrador).

**Mensagens**
- Markdown simples, menções, spoiler e anexos (25 MB).
- Editar (seta ↑) e apagar sem pular a rolagem.
- **Responder**, **encaminhar** (janela igual à do Discord, até 5 destinos) e **reações** (seletor completo de emojis em português, chips azuis nas suas, balão "fulano reagiu com", escolher de novo tira a reação, até 20 por mensagem).
- Menu do botão direito na mensagem, linha "Novas mensagens", indicador de "digitando…".

**Busca estilo Discord**
- Filtros `de:`, `em:`, `tem:` (link, arquivo, imagem, vídeo, áudio, encaminhada), `menciona:`, `antes:`, `depois:` e `durante:`.
- Ignora acentos; resultados num painel à direita com "Pular" para a mensagem.

**Mensagens diretas, amigos e ligações privadas**
- Conversas privadas, sistema de **amigos** (pedido, aceitar, remover) e página Amigos com abas.
- **Ligação privada** como no celular: toca, Atender ou Recusar, painel da ligação em cima do chat e registro "fulano iniciou uma chamada que durou…" / "você perdeu uma chamada…".

**Voz**
- Supressão de ruído, detecção de voz ou apertar para falar, volume por pessoa e indicador de qualidade da conexão.
- Câmera **com prévia antes de ligar**.
- **Transmissão de tela:**
  - seletor dentro da página, sem a barra branca do Windows, e escolha de **qualidade** (480p a 1080p, 30 ou 60 fps);
  - som do PC sem o som do próprio app;
  - **volume da transmissão** de cada pessoa só para você;
  - quem transmite não abre a própria tela em tela cheia.
- Grade de pessoas **igual ao Discord**: blocos 16:9 com a foto no meio, fundo na cor média da foto, arrumação automática para 1 a 5 ou mais pessoas.
- **Botão direito em quem está na sala** abre:
  - Perfil, Mencionar, Mensagem, Iniciar chamada;
  - Volume do usuário, Silenciar, Desativar vídeo;
  - Adicionar amigo;
  - **Mover para**, **Silenciar voz no servidor**, **Desativar áudio no servidor** e **Desconectar**.
- **Arrastar a pessoa** até outra sala para movê-la. Mover, desconectar e silenciar no servidor ficaram liberados para **todos** os membros.
- Entrar na sala foi acelerado: microfone e supressão de ruído preparados junto com a conexão, token pedido ao passar o mouse na sala, e o ícone de sinal mostra quanto tempo levou.

**Música ("Ouvir juntos")**
- Player oficial do YouTube **escondido** (só áudio), sincronizado pelo servidor para quem está na mesma sala de voz.
- Comandos **só no `#tempo`**; respostas do "bot" **DiscordIA Música ✓BOT**, com cartão do vídeo.
- Botão 🎵 no cartão de voz abre o menu, **acima** do "Voz conectada": capa, nome, barra de progresso arrastável, repetir (desligado / música / fila), voltar do início, pausar, pular, parar, volume próprio, fila e campo para colar link.
- Os controles valem para todos da sala; o volume é de cada um.
- Por enquanto **só links de vídeo**: não há busca por nome nem playlists.

**Notificações**
- Por servidor: silenciar (com duração), Todas / Apenas @menções / Nada, silenciar @todos, e ajustes por canal ou categoria.
- Som e notificação do Windows.

**Administração**
- Aba **Usuários** (só administrador) na página Amigos: lista todas as contas, mostra em quais servidores cada uma está (botão **Servidores ▾** coloca ou tira), Mensagem e **Deletar**.
- No botão direito em alguém do servidor: **Expulsar do servidor** e **Deletar usuário**, ambos com confirmação.
- Ao deletar uma conta, as mensagens dela ficam como **"Usuário excluído"**.

**Visual**
- Tema escuro com laranja como cor de destaque.
- **Barra de título própria** (setas voltar/avançar, nome do servidor ou da conversa no meio, botões do Windows à direita).
- Mensagem encaminhada no estilo do Discord.
- Ícones da interface (player de música, 🎵, silenciado, anexo, sala de voz, tela cheia) são SVG; emojis só onde são conteúdo (reações, seletor, texto do bot, notificação do Windows e `<option>` de select).

### Decisões já tomadas (não refazer sem perguntar)

- **Tailscale:** fica (não usar Funnel nem expor portas na internet).
- **Música:** player oficial do YouTube, e não um bot que baixa o áudio (violaria os termos do YouTube). Esconder o vídeo foi escolha do Jonathan, sabendo que vai contra as regras do player.
- **Removidos a pedido:**
  - tópicos, favoritar, marcar como não lido, denunciar;
  - "Editar perfil por servidor";
  - "Silenciar efeitos sonoros" (não existe soundboard);
  - botões de ±10 s da música.
- **Fora dos menus (riscados nos prints):** notas, apps, cargos, ignorar, bloquear, eventos, impulso, diretório de apps, config. de privacidade, ocultar canais silenciados e "Solicitações de mensagens".

### Como trabalhar economizando tokens (pedido do Jonathan)

O Jonathan pediu para **economizar tokens**. Siga isto em todo chat novo:

- **Não leia arquivos grandes inteiros.** O `public/app.js` tem ~3.900 linhas, o `server/index.js` ~1.450 e o `public/app.css` ~1.085. Use busca (Grep) pelo nome da função ou do texto e leia só o trecho com `offset`/`limit`.
- **Use o mapa abaixo** para ir direto à seção certa, em vez de explorar o projeto.
- **Edite só o trecho que muda**, com a ferramenta de edição. Nunca reescreva o arquivo inteiro e nunca use heredoc sem aspas no shell, porque `$('#…')` é expandido e corrompe o arquivo.
- **Teste só o que mudou.** Um teste headless focado no recurso novo; não refaça a bateria toda a cada entrega.
- **Mande para o PC só os arquivos alterados** e confira só o sha256 deles. Não fique copiando o projeto inteiro de volta.
- **Respostas curtas:** o que mudou, se precisa reiniciar o `.bat` ou só Ctrl+R, e pronto. Sem recapitular o trabalho.
- **Pergunte antes** só quando o print ou o pedido não deixarem claro; senão, faça.

**Mapa do `public/app.js`** (linhas aproximadas; procure pelo comentário `// ---------- Nome ----------`):

| Linha | Seção |
|---|---|
| 9 | Utilidades (`h`, `$`, `icon`, `toast`…) |
| 58 | Preferências locais (`prefs`) |
| 80 | Estado (`S`, `V`) |
| 114 | Sons |
| 138 | Entrada (login / cadastro) |
| 175 | Inicialização e eventos SSE |
| 310 | Barra lateral (servidores, canais, salas de voz) |
| 534 | Mensagens (render, reações, emojis, encaminhar) |
| 1188 | DMs, amigos, perfis, ligações privadas |
| 1800 | Digitando… |
| 1816 | Caixa de mensagem |
| 1898 | Voz (`joinVoice`, `leaveVoice`, tiles) |
| 2083 | Microfone (captura + processamento) |
| 2179 | Volumes de quem você ouve |
| 2343 | Apertar para falar |
| 2370 | Ponte com o app desktop (tela, câmera) |
| 2535 | Modais (configurações do usuário etc.) |
| 2846 | Barra de título e voltar/avançar |
| 2856 | Menu do servidor (convite, config., criar canal/categoria, excluir) |
| 3195 | Notificações do servidor |
| 3335 | Busca de mensagens |
| 3581 | Música |
| 3769 | Botão direito em quem está na voz, "Mover para" |
| 3854 | Grade de pessoas na sala (`layoutTiles`, `tileColor`) |

**Mapa do `server/index.js`:** Configuração (19), Utilidades e visibilidade (67), Tempo real SSE (370), Ligações privadas (410), Música (467), Token LiveKit (647), Limite de login (662), Rotas da API e `action()` com o `switch` de tipos (672), Arquivos estáticos (1299), Servidor HTTP (1342), Proxy LiveKit (1357), Início do LiveKit (1382).

### Próximos pedidos do Jonathan (fazer nesta ordem)

1. **Dividir o `app.js` em módulos** (ES modules em `public/js/…`), por exemplo um por seção do mapa acima.
   - Fazer **sem mudar comportamento**: mover código, exportar e importar.
   - Manter `window.__dia` funcionando para os testes.
   - Atualizar o mapa deste README no fim.
2. **Busca do YouTube por nome** (`/play nome da música` e no campo do player).
   - Precisa de uma chave da **YouTube Data API v3**: o Jonathan cria no Google Cloud e ela fica no `data/config.json`, nunca no cliente.
   - O servidor busca, pega o primeiro resultado e segue o fluxo atual. Se não houver chave, mantém a mensagem de hoje ("só link").
   - Talvez dê para aproveitar e aceitar playlists.

### Pendências e ideias em aberto

- **Atraso ao entrar na sala de voz:** o Jonathan começou a descrever ("eu clico para entrar na sala…") e não terminou. Já houve otimizações (ver Voz). Próximo passo: pedir o tempo que o ícone de sinal mostra.
  - Se "conectar" passar de ~2 s, investigar a conexão UDP do LiveKit pelo Tailscale, que pode estar caindo para TCP.
- **Música picotando com o app em segundo plano e o microfone mudo:** foram aplicadas correções no app desktop (switches de segundo plano e EcoQoS; player no mesmo processo). **Falta confirmação do Jonathan.**
- **Transmissão de tela:** conferir com uso real a nova qualidade escolhida e o som sem eco, que exige Windows 11.
- **Ideias oferecidas e não pedidas (não começar sem ele pedir):**
  - janelinha flutuante de controles na chamada;
  - soundboard;
  - tipo de canal **Fórum**;
  - outros administradores.
- **Limitação do Windows 10:** bandeiras de emoji aparecem como letras.
