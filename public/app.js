// DiscordIA — cliente web
import { MicProcessor, dbToPct } from './audio/engine.js';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const LK = () => window.LivekitClient;
// biblioteca de voz (610 KB): carrega em segundo plano depois que o app abre, em vez de segurar a abertura.
// Se a cópia local falhar, tenta a da internet (como antes). Entrar na voz espera por ela.
let lkLoading = null;
function loadLK() {
  if (LK()) return Promise.resolve(LK());
  return (lkLoading ||= new Promise((resolve) => {
    const add = (src, next) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = () => (LK() ? resolve(LK()) : next());
      s.onerror = next;
      document.head.append(s);
    };
    add('/vendor/livekit-client.umd.js', () => add('https://cdn.jsdelivr.net/npm/livekit-client@2/dist/livekit-client.umd.js', () => resolve(LK())));
  }));
}
const desk = window.discordiaDesktop || null; // existe só dentro do app desktop
let globalPtt = false; // true quando o app desktop captura a tecla no sistema todo

// ---------- Utilidades ----------
function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') for (const [p, val] of Object.entries(v)) { if (p.startsWith('--')) e.style.setProperty(p, val); else e.style[p] = val; }
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(String(k)));
  return e;
}
const icon = (id) => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.innerHTML = `<use href="#i-${id}"/>`; return s; };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const initials = (n) => (n || '?').trim().split(/\s+/).slice(0, 2).map((p) => p[0]).join('').toUpperCase();
const fmtTime = (t) => new Date(t).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
function fmtDay(t) {
  const d = new Date(t), today = new Date();
  const y = new Date(); y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Hoje';
  if (d.toDateString() === y.toDateString()) return 'Ontem';
  return d.toLocaleDateString('pt-BR', { day: 'numeric', month: 'long', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}
const fmtSize = (b) => (b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB');

async function api(path, body, method) {
  const res = await fetch(path, {
    method: method || (body ? 'POST' : 'GET'),
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) throw Object.assign(new Error(data?.error || `Erro ${res.status}`), { status: res.status });
  return data;
}
const act = (type, extra = {}) => api('/api/action', { type, ...extra });

function toast(text, err = false, ms = 4000) {
  const t = h('div', { class: 'toast' + (err ? ' err' : '') }, text);
  $('#toasts').append(t);
  setTimeout(() => t.remove(), ms);
  return t;
}

// ---------- Preferências locais ----------
const prefs = Object.assign(
  { sounds: true, notify: 'mentions', ptt: false, pttKey: 'KeyV', mic: '', speaker: '', volumes: {}, hideMembers: false, lastChannel: 0 },
  (() => { try { return JSON.parse(localStorage.getItem('discordia.prefs') || localStorage.getItem('resenha.prefs') || '{}'); } catch { return {}; } })(),
);
const AUDIO_DEFAULTS = {
  inputVolume: 100,   // %
  outputVolume: 100,  // %
  ns: 'forte',        // supressão de ruído: 'forte' (IA) | 'padrao' (navegador) | 'off'
  echo: true,         // cancelamento de eco
  agc: true,          // controle automático de ganho
  autoSens: true,     // sensibilidade automática
  threshold: -50,     // sensibilidade manual (dB)
  pttDelay: 200,      // atraso ao soltar o apertar para falar (ms)
  quality: 64,        // kbps
};
prefs.audio = { ...AUDIO_DEFAULTS, ...(prefs.audio || {}) };
prefs.userMuted ||= {};
if (!Array.isArray(prefs.recentEmojis) || !prefs.recentEmojis.length) prefs.recentEmojis = ['👍', '✅', '🔥', '😂'];
const A = () => prefs.audio;
const savePrefs = () => { try { localStorage.setItem('discordia.prefs', JSON.stringify(prefs)); } catch {} };

// ---------- Estado ----------
const S = {
  me: null, users: new Map(), channels: [], online: new Set(), voice: {}, unread: {},
  current: null, view: 'chat', msgs: {}, hasMore: {}, loading: false,
  typing: {}, invite: null, voiceEnabled: true,
  dms: [], friends: {}, calls: {}, mode: 'server', friendsTab: 'online',
  connId: crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2),
};
const V = { room: null, channelId: null, muted: false, deafened: false, speaking: new Set(), videoEls: new Map(), pttHeld: false, joining: false,
  micTrack: null, micProc: null, pttTimer: 0, meSpeaking: false, levelListeners: new Set() };

const userName = (id) => S.users.get(Number(id))?.displayName || 'alguém';
// ---- vários servidores
S.servers = []; S.serverId = 0; S.allCategories = [];
const serverById = (id) => S.servers.find((s) => s.id === Number(id));
const curServer = () => serverById(S.serverId) || S.servers[0] || null;
const serverName = (id) => serverById(id ?? S.serverId)?.name || 'Servidor';
const isMusicChannel = (cid) => !!cid && S.servers.some((s) => s.musicChannel === Number(cid));
const srvChannels = (sid = S.serverId) => S.channels.filter((c) => c.server_id === sid);
// atalhos que valem para o servidor aberto agora
Object.defineProperties(S, {
  serverName: { get: () => serverName() },
  invite: { get: () => curServer()?.invite?.code || null },
  inviteInfo: { get: () => curServer()?.invite || null },
  musicChannel: { get: () => curServer()?.musicChannel || 0 },
  member: { get: () => S.servers.length > 0 },
  categories: { get: () => S.allCategories.filter((k) => k.server_id === S.serverId) },
});
const isMember = (u) => !!u && !u.deleted && !!curServer()?.members.includes(u.id);
const channelById = (id) => S.channels.find((c) => c.id === Number(id)) || dmById(id);
// conversa privada vira um "canal" com o nome da outra pessoa
function dmById(id) { const d = S.dms.find((x) => x.id === Number(id)); return d ? { ...d, name: userName(d.dm) } : undefined; }
const isDm = (id) => S.dms.some((x) => x.id === Number(id));

// ---------- Sons ----------
let actx;
function beep(notes) {
  if (!prefs.sounds) return;
  try {
    actx ||= new AudioContext();
    let t = actx.currentTime;
    for (const [freq, dur] of notes) {
      const o = actx.createOscillator(), g = actx.createGain();
      o.type = 'sine'; o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.12, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(actx.destination); o.start(t); o.stop(t + dur + 0.02);
      t += dur * 0.8;
    }
  } catch {}
}
const SND = {
  msg: () => beep([[880, 0.09], [1320, 0.12]]),
  join: () => beep([[520, 0.1], [780, 0.14]]),
  leave: () => beep([[780, 0.1], [520, 0.14]]),
  mute: () => beep([[420, 0.07]]),
  unmute: () => beep([[640, 0.07]]),
};

// ---------- Entrada (login / cadastro) ----------
let authMode = 'login';
function showAuth() {
  $('#app').hidden = true;
  $('#auth').hidden = false;
  const inv = new URLSearchParams(location.search).get('convite');
  if (inv) {
    setAuthMode('register'); $('#auth-form').invite.value = inv;
    api('/api/invite-info?code=' + encodeURIComponent(inv)).then((i) => { if (i.name) $('.brand p').textContent = i.valid ? `convite para ${i.name}` : `o convite para ${i.name} não vale mais`; }).catch(() => {});
  }
}
function setAuthMode(mode) {
  authMode = mode;
  $('#auth').classList.toggle('register', mode === 'register');
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === mode));
  $('#auth-submit').textContent = mode === 'login' ? 'Entrar' : 'Criar conta';
  $('#auth-form').password.autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  $('#auth-error').textContent = '';
}
$$('.tab').forEach((t) => t.addEventListener('click', () => setAuthMode(t.dataset.tab)));
$('#auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const btn = $('#auth-submit');
  btn.disabled = true;
  $('#auth-error').textContent = '';
  try {
    await api(authMode === 'login' ? '/api/login' : '/api/register', {
      username: f.username.value, password: f.password.value, displayName: f.displayName.value, invite: f.invite.value,
    });
    history.replaceState(null, '', '/');
    await boot();
  } catch (err) {
    $('#auth-error').textContent = err.message;
  } finally { btn.disabled = false; }
});

// ---------- Inicialização ----------
let es = null, firstOpen = true;
async function loadState() {
  const st = await api('/api/state');
  S.me = st.me;
  S.users = new Map(st.users.map((u) => [u.id, u]));
  S.channels = st.channels;
  S.online = new Set(st.online);
  S.voice = st.voice;
  S.unread = st.unread;
  S.voiceEnabled = st.voiceEnabled;
  S.desktopDownload = st.desktopDownload || null;
  S.lastRead = st.lastRead || {};
  S.dms = st.dms || [];
  S.friends = st.friends || {};
  S.calls = st.calls || {};
  // tópicos foram removidos: canais-filho antigos ficam escondidos
  S.channels = S.channels.filter((c) => !c.parent_id);
  S.allCategories = st.categories || [];
  S.notif = st.notif || null;
  S.music = st.music || {};
  S.servers = st.servers || [];
  if (!serverById(S.serverId)) S.serverId = serverById(prefs.lastServer)?.id || S.servers[0]?.id || 0;
}
async function boot() {
  try { await loadState(); }
  catch (e) { if (e.status === 401) return showAuth(); toast('Não consegui falar com o servidor. Tentando de novo…', true); return setTimeout(boot, 3000); }
  $('#auth').hidden = true;
  $('#app').hidden = false;
  $('#app').classList.toggle('hide-members', prefs.hideMembers);
  renderAll();
  if (S.member) goServer(S.serverId); else showFriends();
  connectEvents();
  checkInviteLink();
  loadLK();
  setTimeout(() => emojiName('🙂'), 1500); // carrega os nomes dos emojis em segundo plano
  // deixa a supressão de ruído já baixada (é o arquivo mais pesado ao entrar na voz)
  setTimeout(() => { fetch('/audio/mic-worklet.js').catch(() => {}); fetch('/vendor/rnnoise/rnnoise-sync.js').catch(() => {}); }, 4000);

}

function connectEvents() {
  es?.close();
  es = new EventSource('/api/events?c=' + encodeURIComponent(S.connId));
  es.addEventListener('open', async () => {
    if (firstOpen) { firstOpen = false; return; }
    // reconectou: atualiza tudo e avisa que ainda estamos na voz
    try {
      await loadState();
      renderAll();
      if (S.current) await openChannel(S.current, true);
      if (V.room && V.channelId) await act('voice_join', { channelId: V.channelId, connId: S.connId, muted: V.muted, deafened: V.deafened }).then(syncVoiceState);
    } catch (e) { if (e.status === 401) location.reload(); }
  });
  es.addEventListener('message', (e) => onMessage(JSON.parse(e.data)));
  es.addEventListener('message_edit', (e) => onEdit(JSON.parse(e.data)));
  es.addEventListener('message_delete', (e) => onDelete(JSON.parse(e.data)));
  es.addEventListener('typing', (e) => onTyping(JSON.parse(e.data)));
  es.addEventListener('presence', (e) => { S.online = new Set(JSON.parse(e.data)); renderMembers(); renderChannels(); renderFriends(); renderProfilePanel(); });
  es.addEventListener('dms', (e) => {
    S.dms = JSON.parse(e.data);
    if (S.current && !channelById(S.current)) showFriends(); // fechou a conversa que estava aberta
    renderChannels(); renderHeader(); checkCalls();
  });
  es.addEventListener('servers', (e) => {
    S.servers = JSON.parse(e.data);
    if (S.mode === 'server' && !serverById(S.serverId)) { if (S.servers[0]) goServer(S.servers[0].id); else { S.serverId = 0; showFriends(); } }
    renderAll(); renderHeader();
    if (S.view === 'friends') renderFriends();
  });
  es.addEventListener('music', (e) => onMusicEvent(JSON.parse(e.data)));
  es.addEventListener('voice_command', (e) => onVoiceCommand(JSON.parse(e.data)));
  es.addEventListener('channel_cleared', (e) => {
    const { channelId } = JSON.parse(e.data);
    S.msgs[channelId] = []; S.hasMore[channelId] = false; S.unread[channelId] = 0;
    if (S.current === channelId && S.view === 'chat') rerenderMessages(true);
    renderChannels();
  });
  es.addEventListener('kicked', (e) => {
    const d = JSON.parse(e.data);
    toast(`Você foi expulso(a) do servidor ${d.server}. Suas mensagens privadas continuam.`, true, 9000);
    if (V.channelId && channelById(V.channelId)?.server_id === d.serverId) leaveVoice(true);
    S.servers = S.servers.filter((s) => s.id !== d.serverId);
    if (S.serverId === d.serverId) { if (S.servers[0]) goServer(S.servers[0].id); else showFriends(); }
    renderAll();
  });
  es.addEventListener('deleted', () => {
    document.body.append(h('div', { class: 'gone' }, h('div', {}, h('h2', {}, 'Sua conta foi excluída'), h('p', {}, 'O administrador do servidor excluiu sua conta do DiscordIA.'))));
    leaveVoice(true);
    setTimeout(() => location.reload(), 5000);
  });
  es.addEventListener('notif', (e) => { S.notif = JSON.parse(e.data); renderChannels(); });
  es.addEventListener('calls', (e) => { S.calls = JSON.parse(e.data); checkCalls(); renderChannels(); });
  es.addEventListener('friends', (e) => {
    const old = S.friends;
    S.friends = JSON.parse(e.data);
    for (const [uid, st] of Object.entries(S.friends)) {
      if (st === 'incoming' && old[uid] !== 'incoming') { toast(`${userName(uid)} te enviou um pedido de amizade.`); SND.msg(); }
      if (st === 'friend' && old[uid] === 'outgoing') toast(`${userName(uid)} aceitou seu pedido de amizade.`);
    }
    renderChannels(); renderFriends(); renderProfilePanel();
    if (S.view === 'chat' && isDm(S.current) && !S.hasMore[S.current]) rerenderMessages();
  });
  es.addEventListener('users', (e) => {
    const prevUsers = S.users;
    S.users = new Map(JSON.parse(e.data).map((u) => [u.id, u])); S.me = S.users.get(S.me.id) || S.me;
    renderAll();
    if (!refreshUserMessages(prevUsers)) rerenderMessages();
  });
  es.addEventListener('channels', (e) => {
    const d = JSON.parse(e.data);
    S.channels = (Array.isArray(d) ? d : d.channels).filter((c) => !c.parent_id);
    if (!Array.isArray(d)) S.allCategories = d.categories || [];
    if (S.current && !channelById(S.current)) { const t = srvChannels().find((c) => c.type === 'text'); if (t) openChannel(t.id); else showFriends(); }
    if (V.channelId && !channelById(V.channelId)) leaveVoice();
    renderAll();
  });
  es.addEventListener('voice', (e) => {
    const others = () => Object.keys(S.voice[V.channelId] || {}).filter((id) => Number(id) !== S.me.id);
    const before = V.channelId ? others() : [];
    const prevVoice = S.voice || {};
    S.voice = JSON.parse(e.data);
    const mine = V.room && S.voice[V.channelId]?.[S.me.id];
    if (mine && (!!mine.smute !== !!V.serverMod?.mute || !!mine.sdeaf !== !!V.serverMod?.deaf)) { V.serverMod = { mute: !!mine.smute, deaf: !!mine.sdeaf }; applyVolumes(); updateMic(); renderMe(); }
    if (V.channelId && V.room) {
      const after = others();
      if (after.some((id) => !before.includes(id))) SND.join();
      else if (before.some((id) => !after.includes(id))) SND.leave();
    }
    // ninguém entrou nem saiu (só microfone, fone, câmera ou tela): a lista de membros e o cabeçalho não mudam
    if (sameVoicePeople(prevVoice, S.voice) && updateVoiceRooms(prevVoice)) { renderTiles(); checkCalls(); return; }
    renderChannels(); renderMembers(); renderTiles(); checkCalls(); renderHeader();
  });
}

function renderAll() {
  renderServerName();
  renderChannels();
  renderMembers();
  renderMe();
  renderHeader();
  $('#btn-invite').hidden = !S.me?.isAdmin;
}

// ---------- Barra lateral ----------
function renderChannels() {
  renderRail();
  renderDmCall();
  if (S.mode === 'home') return renderHome();
  const list = $('#channel-list');
  list.innerHTML = '';
  const admin = S.me?.isAdmin;
  const chanRow = (c) => {
    const type = c.type;
    const muted = type === 'text' && chanMuted(c.id);
    const unread = type === 'text' && !muted ? S.unread[c.id] || 0 : 0;
    const active = (type === 'text' && S.view === 'chat' && S.current === c.id) || (type === 'voice' && S.view === 'voice' && V.channelId === c.id);
    const tools = admin ? h('span', { class: 'chan-tools' },
      h('span', { title: 'Editar canal', onclick: (e) => { e.stopPropagation(); channelModal({ existing: c }); } }, icon('gear')),
      h('span', { title: 'Apagar', onclick: (e) => { e.stopPropagation(); deleteChannel(c); } }, icon('trash'))) : null;
    list.append(h('button', {
      draggable: admin ? 'true' : null, 'data-cid': c.id,
      class: `chan${active ? ' active' : ''}${unread && S.current !== c.id ? ' unread' : ''}${muted ? ' muted' : ''}`,
      onclick: () => (type === 'text' ? openChannel(c.id) : clickVoice(c.id)),
      onmouseenter: type === 'voice' ? () => prefetchVoice(c.id) : null,
    }, icon(type === 'text' ? 'hash' : 'speaker'), h('span', { class: 'name' }, c.name),
      c.private ? h('span', { class: 'chan-lock', title: 'Canal privado' }, icon('lock')) : null,
      unread && S.current !== c.id ? h('span', { class: 'badge' }, unread > 99 ? '99+' : unread) : null, tools));
    if (type === 'voice') {
      const wrap = voicePeopleEl(c);
      if (wrap.childElementCount) list.append(wrap);
      const mu = S.music[c.id]?.current;
      if (mu) list.append(h('div', { class: 'vc-music', title: 'Tocando agora' }, icon('music'), h('span', { class: 'name' }, mu.title)));
    }
  };
  const order = (arr) => arr.filter((c) => !c.parent_id && (c.type === 'text' || S.voiceEnabled))
    .sort((a, b) => (a.type === b.type ? a.position - b.position || a.id - b.id : a.type === 'text' ? -1 : 1));
  // canais sem categoria ficam no topo
  const catIds = new Set(S.categories.map((k) => k.id));
  for (const c of order(srvChannels().filter((c) => !c.category_id || !catIds.has(c.category_id)))) chanRow(c);
  for (const cat of S.categories) {
    const collapsed = !!prefs.collapsed?.[cat.id];
    const head = h('div', { class: 'cat clickable' + (collapsed ? ' collapsed' : ''), onclick: () => toggleCategory(cat.id),
      draggable: admin ? 'true' : null, 'data-cat': cat.id,
      oncontextmenu: (ev) => { ev.preventDefault(); categoryMenu(cat, ev.clientX, ev.clientY); } },
      h('span', { class: 'cat-name' }, icon('chev'), cat.name, cat.private ? icon('lock') : null));
    if (admin) head.append(h('button', { class: 'icon-btn', title: 'Criar canal', onclick: (e) => { e.stopPropagation(); channelModal({ categoryId: cat.id }); } }, icon('plus')));
    list.append(head);
    const chans = order(srvChannels().filter((c) => c.category_id === cat.id));
    // recolhida: mostra só o canal aberto e salas de voz com gente
    for (const c of chans) if (!collapsed || (S.current === c.id && S.view === 'chat') || V.channelId === c.id || Object.keys(S.voice[c.id] || {}).length) chanRow(c);
  }
  updateTitle();
}

// quem está numa sala de voz da barra lateral, com os ícones de microfone, fone, câmera e tela
function voicePeopleEl(c) {
  const people = S.voice[c.id] || {};
  const wrap = h('div', { class: 'voice-people' });
  for (const [uid, st] of Object.entries(people)) {
    const u = S.users.get(Number(uid));
    if (!u) continue;
    const speaking = V.channelId === c.id && V.speaking.has(String(uid));
    const isMe = Number(uid) === S.me.id;
    wrap.append(h('div', { class: 'vp clickable', 'data-uid': uid, 'data-from': c.id, draggable: isDm(c.id) ? null : 'true', title: 'Arraste até outra sala para mover',
      oncontextmenu: (ev) => { ev.preventDefault(); voiceUserMenu(Number(uid), ev.clientX, ev.clientY); },
      onclick: (e) => profileCard(Number(uid), e.currentTarget) },
      avatar(u, 'sm', false, speaking || (isMe && V.meSpeaking)), h('span', { class: 'vp-name' }, u.displayName, prefs.userMuted[uid] ? h('span', { class: 'ic-inline', title: 'Você silenciou essa pessoa' }, icon('vol-off')) : ''),
      h('span', { class: 'flags' },
        st.screen ? h('span', { class: 'live' }, 'AO VIVO') : null,
        st.video ? icon('cam') : null,
        st.sdeaf ? h('span', { class: 'srv-flag', title: 'Áudio desativado no servidor' }, icon('head-off')) : st.smute ? h('span', { class: 'srv-flag', title: 'Silenciado no servidor' }, icon('mic-off')) : null,
        !st.sdeaf && !st.smute ? (st.deafened ? icon('head-off') : st.muted ? icon('mic-off') : null) : null)));
  }
  return wrap;
}

// evento de voz em que ninguém entrou nem saiu (só mudaram ícones): troca só as salas que mudaram.
// Devolve false quando a barra lateral não está como o esperado; aí quem chamou redesenha tudo.
function updateVoiceRooms(prev) {
  renderDmCall();
  if (S.mode === 'home') return true; // na lista de conversas privadas só aparece quem está em chamada, e isso não mudou
  for (const cid of Object.keys(S.voice)) {
    if (JSON.stringify(prev[cid]) === JSON.stringify(S.voice[cid])) continue;
    const btn = $(`#channel-list .chan[data-cid="${cid}"]`);
    if (!btn) continue; // sala que não aparece aqui (outro servidor ou conversa privada)
    const old = btn.nextElementSibling?.classList.contains('voice-people') ? btn.nextElementSibling : null;
    const wrap = voicePeopleEl(channelById(Number(cid)));
    if (!old !== !wrap.childElementCount) return false;
    old?.replaceWith(wrap);
  }
  return true;
}
// as mesmas pessoas nas mesmas salas, na mesma ordem
function sameVoicePeople(a, b) {
  for (const cid of new Set([...Object.keys(a), ...Object.keys(b)])) if (Object.keys(a[cid] || {}).join() !== Object.keys(b[cid] || {}).join()) return false;
  return true;
}

function avatar(u, size = '', dot = false, speaking = false) {
  const a = h('div', { class: `avatar ${size}${speaking ? ' speaking' : ''}${u?.avatar ? ' has-img' : ''}`, style: { '--c': u?.color || '#888' }, title: u?.displayName }, u?.avatar ? h('img', { src: u.avatar, alt: '', loading: 'lazy', draggable: 'false' }) : initials(u?.displayName));
  if (dot) a.append(h('span', { class: 'dot' + (S.online.has(u.id) ? ' on' : '') }));
  return a;
}

function renderMe() {
  if (!S.me) return;
  const box = $('#me-id');
  box.innerHTML = '';
  const inVoice = !!V.room && !!V.channelId;
  const status = inVoice
    ? h('small', { class: 'in-voice' + (V.deafened || V.muted ? ' warn' : '') }, icon('speaker'), V.deafened ? 'Áudio desligado' : V.muted ? 'Microfone mudo' : 'Em voz')
    : h('small', {}, '@' + S.me.username);
  box.append(avatar(S.me, '', true), h('div', { class: 'names' }, h('b', {}, S.me.displayName), status));
  box.title = 'Configurações da conta';
  // "banner" com a cor da pessoa
  $('#me-bar').style.setProperty('--me', S.me.color || 'var(--accent)');

  const m = $('#btn-mute'), d = $('#btn-deafen');
  const micOff = V.muted || V.deafened;
  m.querySelector('use').setAttribute('href', micOff ? '#i-mic-off' : '#i-mic');
  d.querySelector('use').setAttribute('href', V.deafened ? '#i-head-off' : '#i-head');
  m.classList.toggle('off', micOff);
  d.classList.toggle('off', V.deafened);
  m.title = V.muted ? 'Ativar microfone' : 'Silenciar microfone';
  d.title = V.deafened ? 'Ligar áudio' : 'Desligar áudio';
  const sm = $('#st-mute');
  sm.className = 'round-btn' + (micOff ? ' off' : '');
  sm.querySelector('use').setAttribute('href', micOff ? '#i-mic-off' : '#i-mic');
  sm.title = V.muted ? 'Ativar microfone' : 'Silenciar microfone';
  const sd = $('#st-deafen');
  sd.className = 'round-btn' + (V.deafened ? ' off' : '');
  sd.querySelector('use').setAttribute('href', V.deafened ? '#i-head-off' : '#i-head');
  sd.title = V.deafened ? 'Ligar áudio' : 'Desligar áudio (não ouvir ninguém)';

  const ns = $('#btn-ns');
  ns.classList.toggle('on', A().ns === 'forte');
  ns.title = A().ns === 'forte' ? 'Supressão de ruído forte: ligada (clique para desligar)' : 'Supressão de ruído forte: desligada (clique para ligar)';
  desk?.state({ muted: V.muted, deafened: V.deafened, inVoice: !!V.room });
}

// Qualidade da conexão de voz (barrinhas no cartão de voz)
const QUALITY = { excellent: ['q3', 'ótima'], good: ['q2', 'boa'], poor: ['q1', 'ruim'], lost: ['q0', 'caiu'] };
function setSignal(q) {
  const el = $('#vc-signal');
  const [cls, txt] = QUALITY[q] || ['q3', '—'];
  el.className = 'vc-signal ' + cls;
  el.title = 'Conexão de voz: ' + txt;
}

// Menus do microfone e da saída de áudio (setinhas ao lado dos botões)
async function setMicDevice(id) {
  prefs.mic = id; savePrefs();
  if (V.room) await V.room.switchActiveDevice('audioinput', id || 'default').catch(micError);
}
async function setSpeakerDevice(id) {
  prefs.speaker = id; savePrefs();
  if (V.room) await V.room.switchActiveDevice('audiooutput', id || 'default').catch(() => {});
}
async function deviceMenu(anchor, kind) {
  if ($('.popover.menu')?.dataset.kind === kind) return $('.popover.menu').remove();
  $('.popover')?.remove();
  const devs = ((await navigator.mediaDevices?.enumerateDevices?.().catch(() => [])) || [])
    .filter((x) => x.kind === kind && x.deviceId !== 'default' && x.deviceId !== 'communications');
  const current = kind === 'audioinput' ? prefs.mic : prefs.speaker;
  const choose = async (id) => { pop.remove(); await (kind === 'audioinput' ? setMicDevice(id) : setSpeakerDevice(id)); };
  const item = (id, label) => h('button', { type: 'button', class: 'menu-item' + (id === current ? ' sel' : ''), onclick: () => choose(id) },
    h('span', {}, label), id === current ? icon('check') : null);
  const pop = h('div', { class: 'popover menu', 'data-kind': kind },
    h('div', { class: 'menu-title' }, kind === 'audioinput' ? 'Microfone' : 'Saída de áudio'),
    item('', 'Padrão do sistema'),
    ...devs.map((d, i) => item(d.deviceId, d.label || (kind === 'audioinput' ? `Microfone ${i + 1}` : `Saída ${i + 1}`))));
  if (kind === 'audiooutput') {
    const out = h('output', {}, A().outputVolume + '%');
    const r = h('input', { type: 'range', min: 0, max: 200, step: 5, value: A().outputVolume });
    r.oninput = () => { A().outputVolume = Number(r.value); out.textContent = r.value + '%'; applyAudioSettings(false); };
    pop.append(h('div', { class: 'menu-sep' }), h('div', { class: 'menu-title' }, 'Volume de saída'), h('div', { class: 'vol wide' }, r, out));
  } else {
    const out = h('output', {}, A().inputVolume + '%');
    const r = h('input', { type: 'range', min: 0, max: 200, step: 5, value: A().inputVolume });
    r.oninput = () => { A().inputVolume = Number(r.value); out.textContent = r.value + '%'; applyAudioSettings(false); };
    pop.append(h('div', { class: 'menu-sep' }), h('div', { class: 'menu-title' }, 'Volume do microfone'), h('div', { class: 'vol wide' }, r, out));
  }
  pop.append(h('div', { class: 'menu-sep' }),
    h('button', { type: 'button', class: 'menu-item', onclick: () => { pop.remove(); settingsModal('voz'); } }, h('span', {}, 'Configurações de voz'), icon('gear')));
  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.left = Math.max(8, Math.min(r.left - 120, innerWidth - pop.offsetWidth - 8)) + 'px';
  pop.style.bottom = innerHeight - r.top + 8 + 'px';
  const close = (ev) => { if (!pop.contains(ev.target) && !anchor.contains(ev.target)) { pop.remove(); document.removeEventListener('mousedown', close, true); } };
  setTimeout(() => document.addEventListener('mousedown', close, true), 0);
}

function renderMembers() {
  const box = $('#members');
  box.innerHTML = '';
  const all = [...S.users.values()].filter(isMember);
  const inVoice = {};
  for (const [cid, ppl] of Object.entries(S.voice)) for (const uid of Object.keys(ppl)) inVoice[uid] = channelById(cid)?.name;
  const on = all.filter((u) => S.online.has(u.id)), off = all.filter((u) => !S.online.has(u.id));
  const item = (u, online) => h('div', { class: 'member' + (online ? '' : ' offline'), onclick: (ev) => profileCard(u.id, ev.currentTarget, 'left'),
    oncontextmenu: (ev) => { ev.preventDefault(); userMenu(u.id, ev.clientX, ev.clientY); } },
    avatar(u, '', true),
    h('div', { style: { minWidth: 0 } },
      h('div', { class: 'nm' }, u.displayName, ' ', u.isAdmin ? h('span', { class: 'crown', title: 'Administrador' }, '★') : null),
      h('small', {}, inVoice[u.id] ? [h('span', { class: 'ic-inline' }, icon('speaker')), inVoice[u.id]] : '@' + u.username)));
  box.append(h('h4', {}, `Online — ${on.length}`), ...on.map((u) => item(u, true)));
  if (off.length) box.append(h('h4', {}, `Offline — ${off.length}`), ...off.map((u) => item(u, false)));
}

function renderHeader() {
  renderTitlebar();
  updateSearchPlaceholder();
  const app = $('#app');
  app.classList.toggle('home', S.mode === 'home');
  const dmCh = S.view === 'chat' && isDm(S.current) ? channelById(S.current) : null;
  app.classList.toggle('dm', !!dmCh);
  $('#server-head').hidden = S.mode === 'home';
  $('#home-head').hidden = S.mode !== 'home';
  $('#head-tabs').hidden = S.view !== 'friends';
  $('#btn-members').hidden = S.mode === 'home';
  $('#btn-dm-call').hidden = $('#btn-dm-video').hidden = $('#btn-profile').hidden = !dmCh;
  const av = $('#chan-avatar');
  av.hidden = !dmCh;
  $('#chan-icon').style.display = dmCh ? 'none' : '';
  if (dmCh) {
    const u = S.users.get(dmCh.dm);
    av.innerHTML = ''; av.append(avatar(u, 'sm', true));
    $('#chan-title').textContent = u?.displayName || '';
    const live = Object.keys(S.voice[dmCh.id] || {}).length > 0 && V.channelId !== dmCh.id;
    $('#btn-dm-call').classList.toggle('live', live);
    $('#btn-dm-call').title = live ? 'Entrar na chamada' : 'Iniciar chamada de voz';
    $('#btn-profile').classList.toggle('on', !prefs.hideProfile);
    $('#input').placeholder = `Conversar em @${u?.displayName || ''}`;
    return;
  }
  if (S.view === 'friends') {
    $('#chan-icon').querySelector('use').setAttribute('href', '#i-users');
    $('#chan-title').textContent = 'Amigos';
    return;
  }
  if (S.view === 'voice' && V.channelId) {
    $('#chan-icon').querySelector('use').setAttribute('href', '#i-speaker');
    $('#chan-title').textContent = channelById(V.channelId)?.name || '';
  } else {
    $('#chan-icon').querySelector('use').setAttribute('href', '#i-hash');
    $('#chan-title').textContent = channelById(S.current)?.name || '';
  }
  $('#input').placeholder = isMusicChannel(S.current) ? `Mensagem em #${channelById(S.current)?.name || ''} — use /play link-do-youtube` : `Mensagem em #${channelById(S.current)?.name || ''}`;
}
const chanLabel = (c) => (c ? (c.dm ? `@${c.name}` : `#${c.name}`) : '');
function updateTitle() {
  const total = Object.entries(S.unread).reduce((a, [cid, n]) => a + (Number(cid) === S.current && S.view === 'chat' && !document.hidden && document.hasFocus() ? 0 : n), 0);
  document.title = (total ? `(${total}) ` : '') + 'DiscordIA';
}

// ---------- Mensagens ----------
async function openChannel(id, force = false) {
  id = Number(id);
  const changed = S.current !== id;
  if (changed) {
    cancelReply();
    // linha "Novas mensagens": lembra até onde você tinha lido ao entrar no canal
    S.marker = (S.unread[id] || 0) > 0 ? { channelId: id, after: S.lastRead[id] || 0 } : null;
  }
  S.current = id;
  S.view = 'chat';
  if (isDm(id)) { S.mode = 'home'; S.homeLast = id; }
  else {
    S.mode = 'server';
    const sid = channelById(id)?.server_id;
    if (sid && sid !== S.serverId) { S.serverId = sid; if (S.search) closeSearch(); }
    renderAll(); // nome/ícone do servidor, membros e canais do servidor aberto
    prefs.lastServer = S.serverId; prefs.lastChannelBy = { ...(prefs.lastChannelBy || {}), [S.serverId]: id }; savePrefs();
  }
  pushHist({ t: 'chan', id });
  if (S.search && S.search.scope !== searchScope()) closeSearch();
  updateVoiceButtons();
  $('#chat-view').hidden = false;
  $('#voice-view').hidden = true;
  $('#friends-view').hidden = true;
  renderProfilePanel();
  $('#app').classList.remove('nav-open');
  renderHeader();
  if (!S.msgs[id] || force) {
    $('#messages').innerHTML = '';
    try {
      const msgs = await api(`/api/messages?channel=${id}`);
      S.msgs[id] = msgs;
      S.hasMore[id] = msgs.length === 50;
    } catch (e) { toast(e.message, true); return; }
  }
  if (S.current !== id) return;
  rerenderMessages(true);
  markRead();
  renderChannels();
  renderTyping();
  if (changed && matchMedia('(min-width: 761px)').matches) $('#input').focus();
}

function messageMentionsMe(m) {
  return mentionsMe(m.content, m.channelId) || (m.reply && m.reply.userId === S.me?.id && m.userId !== S.me?.id);
}
function mentionsMe(text, channelId) {
  if (!S.me || !text) return false;
  if (new RegExp(`@${S.me.username}\\b`, 'i').test(text)) return true;
  if (isMusicChannel(channelId)) return false; // @all não vale no canal de música
  return /@(all|todos|everyone)\b/i.test(text);
}

function md(text) {
  const blocks = [];
  let s = String(text).replace(/```(?:[\w-]+\n)?([\s\S]*?)```/g, (_, c) => `\u0000${blocks.push(`<pre>${esc(c.replace(/^\n|\n$/g, ''))}</pre>`) - 1}\u0000`);
  s = s.replace(/`([^`\n]+)`/g, (_, c) => `\u0000${blocks.push(`<code>${esc(c)}</code>`) - 1}\u0000`);
  s = esc(s);
  s = s.replace(/\b(https?:\/\/[^\s<]+[^\s<.,;:!?)'"\]])/g, (u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<i>$2</i>')
    .replace(/(^|[\s(])_([^_\n]+)_/g, '$1<i>$2</i>')
    .replace(/~~([^~]+)~~/g, '<s>$1</s>')
    .replace(/\|\|([^|]+)\|\|/g, '<span class="spoiler" title="Spoiler — clique pra ver">$1</span>');
  const names = new Set([...S.users.values()].map((u) => u.username.toLowerCase()));
  s = s.replace(/(^|[\s(])@([\w.-]+)/g, (m, pre, n) => (names.has(n.toLowerCase()) || (/^(all|todos|everyone)$/i.test(n) && !isMusicChannel(S.current)) ? `${pre}<span class="ment">@${n}</span>` : m));
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[i]);
}

function messageEl(m, prev) {
  if (m.call) return callMessageEl(m);
  if (m.sys) return botMessageEl(m, prev);
  const u = S.users.get(m.userId);
  const first = !!m.reply || !!m.forward || !prev || !!prev.sys || !!prev.call || prev.userId !== m.userId || m.createdAt - prev.createdAt > 5 * 60 * 1000 || !sameDay(prev.createdAt, m.createdAt);
  const mine = m.userId === S.me.id;
  const row = h('div', { class: `msg${first ? ' first' : ''}${messageMentionsMe(m) && !mine ? ' mention' : ''}`, 'data-id': m.id });
  if (m.reply) row.append(replyLine(m.reply));
  const av = avatar(u, 'lg');
  av.classList.add('clickable');
  row.append(av);
  const author = h('span', { class: 'author', style: { color: u?.color } }, u?.displayName || 'Desconhecido');
  for (const el of [av, author]) {
    el.addEventListener('click', (ev) => { ev.stopPropagation(); profileCard(m.userId, el); });
    el.addEventListener('contextmenu', (ev) => { ev.preventDefault(); ev.stopPropagation(); userMenu(m.userId, ev.clientX, ev.clientY); });
  }
  row.append(h('div', { class: 'meta' }, author, h('time', { title: new Date(m.createdAt).toLocaleString('pt-BR') }, `${fmtDay(m.createdAt)} às ${fmtTime(m.createdAt)}`)));
  row.append(h('span', { class: 'side-time' }, fmtTime(m.createdAt)));
  if (m.forward) row.append(forwardBox(m.forward));
  if (m.content) {
    const body = h('div', { class: 'body', html: md(m.content) });
    if (m.editedAt) body.append(h('span', { class: 'edited', title: new Date(m.editedAt).toLocaleString('pt-BR') }, '(editada)'));
    row.append(body);
  }
  if (m.attachment) row.append(attachmentEl(m.attachment));
  if (m.reactions?.length) row.append(reactionsBar(m));
  // a barra que aparece com o mouse em cima (reações rápidas, responder, editar, mais) só é montada quando o mouse chega
  row.addEventListener('mouseenter', () => { if (!row.querySelector(':scope > .tools')) row.append(messageTools(m, mine)); });

  row.addEventListener('contextmenu', (ev) => {
    if (ev.target.closest('a, .edit-box, video, audio') || getSelection()?.toString()) return; // deixa o menu normal para links e texto selecionado
    ev.preventDefault();
    messageMenu(m, ev.clientX, ev.clientY);
  });
  // celular: segurar o dedo na mensagem
  let lp = 0, sx = 0, sy = 0;
  row.addEventListener('touchstart', (ev) => {
    const t0 = ev.touches[0]; sx = t0.clientX; sy = t0.clientY;
    lp = setTimeout(() => { navigator.vibrate?.(15); messageMenu(m, sx, sy); }, 500);
  }, { passive: true });
  row.addEventListener('touchmove', (ev) => { const t0 = ev.touches[0]; if (Math.abs(t0.clientX - sx) + Math.abs(t0.clientY - sy) > 10) clearTimeout(lp); }, { passive: true });
  row.addEventListener('touchend', () => clearTimeout(lp));
  return row;
}

function messageTools(m, mine) {
  const tools = h('div', { class: 'tools' });
  for (const e of prefs.recentEmojis.slice(0, 3)) tools.append(h('button', { class: 'icon-btn emo' + (iReacted(m, e) ? ' on' : ''), 'aria-label': `Reagir com ${e}`, 'data-emoji': e, onclick: () => toggleReact(m, e) }, e));
  tools.append(h('button', { class: 'icon-btn', title: 'Adicionar reação', onclick: (ev) => emojiPicker(ev.currentTarget, (e) => toggleReact(m, e)) }, icon('smile-plus')));
  tools.append(h('button', { class: 'icon-btn', title: 'Responder', onclick: () => startReply(m) }, icon('reply')));
  if (mine) tools.append(h('button', { class: 'icon-btn', title: 'Editar', onclick: () => startEdit(m) }, icon('edit')));
  tools.append(h('button', { class: 'icon-btn', title: 'Mais opções', onclick: (ev) => { const r = ev.currentTarget.getBoundingClientRect(); messageMenu(m, r.left, r.bottom + 4); } }, icon('dots')));
  return tools;
}

function replyLine(r) {
  if (r.deleted) return h('div', { class: 'reply-line deleted' }, h('span', { class: 'curve' }), h('i', {}, 'A mensagem original foi apagada'));
  const u = S.users.get(r.userId);
  return h('div', { class: 'reply-line', onclick: () => jumpTo(S.current, r.id) },
    h('span', { class: 'curve' }), avatar(u, 'xs'),
    h('b', { style: { color: u?.color } }, u?.displayName || 'alguém'),
    h('span', { class: 'snip' }, r.content || (r.attachment ? [h('span', { class: 'ic-inline' }, icon('clip')), 'Clique para ver o anexo'] : '')));
}

// Mensagem encaminhada (igual ao Discord): barra à esquerda, "Encaminhada", conteúdo e de onde veio
function forwardBox(f) {
  const box = h('div', { class: 'forward' }, h('div', { class: 'fwd-head' }, icon('forward'), h('i', {}, 'Encaminhada')));
  if (f.content) box.append(h('div', { class: 'body', html: md(f.content) }));
  if (f.attachment) box.append(attachmentEl(f.attachment));
  const src = channelById(f.fromChannelId);
  const when = sameDay(f.createdAt, Date.now()) ? fmtTime(f.createdAt) : `${new Date(f.createdAt).toLocaleDateString('pt-BR')} ${fmtTime(f.createdAt)}`;
  const where = src ? chanLabel(src) : f.fromDm ? 'Mensagem direta' : `#${f.fromChannelName}`;
  box.append(h('button', { type: 'button', class: 'fwd-src', title: src ? 'Ir para a mensagem original' : 'Você não tem acesso à mensagem original',
    onclick: () => (src ? jumpTo(src.id, f.messageId) : toast(f.fromDm ? 'Essa mensagem veio de uma conversa privada de outras pessoas.' : 'Esse canal não existe mais.')) },
    h('span', {}, where), h('span', { class: 'dotsep' }, '•'), h('span', {}, when), src ? icon('right') : null));
  return box;
}

function reactionsBar(m) {
  const bar = h('div', { class: 'reactions' });
  for (const r of m.reactions) {
    const mineR = r.users.includes(S.me.id);
    const chip = h('button', { class: 'rx' + (mineR ? ' mine' : ''), 'aria-label': `${r.emoji} ${r.users.length}`, onclick: () => react(m, r.emoji, !iReacted(m, r.emoji)) },
      h('span', { class: 'e' }, r.emoji), h('span', { class: 'c' }, r.users.length));
    chip.addEventListener('mouseenter', () => showReactionTip(chip, r));
    chip.addEventListener('mouseleave', hideReactionTip);
    bar.append(chip);
  }
  bar.append(h('button', { class: 'rx add', title: 'Adicionar reação', onclick: (ev) => emojiPicker(ev.currentTarget, (e) => toggleReact(m, e)) }, icon('smile-plus')));
  return bar;
}

// Nome do emoji em português (do catálogo do seletor)
let EMOJI_NAMES = null;
function emojiName(e) {
  if (!EMOJI_NAMES) {
    loadEmojis().then((groups) => { EMOJI_NAMES = new Map(groups.flatMap((g) => g.emojis.map((x) => [x[0], x[1]]))); });
    return null;
  }
  return EMOJI_NAMES.get(e) || EMOJI_NAMES.get(e.replace(/️/g, '')) || null;
}

// Balãozinho "Fulano reagiu com :nome:" ao passar o mouse numa reação
function showReactionTip(chip, r) {
  hideReactionTip();
  const ids = [...r.users].sort((a, b) => (a === S.me.id ? -1 : b === S.me.id ? 1 : 0)); // "Você" primeiro
  const names = ids.map((id) => (id === S.me.id ? 'Você' : userName(id)));
  let who;
  if (names.length === 1) who = names[0];
  else if (names.length <= 3) who = names.slice(0, -1).join(', ') + ' e ' + names[names.length - 1];
  else who = `${names.slice(0, 3).join(', ')} e mais ${names.length - 3}`;
  const verb = names.length === 1 && names[0] !== 'Você' ? 'reagiu' : 'reagiram';
  const nm = emojiName(r.emoji);
  const tip = h('div', { class: 'rx-tip' },
    h('span', { class: 'big' }, r.emoji),
    h('span', {}, h('b', {}, who), ` ${names.length === 1 && names[0] === 'Você' ? 'reagiu' : verb} com `, h('b', {}, nm ? `:${nm.replace(/\s+/g, '_')}:` : r.emoji)));
  document.body.append(tip);
  const b = chip.getBoundingClientRect();
  const left = Math.max(8, Math.min(b.left + b.width / 2 - tip.offsetWidth / 2, innerWidth - tip.offsetWidth - 8));
  let top = b.top - tip.offsetHeight - 8;
  if (top < 8) top = b.bottom + 8;
  tip.style.left = left + 'px';
  tip.style.top = top + 'px';
}
function hideReactionTip() { $$('.rx-tip, .tool-tip').forEach((x) => x.remove()); }

// Balão estilo Discord nos botões da barra que aparece ao passar o mouse na mensagem
function showToolTip(btn) {
  hideReactionTip();
  let tip;
  if (btn.dataset.emoji) {
    const e = btn.dataset.emoji, nm = emojiName(e);
    const msgId = +btn.closest('.msg')?.dataset.id;
    const m = Object.values(S.msgs).flat().find((x) => x.id === msgId);
    const on = m && iReacted(m, e);
    tip = h('div', { class: 'tool-tip' }, h('b', {}, nm ? `:${nm.replace(/\s+/g, '_')}:` : e), h('span', {}, on ? 'Clique para remover' : 'Clique para reagir'));
  } else {
    const label = btn.getAttribute('title') || btn.dataset.tip;
    if (!label) return;
    btn.dataset.tip = label; btn.removeAttribute('title'); // some o balão nativo do navegador
    tip = h('div', { class: 'tool-tip' }, h('b', {}, label));
  }
  document.body.append(tip);
  const b = btn.getBoundingClientRect();
  tip.style.left = Math.max(8, Math.min(b.left + b.width / 2 - tip.offsetWidth / 2, innerWidth - tip.offsetWidth - 8)) + 'px';
  tip.style.top = Math.max(8, b.top - tip.offsetHeight - 8) + 'px';
}
document.addEventListener('mouseover', (e) => {
  const btn = e.target.closest?.('.msg .tools button');
  if (btn) { if (!btn.contains(e.relatedTarget)) showToolTip(btn); }
  else if ($('.tool-tip')) $$('.tool-tip').forEach((x) => x.remove());
});
document.addEventListener('click', (e) => { const btn = e.target.closest?.('.msg .tools button'); if (btn?.dataset.emoji) setTimeout(() => { const nb = document.elementFromPoint(e.clientX, e.clientY)?.closest('.msg .tools button'); if (nb) showToolTip(nb); else hideReactionTip(); }, 250); }, true);
// se a pílula sumir (reação tirada) ou o mouse sair de cima, o balão some junto
document.addEventListener('mouseover', (e) => { if (!e.target.closest?.('.rx') && $('.rx-tip')) hideReactionTip(); });
$('#messages').addEventListener('scroll', hideReactionTip, { passive: true });


function attachmentEl(a) {
  const box = h('div', { class: 'attach' });
  if (/^image\/(png|jpeg|gif|webp)$/.test(a.type)) {
    const img = h('img', { src: a.url, alt: a.name, loading: 'lazy' });
    img.addEventListener('load', () => { if (nearBottom(400)) scrollBottom(); });
    img.addEventListener('click', () => {
      const lb = h('div', { class: 'lightbox', onclick: () => lb.remove() }, h('img', { src: a.url, alt: a.name }));
      document.body.append(lb);
    });
    box.append(img);
  } else if (/^video\/(mp4|webm)$/.test(a.type)) {
    box.append(h('video', { src: a.url, controls: true, preload: 'metadata' }));
  } else if (/^audio\//.test(a.type)) {
    box.append(h('audio', { src: a.url, controls: true, preload: 'metadata' }));
  } else {
    box.append(h('a', { class: 'file-card', href: a.url, download: a.name }, icon('file'), h('span', {}, h('b', {}, a.name), h('small', {}, fmtSize(a.size)))));
  }
  return box;
}

const nearBottom = (px = 120) => { const el = $('#messages'); return el.scrollHeight - el.scrollTop - el.clientHeight < px; };
const scrollBottom = () => { const el = $('#messages'); el.scrollTop = el.scrollHeight; };

function rerenderMessages(toBottom = false) {
  const box = $('#messages');
  const list = S.msgs[S.current];
  if (!list || S.view !== 'chat') return;
  const stick = toBottom || nearBottom();
  const fromBottom = box.scrollHeight - box.scrollTop;
  box.innerHTML = '';
  box.append(messagesHead(list));
  drawMessages(box, list, { prev: null, markerDone: false, marker: S.marker?.channelId === S.current ? S.marker.after : null });
  const nd = toBottom && $('.new-divider', box);
  if (nd) { nd.scrollIntoView({ block: 'center' }); return; }
  if (stick) scrollBottom();
  else box.scrollTop = box.scrollHeight - fromBottom;
}

// topo da conversa: botão de carregar as antigas ou, no começo de tudo, a apresentação do canal/conversa
function messagesHead(list) {
  if (S.hasMore[S.current]) return h('button', { class: 'btn load-more', onclick: loadOlder }, 'Carregar mensagens antigas');
  const ch = channelById(S.current);
  if (ch?.dm) return dmIntro(ch, !list.length);
  return h('div', { class: 'empty' }, h('h3', {}, `Bem-vindo a #${ch?.name || ''}!`), h('div', {}, 'Esse é o começo do canal. Manda a primeira mensagem aí.'));
}

// desenha mensagens em sequência: separador de dia, linha "Novas mensagens" e agrupamento por autor (st guarda onde parou)
function drawMessages(box, msgs, st) {
  for (const m of msgs) {
    if (!st.prev || !sameDay(st.prev.createdAt, m.createdAt)) box.append(h('div', { class: 'day' }, fmtDay(m.createdAt)));
    if (st.marker !== null && !st.markerDone && m.id > st.marker && m.userId !== S.me.id) {
      st.markerDone = true;
      box.append(h('div', { class: 'new-divider' }, h('span', {}, 'Novas mensagens')));
      st.prev = null; // a próxima mensagem mostra autor de novo
    }
    box.append(messageEl(m, st.prev));
    st.prev = m;
  }
}

// rolar para cima: põe só as mensagens antigas no topo, sem redesenhar a conversa inteira.
// O resultado é o mesmo HTML do rerenderMessages(); se a tela não estiver como o esperado, redesenha tudo como antes.
function prependOlder(older) {
  const box = $('#messages');
  const list = S.msgs[S.current];
  if (!list || S.view !== 'chat') return;
  const m0 = list[older.length]; // a mensagem que estava no topo
  const head = box.firstElementChild;
  const m0El = m0 && $(`.msg[data-id="${m0.id}"]`, box);
  if (!older.length || !m0El || !head?.classList.contains('load-more')) return rerenderMessages();
  // entre o botão e essa mensagem só pode haver o separador de dia e, talvez, a linha "Novas mensagens"
  const lead = [];
  for (let el = head.nextElementSibling; el && el !== m0El && lead.length < 3; el = el.nextElementSibling) lead.push(el);
  if (!lead[0]?.matches('.day') || lead.length > 2 || (lead[1] && !lead[1].matches('.new-divider'))) return rerenderMessages();
  const stick = nearBottom();
  const fromBottom = box.scrollHeight - box.scrollTop;
  const oldDivider = $('.new-divider', box);
  const frag = document.createDocumentFragment();
  frag.append(messagesHead(list));
  const st = { prev: null, markerDone: false, marker: S.marker?.channelId === S.current ? S.marker.after : null };
  drawMessages(frag, older, st);
  const moved = st.markerDone; // a linha "Novas mensagens" agora fica no meio das antigas
  // linha que estava mais abaixo e precisa sair: a mensagem depois dela volta a se agrupar com a anterior
  let after = null;
  if (moved && oldDivider && oldDivider !== lead[1]) {
    const next = oldDivider.nextElementSibling;
    const i = list.findIndex((x) => x.id === Number(next?.dataset.id));
    if (i < 1) return rerenderMessages();
    after = [next, messageEl(list[i], list[i - 1])];
  }
  // a mensagem do topo, como o redesenho completo a mostraria
  if (!sameDay(st.prev.createdAt, m0.createdAt)) frag.append(h('div', { class: 'day' }, fmtDay(m0.createdAt)));
  head.remove();
  lead[0].remove();
  if (lead[1] && !moved) frag.append(lead[1]); // continua antes dela, que segue sem agrupar
  else { lead[1]?.remove(); m0El.replaceWith(messageEl(m0, st.prev)); }
  if (after) { oldDivider.remove(); after[0].replaceWith(after[1]); }
  box.prepend(frag);
  if (stick) scrollBottom();
  else box.scrollTop = box.scrollHeight - fromBottom;
}

// alguém trocou nome, cor ou foto: redesenha só as mensagens que mostram essa pessoa (antes redesenhava a conversa inteira).
// Devolve false quando mudou algo que afeta outras mensagens (pessoa nova, @usuário, conta excluída)
// ou quando a tela não está como o esperado; aí quem chamou redesenha tudo como antes.
function refreshUserMessages(prev) {
  const box = $('#messages');
  const list = S.msgs[S.current];
  if (!list || S.view !== 'chat') return true; // como no rerenderMessages: fora do chat não há o que redesenhar
  if (!prev || prev.size !== S.users.size) return false;
  const changed = new Set();
  for (const [id, u] of S.users) {
    const p = prev.get(id);
    if (!p || p.username !== u.username || p.deleted !== u.deleted) return false;
    if (p.displayName !== u.displayName || p.color !== u.color || p.avatar !== u.avatar) changed.add(id);
  }
  const jobs = [];
  list.forEach((m, i) => {
    if (!changed.has(m.userId) && !changed.has(m.reply?.userId)) return;
    const el = $(`.msg[data-id="${m.id}"]`, box);
    jobs.push([el, m, i === 0 || el?.previousElementSibling?.matches('.new-divider') ? null : list[i - 1]]);
  });
  const ch = channelById(S.current);
  const head = !S.hasMore[S.current] && ch?.dm && changed.has(ch.dm) ? box.firstElementChild : null;
  if (jobs.some(([el]) => !el) || (head && !head.matches('.dm-intro'))) return false;
  const stick = nearBottom();
  const fromBottom = box.scrollHeight - box.scrollTop;
  for (const [el, m, p] of jobs) el.replaceWith(messageEl(m, p));
  head?.replaceWith(messagesHead(list));
  if (stick) scrollBottom();
  else box.scrollTop = box.scrollHeight - fromBottom;
  return true;
}

async function loadOlder() {
  const id = S.current;
  const list = S.msgs[id];
  if (S.loading || !S.hasMore[id] || !list?.length) return;
  S.loading = true;
  try {
    const older = await api(`/api/messages?channel=${id}&before=${list[0].id}`);
    S.msgs[id] = older.concat(list);
    S.hasMore[id] = older.length === 50;
    if (S.current === id) prependOlder(older);
  } catch (e) { toast(e.message, true); }
  S.loading = false;
}
$('#messages').addEventListener('scroll', () => { if ($('#messages').scrollTop < 60) loadOlder(); });

let readTimer;
function markRead() {
  if (document.hidden || S.view !== 'chat') return;
  const list = S.msgs[S.current];
  S.unread[S.current] = 0;
  updateTitle();
  clearTimeout(readTimer);
  if (list?.length) {
    const cid = S.current, last = list[list.length - 1].id;
    readTimer = setTimeout(() => { S.lastRead[cid] = Math.max(S.lastRead[cid] || 0, last); act('read', { channelId: cid, messageId: last }).catch(() => {}); }, 400);
  }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) { markRead(); renderChannels(); } });

function onMessage(m) {
  const list = S.msgs[m.channelId];
  const isNew = !!list && !list.some((x) => x.id === m.id);
  if (isNew) list.push(m);
  delete S.typing[m.channelId]?.[m.userId];
  const mine = m.userId === S.me.id;
  const viewing = S.current === m.channelId && S.view === 'chat' && !document.hidden && document.hasFocus();
  // se o canal ainda está carregando (list vazia), a mensagem já vem junto no carregamento
  if (isNew && S.current === m.channelId && S.view === 'chat') {
    const box = $('#messages');
    const stick = mine || nearBottom();
    const prev = list[list.length - 2];
    if (!prev || !sameDay(prev.createdAt, m.createdAt)) box.append(h('div', { class: 'day' }, fmtDay(m.createdAt)));
    box.append(messageEl(m, prev));
    if (stick) scrollBottom();
    renderTyping();
  }
  if (!mine) {
    if (viewing) markRead();
    else {
      S.unread[m.channelId] = (S.unread[m.channelId] || 0) + 1;
      renderChannels();
    }
    const mention = messageMentionsMe(m) || isDm(m.channelId);
    const alert = shouldAlert(m, mention);
    if (!viewing && alert) { SND.msg(); desk?.flash(); }
    if (alert && (document.hidden || !document.hasFocus()) && 'Notification' in window && Notification.permission === 'granted' && (prefs.notify === 'all' || (prefs.notify === 'mentions' && mention))) {
      const n = new Notification(isDm(m.channelId) ? userName(m.userId) : `${userName(m.userId)} em ${chanLabel(channelById(m.channelId))}`, { body: m.call ? '📞 Está te ligando' : m.content || (m.attachment ? '📎 ' + m.attachment.name : ''), icon: '/icon.svg', tag: 'resenha-' + m.channelId });
      n.onclick = () => { window.focus(); openChannel(m.channelId); n.close(); };
    }
  }
}
function onEdit(m) {
  hideReactionTip();
  const list = S.msgs[m.channelId];
  const i = list?.findIndex((x) => x.id === m.id);
  if (i >= 0) {
    list[i] = m;
    if (S.current !== m.channelId || S.view !== 'chat' || $('.edit-box')) return;
    const old = $(`.msg[data-id="${m.id}"]`);
    if (old) old.replaceWith(messageEl(m, old.classList.contains('first') && !m.reply && !m.forward ? null : list[i - 1]));
  }
}
function onDelete({ id, channelId }) {
  const list = S.msgs[channelId];
  if (!list) return;
  const idx = list.findIndex((x) => x.id === id);
  if (idx < 0) return;
  S.msgs[channelId] = list.filter((x) => x.id !== id);
  if (S.current !== channelId || S.view !== 'chat') return;
  // Tira só essa mensagem da tela, sem redesenhar o chat (assim ele não pula para o fim)
  const box = $('#messages');
  const el = $(`.msg[data-id="${id}"]`, box);
  if (!el) return;
  const wasBottom = nearBottom(40);
  // "âncora": a primeira mensagem que você está vendo; ela fica parada no mesmo lugar
  const boxTop = box.getBoundingClientRect().top;
  let anchor = [...box.querySelectorAll('.msg')].find((m) => m !== el && m.getBoundingClientRect().bottom > boxTop + 1);
  const anchorTop = anchor?.getBoundingClientRect().top;
  const next = el.nextElementSibling, prevEl = el.previousElementSibling;
  el.remove();
  // a mensagem seguinte pode precisar voltar a mostrar nome e foto
  const newList = S.msgs[channelId];
  const nextMsg = newList[idx];
  if (next?.classList.contains('msg') && nextMsg && Number(next.dataset.id) === nextMsg.id) {
    const fresh = messageEl(nextMsg, prevEl?.classList.contains('msg') ? newList[idx - 1] : null);
    next.replaceWith(fresh);
    if (anchor === next) anchor = fresh;
  }
  // separador de dia que ficou vazio
  if (prevEl?.classList.contains('day') && (!prevEl.nextElementSibling || prevEl.nextElementSibling.classList.contains('day'))) prevEl.remove();
  if (wasBottom) scrollBottom();
  else if (anchor?.isConnected && anchorTop !== undefined) box.scrollTop += anchor.getBoundingClientRect().top - anchorTop;
}
function startEdit(m) {
  if ($('.edit-box')) rerenderMessages();
  const row = $(`.msg[data-id="${m.id}"]`);
  if (!row) return;
  const body = row.querySelector('.body');
  const ta = h('textarea', { rows: 2 });
  ta.value = m.content;
  const box = h('div', { class: 'edit-box' }, ta, h('small', {}, 'Enter salva · Esc cancela'));
  if (body) body.replaceWith(box); else row.querySelector('.meta').after(box);
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  autosize(ta);
  ta.addEventListener('input', () => autosize(ta));
  ta.addEventListener('keydown', async (e) => {
    if (e.key === 'Escape') { box.remove(); rerenderMessages(); }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const content = ta.value.trim();
      box.remove();
      if (content !== m.content) await act('edit', { id: m.id, content }).catch((err) => toast(err.message, true));
      rerenderMessages();
    }
  });
}
async function confirmDelete(m) {
  if (!(await confirmModal('Apagar mensagem?', 'Essa mensagem vai sumir pra todo mundo.', 'Apagar'))) return;
  act('delete', { id: m.id }).catch((e) => toast(e.message, true));
}

// ======================= Menu da mensagem e ações =======================
// Posiciona um popover num ponto, sem sair da tela
function placePopover(pop, x, y) {
  (modal.open ? modal : document.body).append(pop); // dentro de uma janela aberta, o menu precisa ficar dentro dela
  const w = pop.offsetWidth, hgt = pop.offsetHeight;
  pop.style.left = Math.max(8, Math.min(x, innerWidth - w - 8)) + 'px';
  pop.style.top = Math.max(8, Math.min(y, innerHeight - hgt - 8)) + 'px';
  // tira os ouvintes junto com o menu (antes o do teclado só saía apertando Esc e segurava o menu na memória)
  const stop = () => { document.removeEventListener('mousedown', close, true); document.removeEventListener('touchstart', close, true); removeEventListener('keydown', esc, true); };
  const close = (ev) => {
    if (!pop.isConnected) return stop(); // já foi fechado de outro jeito
    if (pop.contains(ev.target)) return;
    pop.remove(); stop();
  };
  setTimeout(() => { document.addEventListener('mousedown', close, true); document.addEventListener('touchstart', close, true); }, 0);
  const esc = (ev) => {
    if (!pop.isConnected) return stop();
    if (ev.key === 'Escape') { pop.remove(); stop(); }
  };
  addEventListener('keydown', esc, true);
  return pop;
}
const closePopovers = () => $$('.popover').forEach((p) => p.remove());

function pushRecent(e) {
  prefs.recentEmojis = [e, ...prefs.recentEmojis.filter((x) => x !== e)].slice(0, 8);
  savePrefs();
}
const reactBusy = new Set();
async function react(m, emoji, on) {
  hideReactionTip();
  const key = m.id + '|' + emoji;
  if (reactBusy.has(key)) return; // ignora clique repetido enquanto o primeiro ainda está indo
  reactBusy.add(key);
  if (on) pushRecent(emoji);
  try { await act('react', { messageId: m.id, emoji, on }); } catch (e) { toast(e.message, true); }
  finally { setTimeout(() => reactBusy.delete(key), 250); }
}
// Escolher um emoji que você já usou nessa mensagem tira a reação; senão, adiciona (igual ao Discord)
const toggleReact = (m, e) => react(m, e, !iReacted(m, e));
// Estado atual da minha reação (sempre do dado mais novo, não do que estava na tela quando desenhou)
function iReacted(m, emoji) {
  const cur = S.msgs[m.channelId]?.find((x) => x.id === m.id) || m;
  return !!cur.reactions?.find((r) => r.emoji === emoji)?.users.includes(S.me.id);
}
// Depois de escolher num seletor/menu, ignora o "segundo clique" de um clique duplo
function swallowNextClick(ms = 400) {
  const block = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
  addEventListener('click', block, true);
  addEventListener('dblclick', block, true);
  setTimeout(() => { removeEventListener('click', block, true); removeEventListener('dblclick', block, true); }, ms);
}

// Lista completa de emojis (nomes em português, Unicode/CLDR). Carrega só quando abre pela primeira vez.
let EMOJI_DATA = null;
async function loadEmojis() {
  if (!EMOJI_DATA) EMOJI_DATA = fetch('/emoji-pt.json').then((r) => r.json()).catch(() => { EMOJI_DATA = null; return []; });
  return EMOJI_DATA;
}
const semAcento = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

async function emojiPicker(anchor, onPick, at) {
  closePopovers();
  const search = h('input', { type: 'search', placeholder: 'Procurar emoji (ex: rir, coração, fogo)', autocomplete: 'off' });
  const tabs = h('div', { class: 'emoji-tabs' });
  const body = h('div', { class: 'emoji-body' }, h('p', { class: 'hint', style: { padding: '12px' } }, 'Carregando…'));
  const preview = h('div', { class: 'emoji-preview' }, h('span', { class: 'big' }, '🙂'), h('span', { class: 'nm' }, 'Escolha um emoji'));
  const pop = h('div', { class: 'popover emoji-picker' }, h('div', { class: 'emoji-top' }, search), h('div', { class: 'emoji-main' }, tabs, body), preview);
  const r = at || anchor.getBoundingClientRect();
  placePopover(pop, r.left, (r.bottom ?? r.top) + 6);
  if (!at && r.bottom + pop.offsetHeight > innerHeight) pop.style.top = Math.max(8, r.top - pop.offsetHeight - 6) + 'px';
  setTimeout(() => search.focus(), 0);

  const groups = await loadEmojis();
  if (!pop.isConnected) return;
  const byChar = new Map(groups.flatMap((g) => g.emojis.map((x) => [x[0], x])));
  const recent = prefs.recentEmojis.map((e) => byChar.get(e) || [e, e, '']);
  const all = [{ id: 'recentes', nome: 'Usados recentemente', icone: '🕘', emojis: recent }, ...groups];

  const pick = (e) => { pop.remove(); swallowNextClick(); onPick(e); };
  const btn = (x) => {
    const b = h('button', { type: 'button', class: 'emo', title: x[1], onclick: () => pick(x[0]) }, x[0]);
    b.addEventListener('mouseenter', () => { preview.firstChild.textContent = x[0]; preview.lastChild.textContent = x[1]; });
    return b;
  };
  const sections = new Map();
  const drawAll = () => {
    body.innerHTML = '';
    for (const g of all) {
      if (!g.emojis.length) continue;
      const sec = h('section', { 'data-id': g.id }, h('h5', {}, g.nome), h('div', { class: 'emoji-grid' }, ...g.emojis.map(btn)));
      sections.set(g.id, sec);
      body.append(sec);
    }
  };
  drawAll();
  tabs.innerHTML = '';
  for (const g of all) {
    tabs.append(h('button', { type: 'button', title: g.nome, 'data-id': g.id, onclick: () => {
      if (search.value) { search.value = ''; drawAll(); }
      const sec = sections.get(g.id); if (sec) body.scrollTop = sec.offsetTop - body.offsetTop;
    } }, g.icone));
  }
  // destaca a categoria visível
  body.addEventListener('scroll', () => {
    let cur = all[0].id;
    for (const [id, sec] of sections) if (sec.offsetTop - body.offsetTop <= body.scrollTop + 8) cur = id;
    $$('.emoji-tabs button', pop).forEach((b) => b.classList.toggle('on', b.dataset.id === cur));
  });
  body.dispatchEvent(new Event('scroll'));

  search.addEventListener('input', () => {
    const q2 = semAcento(search.value.trim());
    if (!q2) return drawAll();
    const terms = q2.split(/\s+/);
    const found = groups.flatMap((g) => g.emojis).filter((x) => terms.every((w) => x[2].split(' ').some((k) => k.startsWith(w)) || semAcento(x[1]).includes(w)));
    body.innerHTML = '';
    body.append(found.length
      ? h('section', {}, h('h5', {}, `Resultados (${found.length})`), h('div', { class: 'emoji-grid' }, ...found.slice(0, 400).map(btn)))
      : h('p', { class: 'hint', style: { padding: '12px' } }, 'Nenhum emoji encontrado.'));
  });
  search.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const first = $('.emoji-grid .emo', body); if (first) first.click(); } });
}

function messageMenu(m, x, y) {
  closePopovers();
  const mine = m.userId === S.me.id;
  const item = (ic, label, fn, cls = '') => h('button', { type: 'button', class: 'menu-item ' + cls, onclick: () => { pop.remove(); fn(); } }, h('span', {}, label), icon(ic));
  const sep = () => h('div', { class: 'menu-sep' });
  const quick = h('div', { class: 'quick-react' },
    ...prefs.recentEmojis.slice(0, 4).map((e) => h('button', { type: 'button', class: iReacted(m, e) ? 'on' : '', title: iReacted(m, e) ? `Tirar sua reação ${e}` : `Reagir com ${e}`, onclick: () => { pop.remove(); swallowNextClick(); toggleReact(m, e); } }, e)));
  const pop = h('div', { class: 'popover menu ctx' },
    quick,
    h('button', { type: 'button', class: 'menu-item', onclick: () => { const r = pop.getBoundingClientRect(); pop.remove(); emojiPicker(null, (e) => toggleReact(m, e), { left: r.left, top: r.top, bottom: r.top }); } },
      h('span', { class: 'with-icon' }, icon('smile-plus'), 'Adicionar reação'), icon('right')),
    sep(),
    item('reply', 'Responder', () => startReply(m)),
    item('forward', 'Encaminhar', () => forwardModal(m)),
    m.content ? item('copy', 'Copiar texto', () => { navigator.clipboard?.writeText(m.content); toast('Texto copiado.'); }) : null,
    mine || S.me.isAdmin ? sep() : null,
    mine ? item('edit', 'Editar mensagem', () => startEdit(m)) : null,
    mine || S.me.isAdmin ? item('trash', 'Apagar mensagem', () => confirmDelete(m), 'danger') : null,
  );
  placePopover(pop, x, y);
}

// ---- Responder
function startReply(m) {
  if (m.channelId !== S.current) return;
  S.replyTo = { id: m.id, channelId: m.channelId, userId: m.userId };
  const bar = $('#replying');
  bar.innerHTML = '';
  bar.append(h('span', {}, 'Respondendo a ', h('b', {}, userName(m.userId))),
    h('button', { type: 'button', class: 'icon-btn', title: 'Cancelar resposta (Esc)', onclick: cancelReply }, icon('x')));
  bar.hidden = false;
  input.focus();
}
function cancelReply() {
  S.replyTo = null;
  const bar = $('#replying');
  if (bar) { bar.hidden = true; bar.innerHTML = ''; }
}

// ---- Ir até uma mensagem (carrega mensagens antigas se precisar)
async function jumpTo(channelId, msgId) {
  if (S.current !== channelId || S.view !== 'chat') await openChannel(channelId);
  for (let i = 0; i < 30; i++) {
    if (S.msgs[channelId]?.some((x) => x.id === msgId) || !S.hasMore[channelId]) break;
    S.loading = false;
    await loadOlder();
  }
  const el = $(`.msg[data-id="${msgId}"]`);
  if (!el) return toast('Não achei essa mensagem (pode ter sido apagada).');
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
}

// ---- Encaminhar (igual ao Discord: escolhe uma ou mais conversas, com mensagem opcional)
function forwardModal(m) {
  openModal((f) => {
    f.classList.add('fwd-modal');
    const chosen = new Map(); // chave -> { channelId } ou { userId }
    const search = h('input', { type: 'search', placeholder: 'Buscar', autocomplete: 'off' });
    const list = h('div', { class: 'fwd-list' });
    const comment = h('input', { placeholder: 'Adicione uma mensagem opcional...', maxlength: 2000, autocomplete: 'off' });
    const go = h('button', { type: 'submit', class: 'btn primary fwd-send', disabled: true }, 'Enviar', icon('send'));
    // destinos: conversas privadas (mais recentes primeiro), canais de texto e o resto do pessoal
    const dms = [...S.dms].sort((a, b) => b.lastAt - a.lastAt);
    const withDm = new Set(dms.map((d) => d.dm));
    const dests = [
      ...dms.map((d) => ({ key: 'u' + d.dm, userId: d.dm })),
      ...S.channels.filter((c) => c.type === 'text').map((c) => ({ key: 'c' + c.id, channelId: c.id })),
      ...[...S.users.values()].filter((u) => u.id !== S.me.id && !u.deleted && !withDm.has(u.id)).sort((a, b) => a.displayName.localeCompare(b.displayName)).map((u) => ({ key: 'u' + u.id, userId: u.id })),
    ];
    const label = (d) => (d.userId ? userName(d.userId) : channelById(d.channelId)?.name || '');
    const draw = () => {
      list.innerHTML = '';
      const q2 = semAcento(search.value.trim());
      const shown = dests.filter((d) => !q2 || semAcento(label(d)).includes(q2) || (d.userId && semAcento(S.users.get(d.userId)?.username || '').includes(q2)));
      if (!shown.length) list.append(h('p', { class: 'hint', style: { padding: '16px 8px' } }, 'Nada encontrado.'));
      for (const d of shown) {
        const u = d.userId && S.users.get(d.userId);
        const pic = u ? avatar(u, '', true) : h('span', { class: 'fwd-server' }, h('img', { src: '/icon.svg', alt: '' }), h('span', { class: 'fwd-kind' }, icon('hash')));
        const box = h('input', { type: 'checkbox', checked: chosen.has(d.key) });
        box.onchange = () => {
          if (box.checked) {
            if (chosen.size >= 5) { box.checked = false; return toast('Dá para encaminhar para até 5 conversas de uma vez.'); }
            chosen.set(d.key, d);
          } else chosen.delete(d.key);
          go.disabled = !chosen.size;
          row.classList.toggle('sel', box.checked);
        };
        const row = h('label', { class: 'fwd-row' + (chosen.has(d.key) ? ' sel' : '') }, pic,
          h('span', { class: 'fwd-names' }, h('b', {}, label(d)), h('small', {}, u ? u.username : serverName(channelById(d.channelId)?.server_id))), box);
        list.append(row);
      }
    };
    search.oninput = draw;
    draw();
    const what = m.forward ? m.forward : m;
    const preview = h('div', { class: 'fwd-preview' },
      what.content ? h('div', { class: 'body', html: md(what.content) }) : null,
      what.attachment ? h('div', { class: 'fwd-file' }, h('span', { class: 'ic-inline' }, icon('clip')), what.attachment.name) : null);
    const emo = h('button', { type: 'button', class: 'icon-btn', title: 'Emoji', onclick: (ev) => emojiPicker(ev.currentTarget, (e) => { comment.value += e; comment.focus(); }) }, icon('smile'));
    f.append(
      h('div', { class: 'fwd-top' },
        h('div', { class: 'fwd-title' }, h('h3', {}, 'Encaminhar para'), h('button', { type: 'button', class: 'icon-btn', title: 'Fechar', onclick: () => modal.close() }, icon('x'))),
        h('p', {}, 'Selecione onde você quer compartilhar esta mensagem.'),
        h('label', { class: 'fwd-search' }, icon('search'), search)),
      list,
      h('div', { class: 'fwd-bottom' }, preview, h('div', { class: 'fwd-actions' }, h('div', { class: 'fwd-comment' }, comment, emo), go)));
    f.onsubmit = async (e) => {
      e.preventDefault();
      if (!chosen.size || go.disabled) return;
      go.disabled = true;
      const targets = [...chosen.values()];
      let ok = 0;
      for (const d of targets) {
        try { await act('forward', { messageId: m.id, comment: comment.value, ...(d.userId ? { userId: d.userId } : { channelId: d.channelId }) }); ok++; }
        catch (x) { toast(x.message, true); }
      }
      modal.close();
      if (ok) toast(ok === 1 ? `Encaminhada para ${targets[0].userId ? '@' : '#'}${label(targets[0])}.` : `Encaminhada para ${ok} conversas.`);
    };
    modal.addEventListener('close', () => f.classList.remove('fwd-modal'), { once: true });
    setTimeout(() => search.focus(), 0);
  });
}

// ---------- Mensagens diretas, amigos e perfis ----------
const friendState = (uid) => S.friends[uid] || 'none';
const isOnline = (uid) => S.online.has(Number(uid));
const fmtSince = (t) => new Date(t).toLocaleDateString('pt-BR', { day: 'numeric', month: 'short', year: 'numeric' });

// barrinha da esquerda: botão das mensagens diretas, conversas com mensagem nova e o servidor
function renderRail() {
  if (!S.me) return;
  const dmUnread = S.dms.reduce((a, d) => a + (S.current === d.id && S.view === 'chat' ? 0 : S.unread[d.id] || 0), 0);
  const incoming = Object.values(S.friends).filter((x) => x === 'incoming').length;
  const home = $('#rail-home');
  home.classList.toggle('active', S.mode === 'home');
  home.querySelector('.rail-badge')?.remove();
  if (incoming) home.append(h('span', { class: 'rail-badge' }, incoming));
  const box = $('#rail-dms');
  box.innerHTML = '';
  for (const d of S.dms.filter((x) => (S.unread[x.id] || 0) > 0 && !(S.current === x.id && S.view === 'chat')).sort((a, b) => b.lastAt - a.lastAt)) {
    const u = S.users.get(d.dm);
    const n = S.unread[d.id];
    box.append(h('button', { class: 'rail-btn dm', 'data-tip': u?.displayName, onclick: () => openChannel(d.id) }, avatar(u, 'rail'), h('span', { class: 'rail-badge' }, n > 99 ? '99+' : n)));
  }
  const list = $('#rail-servers');
  list.innerHTML = '';
  for (const s of S.servers) {
    const active = S.mode === 'server' && S.serverId === s.id;
    const unread = srvChannels(s.id).some((c) => c.type === 'text' && (S.unread[c.id] || 0) > 0 && !chanMuted(c.id) && !(S.current === c.id && S.view === 'chat'));
    list.append(h('button', { class: `rail-btn server${active ? ' active' : ''}${unread && !active ? ' unread' : ''}`, 'data-tip': s.name, onclick: () => goServer(s.id),
      oncontextmenu: (ev) => { ev.preventDefault(); goServer(s.id); setTimeout(serverMenu, 50); } }, serverIcon(s)));
  }
  $('#rail-add').hidden = !S.me.isAdmin;
  $('#rail-sep2').hidden = !S.me.isAdmin;
  void dmUnread;
}

// ícone do servidor: o primeiro usa o ícone do app; os outros, as iniciais do nome
function serverIcon(s, cls = '') {
  if (s?.icon === 'app') return h('img', { src: '/icon.svg', alt: '', class: cls });
  if (s?.icon?.startsWith('/uploads/')) return h('img', { src: s.icon, alt: '', class: 'srv-img ' + cls });
  const ini = (s?.name || '?').trim().split(/\s+/).slice(0, 2).map((p) => p[0]).join('').toUpperCase();
  return h('span', { class: 'srv-ini ' + cls, style: { '--c': s?.color || '#5865f2' } }, ini);
}
// ---- imagens (foto de perfil, banner, ícone do servidor): recorta no tamanho certo antes de enviar
function pickImage() {
  return new Promise((resolve) => {
    const i = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif' });
    i.onchange = () => resolve(i.files[0] || null);
    i.click();
  });
}
async function cropImage(file, w, hgt) {
  if (file.type === 'image/gif' && file.size < 6 * 1048576) return file; // GIF animado vai como está
  const bmp = await createImageBitmap(file);
  const sc = Math.max(w / bmp.width, hgt / bmp.height);
  const sw = w / sc, sh = hgt / sc;
  const c = document.createElement('canvas'); c.width = w; c.height = hgt;
  c.getContext('2d').drawImage(bmp, (bmp.width - sw) / 2, (bmp.height - sh) / 2, sw, sh, 0, 0, w, hgt);
  return new Promise((r) => c.toBlob(r, 'image/webp', 0.9));
}
async function uploadImage(w, hgt, name) {
  const f = await pickImage();
  if (!f) return null;
  if (!f.type.startsWith('image/')) { toast('Escolha uma imagem (PNG, JPG, WEBP ou GIF).', true); return null; }
  const blob = await cropImage(f, w, hgt);
  const r = await fetch('/api/upload', { method: 'POST', headers: { 'Content-Type': blob.type || 'image/webp', 'X-Filename': encodeURIComponent(name + (blob.type === 'image/gif' ? '.gif' : '.webp')) }, body: blob });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { toast(d.error || 'Falha no envio da imagem.', true); return null; }
  return d.url;
}
// balãozinho com o nome ao passar o mouse na barra de servidores (igual ao Discord)
(() => {
  const rail = $('#rail');
  let tip = null;
  const hide = () => { tip?.remove(); tip = null; };
  rail.addEventListener('mouseover', (e) => {
    const b = e.target.closest?.('[data-tip]');
    if (!b) return hide();
    if (tip?.dataset.for === b.dataset.tip) return;
    hide();
    tip = h('div', { class: 'rail-tip', 'data-for': b.dataset.tip }, b.dataset.tip);
    document.body.append(tip);
    const r = b.getBoundingClientRect();
    tip.style.left = r.right + 14 + 'px';
    tip.style.top = r.top + r.height / 2 - tip.offsetHeight / 2 + 'px';
  });
  rail.addEventListener('mouseleave', hide);
  rail.addEventListener('click', hide);
})();
function createServerModal() {
  openModal((f) => {
    withModalClass(f, 'mx');
    const name = h('input', { maxlength: 40, placeholder: 'Servidor da galera', autocomplete: 'off' });
    const go = h('button', { class: 'btn primary', disabled: true }, 'Criar servidor');
    const err = h('p', { class: 'form-error' });
    name.oninput = () => { go.disabled = !name.value.trim(); };
    f.append(h('div', { class: 'mx-pad' },
      modalHead('Criar um servidor', 'Ele já vem com #geral, uma sala de voz e o #tempo para música. Só entra quem receber um convite.'),
      h('div', { class: 'mx-sec' }, h('h5', {}, 'Nome do servidor'), h('div', { class: 'mx-input' }, name, emojiInput(name))), err,
      h('div', { class: 'mx-actions' }, h('button', { type: 'button', class: 'btn', onclick: () => modal.close() }, 'Cancelar'), go)));
    f.onsubmit = async (e) => {
      e.preventDefault();
      if (!name.value.trim()) return;
      try {
        const r = await act('server_create', { name: name.value });
        modal.close();
        await loadState(); renderAll(); goServer(r.serverId);
        toast('Servidor criado! Use "Convidar para o servidor" para chamar a galera.');
      } catch (x) { err.textContent = x.message; }
    };
    setTimeout(() => name.focus(), 0);
  });
}
// link de convite aberto no app (…/?convite=código): pergunta se quer entrar
async function checkInviteLink() {
  const code = new URLSearchParams(location.search).get('convite');
  if (!code) return;
  history.replaceState(null, '', location.pathname);
  try {
    const info = await api('/api/invite-info?code=' + encodeURIComponent(code));
    if (!info.valid) return toast(info.name ? `O convite para ${info.name} expirou ou já foi usado.` : 'Esse convite não vale mais.', true);
    const mine = S.servers.find((s) => s.name === info.name && s.members.includes(S.me.id));
    if (mine) return goServer(mine.id);
    if (!(await confirmModal(`Entrar em ${info.name}?`, `Você foi convidado(a) para o servidor ${info.name} (${info.members} ${info.members === 1 ? 'membro' : 'membros'}).`, 'Entrar no servidor'))) return;
    const r = await act('server_join', { invite: code });
    await loadState(); renderAll(); goServer(r.serverId);
  } catch (e) { toast(e.message, true); }
}

function renderHome() {
  const list = $('#channel-list');
  list.innerHTML = '';
  if (!S.member) { // foi expulso: pode voltar com um convite
    const inp = h('input', { placeholder: 'Cole o link ou código do convite', autocomplete: 'off' });
    list.append(h('form', { class: 'join-card', onsubmit: async (e) => {
      e.preventDefault();
      try { const r = await act('server_join', { invite: inp.value }); await loadState(); renderAll(); goServer(r.serverId); toast(`Bem-vindo(a) ao ${S.serverName}!`); }
      catch (x) { toast(x.message, true); }
    } }, h('b', {}, 'Você não está em nenhum servidor'), h('small', {}, 'Recebeu um convite? Cole aqui para entrar.'), inp, h('button', { class: 'btn primary' }, 'Entrar no servidor')));
  }
  const incoming = Object.values(S.friends).filter((x) => x === 'incoming').length;
  list.append(h('button', { class: 'chan home-item' + (S.view === 'friends' ? ' active' : ''), onclick: showFriends },
    icon('users'), h('span', { class: 'name' }, 'Amigos'), incoming ? h('span', { class: 'badge' }, incoming) : null));
  list.append(h('div', { class: 'cat' }, h('span', {}, 'Mensagens diretas'), h('button', { class: 'icon-btn', title: 'Criar mensagem direta', onclick: findModal }, icon('plus'))));
  const dms = [...S.dms].sort((a, b) => b.lastAt - a.lastAt);
  if (!dms.length) list.append(h('p', { class: 'hint dm-empty' }, 'Nenhuma conversa ainda. Clique no + ou com o botão direito em alguém e escolha “Mensagem”.'));
  for (const d of dms) {
    const u = S.users.get(d.dm);
    const unread = S.current === d.id && S.view === 'chat' ? 0 : S.unread[d.id] || 0;
    const active = (S.view === 'chat' && S.current === d.id) || (S.view === 'voice' && V.channelId === d.id);
    const connected = V.channelId === d.id && !!V.room;
    const inCall = Object.keys(S.voice[d.id] || {}).length > 0;
    list.append(h('button', {
      class: `chan dm${active ? ' active' : ''}${unread ? ' unread' : ''}${connected ? ' connected' : ''}`,
      onclick: () => openChannel(d.id),
      oncontextmenu: (ev) => { ev.preventDefault(); userMenu(d.dm, ev.clientX, ev.clientY, d.id); },
    }, avatar(u, '', true), h('span', { class: 'name' }, u?.displayName || 'alguém'),
      V.channelId === d.id && S.calls[d.id] ? h('span', { class: 'call-timer', 'data-start': S.calls[d.id].startedAt }, fmtDur(Date.now() - S.calls[d.id].startedAt))
        : inCall ? h('span', { class: 'in-call', title: 'Chamada em andamento' }, icon('phone')) : null,
      unread ? h('span', { class: 'badge' }, unread > 99 ? '99+' : unread) : null,
      h('span', { class: 'chan-tools' }, h('span', { title: 'Fechar conversa', onclick: (e) => { e.stopPropagation(); closeDm(d.id); } }, icon('x')))));
  }
  updateTitle();
}

async function openDm(uid) {
  uid = Number(uid);
  const existing = S.dms.find((d) => d.dm === uid);
  if (existing) return openChannel(existing.id), existing.id;
  try {
    const { id } = await act('dm_open', { userId: uid });
    if (!S.dms.some((d) => d.id === id)) S.dms.push({ id, type: 'text', dm: uid, lastId: 0, lastAt: Date.now() });
    await openChannel(id);
    return id;
  } catch (e) { toast(e.message, true); }
}
async function closeDm(id) {
  S.dms = S.dms.filter((d) => d.id !== id);
  if (S.current === id && S.view === 'chat') showFriends(); else renderChannels();
  act('dm_close', { channelId: id }).catch(() => {});
}
async function startCall(uid, video = false) {
  const id = await openDm(uid);
  if (!id) return;
  if (V.channelId === id && V.room) return showVoiceView();
  await joinVoice(id);
  if (video && V.room) toggleCam();
}

function showFriends() {
  S.mode = 'home';
  S.view = 'friends';
  pushHist({ t: 'friends' });
  if (S.search) closeSearch();
  S.current = null;
  S.homeLast = null;
  cancelReply();
  $('#chat-view').hidden = true;
  $('#voice-view').hidden = true;
  $('#friends-view').hidden = false;
  $('#app').classList.remove('nav-open');
  renderHeader(); renderChannels(); renderFriends(); renderTyping();
}
function goHome() {
  if (S.homeLast && isDm(S.homeLast)) return openChannel(S.homeLast);
  if (S.view === 'voice' && isDm(V.channelId)) return showVoiceView();
  showFriends();
}
function goServer(sid = S.serverId) {
  sid = Number(sid) || S.servers[0]?.id;
  if (!serverById(sid)) return showFriends();
  if (S.view === 'voice' && V.channelId && !isDm(V.channelId) && channelById(V.channelId)?.server_id === sid) return showVoiceView();
  S.serverId = sid;
  const texts = srvChannels(sid).filter((c) => c.type === 'text');
  const last = prefs.lastChannelBy?.[sid] ?? (sid === S.servers[0]?.id ? prefs.lastChannel : 0);
  const id = texts.find((c) => c.id === last)?.id || texts[0]?.id;
  if (id) openChannel(id);
  else { // servidor sem canal de texto (ou nenhum visível): mostra a lista vazia
    S.mode = 'server'; S.view = 'chat'; S.current = null;
    $('#messages').innerHTML = ''; renderAll(); renderHeader();
  }
}

// ---- Página "Amigos"
function renderFriends() {
  const tabs = $('#head-tabs');
  const view = $('#friends-view');
  if (S.view !== 'friends') return;
  const incoming = Object.values(S.friends).filter((x) => x === 'incoming').length;
  const tab = (id, label, badge) => h('button', { class: 'head-tab' + (S.friendsTab === id ? ' on' : '') + (id === 'add' ? ' add' : ''), onclick: () => { S.friendsTab = id; renderFriends(); } }, label, badge ? h('span', { class: 'badge' }, badge) : null);
  tabs.innerHTML = '';
  tabs.append(tab('online', 'Disponível'), tab('all', 'Todos'), tab('pending', 'Pendente', incoming), S.me.isAdmin ? tab('users', 'Usuários') : '', tab('add', 'Adicionar amigo'));
  if (S.friendsTab === 'users' && !S.me.isAdmin) S.friendsTab = 'online';
  if (S.friendsTab !== 'add') S.addMsg = null;
  view.innerHTML = '';
  const others = [...S.users.values()].filter((u) => u.id !== S.me.id && !u.deleted).sort((a, b) => a.displayName.localeCompare(b.displayName));

  if (S.friendsTab === 'users') return renderUsersAdmin(view);
  if (S.friendsTab === 'add') {
    const inp = h('input', { placeholder: 'Você pode adicionar amigos com o nome de usuário deles.', autocomplete: 'off', maxlength: 32 });
    const btn = h('button', { class: 'btn primary', disabled: true }, 'Enviar pedido de amizade');
    const msg = h('p', { class: 'add-msg ' + (S.addMsg?.cls || '') }, S.addMsg?.text || '');
    inp.oninput = () => { btn.disabled = !inp.value.trim(); S.addMsg = null; msg.textContent = ''; msg.className = 'add-msg'; };
    const send = async () => {
      try {
        const r = await act('friend_request', { username: inp.value.trim() });
        S.addMsg = { cls: 'ok', text: r.status === 'friend' ? `Agora você e ${r.name} são amigos!` : `Pedido de amizade enviado para ${r.name}.` };
      } catch (e) { S.addMsg = { cls: 'bad', text: e.message }; }
      renderFriends(); // a lista pode ter mudado
    };
    btn.onclick = send;
    inp.onkeydown = (e) => { if (e.key === 'Enter' && inp.value.trim()) send(); };
    const sugg = others.filter((u) => friendState(u.id) === 'none');
    view.append(h('div', { class: 'add-friend' },
      h('h3', {}, 'Adicionar amigo'), h('p', {}, 'Você pode adicionar amigos com o nome de usuário deles.'),
      h('div', { class: 'add-box' }, inp, btn), msg));
    if (sugg.length) {
      view.append(h('h4', { class: 'friends-count' }, `Pessoas do servidor — ${sugg.length}`));
      for (const u of sugg) view.append(friendRow(u, 'none'));
    }
    setTimeout(() => inp.focus(), 0);
    return;
  }
  const search = h('input', { type: 'search', placeholder: 'Buscar', autocomplete: 'off', value: S.friendsQuery || '' });
  const listBox = h('div', {});
  const draw = () => {
    S.friendsQuery = search.value;
    const q2 = semAcento(search.value.trim());
    let rows = others.filter((u) => !q2 || semAcento(u.displayName).includes(q2) || semAcento(u.username).includes(q2));
    let title;
    if (S.friendsTab === 'pending') { rows = rows.filter((u) => ['incoming', 'outgoing'].includes(friendState(u.id))); title = 'Pendente'; }
    else {
      rows = rows.filter((u) => friendState(u.id) === 'friend');
      if (S.friendsTab === 'online') { rows = rows.filter((u) => isOnline(u.id)); title = 'Disponível'; } else title = 'Todos os amigos';
    }
    listBox.innerHTML = '';
    listBox.append(h('h4', { class: 'friends-count' }, `${title} — ${rows.length}`));
    for (const u of rows) listBox.append(friendRow(u, friendState(u.id)));
    if (!rows.length) {
      const txt = S.friendsTab === 'pending' ? 'Não há pedidos de amizade pendentes.' : S.friendsTab === 'online' ? 'Nenhum amigo disponível agora.' : 'Você ainda não adicionou ninguém.';
      listBox.append(h('div', { class: 'friends-empty' }, h('p', {}, txt),
        S.friendsTab !== 'pending' ? h('button', { class: 'btn primary', onclick: () => { S.friendsTab = 'add'; renderFriends(); } }, 'Adicionar amigo') : null));
    }
  };
  search.oninput = draw;
  view.append(h('label', { class: 'fwd-search friends-search' }, search, icon('search')), listBox);
  draw();
}
// ---- Lista de todos os usuários do app (só o administrador): controle de quem está no servidor, expulsos e exclusão
function renderUsersAdmin(view) {
  const search = h('input', { type: 'search', placeholder: 'Buscar usuário', autocomplete: 'off', value: S.usersQuery || '' });
  const filt = S.usersFilter || 'all';
  const listBox = h('div', {});
  const fbtn = (id, label) => h('button', { type: 'button', class: 'head-tab' + (filt === id ? ' on' : ''), onclick: () => { S.usersFilter = id; renderFriends(); } }, label);
  const serversOf = (u) => S.servers.filter((s) => s.members.includes(u.id));
  const draw = () => {
    S.usersQuery = search.value;
    const q2 = semAcento(search.value.trim());
    const all = [...S.users.values()].filter((u) => !u.deleted);
    let rows = all.filter((u) => !q2 || semAcento(u.displayName).includes(q2) || semAcento(u.username).includes(q2));
    if (filt === 'none') rows = rows.filter((u) => !serversOf(u).length);
    rows.sort((a, b) => (b.isAdmin - a.isAdmin) || a.displayName.localeCompare(b.displayName));
    listBox.innerHTML = '';
    listBox.append(h('h4', { class: 'friends-count' }, `Usuários — ${rows.length}`, h('span', { class: 'uc-sum' }, ` · ${all.filter((u) => !serversOf(u).length).length} sem nenhum servidor`)));
    for (const u of rows) {
      const me = u.id === S.me.id;
      const mine = serversOf(u);
      const tags = h('span', { class: 'uc-tags' },
        u.isAdmin ? h('span', { class: 'uc-tag admin' }, '★ Administrador') : null,
        ...(mine.length ? mine.map((s) => h('span', { class: 'uc-tag ok' }, s.name)) : [h('span', { class: 'uc-tag kicked' }, 'Sem servidor')]),
        friendState(u.id) === 'friend' ? h('span', { class: 'uc-tag' }, 'Amigo') : null);
      const acts = h('div', { class: 'friend-acts' });
      if (!me) acts.append(h('button', { class: 'round-act', title: 'Mensagem', onclick: () => openDm(u.id) }, icon('chat')));
      if (!me && !u.isAdmin) {
        acts.append(h('button', { class: 'btn uc-btn', onclick: (ev) => userServersMenu(u, ev.currentTarget) }, 'Servidores ▾'));
        acts.append(h('button', { class: 'btn danger uc-btn', onclick: () => deleteUser(u) }, 'Deletar'));
      }
      listBox.append(h('div', { class: 'friend-row uc-row' + (mine.length ? '' : ' kicked'), oncontextmenu: (ev) => { ev.preventDefault(); userMenu(u.id, ev.clientX, ev.clientY); } },
        avatar(u, '', true),
        h('div', { class: 'friend-names' }, h('b', {}, u.displayName, h('span', { class: 'uname', style: { display: 'inline' } }, '@' + u.username), me ? h('span', { class: 'uname', style: { display: 'inline' } }, ' (você)') : null),
          h('small', {}, tags, ` ${isOnline(u.id) ? 'Online' : 'Offline'} · membro desde ${u.createdAt ? fmtSince(u.createdAt) : '—'}`)),
        acts));
    }
    if (!rows.length) listBox.append(h('div', { class: 'friends-empty' }, h('p', {}, 'Ninguém encontrado.')));
  };
  search.oninput = draw;
  view.append(h('div', { class: 'uc-filters' }, fbtn('all', 'Todos'), fbtn('none', 'Sem servidor')),
    h('label', { class: 'fwd-search friends-search' }, search, icon('search')), listBox);
  draw();
}
// em quais servidores a pessoa está: marcar = trazer para o servidor, desmarcar = expulsar
function userServersMenu(u, anchor) {
  closePopovers();
  const pop = h('div', { class: 'popover menu ctx' }, h('div', { class: 'menu-title' }, `Servidores de ${u.displayName}`),
    ...S.servers.map((s) => {
      const inIt = s.members.includes(u.id);
      return h('button', { type: 'button', class: 'menu-item', onclick: async () => {
        pop.remove();
        if (inIt) {
          if (!(await confirmModal(`Expulsar ${u.displayName} de ${s.name}?`, `${u.displayName} perde os canais de ${s.name} e sai das salas de voz dele. A conta continua.`, 'Expulsar'))) return;
          act('member_kick', { userId: u.id, serverId: s.id }).then(() => toast(`${u.displayName} saiu de ${s.name}.`)).catch((e) => toast(e.message, true));
        } else {
          if (!(await confirmModal(`Colocar ${u.displayName} em ${s.name}?`, `${u.displayName} passa a ver os canais de ${s.name}, sem precisar de convite.`, 'Colocar no servidor'))) return;
          act('member_restore', { userId: u.id, serverId: s.id }).then(() => toast(`${u.displayName} entrou em ${s.name}.`)).catch((e) => toast(e.message, true));
        }
      } }, h('span', { class: 'with-icon' }, serverIcon(s, 'mini'), s.name), inIt ? icon('check') : null);
    }));
  const r = anchor.getBoundingClientRect();
  placePopover(pop, r.left - 120, r.bottom + 4);
}
function friendRow(u, st) {
  const btn = (ic, title, fn, cls = '') => h('button', { class: 'round-act ' + cls, title, onclick: (e) => { e.stopPropagation(); fn(e); } }, icon(ic));
  const status = st === 'incoming' ? 'Pedido de amizade recebido' : st === 'outgoing' ? 'Pedido de amizade enviado' : isOnline(u.id) ? 'Disponível' : 'Offline';
  const acts = h('div', { class: 'friend-acts' });
  if (st === 'incoming') acts.append(btn('check', 'Aceitar', () => act('friend_accept', { userId: u.id }).catch((e) => toast(e.message, true)), 'ok'), btn('x', 'Recusar', () => act('friend_remove', { userId: u.id }), 'bad'));
  else if (st === 'outgoing') acts.append(btn('x', 'Cancelar pedido', () => act('friend_remove', { userId: u.id }), 'bad'));
  else if (st === 'none') acts.append(btn('user-plus', 'Adicionar amigo', () => act('friend_request', { userId: u.id }).then(() => toast(`Pedido de amizade enviado para ${u.displayName}.`)).catch((e) => toast(e.message, true)), 'ok'), btn('chat', 'Mensagem', () => openDm(u.id)));
  else acts.append(btn('chat', 'Mensagem', () => openDm(u.id)), btn('dots', 'Mais', (e) => { const r = e.currentTarget.getBoundingClientRect(); userMenu(u.id, r.left, r.bottom + 4); }));
  return h('div', { class: 'friend-row', onclick: () => (st === 'friend' || st === 'none' ? openDm(u.id) : null),
    oncontextmenu: (ev) => { ev.preventDefault(); userMenu(u.id, ev.clientX, ev.clientY); } },
    avatar(u, '', true), h('div', { class: 'friend-names' }, h('b', {}, u.displayName, h('span', { class: 'uname' }, u.username)), h('small', {}, status)), acts);
}

// ---- Começo de uma conversa privada
function dmIntro(ch, empty) {
  const u = S.users.get(ch.dm);
  const st = friendState(ch.dm);
  const acts = h('div', { class: 'dm-intro-acts' });
  if (st === 'none') acts.append(h('button', { class: 'btn primary', onclick: () => act('friend_request', { userId: ch.dm }).catch((e) => toast(e.message, true)) }, 'Adicionar amigo'));
  else if (st === 'outgoing') acts.append(h('button', { class: 'btn', disabled: true }, 'Pedido de amizade enviado'));
  else if (st === 'incoming') acts.append(h('button', { class: 'btn primary', onclick: () => act('friend_accept', { userId: ch.dm }) }, 'Aceitar pedido de amizade'), h('button', { class: 'btn', onclick: () => act('friend_remove', { userId: ch.dm }) }, 'Recusar'));
  else acts.append(h('button', { class: 'btn', onclick: () => removeFriend(ch.dm) }, 'Remover amizade'));
  const box = h('div', { class: 'dm-intro' }, avatar(u, 'xl'), h('h2', {}, u?.displayName || ''), h('div', { class: 'uname-big' }, u?.username || ''),
    h('p', {}, 'Este é o começo do seu histórico de mensagens diretas com ', h('b', {}, u?.displayName || ''), '.'), acts);
  if (empty) box.append(h('button', { class: 'wave-btn', onclick: () => act('send', { channelId: ch.id, content: '👋' }).catch((e) => toast(e.message, true)) }, h('span', { class: 'e' }, '👋'), `Acenar para ${u?.displayName || ''}`));
  return box;
}
async function removeFriend(uid) {
  if (!(await confirmModal(`Remover ${userName(uid)}`, `Tem certeza de que quer remover ${userName(uid)} dos seus amigos?`, 'Remover amizade'))) return;
  act('friend_remove', { userId: uid }).catch((e) => toast(e.message, true));
}

// ---- Painel do perfil à direita (na conversa privada)
// banner do perfil: imagem enviada, cor escolhida ou a cor da pessoa
function bannerEl(u) {
  const b = u.banner;
  if (b && b.startsWith('/uploads/')) return h('div', { class: 'pf-banner img', style: { backgroundImage: `url("${b}")` } });
  return h('div', { class: 'pf-banner', style: { '--c': b && b.startsWith('#') ? b : u.color } });
}
function profileBody(u, big = true) {
  const st = friendState(u.id);
  return [
    bannerEl(u),
    h('div', { class: 'pf-avatar' }, avatar(u, big ? 'xl' : 'xl', true)),
    h('div', { class: 'pf-body' },
      h('h3', {}, u.displayName), h('div', { class: 'pf-user' }, u.username, u.isAdmin ? h('span', { class: 'pf-tag' }, '★ Administrador') : null),
      st === 'friend' ? h('div', { class: 'pf-friend' }, icon('users'), 'Vocês são amigos') : null,
      h('div', { class: 'pf-sec' }, h('h5', {}, 'Membro desde'), h('div', {}, u.createdAt ? fmtSince(u.createdAt) : '—'))),
  ];
}
function renderProfilePanel() {
  const panel = $('#profile-panel');
  const ch = S.view === 'chat' && isDm(S.current) ? channelById(S.current) : null;
  $('#app').classList.toggle('hide-profile', !!prefs.hideProfile);
  panel.innerHTML = '';
  const u = ch && S.users.get(ch.dm);
  if (!u) return;
  panel.append(...profileBody(u));
}

// ---- Cartão de perfil (clicar no nome/foto ou "Perfil" no menu)
function profileCard(uid, anchor, side) {
  closePopovers();
  const u = S.users.get(Number(uid));
  if (!u) return;
  const me = u.id === S.me.id;
  const pop = h('div', { class: 'popover profile-card' }, ...profileBody(u, false));
  const acts = h('div', { class: 'pf-acts' });
  if (me) acts.append(h('button', { class: 'btn', onclick: () => { pop.remove(); settingsModal('conta'); } }, 'Editar perfil'));
  else {
    const msg = h('input', { placeholder: `Mensagem para @${u.displayName}`, maxlength: 4000 });
    msg.onkeydown = async (e) => {
      if (e.key !== 'Enter' || !msg.value.trim()) return;
      const text = msg.value.trim(); pop.remove();
      const id = await openDm(u.id);
      if (id) act('send', { channelId: id, content: text }).catch((x) => toast(x.message, true));
    };
    acts.append(msg);
  }
  pop.append(acts);
  const r = anchor?.getBoundingClientRect?.() || { left: innerWidth / 2 - 150, right: innerWidth / 2 + 150, top: 120, bottom: 120 };
  placePopover(pop, side === 'left' ? r.left - 320 : r.right + 10, r.top);
  if (!me) setTimeout(() => pop.querySelector('input')?.focus(), 0);
}

// ---- Botão direito em alguém
async function kickUser(u) {
  if (!(await confirmModal(`Expulsar ${u.displayName} do servidor?`, `${u.displayName} sai do ${S.serverName} na hora: perde os canais e sai das salas de voz. A conta continua (mensagens privadas e amizades também) e a pessoa pode voltar se receber um convite novo.`, 'Expulsar do servidor'))) return;
  act('member_kick', { userId: u.id, serverId: S.serverId }).then(() => toast(`${u.displayName} foi expulso(a) do servidor.`)).catch((e) => toast(e.message, true));
}
async function deleteUser(u) {
  if (!(await confirmModal(`Deletar o usuário ${u.displayName}?`, `A conta de ${u.displayName} (@${u.username}) é excluída e a pessoa perde o acesso ao app na hora. As mensagens dela continuam aparecendo como "Usuário excluído". Isso não pode ser desfeito.`, 'Deletar usuário'))) return;
  act('user_delete', { userId: u.id }).then(() => toast('Usuário excluído.')).catch((e) => toast(e.message, true));
}
function userMenu(uid, x, y, dmId) {
  closePopovers();
  uid = Number(uid);
  const u = S.users.get(uid);
  if (!u || u.deleted) return;
  const me = uid === S.me.id;
  const st = friendState(uid);
  const item = (label, fn, cls = '') => h('button', { type: 'button', class: 'menu-item ' + cls, onclick: () => { pop.remove(); fn(); } }, h('span', {}, label));
  const sep = () => h('div', { class: 'menu-sep' });
  const pop = h('div', { class: 'popover menu ctx user-menu' },
    item('Perfil', () => profileCard(uid, null)),
    item('Mencionar', () => mentionUser(u)),
    me ? null : item('Mensagem', () => openDm(uid)),
    me ? null : item(Object.keys(S.voice[dmId || S.dms.find((d) => d.dm === uid)?.id] || {}).length ? 'Entrar na chamada' : 'Iniciar chamada', () => startCall(uid)),
    me ? null : sep(),
    me ? null
      : st === 'none' ? item('Adicionar amigo', () => act('friend_request', { userId: uid }).then(() => toast(`Pedido de amizade enviado para ${u.displayName}.`)).catch((e) => toast(e.message, true)))
      : st === 'outgoing' ? item('Cancelar pedido de amizade', () => act('friend_remove', { userId: uid }))
      : st === 'incoming' ? item('Aceitar pedido de amizade', () => act('friend_accept', { userId: uid }).catch((e) => toast(e.message, true)))
      : item('Remover amizade', () => removeFriend(uid), 'danger'),
    dmId ? item('Fechar conversa', () => closeDm(dmId)) : null,
    ...(S.me.isAdmin && !me && !u.isAdmin && !u.deleted ? [sep(),
      S.mode === 'server' && isMember(u) ? item('Expulsar do servidor', () => kickUser(u), 'danger') : null,
      item('Deletar usuário', () => deleteUser(u), 'danger')] : []));
  placePopover(pop, x, y);
}
async function mentionUser(u) {
  if (S.view !== 'chat' || !S.current) goServer();
  for (let i = 0; i < 20 && S.view !== 'chat'; i++) await new Promise((r) => setTimeout(r, 50));
  const tag = `@${u.username} `;
  const start = input.selectionStart ?? input.value.length;
  const before = input.value.slice(0, start);
  input.value = before + (before && !/\s$/.test(before) ? ' ' : '') + tag + input.value.slice(input.selectionEnd ?? start);
  autosize(input);
  input.focus();
  input.selectionStart = input.selectionEnd = input.value.length;
}

// ---- Procurar alguém para conversar
function findModal() {
  openModal((f) => {
    const search = h('input', { type: 'search', placeholder: 'Para onde você quer ir?', autocomplete: 'off' });
    const list = h('div', { class: 'fwd-list find-list' });
    let sel = 0, rows = [];
    const draw = () => {
      const q2 = semAcento(search.value.trim());
      rows = [
        ...[...S.users.values()].filter((u) => u.id !== S.me.id && !u.deleted).map((u) => ({ u, label: u.displayName, sub: u.username, go: () => openDm(u.id) })),
        ...S.channels.filter((c) => c.type === 'text').map((c) => ({ c, label: c.name, sub: serverName(c.server_id), go: () => openChannel(c.id) })),
      ].filter((r) => !q2 || semAcento(r.label).includes(q2) || semAcento(r.sub).includes(q2));
      sel = Math.min(sel, Math.max(0, rows.length - 1));
      list.innerHTML = '';
      rows.forEach((r, i) => list.append(h('button', { type: 'button', class: 'fwd-row' + (i === sel ? ' sel' : ''), onclick: () => { modal.close(); r.go(); } },
        r.u ? avatar(r.u, '', true) : h('span', { class: 'fwd-server' }, icon('hash')), h('span', { class: 'fwd-names' }, h('b', {}, r.label), h('small', {}, r.sub)))));
      if (!rows.length) list.append(h('p', { class: 'hint', style: { padding: '12px' } }, 'Ninguém encontrado.'));
    };
    search.oninput = () => { sel = 0; draw(); };
    search.onkeydown = (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % Math.max(1, rows.length); draw(); }
      if (e.key === 'Enter') { e.preventDefault(); const r = rows[sel]; if (r) { modal.close(); r.go(); } }
    };
    f.append(h('h3', {}, 'Encontre ou comece uma conversa'), search, list,
      h('p', { class: 'hint' }, 'Use ↑ ↓ para escolher e Enter para abrir.'));
    draw();
    setTimeout(() => search.focus(), 0);
  });
}

// ---- Chamada privada (funciona como no celular: toca, dá para atender ou recusar)
const fmtDur = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60; return (hh ? hh + ':' + String(mm).padStart(2, '0') : mm) + ':' + String(ss).padStart(2, '0'); };
function durText(ms) {
  const min = Math.round(ms / 60000);
  if (min < 1) return 'menos de um minuto';
  if (min < 60) return min === 1 ? '1 minuto' : `${min} minutos`;
  const hh = Math.floor(min / 60), mm = min % 60;
  return `${hh} hora${hh > 1 ? 's' : ''}${mm ? ` e ${mm} minuto${mm > 1 ? 's' : ''}` : ''}`;
}
// linha "Fulano iniciou uma chamada…" / "Você perdeu uma chamada de…"
function callMessageEl(m) {
  const c = m.call;
  const starter = m.userId === S.me.id ? 'Você' : userName(m.userId);
  const ended = !!c.endedAt;
  const missed = ended && m.userId !== S.me.id && !c.joined.includes(S.me.id);
  const declined = (c.declined || []).includes(S.me.id) && m.userId !== S.me.id;
  const dur = ended ? durText(c.endedAt - c.startedAt) : '';
  let text;
  if (missed) text = [declined ? 'Você recusou uma chamada de ' : 'Você perdeu uma chamada de ', h('b', {}, userName(m.userId)), ` que durou ${dur}.`];
  else text = [h('b', {}, starter), ended ? ` iniciou uma chamada que durou ${dur}.` : ' iniciou uma chamada.'];
  const when = sameDay(m.createdAt, Date.now()) ? fmtTime(m.createdAt) : `${new Date(m.createdAt).toLocaleDateString('pt-BR')} ${fmtTime(m.createdAt)}`;
  const row = h('div', { class: 'msg call-msg' + (missed ? ' missed' : ''), 'data-id': m.id },
    h('span', { class: 'call-ic' }, icon('phone')), h('span', { class: 'call-txt' }, ...text, h('time', {}, when)));
  if (!ended && V.channelId !== m.channelId) row.append(h('button', { class: 'btn call-join small', onclick: () => joinVoice(m.channelId) }, 'Entrar na chamada'));
  return row;
}

// painel da ligação em cima do chat da conversa privada (igual ao Discord)
function renderDmCall() {
  const box = $('#dm-call');
  if (!box) return;
  const cid = S.view === 'chat' && isDm(S.current) ? S.current : null;
  const people = cid ? Object.keys(S.voice[cid] || {}).map(Number) : [];
  const meIn = !!cid && V.channelId === cid;
  const ringing = cid ? (S.calls[cid]?.ringing || []).filter((x) => !people.includes(x)) : [];
  if (!cid || (!meIn && !people.length)) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  box.innerHTML = '';
  const ch = channelById(cid);
  const ppl = h('div', { class: 'call-people' });
  const ids = [...new Set([...(meIn ? [S.me.id] : []), ...people, ...ringing])];
  for (const uid of ids) {
    const st = S.voice[cid]?.[uid] || {};
    const isMe = uid === S.me.id;
    const speaking = meIn && (isMe ? V.meSpeaking : V.speaking.has(String(uid)));
    const wrap = h('div', { class: 'call-person' + (ringing.includes(uid) ? ' ringing' : '') + (speaking ? ' speaking' : ''), title: userName(uid) }, avatar(S.users.get(uid), 'call'));
    if (st.deafened || st.muted) wrap.append(h('span', { class: 'call-flag' }, icon(st.deafened ? 'head-off' : 'mic-off')));
    if (st.screen) wrap.append(h('span', { class: 'call-live' }, 'AO VIVO'));
    ppl.append(wrap);
  }
  box.append(ppl);
  const other = ch.dm;
  if (!meIn) {
    box.append(h('div', { class: 'call-status' }, `${userName(people[0])} está em uma chamada`),
      h('div', { class: 'call-ctrls' }, h('button', { class: 'call-join', onclick: () => joinVoice(cid) }, icon('phone'), 'Entrar na chamada')));
    return;
  }
  if (!V.room) box.append(h('div', { class: 'call-status' }, 'Conectando…'));
  else if (ringing.length) box.append(h('div', { class: 'call-status' }, `Chamando ${userName(other)}…`));
  else if (!people.includes(other)) box.append(h('div', { class: 'call-status' }, h('span', {}, `${userName(other)} não está na chamada. `), h('button', { class: 'link', onclick: () => act('call_ring', { channelId: cid }) }, 'Ligar de novo')));
  const lp = V.room?.localParticipant;
  const micOff = V.muted || V.deafened;
  const anyVideo = Object.values(S.voice[cid] || {}).some((s) => s.video || s.screen);
  const btn = (ic, title, fn, cls = '') => h('button', { class: 'call-btn2 ' + cls, title, onclick: fn }, icon(ic));
  box.append(h('div', { class: 'call-ctrls' },
    h('div', { class: 'call-group' },
      btn(micOff ? 'mic-off' : 'mic', V.muted ? 'Ativar microfone' : 'Silenciar microfone', toggleMute, micOff ? 'off' : ''),
      btn('chev', 'Escolher microfone', (e) => deviceMenu(e.currentTarget, 'audioinput'), 'caret'),
      btn(V.deafened ? 'head-off' : 'head', V.deafened ? 'Ligar áudio' : 'Desligar áudio', toggleDeafen, V.deafened ? 'off' : ''),
      btn('cam', lp?.isCameraEnabled ? 'Desligar câmera' : 'Ligar câmera', toggleCam, lp?.isCameraEnabled ? 'on' : ''),
      btn('screen', lp?.isScreenShareEnabled ? 'Parar de compartilhar' : 'Compartilhar tela', toggleScreen, lp?.isScreenShareEnabled ? 'on' : '')),
    h('div', { class: 'call-group' }, btn('grid', anyVideo ? 'Ver vídeo / tela em tela cheia' : 'Abrir a sala da chamada', showVoiceView, anyVideo ? 'on' : '')),
    btn('phone-off', 'Desligar', () => leaveVoice(), 'hang')));
}

// toque de quem recebe e "chamando…" de quem liga
let ringTimer = 0, ringMode = '';
function checkCalls() {
  const incoming = S.dms.find((d) => (S.calls[d.id]?.ringing || []).includes(S.me.id) && V.channelId !== d.id);
  const outgoing = !!V.room && isDm(V.channelId) && (S.calls[V.channelId]?.ringing || []).length > 0;
  const card = $('#call-card');
  if (!incoming) card?.remove();
  else if (card?.dataset.id !== String(incoming.id)) {
    card?.remove();
    const u = S.users.get(incoming.dm);
    document.body.append(h('div', { class: 'call-card', id: 'call-card', 'data-id': incoming.id },
      avatar(u, 'xl'), h('b', {}, u?.displayName || ''), h('small', {}, 'Chamada recebida…'),
      h('div', { class: 'call-acts' },
        h('button', { class: 'call-btn no', title: 'Recusar', onclick: () => { $('#call-card')?.remove(); act('call_decline', { channelId: incoming.id }).catch(() => {}); } }, icon('phone-off')),
        h('button', { class: 'call-btn yes', title: 'Atender', onclick: () => { $('#call-card')?.remove(); joinVoice(incoming.id); } }, icon('phone')))));
    desk?.flash();
  }
  const mode = incoming ? 'in' : outgoing ? 'out' : '';
  if (mode === ringMode) return;
  ringMode = mode;
  clearInterval(ringTimer); ringTimer = 0;
  const tone = () => (ringMode === 'in' ? beep([[660, 0.18], [880, 0.22], [660, 0.18], [880, 0.22]]) : ringMode === 'out' ? beep([[440, 0.5]]) : null);
  if (mode) { tone(); ringTimer = setInterval(tone, mode === 'in' ? 2400 : 3000); }
}
// relógio da ligação na lista de conversas
setInterval(() => { $$('.call-timer').forEach((el) => { el.textContent = fmtDur(Date.now() - Number(el.dataset.start)); }); }, 1000);

// ---------- Digitando… ----------
function onTyping({ channelId, userId }) {
  if (userId === S.me.id) return;
  S.typing[channelId] ||= {};
  clearTimeout(S.typing[channelId][userId]);
  S.typing[channelId][userId] = setTimeout(() => { delete S.typing[channelId][userId]; renderTyping(); }, 6000);
  renderTyping();
}
function renderTyping() {
  const ids = Object.keys(S.typing[S.current] || {});
  const el = $('#typing');
  if (!ids.length) return (el.innerHTML = '');
  const names = ids.map((id) => `<b>${esc(userName(id))}</b>`);
  el.innerHTML = names.length === 1 ? `${names[0]} está digitando…` : names.length < 4 ? `${names.join(', ')} estão digitando…` : 'Várias pessoas estão digitando…';
}

// ---------- Caixa de mensagem ----------
const input = $('#input');
let pending = null, lastTyping = 0;
function autosize(t) { t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, innerHeight * 0.4) + 'px'; }
input.addEventListener('input', () => {
  autosize(input);
  if (input.value.trim() && Date.now() - lastTyping > 3000) { lastTyping = Date.now(); act('typing', { channelId: S.current }).catch(() => {}); }
});
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#composer').requestSubmit(); }
  if (e.key === 'Escape' && S.replyTo) { e.preventDefault(); cancelReply(); }
  if (e.key === 'ArrowUp' && !input.value) {
    const mine = [...(S.msgs[S.current] || [])].reverse().find((m) => m.userId === S.me.id && m.content);
    const row = mine && $(`.msg[data-id="${mine.id}"]`);
    if (row) { e.preventDefault(); startEdit(mine); }
  }
});
$('#composer').addEventListener('submit', async (e) => {
  e.preventDefault();
  const content = input.value.trim();
  if (pending && !pending.ready) return toast('Espera o arquivo terminar de enviar.');
  if (!content && !pending) return;
  if (/^\/clean\s*$/i.test(content)) { // comando de administrador: apaga todas as mensagens do canal
    if (!S.me.isAdmin) return toast('Só o administrador pode usar /clean.', true);
    const ch = channelById(S.current);
    if (!ch || ch.dm) return toast('O /clean só funciona nos canais do servidor.', true);
    input.value = ''; autosize(input);
    if (!(await confirmModal(`Apagar todas as mensagens de #${ch.name}?`, 'Todas as mensagens desse canal serão apagadas pra sempre, para todo mundo. Isso não pode ser desfeito.', 'Apagar tudo'))) return;
    return act('channel_clean', { channelId: ch.id }).then(() => toast(`#${ch.name} foi limpo.`)).catch((x) => toast(x.message, true));
  }
  const body = { channelId: S.current, content, attachment: pending?.ready || null, replyTo: S.replyTo?.channelId === S.current ? S.replyTo.id : null };
  cancelReply();
  input.value = ''; autosize(input);
  clearPending();
  lastTyping = 0;
  try { await act('send', body); }
  catch (err) { toast(err.message, true); input.value = content; }
});

$('#btn-attach').addEventListener('click', () => $('#file-input').click());
$('#file-input').addEventListener('change', (e) => { if (e.target.files[0]) uploadFile(e.target.files[0]); e.target.value = ''; });
input.addEventListener('paste', (e) => {
  const f = [...(e.clipboardData?.files || [])][0];
  if (f) { e.preventDefault(); uploadFile(f); }
});
let dragDepth = 0, dropHint = null;
window.addEventListener('dragenter', (e) => { if (S.view !== 'chat' || !e.dataTransfer?.types.includes('Files')) return; dragDepth++; if (!dropHint) document.body.append(dropHint = h('div', { class: 'drop-hint' }, `Solta pra enviar em ${chanLabel(channelById(S.current))}`)); });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; dropHint?.remove(); dropHint = null; } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => { e.preventDefault(); dragDepth = 0; dropHint?.remove(); dropHint = null; const f = e.dataTransfer?.files?.[0]; if (f && S.view === 'chat') uploadFile(f); });

function clearPending() { pending?.xhr?.abort(); pending = null; $('#pending-file').hidden = true; $('#pending-file').innerHTML = ''; }
function uploadFile(file) {
  clearPending();
  const box = $('#pending-file');
  const bar = h('i');
  const preview = file.type.startsWith('image/') ? h('img', { src: URL.createObjectURL(file), alt: '' }) : icon('file');
  box.append(preview, h('div', { class: 'grow' }, h('div', {}, file.name, ' · ', fmtSize(file.size)), h('div', { class: 'progress' }, bar)),
    h('button', { type: 'button', class: 'icon-btn', title: 'Cancelar', onclick: clearPending }, icon('x')));
  box.hidden = false;
  const xhr = new XMLHttpRequest();
  pending = { xhr, ready: null };
  const mine = pending;
  xhr.open('POST', '/api/upload');
  xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
  xhr.setRequestHeader('X-Filename', encodeURIComponent(file.name));
  xhr.upload.onprogress = (e) => { if (e.lengthComputable) bar.style.width = (e.loaded / e.total) * 100 + '%'; };
  xhr.onload = () => {
    if (pending !== mine) return;
    let data = {};
    try { data = JSON.parse(xhr.responseText); } catch {}
    if (xhr.status !== 200) { toast(data.error || 'Falha no envio.', true); return clearPending(); }
    mine.ready = data;
    bar.style.width = '100%';
    bar.style.background = 'var(--ok)';
    input.focus();
  };
  xhr.onerror = () => { if (pending === mine) { toast('Falha no envio.', true); clearPending(); } };
  xhr.send(file);
  input.focus();
}

// ---------- Voz ----------
function clickVoice(id) {
  id = Number(id);
  if (V.channelId === id && V.room) return showVoiceView();
  joinVoice(id);
}
function showVoiceView() {
  S.view = 'voice';
  S.mode = isDm(V.channelId) ? 'home' : 'server';
  $('#friends-view').hidden = true;
  $('#chat-view').hidden = true;
  $('#voice-view').hidden = false;
  $('#app').classList.remove('nav-open');
  renderHeader(); renderChannels(); renderTiles();
}

async function joinVoice(id) {
  const L = LK() || (await loadLK());
  if (!L) return toast('A biblioteca de voz não carregou. Confira a internet ou peça para o dono do servidor reabrir o DiscordIA.', true, 7000);
  if (!window.isSecureContext) return toast('O navegador só libera o microfone em HTTPS. Use o endereço https://…ts.net do Tailscale (ou localhost no PC do servidor).', true, 9000);
  if (V.joining) return;
  V.joining = true;
  if (V.room) await leaveVoice(true);
  setVoiceStatus('Conectando…');
  $('#voice-bar').hidden = false;
  $('#voice-where').textContent = isDm(id) ? `@${channelById(id)?.name || ''}` : `${channelById(id)?.name || ''} / ${serverName(channelById(id)?.server_id)}`;
  setSignal('excellent');
  V.channelId = id;
  if (isDm(id)) { if (S.current !== id || S.view !== 'chat') await openChannel(id); renderDmCall(); renderChannels(); }
  else showVoiceView();
  const tm = { start: performance.now() };
  const micReady = prepareMic(); // microfone + supressão de ruído começam JUNTO com a conexão (antes era um depois do outro)
  micReady.catch(() => {});
  try {
    const { token, path } = await voiceToken(id);
    tm.token = performance.now();
    const room = new L.Room({
      adaptiveStream: true, dynacast: true,
      webAudioMix: true, // permite volume por pessoa acima de 100%
      audioCaptureDefaults: captureOptions(),
      audioOutput: prefs.speaker ? { deviceId: prefs.speaker } : undefined,
      publishDefaults: { dtx: true, red: true, audioPreset: { maxBitrate: A().quality * 1000 } },
    });
    V.room = room;
    wireRoom(room);
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${path}`;
    await room.connect(url, token);
    tm.connect = performance.now();
    if (V.room !== room) { micReady.then((m) => m?.track.stop()).catch(() => {}); return; }
    // já está na sala: aparece para todo mundo e você já ouve; o microfone entra logo em seguida
    act('voice_join', { channelId: id, connId: S.connId, muted: true, deafened: V.deafened }).catch(() => {});
    applyVolumes();
    setVoiceStatus('Voz conectada');
    SND.join();
    syncPlayer(); renderMusic(); // se já tem música tocando nessa sala, começa a tocar
    renderTiles();
    await publishMic(room, micReady);
    tm.mic = performance.now();
    if (V.room !== room) return;
    syncVoiceState();
    V.joinTiming = { token: Math.round(tm.token - tm.start), conexao: Math.round(tm.connect - tm.token), microfone: Math.round(tm.mic - tm.connect), total: Math.round(tm.mic - tm.start) };
    console.info('[voz] tempo para entrar (ms):', V.joinTiming);
    $('#vc-signal').title = `Conexão de voz · entrou em ${(V.joinTiming.total / 1000).toFixed(1)} s (conectar ${(V.joinTiming.conexao / 1000).toFixed(1)} s)`;
  } catch (e) {
    console.error(e);
    toast('Não consegui entrar na voz: ' + (e.message || e), true, 8000);
    micReady.then((m) => m?.track.stop()).catch(() => {}); // solta o microfone
    await leaveVoice(true);
  } finally { V.joining = false; }
}

function micError(e) {
  console.error(e);
  if (V.screenBusy) return; // erro da transmissão de tela, não do microfone (não silencia ninguém)
  V.muted = true;
  renderMe();
  toast(e?.name === 'NotAllowedError' ? 'Você bloqueou o microfone. Libere no cadeado da barra de endereço.' : 'Não achei um microfone funcionando.', true, 7000);
}

function wireRoom(room) {
  const E = LK().RoomEvent;
  room.on(E.TrackSubscribed, (track, pub, p) => {
    if (track.kind === 'audio') {
      // com webAudioMix o som sai pelo AudioContext; o elemento só "segura" a faixa (fica mudo)
      const el = track.attach();
      el.dataset.pid = p.identity;
      $('#audio-sink').append(el);
      applyVolumes();
    }
    renderTiles();
  });
  room.on(E.TrackUnsubscribed, (track) => { track.detach().forEach((e) => e.remove()); renderTiles(); });
  room.on(E.TrackMuted, renderTiles);
  room.on(E.TrackUnmuted, renderTiles);
  room.on(E.LocalTrackPublished, () => { renderTiles(); syncVoiceState(); });
  room.on(E.LocalTrackUnpublished, () => { renderTiles(); syncVoiceState(); });
  room.on(E.ParticipantConnected, renderTiles);
  room.on(E.ParticipantDisconnected, renderTiles);
  room.on(E.ActiveSpeakersChanged, onSpeakersChanged);
  room.on(E.ConnectionQualityChanged, (q, p) => { if (p === room.localParticipant) setSignal(q); });
  room.on(E.Reconnecting, () => { setVoiceStatus('Reconectando…', true); setSignal('poor'); });
  room.on(E.Reconnected, () => setVoiceStatus('Voz conectada'));
  room.on(E.Disconnected, () => { if (V.room === room) { toast('A conexão de voz caiu.', true); leaveVoice(true); } });
  room.on(E.AudioPlaybackStatusChanged, () => {
    if (!room.canPlaybackAudio) {
      const t = toast(h('span', {}, 'O navegador pausou o áudio. ', h('button', { class: 'btn primary', onclick: () => { room.startAudio(); t.remove(); } }, 'Ativar som')), false, 15000);
    }
  });
  room.on(E.MediaDevicesError, (e) => micError(e));
}

// quem está falando mudou: só liga e desliga o destaque nos avatares (antes refazia a barra lateral inteira)
function onSpeakersChanged(speakers) {
  V.speaking = new Set(speakers.map((s) => s.identity));
  $$('.tile').forEach((t) => t.classList.toggle('speaking', V.speaking.has(t.dataset.pid)));
  $$('#channel-list .vp[data-uid]').forEach((el) => {
    const uid = el.dataset.uid;
    const on = (V.channelId === Number(el.dataset.from) && V.speaking.has(uid)) || (Number(uid) === S.me.id && V.meSpeaking);
    el.querySelector('.avatar')?.classList.toggle('speaking', on);
  });
  renderDmCall();
}

function setVoiceStatus(text, bad = false) {
  const s = $('#voice-status');
  s.textContent = text;
  s.classList.toggle('bad', bad);
}

async function leaveVoice(silent = false) {
  musicOpen = false;
  const room = V.room;
  V.room = null;
  const wasIn = V.channelId;
  V.channelId = null;
  V.speaking.clear();
  V.videoEls.clear();
  clearTimeout(V.pttTimer);
  V.micTrack = null;
  V.micProc = null;
  V.meSpeaking = false;
  $('#voice-bar').hidden = true;
  $('#audio-sink').innerHTML = '';
  renderMusic(); syncPlayer();
  if (room) { try { await room.disconnect(); } catch {} }
  if (wasIn) act('voice_leave').catch(() => {});
  if (!silent) SND.leave();
  if (S.view === 'voice') { if (S.current) openChannel(S.current); else if (S.mode === 'home') showFriends(); else goServer(S.serverId); }
  renderChannels();
  updateVoiceButtons();
}

function syncVoiceState() {
  updateVoiceButtons();
  if (!V.room) return;
  const lp = V.room.localParticipant;
  act('voice_state', {
    muted: !micShouldBeOpen(), deafened: V.deafened,
    video: lp.isCameraEnabled,       // câmera desligada continua publicada, só pausada
    screen: lp.isScreenShareEnabled,
  }).catch(() => {});
}

function updateVoiceButtons() {
  const lp = V.room?.localParticipant;
  const cam = !!lp?.isCameraEnabled;
  const scr = !!lp?.isScreenShareEnabled;
  $('#btn-cam').classList.toggle('on', cam);
  $('#btn-screen').classList.toggle('on', scr);
  $('#btn-cam').title = cam ? 'Desligar câmera' : 'Ligar câmera';
  $('#btn-screen').title = scr ? 'Parar de compartilhar' : 'Compartilhar tela';
  $('#btn-stage').classList.toggle('on', S.view === 'voice');
  $('#st-cam').className = 'round-btn' + (cam ? ' on' : '');
  $('#st-screen').className = 'round-btn' + (scr ? ' on' : '');
  renderMe();
}

async function toggleMute() {
  if (V.deafened) { V.deafened = false; applyVolumes(); }
  V.muted = !V.muted;
  (V.muted ? SND.mute : SND.unmute)();
  await updateMic();
  renderMe();
}
async function toggleDeafen() {
  V.deafened = !V.deafened;
  (V.deafened ? SND.mute : SND.unmute)();
  applyVolumes();
  applyMusicVolume(); // desligar o áudio também cala a música
  await updateMic();
  renderMe();
}

// ---------- Microfone (captura + processamento) ----------
function captureOptions() {
  return {
    deviceId: prefs.mic || undefined,
    echoCancellation: A().echo,
    autoGainControl: A().agc,
    noiseSuppression: A().ns === 'padrao', // a supressão "forte" é feita pelo DiscordIA (RNNoise)
    channelCount: 1,
  };
}
function processorSettings() {
  return {
    inputVolume: A().inputVolume / 100,
    rnnoise: A().ns === 'forte',
    gate: !prefs.ptt, // no apertar para falar a tecla decide, não a sensibilidade
    autoSens: A().autoSens,
    threshold: A().threshold,
  };
}
function micShouldBeOpen() { return !!V.room && !V.muted && !V.deafened && !V.serverMod?.mute && !V.serverMod?.deaf && (!prefs.ptt || V.pttHeld); }

function onMicLevel(m) {
  const speaking = !!(m.open && micShouldBeOpen() && m.db > -70);
  if (speaking !== V.meSpeaking && V.room) {
    V.meSpeaking = speaking;
    const me = V.room.localParticipant.identity;
    $$(`.tile[data-pid="${me}"]`).forEach((t) => t.classList.toggle('speaking', speaking || V.speaking.has(me)));
    $$(`.vp[data-uid="${me}"] .avatar`).forEach((a) => a.classList.toggle('speaking', speaking || V.speaking.has(me)));
  }
  for (const fn of V.levelListeners) fn(m);
}

// prepara o microfone (captura + supressão de ruído) sem esperar a conexão
async function prepareMic() {
  const L = LK();
  let track;
  try { track = await L.createLocalAudioTrack(captureOptions()); }
  catch (e) { micError(e); return null; }
  await track.mute(); // entra mudo até tudo estar pronto
  const proc = new MicProcessor(processorSettings());
  proc.onLevel = onMicLevel;
  proc.onError = () => { toast('A supressão de ruído forte falhou neste aparelho. Usando a padrão.', true, 7000); A().ns = 'padrao'; savePrefs(); applyAudioSettings(true); };
  // a parte demorada (carregar a supressão de ruído) já vai sendo feita; ligar de fato só depois de publicar
  await proc.ensureContext().catch((e) => console.warn('pré-carga do processamento falhou', e));
  return { track, proc };
}
async function publishMic(room, ready) {
  const L = LK();
  const m = await (ready || prepareMic()).catch(() => null);
  if (!m) return;
  if (V.room !== room) { m.track.stop(); return; }
  await room.localParticipant.publishTrack(m.track, { source: L.Track.Source.Microphone, name: 'microfone' });
  V.micTrack = m.track;
  try { await m.track.setProcessor(m.proc); V.micProc = m.proc; } // o LiveKit só aceita o processamento depois de publicar
  catch (e) {
    console.warn('Processamento de áudio indisponível', e);
    toast('Não consegui ligar o processamento de áudio; seguindo com o áudio normal.', true, 7000);
  }
  await updateMic();
}
// token da sala guardado por alguns minutos (pedido já ao passar o mouse na sala)
const voiceTokens = new Map();
async function voiceToken(id) {
  const c = voiceTokens.get(id);
  if (c && Date.now() - c.at < 5 * 60e3) { voiceTokens.delete(id); return c; }
  return api(`/api/voice-token?channel=${id}`);
}
function prefetchVoice(id) {
  if (V.channelId === id || voiceTokens.has(id) || !LK()) return;
  api(`/api/voice-token?channel=${id}`).then((r) => voiceTokens.set(id, { ...r, at: Date.now() })).catch(() => {});
}

async function updateMic() {
  const t = V.micTrack;
  if (t) {
    try {
      if (micShouldBeOpen()) { if (t.isMuted) await t.unmute(); }
      else if (!t.isMuted) await t.mute();
    } catch (e) { micError(e); }
  }
  syncVoiceState();
  renderTiles();
}

// Aplica mudanças das configurações de áudio na chamada em andamento
let restartTimer = 0;
async function applyAudioSettings(needsRestart = false) {
  savePrefs();
  V.micProc?.update(processorSettings());
  applyVolumes();
  if (needsRestart && V.micTrack) {
    clearTimeout(restartTimer);
    restartTimer = setTimeout(() => V.micTrack?.restartTrack(captureOptions()).catch(micError), 150);
  }
}

// ---------- Volumes de quem você ouve ----------
function effectiveVolume(identity, stream = false) {
  if (V.deafened || V.serverMod?.deaf) return 0;
  const out = A().outputVolume / 100;
  if (stream) return prefs.streamMuted?.[identity] ? 0 : (prefs.streamVolumes?.[identity] ?? 1) * out; // volume da transmissão (só para você)
  if (prefs.userMuted[identity]) return 0;
  return (prefs.volumes[identity] ?? 1) * out;
}
function applyVolumes() {
  if (!V.room) return;
  const src = LK().Track.Source;
  for (const p of V.room.remoteParticipants.values()) {
    p.setVolume(effectiveVolume(p.identity), src.Microphone);
    p.setVolume(effectiveVolume(p.identity, true), src.ScreenShareAudio);
  }
}

async function toggleCam() {
  if (!V.room) return;
  const lp = V.room.localParticipant;
  if (lp.isCameraEnabled) { // desligar é direto
    await lp.setCameraEnabled(false).catch((e) => toast('Câmera: ' + e.message, true));
    syncVoiceState(); renderTiles();
    return;
  }
  const deviceId = await cameraPreview(); // ligar: primeiro mostra a prévia (evita abrir a câmera sem querer)
  if (deviceId === null || !V.room) return;
  await lp.setCameraEnabled(true, deviceId ? { deviceId } : undefined).catch((e) => toast('Câmera: ' + e.message, true));
  syncVoiceState(); renderTiles();
}
// Janela de prévia da câmera (igual à de compartilhar tela). Devolve o id da câmera escolhida, ou null se cancelar.
function cameraPreview() {
  return new Promise((resolve) => {
    let stream = null, done = false;
    const stop = () => { stream?.getTracks().forEach((tr) => tr.stop()); stream = null; };
    const finish = (v) => { if (done) return; done = true; stop(); resolve(v); };
    openModal((f) => {
      f.classList.add('mx', 'cam-modal');
      const video = h('video', { autoplay: true, muted: true, playsinline: true });
      const status = h('div', { class: 'cam-status' }, 'Abrindo a câmera…');
      const select = h('select', {});
      const go = h('button', { class: 'btn primary', disabled: true }, 'Ligar câmera');
      const start = async (id) => {
        stop();
        status.hidden = false; status.textContent = 'Abrindo a câmera…'; go.disabled = true;
        try {
          stream = await navigator.mediaDevices.getUserMedia({ video: id ? { deviceId: { exact: id } } : true, audio: false });
          if (done) return stop();
          video.srcObject = stream;
          status.hidden = true; go.disabled = false;
          const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
          const cur = stream.getVideoTracks()[0]?.getSettings().deviceId || id;
          select.innerHTML = '';
          cams.forEach((c, i) => select.append(h('option', { value: c.deviceId, selected: c.deviceId === cur }, c.label || `Câmera ${i + 1}`)));
          select.parentElement.hidden = cams.length < 2;
          prefs.camera = cur; savePrefs();
        } catch (e) {
          status.textContent = e?.name === 'NotAllowedError' ? 'Você bloqueou a câmera. Libere nas permissões do navegador/app.' : e?.name === 'NotFoundError' ? 'Não achei nenhuma câmera neste aparelho.' : 'Não consegui abrir a câmera: ' + (e?.message || e);
        }
      };
      select.onchange = () => start(select.value);
      f.append(h('div', { class: 'mx-pad' },
        modalHead('Ligar câmera', 'Confira como você está aparecendo antes de ligar para a sala.'),
        h('div', { class: 'cam-preview' }, video, status),
        h('label', { class: 'field cam-pick', hidden: true }, 'Câmera', select),
        h('div', { class: 'mx-actions' }, h('button', { type: 'button', class: 'btn', onclick: () => modal.close() }, 'Cancelar'), go)));
      f.onsubmit = (e) => { e.preventDefault(); const id = select.value || prefs.camera || ''; finish(id); modal.close(); };
      modal.addEventListener('close', () => { f.classList.remove('cam-modal'); finish(null); }, { once: true });
      start(prefs.camera || '');
    });
  });
}
// qualidade da transmissão de tela (o usuário escolhe na janela de compartilhar)
const SCREEN_Q = {
  '480p30': { label: '480p · 30 fps (leve)', width: 854, height: 480, fps: 30, bitrate: 1_200_000 },
  '720p30': { label: '720p · 30 fps (equilibrado)', width: 1280, height: 720, fps: 30, bitrate: 2_500_000 },
  '720p60': { label: '720p · 60 fps (movimento)', width: 1280, height: 720, fps: 60, bitrate: 4_000_000 },
  '1080p30': { label: '1080p · 30 fps (nítido)', width: 1920, height: 1080, fps: 30, bitrate: 4_500_000 },
  '1080p60': { label: '1080p · 60 fps (máximo)', width: 1920, height: 1080, fps: 60, bitrate: 7_000_000 },
};
function screenOpts(key) {
  const q = SCREEN_Q[key] || SCREEN_Q['720p30'];
  return {
    capture: { resolution: { width: q.width, height: q.height, frameRate: q.fps }, contentHint: q.fps >= 60 ? 'motion' : 'detail' },
    publish: { screenShareEncoding: { maxBitrate: q.bitrate, maxFramerate: q.fps }, simulcast: false },
  };
}
async function toggleScreen() {
  if (!V.room) return;
  const lp = V.room.localParticipant;
  if (!navigator.mediaDevices?.getDisplayMedia) return toast('Esse navegador não compartilha tela (no celular geralmente não dá).', true);
  if (lp.isScreenShareEnabled) { // parar é direto
    await lp.setScreenShareEnabled(false).catch(() => {});
    syncVoiceState(); renderTiles();
    return;
  }
  // som do PC sem o som do próprio app (senão quem está na chamada se ouve de volta)
  const sysAudio = { restrictOwnAudio: true, suppressLocalAudioPlayback: false, echoCancellation: false, noiseSuppression: false, autoGainControl: false };
  let audio = sysAudio, pick = null;
  if (desk?.screenSources) { // app desktop: seletor dentro da página (igual à janela da câmera)
    pick = await screenPicker();
    if (!pick || !V.room) return; // cancelou: não acontece nada
    await desk.chooseScreen(pick);
    audio = pick.audio ? sysAudio : false;
  }
  V.screenBusy = true;
  try {
    const so = screenOpts(pick?.quality || prefs.screenQuality);
    await lp.setScreenShareEnabled(true, { audio, systemAudio: 'include', selfBrowserSurface: 'exclude', ...so.capture }, so.publish);
  } catch (e) {
    const cancelled = e.name === 'NotAllowedError' || e.name === 'AbortError';
    if (!cancelled && pick && audio) {
      // esse PC não deixou pegar o som junto: tenta de novo só com a imagem (sem abrir o seletor de novo)
      try { await desk.chooseScreen({ ...pick, audio: false }); const so2 = screenOpts(pick?.quality || prefs.screenQuality); await lp.setScreenShareEnabled(true, { audio: false, selfBrowserSurface: 'exclude', ...so2.capture }, so2.publish); toast('Transmitindo sem som (esse PC não deixou pegar o som junto).'); }
      catch (e2) { toast('Não consegui transmitir a tela: ' + e2.message, true); }
    } else if (!cancelled) toast('Não consegui transmitir a tela: ' + e.message, true);
  } finally { setTimeout(() => { V.screenBusy = false; }, 1500); }
  syncVoiceState(); renderTiles();
}
// Janela "Compartilhar tela" no mesmo padrão da "Ligar câmera". Devolve { id, audio } ou null se cancelar.
function screenPicker() {
  return new Promise((resolve) => {
    let done = false, timer = 0;
    const finish = (v) => { if (done) return; done = true; clearInterval(timer); resolve(v); };
    openModal((f) => {
      f.classList.add('mx', 'cam-modal');
      let tab = 'screen', sel = null, sources = [];
      const grid = h('div', { class: 'scr-grid' }, h('div', { class: 'cam-status' }, 'Procurando telas e janelas…'));
      const audioCb = h('input', { type: 'checkbox', checked: prefs.screenAudio !== false });
      audioCb.onchange = () => { prefs.screenAudio = audioCb.checked; savePrefs(); };
      const audioRow = h('label', { class: 'scr-audio' }, audioCb, h('span', {}, 'Compartilhar o som do PC'));
      const audioNote = h('small', { class: 'hint scr-note' }, 'O som só pode ir junto quando você transmite a tela inteira.');
      const quality = h('select', { class: 'scr-quality' }, ...Object.entries(SCREEN_Q).map(([k, q]) => h('option', { value: k, selected: k === (prefs.screenQuality || '720p30') }, q.label)));
      quality.onchange = () => { prefs.screenQuality = quality.value; savePrefs(); };
      const go = h('button', { class: 'btn primary', disabled: true }, 'Compartilhar');
      const tabs = h('div', { class: 'scr-tabs' });
      const draw = () => {
        tabs.innerHTML = '';
        for (const [k, label] of [['screen', 'Telas'], ['window', 'Janelas']]) tabs.append(h('button', { type: 'button', class: 'head-tab' + (tab === k ? ' on' : ''), onclick: () => { tab = k; draw(); } }, label));
        const list = sources.filter((s) => (tab === 'screen') === s.screen);
        if (sources.length && !list.some((s) => s.id === sel)) sel = tab === 'screen' && list.length === 1 ? list[0].id : (list.some((s) => s.id === sel) ? sel : null);
        grid.innerHTML = '';
        if (sources.length && !list.length) grid.append(h('div', { class: 'cam-status' }, tab === 'screen' ? 'Nenhuma tela encontrada.' : 'Nenhuma janela aberta para compartilhar.'));
        for (const s of list) grid.append(h('button', { type: 'button', class: 'scr-src' + (s.id === sel ? ' sel' : ''), onclick: () => { sel = s.id; draw(); }, ondblclick: () => { sel = s.id; f.requestSubmit(); } },
          h('img', { src: s.thumb, alt: '' }), h('span', {}, s.icon ? h('img', { class: 'scr-ic', src: s.icon, alt: '' }) : null, s.screen && list.length === 1 ? 'Tela cheia' : s.name)));
        go.disabled = !sel;
        const isScreen = sources.find((s) => s.id === sel)?.screen ?? tab === 'screen';
        audioRow.hidden = !isScreen; audioNote.hidden = isScreen;
      };
      const load = async () => { try { sources = await desk.screenSources(); if (!done) draw(); } catch (e) { grid.innerHTML = ''; grid.append(h('div', { class: 'cam-status' }, 'Não consegui listar as telas: ' + e.message)); } };
      f.append(h('div', { class: 'mx-pad' },
        modalHead('Compartilhar tela', 'O que você quer compartilhar?'),
        tabs, grid,
        h('div', { class: 'scr-foot' }, h('div', { class: 'scr-q' }, h('span', {}, 'Qualidade da transmissão'), quality), h('div', {}, audioRow, audioNote)),
        h('div', { class: 'mx-actions' }, h('button', { type: 'button', class: 'btn', onclick: () => modal.close() }, 'Cancelar'), go)));
      draw();
      load();
      timer = setInterval(load, 3000); // miniaturas atualizadas
      f.onsubmit = (e) => { e.preventDefault(); if (!sel) return; const s = sources.find((x) => x.id === sel); finish({ id: sel, audio: !!s?.screen && audioCb.checked, quality: quality.value }); modal.close(); };
      modal.addEventListener('close', () => { f.classList.remove('cam-modal'); finish(null); }, { once: true });
    });
  });
}

// ---------- Apertar para falar ----------
// No navegador funciona com a aba em foco; no app desktop funciona até com um jogo em foco.
function pttDown() {
  if (!prefs.ptt || !V.room) return;
  clearTimeout(V.pttTimer);
  if (V.pttHeld) return;
  V.pttHeld = true;
  updateMic();
}
function pttUp() {
  if (!V.pttHeld) return;
  clearTimeout(V.pttTimer);
  // atraso ao soltar: não corta o fim da palavra
  V.pttTimer = setTimeout(() => { V.pttHeld = false; updateMic(); }, A().pttDelay);
}
const mouseCode = (b) => (b === 3 ? 'Mouse4' : b === 4 ? 'Mouse5' : null);
window.addEventListener('keydown', (e) => {
  if (globalPtt || e.code !== prefs.pttKey || e.repeat) return;
  if (e.target.matches('input, textarea, select, [contenteditable]')) return;
  pttDown();
});
window.addEventListener('keyup', (e) => { if (!globalPtt && e.code === prefs.pttKey) pttUp(); });
window.addEventListener('mousedown', (e) => { if (prefs.ptt && mouseCode(e.button) === prefs.pttKey) { e.preventDefault(); if (!globalPtt) pttDown(); } });
window.addEventListener('mouseup', (e) => { if (prefs.ptt && mouseCode(e.button) === prefs.pttKey) { e.preventDefault(); if (!globalPtt) pttUp(); } });
window.addEventListener('blur', () => { if (!globalPtt) pttUp(); });
window.addEventListener('focus', () => { markRead(); renderChannels(); });

// ---------- Ponte com o app desktop ----------
async function syncDesktop() {
  if (!desk) return;
  try { globalPtt = !!(await desk.setPtt({ enabled: !!prefs.ptt, code: prefs.pttKey })); } catch { globalPtt = false; }
}
if (desk) {
  desk.onCommand((cmd) => {
    if (cmd === 'mute') toggleMute();
    else if (cmd === 'deafen') toggleDeafen();
    else if (cmd === 'ptt-down') pttDown();
    else if (cmd === 'ptt-up') pttUp();
    else if (cmd === 'leave') leaveVoice();
  });
  syncDesktop();
}

function videoFor(track) {
  let el = V.videoEls.get(track.sid);
  if (!el) {
    el = track.attach();
    el.muted = true;
    el.playsInline = true;
    V.videoEls.set(track.sid, el);
  }
  return el;
}

// Volume de uma pessoa (0–200%) e "silenciar só para mim"
function userVolumeControl(identity, compact = false) {
  const pct = Math.round((prefs.volumes[identity] ?? 1) * 100);
  const out = h('output', {}, pct + '%');
  const range = h('input', { type: 'range', min: 0, max: 200, step: 5, value: pct, title: 'Volume dessa pessoa para você' });
  range.addEventListener('input', () => {
    prefs.volumes[identity] = Number(range.value) / 100;
    out.textContent = range.value + '%';
    applyVolumes(); savePrefs();
  });
  range.addEventListener('dblclick', () => { range.value = 100; range.dispatchEvent(new Event('input')); });
  const muted = !!prefs.userMuted[identity];
  const muteBtn = h('button', { type: 'button', class: 'icon-btn' + (muted ? ' off' : ''), title: muted ? 'Voltar a ouvir' : 'Silenciar só para mim',
    onclick: () => { prefs.userMuted[identity] = !prefs.userMuted[identity]; savePrefs(); applyVolumes(); renderTiles(); renderChannels(); } }, icon(muted ? 'head-off' : 'speaker'));
  return h('div', { class: 'vol' + (compact ? '' : ' wide') }, muteBtn, range, out);
}

function renderTiles() {
  if (S.view !== 'voice') return;
  const box = $('#tiles');
  const room = V.room;
  if (!room) { box.innerHTML = ''; box.classList.remove('focus'); box.append(h('p', { class: 'stage-hint' }, 'Conectando…')); return; }
  const src = LK().Track.Source;
  const parts = [room.localParticipant, ...room.remoteParticipants.values()];
  const used = new Set();
  const nameOf = (p) => S.users.get(Number(p.identity))?.displayName || p.name;

  // telas sendo transmitidas
  const screens = [];
  for (const p of parts) {
    const pub = p.getTrackPublication(src.ScreenShare);
    if (pub?.track && !pub.isMuted && !(p !== room.localParticipant && prefs.videoOff?.[p.identity])) screens.push({ p, track: pub.track });
  }
  const screenTile = (s, main) => {
    used.add(s.track.sid);
    const tile = h('div', { class: 'tile screen' + (main ? ' main' : ''), 'data-pid': s.p.identity, 'data-sid': s.track.sid },
      videoFor(s.track),
      h('div', { class: 'label' }, icon('screen'), s.p === room.localParticipant ? 'Sua tela (você está transmitindo)' : `Tela de ${nameOf(s.p)}`));
    const own = s.p === room.localParticipant;
    tile.addEventListener('contextmenu', (ev) => { ev.preventDefault(); voiceUserMenu(Number(s.p.identity), ev.clientX, ev.clientY); });
    // volume da transmissão de outra pessoa (só para você)
    if (!own && s.p.getTrackPublication(src.ScreenShareAudio)) {
      const id = s.p.identity;
      const pct = Math.round((prefs.streamVolumes?.[id] ?? 1) * 100);
      const out = h('output', {}, pct + '%');
      const r = h('input', { type: 'range', min: 0, max: 200, step: 5, value: pct, title: 'Volume desta transmissão (só para você)' });
      r.oninput = () => { prefs.streamVolumes[id] = Number(r.value) / 100; prefs.streamMuted[id] = false; out.textContent = r.value + '%'; savePrefs(); applyVolumes(); };
      const mutedS = !!prefs.streamMuted?.[id];
      const mb = h('button', { type: 'button', class: 'icon-btn' + (mutedS ? ' off' : ''), title: mutedS ? 'Ouvir a transmissão' : 'Silenciar a transmissão (só para você)',
        onclick: (e) => { e.stopPropagation(); prefs.streamMuted[id] = !prefs.streamMuted[id]; savePrefs(); applyVolumes(); renderTiles(); } }, icon(mutedS ? 'head-off' : 'speaker'));
      tile.append(h('div', { class: 'vol stream-vol', onclick: (e) => e.stopPropagation() }, mb, r, out));
    }
    if (main && own) { /* a própria tela: sem tela cheia (ficaria uma tela dentro da outra) */ }
    else if (main) {
      const full = () => (document.fullscreenElement ? document.exitFullscreen() : tile.requestFullscreen?.());
      tile.append(h('button', { class: 'icon-btn full', title: 'Tela cheia (ou dois cliques)', onclick: full }, icon('fullscreen')));
      tile.addEventListener('dblclick', full);
    } else {
      tile.title = 'Mostrar esta tela em destaque';
      tile.addEventListener('click', () => { V.focusSid = s.track.sid; renderTiles(); });
    }
    return tile;
  };

  // pessoas da sala (câmera ou avatar)
  const personTile = (p, compact) => {
    const local = p === room.localParticipant;
    const u = S.users.get(Number(p.identity));
    const cam = p.getTrackPublication(src.Camera);
    const mic = p.getTrackPublication(src.Microphone);
    const muted = local ? !micShouldBeOpen() : (!mic || mic.isMuted);
    const speaking = V.speaking.has(p.identity) || (local && V.meSpeaking);
    const tile = h('div', { class: 'tile person' + (speaking ? ' speaking' : ''), 'data-pid': p.identity, style: { background: tileColor(u) } });
    const camOn = cam?.track && !cam.isMuted && !(!local && prefs.videoOff?.[p.identity]);
    if (camOn) { used.add(cam.track.sid); tile.append(videoFor(cam.track)); tile.classList.add('cam'); }
    else tile.append(avatar(u || { displayName: p.name, color: '#888' }));
    const mutedForMe = !local && prefs.userMuted[p.identity];
    const vs = S.voice[V.channelId]?.[p.identity] || {};
    tile.append(h('div', { class: 'label' }, vs.smute || vs.sdeaf ? icon(vs.sdeaf ? 'head-off' : 'mic-off') : muted ? icon('mic-off') : null, mutedForMe ? icon('head-off') : null, nameOf(p) + (local ? ' (você)' : '')));
    // clique: perfil; botão direito: opções (volume, silenciar, mover, desconectar…)
    tile.addEventListener('click', () => profileCard(Number(p.identity), tile));
    tile.addEventListener('contextmenu', (ev) => { ev.preventDefault(); voiceUserMenu(Number(p.identity), ev.clientX, ev.clientY); });
    void compact;
    return tile;
  };

  if (!screens.length) {
    box.innerHTML = '';
    box.classList.remove('focus');
    for (const p of parts) box.append(personTile(p, false));
    requestAnimationFrame(layoutTiles);
  } else {
    // modo transmissão: tela em destaque no meio, todo mundo em miniatura embaixo
    const focused = screens.find((s) => s.track.sid === V.focusSid) || screens[0];
    V.focusSid = focused.track.sid;
    const strip = h('div', { class: 'stage-strip' });
    for (const s of screens) if (s !== focused) strip.append(screenTile(s, false));
    for (const p of parts) strip.append(personTile(p, true));
    // A tela em destaque NÃO é recriada se continua a mesma: recriar tiraria quem está em tela cheia
    const mainTile = $('.stage-main > .tile', box);
    if (box.classList.contains('focus') && mainTile?.dataset.sid === focused.track.sid) {
      used.add(focused.track.sid);
      const oldStrip = $('.stage-strip', box);
      if (oldStrip) oldStrip.replaceWith(strip); else box.append(strip);
    } else {
      box.innerHTML = '';
      box.classList.add('focus');
      box.append(h('div', { class: 'stage-main' }, screenTile(focused, true)), strip);
    }
  }
  for (const sid of [...V.videoEls.keys()]) if (!used.has(sid)) V.videoEls.delete(sid);
  updateVoiceButtons();
}

$('#btn-mute').addEventListener('click', toggleMute);
$('#st-mute').addEventListener('click', toggleMute);
$('#st-deafen').addEventListener('click', toggleDeafen);
$('#btn-deafen').addEventListener('click', toggleDeafen);
$('#btn-leave').addEventListener('click', () => leaveVoice());
$('#st-leave').addEventListener('click', () => leaveVoice());
$('#btn-cam').addEventListener('click', toggleCam);
$('#st-cam').addEventListener('click', toggleCam);
$('#btn-screen').addEventListener('click', toggleScreen);
$('#st-screen').addEventListener('click', toggleScreen);
$('#voice-where').addEventListener('click', showVoiceView);
$('#btn-stage').addEventListener('click', () => (S.view === 'voice' ? openChannel(S.current) : showVoiceView()));
$('#btn-voice-settings').addEventListener('click', () => settingsModal('voz'));
$('#btn-ns').addEventListener('click', () => {
  A().ns = A().ns === 'forte' ? 'padrao' : 'forte';
  applyAudioSettings(true);
  renderMe();
  toast(A().ns === 'forte' ? 'Supressão de ruído forte ligada.' : 'Supressão de ruído forte desligada (usando a padrão).');
});
$('#mic-menu').addEventListener('click', (e) => deviceMenu(e.currentTarget, 'audioinput'));
$('#spk-menu').addEventListener('click', (e) => deviceMenu(e.currentTarget, 'audiooutput'));
$('#me-id').addEventListener('click', () => settingsModal('conta'));
window.addEventListener('beforeunload', () => { if (V.room) navigator.sendBeacon?.('/api/action', new Blob([JSON.stringify({ type: 'voice_leave' })], { type: 'text/plain' })); });

// ---------- Modais ----------
const modal = $('#modal');
function openModal(build) {
  const f = $('#modal-form');
  f.innerHTML = '';
  f.onsubmit = null;
  build(f);
  modal.showModal();
}
modal.addEventListener('close', () => modal.dispatchEvent(new Event('closed')));
function confirmModal(title, text, okLabel = 'Confirmar') {
  return new Promise((resolve) => {
    openModal((f) => {
      f.append(h('h3', {}, title), h('p', {}, text),
        h('div', { class: 'row' }, h('button', { class: 'btn', value: 'no' }, 'Cancelar'), h('button', { class: 'btn danger', value: 'ok' }, okLabel)));
    });
    modal.addEventListener('close', () => resolve(modal.returnValue === 'ok'), { once: true });
  });
}

async function deleteChannel(c) {
  if (!(await confirmModal(`Apagar ${c.type === 'text' ? '#' : ''}${c.name}?`, c.type === 'text' ? 'Todas as mensagens desse canal serão apagadas pra sempre.' : 'Quem estiver na sala vai ser desconectado.', 'Apagar canal'))) return;
  act('channel_delete', { channelId: c.id }).catch((e) => toast(e.message, true));
}

const KEY_LABEL = (code) => ({ Mouse4: 'Mouse lateral 1', Mouse5: 'Mouse lateral 2', Backquote: '`', Space: 'Espaço', ControlLeft: 'Ctrl', ControlRight: 'Ctrl direito', AltLeft: 'Alt', AltRight: 'Alt Gr', ShiftLeft: 'Shift', ShiftRight: 'Shift direito', CapsLock: 'Caps Lock' }[code] || code.replace(/^Key/, '').replace(/^Digit/, '').replace(/^Numpad/, 'Num '));
// Janelinha de volume ao clicar em alguém na sala de voz (barra lateral)
function userPopover(anchor, identity, u) {
  $('.popover')?.remove();
  const r = anchor.getBoundingClientRect();
  const pop = h('div', { class: 'popover', style: { left: Math.min(r.left, innerWidth - 280) + 'px', top: r.bottom + 6 + 'px' } },
    h('b', {}, u?.displayName || 'Volume'), userVolumeControl(identity));
  document.body.append(pop);
  const close = (ev) => { if (!pop.contains(ev.target) && ev.target !== anchor) { pop.remove(); document.removeEventListener('mousedown', close, true); } };
  setTimeout(() => document.addEventListener('mousedown', close, true), 0);
}

function settingsModal(startTab = 'voz') {
  let test = null; // teste de microfone fora da chamada
  let loopEl = null;
  const stopTest = () => {
    V.levelListeners.delete(onLevel);
    if (loopEl) { loopEl.pause(); loopEl.srcObject = null; loopEl = null; }
    if (test) { test.proc?.destroy(); test.stream?.getTracks().forEach((x) => x.stop()); test = null; }
  };

  // ---- medidor ----
  const fill = h('i'), mark = h('span', { class: 'mark' });
  const meter = h('div', { class: 'meter big' }, fill, mark);
  const meterInfo = h('small', { class: 'hint' }, 'Clique em "Testar microfone" e fale.');
  function onLevel(m) {
    fill.style.width = dbToPct(m.db) + '%';
    fill.classList.toggle('open', !!m.open);
    if (!prefs.ptt) { mark.hidden = false; mark.style.left = dbToPct(A().autoSens ? m.threshold : A().threshold) + '%'; }
    else mark.hidden = true;
  }

  openModal((f) => {
    f.classList.add('settings');
    const panels = {};
    const tabsNav = h('div', { class: 'tabs settings-tabs', role: 'tablist' });
    const show = (k) => {
      for (const [key, el] of Object.entries(panels)) el.hidden = key !== k;
      $$('.settings-tabs .tab', f).forEach((b) => b.classList.toggle('active', b.dataset.k === k));
    };
    for (const [k, label] of [['voz', 'Voz e áudio'], ['conta', 'Minha conta'], ['avisos', 'Notificações']]) {
      tabsNav.append(h('button', { type: 'button', class: 'tab', 'data-k': k, onclick: () => show(k) }, label));
    }

    // ================= VOZ E ÁUDIO =================
    const micSel = h('select'), spkSel = h('select');
    const fillDevices = async () => {
      const devs = (await navigator.mediaDevices?.enumerateDevices?.().catch(() => [])) || [];
      micSel.innerHTML = ''; spkSel.innerHTML = '';
      micSel.append(h('option', { value: '' }, 'Padrão do sistema'));
      spkSel.append(h('option', { value: '' }, 'Padrão do sistema'));
      for (const d of devs) {
        if (d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications') micSel.append(h('option', { value: d.deviceId, selected: d.deviceId === prefs.mic }, d.label || 'Microfone'));
        if (d.kind === 'audiooutput' && d.deviceId !== 'default' && d.deviceId !== 'communications') spkSel.append(h('option', { value: d.deviceId, selected: d.deviceId === prefs.speaker }, d.label || 'Saída de áudio'));
      }
    };
    fillDevices();
    micSel.onchange = async () => {
      prefs.mic = micSel.value; savePrefs();
      if (V.room) V.room.switchActiveDevice('audioinput', prefs.mic || 'default').catch(micError);
      if (test) { stopTest(); await startTest(); }
    };
    spkSel.onchange = () => {
      prefs.speaker = spkSel.value; savePrefs();
      if (V.room) V.room.switchActiveDevice('audiooutput', prefs.speaker || 'default').catch(() => {});
      if (loopEl?.setSinkId) loopEl.setSinkId(prefs.speaker || '').catch(() => {});
    };

    const slider = (label, key, min, max, step, fmt, onChange) => {
      const out = h('output', {}, fmt(A()[key]));
      const r = h('input', { type: 'range', min, max, step, value: A()[key] });
      r.addEventListener('input', () => { A()[key] = Number(r.value); out.textContent = fmt(A()[key]); onChange?.(); });
      return h('label', { class: 'field slider' }, h('span', { class: 'slider-head' }, label, out), r);
    };
    const live = () => { applyAudioSettings(false); test?.proc?.update(processorSettings()); };
    const liveRestart = async () => {
      applyAudioSettings(true);
      if (test) { stopTest(); await startTest(); }
    };

    const testBtn = h('button', { type: 'button', class: 'btn' }, 'Testar microfone');
    const listen = h('input', { type: 'checkbox' });
    async function startTest() {
      V.levelListeners.add(onLevel);
      let track;
      if (V.micProc && V.room) {
        track = V.micProc.processedTrack;
        meterInfo.textContent = 'Você está numa sala: o medidor mostra o que os outros ouvem.';
      } else {
        const o = captureOptions();
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { ...o, deviceId: o.deviceId ? { exact: o.deviceId } : undefined } });
        const proc = new MicProcessor(processorSettings());
        proc.onLevel = (m) => onLevel(m);
        await proc.init({ track: stream.getAudioTracks()[0] });
        test = { stream, proc };
        track = proc.processedTrack;
        fillDevices();
        meterInfo.textContent = prefs.ptt ? 'No apertar para falar a sensibilidade não é usada.' : 'A marca branca é a sensibilidade: acima dela a sua voz passa.';
      }
      if (listen.checked && track) {
        loopEl = new Audio();
        loopEl.srcObject = new MediaStream([track]);
        if (prefs.speaker && loopEl.setSinkId) loopEl.setSinkId(prefs.speaker).catch(() => {});
        loopEl.play().catch(() => {});
      }
      testBtn.textContent = 'Parar teste';
    }
    testBtn.onclick = async () => {
      if (testBtn.textContent === 'Parar teste') { stopTest(); testBtn.textContent = 'Testar microfone'; fill.style.width = '0'; return; }
      try { await startTest(); } catch (e) { stopTest(); micError(e); }
    };
    listen.onchange = async () => { if (testBtn.textContent === 'Parar teste') { stopTest(); await startTest(); } };

    // modo de entrada
    const modeVoz = h('input', { type: 'radio', name: 'modo', checked: !prefs.ptt });
    const modePtt = h('input', { type: 'radio', name: 'modo', checked: prefs.ptt });
    const vozBox = h('div', { class: 'sub' }), pttBox = h('div', { class: 'sub' });
    const autoSens = h('input', { type: 'checkbox', checked: A().autoSens });
    const manual = slider('Sensibilidade manual', 'threshold', -80, 0, 1, (v) => v + ' dB', live);
    manual.hidden = A().autoSens;
    autoSens.onchange = () => { A().autoSens = autoSens.checked; manual.hidden = autoSens.checked; live(); };
    vozBox.append(h('label', { class: 'check' }, autoSens, 'Sensibilidade automática'), manual,
      h('small', { class: 'hint' }, 'Abaixo da sensibilidade o microfone fica fechado, então ruído baixo e respiração não vão para a sala.'));

    let pttKey = prefs.pttKey;
    const keyBtn = h('button', { type: 'button', class: 'btn' }, h('span', { class: 'kbd' }, KEY_LABEL(pttKey)), '  trocar tecla');
    keyBtn.onclick = () => {
      keyBtn.textContent = 'Aperte uma tecla ou um botão lateral do mouse…';
      const done = async (code) => {
        pttKey = code; prefs.pttKey = code; savePrefs(); await syncDesktop();
        keyBtn.innerHTML = '';
        keyBtn.append(h('span', { class: 'kbd' }, KEY_LABEL(pttKey)), '  trocar tecla');
        window.removeEventListener('keydown', onKey, true);
        window.removeEventListener('mousedown', onMouse, true);
      };
      const onKey = (e) => { e.preventDefault(); e.stopPropagation(); done(e.code === 'Escape' ? pttKey : e.code); };
      const onMouse = (e) => { const c = mouseCode(e.button); if (c) { e.preventDefault(); done(c); } };
      setTimeout(() => { window.addEventListener('keydown', onKey, true); window.addEventListener('mousedown', onMouse, true); }, 0);
    };
    pttBox.append(h('div', { class: 'field' }, 'Tecla'), h('div', { style: { marginBottom: '12px' } }, keyBtn),
      slider('Atraso ao soltar', 'pttDelay', 0, 1000, 20, (v) => v + ' ms'),
      h('small', { class: 'hint' }, desk
        ? (globalPtt ? 'App para Windows: a tecla funciona até com um jogo em foco.' : 'App para Windows.')
        : 'No navegador só funciona com a aba do DiscordIA em foco. No app para Windows funciona até dentro de jogos.'));
    const syncMode = async () => {
      vozBox.hidden = prefs.ptt; pttBox.hidden = !prefs.ptt;
      mark.hidden = prefs.ptt;
    };
    const setMode = async (ptt) => {
      prefs.ptt = ptt; V.pttHeld = false; savePrefs();
      await syncDesktop(); live(); syncMode(); await updateMic();
      if (ptt) toast(`Apertar para falar: segure ${KEY_LABEL(prefs.pttKey)} para falar.`);
    };
    modeVoz.onchange = () => setMode(false);
    modePtt.onchange = () => setMode(true);
    syncMode();

    // processamento
    const nsOpt = (val, title, desc) => {
      const r = h('input', { type: 'radio', name: 'ns', value: val, checked: A().ns === val });
      r.onchange = () => { A().ns = val; liveRestart(); };
      return h('label', { class: 'choice' }, r, h('span', {}, h('b', {}, title), h('small', {}, desc)));
    };
    const echo = h('input', { type: 'checkbox', checked: A().echo });
    echo.onchange = () => { A().echo = echo.checked; liveRestart(); };
    const agc = h('input', { type: 'checkbox', checked: A().agc });
    agc.onchange = () => { A().agc = agc.checked; liveRestart(); };
    const quality = h('select', {}, ...[[32, 'Econômica (32 kbps)'], [64, 'Padrão (64 kbps)'], [96, 'Alta (96 kbps)'], [128, 'Máxima (128 kbps)']]
      .map(([v, l]) => h('option', { value: v, selected: A().quality === v }, l)));
    quality.onchange = () => { A().quality = Number(quality.value); savePrefs(); if (V.room) toast('A nova qualidade vale a partir da próxima vez que você entrar numa sala.'); };

    const resetBtn = h('button', { type: 'button', class: 'btn' }, 'Restaurar padrões de áudio');
    resetBtn.onclick = async () => { prefs.audio = { ...AUDIO_DEFAULTS }; prefs.ptt = false; savePrefs(); stopTest(); await syncDesktop(); applyAudioSettings(true); modal.close(); settingsModal('voz'); };
    const download = !desk && S.desktopDownload ? h('a', { class: 'btn', href: S.desktopDownload, download: '', style: { textDecoration: 'none' } }, '⬇ Baixar app para Windows') : null;

    panels.voz = h('div', { class: 'panel' },
      h('div', { class: 'grid2' }, h('label', { class: 'field' }, 'Microfone', micSel), h('label', { class: 'field' }, 'Saída de áudio', spkSel)),
      h('div', { class: 'grid2' },
        slider('Volume do microfone', 'inputVolume', 0, 200, 5, (v) => v + '%', live),
        slider('Volume de saída', 'outputVolume', 0, 200, 5, (v) => v + '%', live)),
      h('div', { class: 'test-row' }, testBtn, h('label', { class: 'check inline' }, listen, 'Ouvir minha voz (use fone)')),
      meter, meterInfo,
      h('h4', {}, 'Modo de entrada'),
      h('div', { class: 'radio-row' }, h('label', {}, modeVoz, 'Detecção de voz'), h('label', {}, modePtt, 'Apertar para falar')),
      vozBox, pttBox,
      h('h4', {}, 'Supressão de ruído'),
      h('div', { class: 'choices' },
        nsOpt('forte', 'Forte (IA)', 'Remove ventilador, teclado, cachorro, trânsito. Recomendado.'),
        nsOpt('padrao', 'Padrão', 'A do navegador. Mais leve, remove só ruído constante.'),
        nsOpt('off', 'Desligada', 'Áudio puro. Para microfone de estúdio ou música.')),
      h('h4', {}, 'Processamento de voz'),
      h('label', { class: 'check' }, echo, 'Cancelamento de eco (deixe ligado se usa caixa de som)'),
      h('label', { class: 'check' }, agc, 'Controle automático de ganho (nivela o volume da sua voz)'),
      h('label', { class: 'field' }, 'Qualidade do áudio', quality),
      h('div', { class: 'row', style: { justifyContent: 'space-between' } }, resetBtn, download),
    );

    // ================= CONTA =================
    const me = S.me;
    let color = me.color;
    const name = h('input', { value: me.displayName, maxlength: 32 });
    const sw = h('div', { class: 'swatches' });
    const COLORS = ['#ff8a3d', '#3ddc97', '#5aa9ff', '#ff5d8f', '#c792ff', '#ffd23f', '#4dd4e6', '#ff6b4a', '#9be15d', '#f78fb3'];
    const drawSw = () => { sw.innerHTML = ''; for (const c of COLORS) sw.append(h('button', { type: 'button', class: 'swatch' + (c === color ? ' sel' : ''), style: { background: c }, onclick: () => { color = c; drawSw(); } })); };
    drawSw();
    const curPw = h('input', { type: 'password', autocomplete: 'current-password' });
    const newPw = h('input', { type: 'password', autocomplete: 'new-password', minlength: 6 });
    const err = h('p', { class: 'form-error' });
    // foto e banner (salvam na hora)
    const prev = h('div', { class: 'pf-preview' });
    const drawPrev = () => { prev.innerHTML = ''; const u = S.users.get(me.id) || me; prev.append(bannerEl(u), h('div', { class: 'pf-avatar' }, avatar(u, 'xl'))); };
    drawPrev();
    const saveImg = async (patch) => { try { await act('profile', { displayName: name.value, color, ...patch }); Object.assign(S.users.get(me.id) || {}, patch); Object.assign(S.me, patch); drawPrev(); renderAll(); rerenderMessages(); } catch (x) { toast(x.message, true); } };
    const bannerColor = h('input', { type: 'color', value: me.banner?.startsWith('#') ? me.banner : me.color, title: 'Cor do banner' });
    bannerColor.onchange = () => saveImg({ banner: bannerColor.value });
    panels.conta = h('div', { class: 'panel' },
      prev,
      h('div', { class: 'pf-edit' },
        h('div', {}, h('b', {}, 'Foto de perfil'), h('div', { class: 'row-btns' },
          h('button', { type: 'button', class: 'btn primary', onclick: async () => { const url = await uploadImage(256, 256, 'avatar'); if (url) saveImg({ avatar: url }); } }, 'Trocar foto'),
          h('button', { type: 'button', class: 'btn', onclick: () => saveImg({ avatar: null }) }, 'Remover'))),
        h('div', {}, h('b', {}, 'Banner'), h('div', { class: 'row-btns' },
          h('button', { type: 'button', class: 'btn primary', onclick: async () => { const url = await uploadImage(960, 340, 'banner'); if (url) saveImg({ banner: url }); } }, 'Enviar imagem'),
          h('label', { class: 'btn color-btn' }, bannerColor, 'Cor'),
          h('button', { type: 'button', class: 'btn', onclick: () => saveImg({ banner: null }) }, 'Remover')))),
      h('label', { class: 'field' }, 'Nome que aparece', name),
      h('div', { class: 'field' }, 'Cor'), sw,
      h('h4', {}, 'Trocar senha (opcional)'),
      h('label', { class: 'field' }, 'Senha atual', curPw),
      h('label', { class: 'field' }, 'Senha nova', newPw),
      err,
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn danger', style: { marginRight: 'auto' }, onclick: async () => { await leaveVoice(true); await api('/api/logout', {}); location.reload(); } }, 'Sair da conta'),
        h('button', { class: 'btn primary' }, 'Salvar')));

    // ================= NOTIFICAÇÕES =================
    const sounds = h('input', { type: 'checkbox', checked: prefs.sounds });
    sounds.onchange = () => { prefs.sounds = sounds.checked; savePrefs(); };
    const notif = h('select', {},
      h('option', { value: 'all', selected: prefs.notify === 'all' }, 'Todas as mensagens'),
      h('option', { value: 'mentions', selected: prefs.notify === 'mentions' }, 'Só quando me marcarem (@)'),
      h('option', { value: 'none', selected: prefs.notify === 'none' }, 'Nenhuma'));
    notif.onchange = () => {
      prefs.notify = notif.value; savePrefs();
      if (notif.value !== 'none' && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission();
    };
    panels.avisos = h('div', { class: 'panel' },
      h('label', { class: 'check' }, sounds, 'Sons (mensagens, entrar e sair da voz, mudo)'),
      h('label', { class: 'field' }, 'Notificações com a janela fora de foco', notif),
      desk ? h('small', { class: 'hint' }, 'Atalhos em qualquer lugar: Ctrl+Shift+M silencia o microfone, Ctrl+Shift+D desliga o áudio.') : null);

    f.append(
      h('div', { class: 'settings-head' }, h('h3', {}, 'Configurações'), h('button', { type: 'button', class: 'icon-btn', title: 'Fechar', onclick: () => modal.close() }, icon('x'))),
      tabsNav, panels.voz, panels.conta, panels.avisos);
    show(startTab);

    f.onsubmit = async (e) => {
      e.preventDefault();
      try {
        await act('profile', { displayName: name.value, color, currentPassword: curPw.value, newPassword: newPw.value });
        curPw.value = ''; newPw.value = ''; err.textContent = '';
        toast('Conta atualizada.');
      } catch (x) { err.textContent = x.message; }
    };
  });
  modal.addEventListener('close', () => { stopTest(); $('#modal-form').classList.remove('settings'); }, { once: true });
}

$('#btn-settings').addEventListener('click', () => settingsModal('voz'));

$('#btn-invite').addEventListener('click', inviteModal);
$('#btn-music').addEventListener('click', () => (musicOpen ? closeMusic() : openMusic()));
$('#rail-home').addEventListener('click', goHome);
$('#rail-add').addEventListener('click', createServerModal);
$('#btn-find').addEventListener('click', findModal);
$('#btn-dm-call').addEventListener('click', () => { const ch = channelById(S.current); if (ch?.dm) startCall(ch.dm); });
$('#btn-dm-video').addEventListener('click', () => { const ch = channelById(S.current); if (ch?.dm) startCall(ch.dm, true); });
$('#btn-profile').addEventListener('click', () => { prefs.hideProfile = !prefs.hideProfile; savePrefs(); renderProfilePanel(); renderHeader(); });
$('#btn-members').addEventListener('click', () => {
  if (matchMedia('(max-width: 1000px)').matches) $('#app').classList.toggle('show-members');
  else { prefs.hideMembers = !prefs.hideMembers; savePrefs(); $('#app').classList.toggle('hide-members', prefs.hideMembers); }
});
$('#btn-menu').addEventListener('click', () => $('#app').classList.add('nav-open'));
$('#scrim').addEventListener('click', () => $('#app').classList.remove('nav-open'));
document.addEventListener('click', (e) => { const sp = e.target.closest('.spoiler'); if (sp) sp.classList.add('open'); });

// ---------- Barra de título (igual ao Discord) e voltar/avançar ----------
if (desk?.titleBar) $('#app').classList.add('desktop-frame');
// ---------- Nome do servidor (o administrador pode trocar quando quiser) ----------
function renderServerName() {
  $('#server-name-text').textContent = S.serverName;
  $('#server-name').classList.toggle('admin', !!S.me?.isAdmin);
  const hi = $('#server-head-icon'); if (hi) { hi.innerHTML = ''; hi.append(serverIcon(curServer())); }
  if ($('#voice-where') && V.channelId && !isDm(V.channelId)) $('#voice-where').textContent = `${channelById(V.channelId)?.name || ''} / ${serverName(channelById(V.channelId)?.server_id)}`;
  renderTitlebar();
}
// ---------- Menu do servidor (clicar no nome lá em cima, igual ao Discord) ----------
function serverMenu() {
  const btn = $('#server-name');
  if ($('.server-menu')) { closePopovers(); btn.classList.remove('open'); return; }
  closePopovers();
  const admin = S.me.isAdmin;
  const item = (label, ic, fn) => h('button', { type: 'button', class: 'menu-item', onclick: () => { pop.remove(); btn.classList.remove('open'); fn(); } }, h('span', {}, label), icon(ic));
  const sep = () => h('div', { class: 'menu-sep' });
  const pop = h('div', { class: 'popover menu ctx server-menu' },
    admin ? item('Convidar para o servidor', 'user-plus', inviteModal) : null,
    admin ? item('Config. do servidor', 'gear', serverSettingsModal) : null,
    admin ? item('Criar canal', 'plus-circle', () => channelModal({})) : null,
    admin ? item('Criar categoria', 'folder-plus', () => categoryModal()) : null,
    admin ? sep() : null,
    item('Config. de notificação', 'bell', notifModal),
    admin ? sep() : null,
    admin ? h('button', { type: 'button', class: 'menu-item danger', onclick: () => { pop.remove(); btn.classList.remove('open');
      if (S.servers.length <= 1) return toast('Esse é o único servidor. Crie outro antes de excluir este.', true);
      deleteServerFlow(); } }, h('span', {}, 'Excluir servidor'), icon('trash')) : null);
  const r = btn.getBoundingClientRect();
  placePopover(pop, r.left, r.bottom + 6);
  pop.style.width = Math.max(240, r.width) + 'px';
  btn.classList.add('open');
  const obs = new MutationObserver(() => { if (!pop.isConnected) { btn.classList.remove('open'); obs.disconnect(); } });
  obs.observe(pop.parentNode, { childList: true });
}

// cabeçalho padrão das janelas novas (título + X)
const modalHead = (title, sub) => h('div', { class: 'mx-head' },
  h('div', {}, h('h3', {}, title), sub ? h('p', {}, sub) : null),
  h('button', { type: 'button', class: 'icon-btn', title: 'Fechar', onclick: () => modal.close() }, icon('x')));
const switchEl = (checked, onchange) => { const i = h('input', { type: 'checkbox', checked }); i.onchange = () => onchange(i.checked); return h('label', { class: 'switch' }, i, h('span', {})); };
const withModalClass = (f, cls) => { f.classList.add(cls); modal.addEventListener('close', () => f.classList.remove(cls), { once: true }); };

// ---- Convidar para o servidor
const inviteUrl = () => `${location.origin}/?convite=${encodeURIComponent(S.invite || '')}`;
function inviteExpiryText() {
  const inf = S.inviteInfo || {};
  let t = inf.expiresAt ? `Seu link de convite expira ${new Date(inf.expiresAt).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).replace(',', ' às')}` : 'Seu link de convite nunca expira';
  if (inf.maxUses) t += ` e vale para ${inf.maxUses} ${inf.maxUses === 1 ? 'pessoa' : 'pessoas'} (${inf.uses || 0} já usaram)`;
  return t + '.';
}
function inviteModal() {
  openModal((f) => {
    withModalClass(f, 'mx');
    const firstText = srvChannels().find((c) => c.type === 'text');
    const search = h('input', { type: 'search', placeholder: 'Buscar amigos', autocomplete: 'off' });
    const list = h('div', { class: 'mx-list' });
    const sent = new Set();
    const draw = () => {
      list.innerHTML = '';
      const q2 = semAcento(search.value.trim());
      const friends = [...S.users.values()].filter((u) => u.id !== S.me.id && !u.deleted && friendState(u.id) === 'friend')
        .filter((u) => !q2 || semAcento(u.displayName).includes(q2) || semAcento(u.username).includes(q2))
        .sort((a, b) => a.displayName.localeCompare(b.displayName));
      if (!friends.length) list.append(h('p', { class: 'hint', style: { padding: '14px 4px' } }, q2 ? 'Ninguém encontrado.' : 'Você ainda não adicionou amigos. Use o link abaixo para chamar alguém.'));
      for (const u of friends) {
        const b = h('button', { type: 'button', class: 'btn mx-invite' + (sent.has(u.id) ? ' done' : ''), disabled: sent.has(u.id) }, sent.has(u.id) ? 'Enviado' : 'Convidar');
        b.onclick = async () => {
          b.disabled = true;
          try {
            const { id } = await act('dm_open', { userId: u.id });
            await act('send', { channelId: id, content: `Bora entrar no **${S.serverName}**! ${inviteUrl()}` });
            sent.add(u.id); b.textContent = 'Enviado'; b.classList.add('done');
          } catch (e) { b.disabled = false; toast(e.message, true); }
        };
        list.append(h('div', { class: 'mx-row' }, avatar(u, ''), h('span', { class: 'fwd-names' }, h('b', {}, u.displayName), h('small', {}, u.username)), b));
      }
    };
    search.oninput = draw;
    draw();
    const link = h('input', { readonly: true, value: inviteUrl(), onfocus: (e) => e.target.select() });
    const copy = h('button', { type: 'button', class: 'btn primary' }, 'Copiar');
    copy.onclick = () => { navigator.clipboard?.writeText(link.value); copy.textContent = 'Copiado'; copy.classList.add('ok'); setTimeout(() => { copy.textContent = 'Copiar'; copy.classList.remove('ok'); }, 1500); };
    f.append(
      h('div', { class: 'mx-top' }, modalHead(`Convidar amigos para ${S.serverName}`, firstText ? h('span', {}, 'Os destinatários chegarão em ', h('b', { class: 'mx-chan' }, '# ', firstText.name)) : null),
        h('label', { class: 'fwd-search' }, icon('search'), search)),
      list,
      h('div', { class: 'mx-bottom' },
        h('b', {}, 'Ou, envie um convite do servidor a um amigo'),
        h('div', { class: 'mx-link' }, link, copy),
        h('p', { class: 'mx-foot' }, inviteExpiryText(), ' ', h('button', { type: 'button', class: 'link-btn', onclick: inviteSettingsModal }, 'Editar link de convite.'))));
    setTimeout(() => search.focus(), 0);
  });
}
function inviteSettingsModal() {
  openModal((f) => {
    withModalClass(f, 'mx');
    const EXP = [[30 * 60e3, '30 minutos'], [3600e3, '1 hora'], [6 * 3600e3, '6 horas'], [12 * 3600e3, '12 horas'], [864e5, '1 dia'], [7 * 864e5, '7 dias'], [30 * 864e5, '30 dias'], [0, 'Nunca']];
    const USES = [[0, 'Sem limite'], [1, '1 uso'], [5, '5 usos'], [10, '10 usos'], [25, '25 usos'], [50, '50 usos'], [100, '100 usos']];
    const exp = h('select', {}, ...EXP.map(([v, l]) => h('option', { value: v, selected: v === 0 }, l)));
    const uses = h('select', {}, ...USES.map(([v, l]) => h('option', { value: v, selected: v === (S.inviteInfo?.maxUses || 0) }, l)));
    f.append(h('div', { class: 'mx-pad' }, modalHead('Configurações do link de convite', 'Ao gerar um link novo, o link antigo para de funcionar.'),
      h('label', { class: 'field' }, 'Expirar após', exp),
      h('label', { class: 'field' }, 'Número máximo de usos', uses),
      h('div', { class: 'mx-actions' }, h('button', { type: 'button', class: 'btn', onclick: inviteModal }, 'Cancelar'), h('button', { class: 'btn primary' }, 'Gerar um novo link'))));
    f.onsubmit = async (e) => {
      e.preventDefault();
      try {
        const r = await act('invite_regen', { serverId: S.serverId, expiresIn: Number(exp.value), maxUses: Number(uses.value) });
        if (curServer()) curServer().invite = r.inviteInfo;
        toast('Link novo gerado. O antigo não vale mais.');
        inviteModal();
      } catch (x) { toast(x.message, true); }
    };
  });
}

// ---- Escolher quem pode ver (canal ou categoria privada)
function memberPicker(selected) {
  const box = h('div', { class: 'mx-members' });
  const others = [...S.users.values()].filter((u) => !u.isAdmin && isMember(u)).sort((a, b) => a.displayName.localeCompare(b.displayName));
  box.append(h('p', { class: 'hint' }, 'Quem pode ver? Administradores sempre veem tudo.'));
  if (!others.length) box.append(h('p', { class: 'hint' }, 'Ainda não tem mais ninguém no servidor.'));
  for (const u of others) {
    const cb = h('input', { type: 'checkbox', checked: selected.has(u.id) });
    cb.onchange = () => (cb.checked ? selected.add(u.id) : selected.delete(u.id));
    box.append(h('label', { class: 'fwd-row' }, avatar(u, 'sm'), h('span', { class: 'fwd-names' }, h('b', {}, u.displayName), h('small', {}, u.username)), cb));
  }
  return box;
}
function emojiInput(input) {
  return h('button', { type: 'button', class: 'icon-btn', title: 'Emoji', onclick: (ev) => emojiPicker(ev.currentTarget, (e) => { input.value += e; input.dispatchEvent(new Event('input')); input.focus(); }) }, icon('smile'));
}

// ---- Criar / editar canal
function channelModal({ categoryId = null, existing = null, type = 'text' } = {}) {
  openModal((f) => {
    withModalClass(f, 'mx');
    let kind = existing?.type || type;
    let priv = !!existing?.private;
    const members = new Set(existing?.members || []);
    const name = h('input', { maxlength: 40, placeholder: 'novo-canal', value: existing?.name || '', autocomplete: 'off' });
    const pre = h('span', { class: 'mx-pre' }, icon(kind === 'text' ? 'hash' : 'speaker'));
    const go = h('button', { class: 'btn primary', disabled: !existing?.name }, existing ? 'Salvar' : 'Criar canal');
    const err = h('p', { class: 'form-error' });
    const membersBox = h('div', {});
    const drawMembers = () => { membersBox.innerHTML = ''; if (priv) membersBox.append(memberPicker(members)); };
    name.oninput = () => { if (kind === 'text') { const p = name.selectionStart; name.value = name.value.toLowerCase().replace(/\s/g, '-'); name.setSelectionRange(p, p); } go.disabled = !name.value.trim(); };
    const typeOpt = (k, ic, label, desc) => {
      const r = h('input', { type: 'radio', name: 'kind', checked: kind === k });
      r.onchange = () => { kind = k; pre.innerHTML = ''; pre.append(icon(ic)); name.placeholder = k === 'text' ? 'novo-canal' : 'Nova sala'; name.dispatchEvent(new Event('input')); };
      return h('label', { class: 'mx-type' }, r, h('span', { class: 'mx-type-txt' }, h('b', {}, icon(ic), label), h('small', {}, desc)));
    };
    const cat = categoryId && S.categories.find((c) => c.id === categoryId);
    f.append(h('div', { class: 'mx-pad' },
      modalHead(existing ? 'Editar canal' : 'Criar canal', cat ? `em ${cat.name}` : null),
      existing ? null : h('div', { class: 'mx-sec' }, h('h5', {}, 'Tipo de canal'),
        typeOpt('text', 'hash', 'Texto', 'Envie mensagens, imagens, GIFs, emojis, opiniões e piadas'),
        typeOpt('voice', 'speaker', 'Voz', 'Passe tempo com a turma com voz, vídeo e compartilhamento de tela')),
      h('div', { class: 'mx-sec' }, h('h5', {}, 'Nome do canal'), h('div', { class: 'mx-input' }, pre, name, emojiInput(name))),
      h('div', { class: 'mx-sec mx-switch-row' },
        h('div', {}, h('b', {}, icon('lock'), 'Canal privado'), h('small', {}, 'Somente membros selecionados poderão visualizar esse canal.')),
        switchEl(priv, (v) => { priv = v; drawMembers(); })),
      membersBox, err,
      h('div', { class: 'mx-actions' }, h('button', { type: 'button', class: 'btn', onclick: () => modal.close() }, 'Cancelar'), go)));
    drawMembers();
    f.onsubmit = async (e) => {
      e.preventDefault();
      if (!name.value.trim()) return;
      try {
        if (existing) await act('channel_update', { channelId: existing.id, name: name.value, private: priv, members: [...members] });
        else {
          const r = await act('channel_create', { serverId: S.serverId, name: name.value, channelType: kind, categoryId, private: priv, members: [...members] });
          modal.close();
          if (kind === 'text' && r?.id) setTimeout(() => channelById(r.id) && openChannel(r.id), 300);
          return;
        }
        modal.close();
      } catch (x) { err.textContent = x.message; }
    };
    setTimeout(() => name.focus(), 0);
  });
}

// ---- Criar / editar categoria
function categoryModal(existing = null) {
  openModal((f) => {
    withModalClass(f, 'mx');
    let priv = !!existing?.private;
    const members = new Set(existing?.members || []);
    const name = h('input', { maxlength: 40, placeholder: 'Nova Categoria', value: existing?.name || '', autocomplete: 'off' });
    const go = h('button', { class: 'btn primary', disabled: !existing?.name }, existing ? 'Salvar' : 'Criar categoria');
    const err = h('p', { class: 'form-error' });
    const membersBox = h('div', {});
    const drawMembers = () => { membersBox.innerHTML = ''; if (priv) membersBox.append(memberPicker(members)); };
    name.oninput = () => { go.disabled = !name.value.trim(); };
    f.append(h('div', { class: 'mx-pad' },
      modalHead(existing ? 'Editar categoria' : 'Criar categoria'),
      h('div', { class: 'mx-sec' }, h('h5', {}, 'Nome da categoria'), h('div', { class: 'mx-input' }, name, emojiInput(name))),
      h('div', { class: 'mx-sec mx-switch-row' },
        h('div', {}, h('b', {}, icon('lock'), 'Categoria privada'), h('small', {}, 'Ao tornar uma categoria privada, somente membros selecionados poderão visualizar essa categoria. Canais vinculados a esta categoria seguirão esta configuração automaticamente.')),
        switchEl(priv, (v) => { priv = v; drawMembers(); })),
      membersBox, err,
      h('div', { class: 'mx-actions' }, h('button', { type: 'button', class: 'btn', onclick: () => modal.close() }, 'Cancelar'), go)));
    drawMembers();
    f.onsubmit = async (e) => {
      e.preventDefault();
      if (!name.value.trim()) return;
      try {
        if (existing) await act('category_update', { categoryId: existing.id, name: name.value, private: priv, members: [...members] });
        else await act('category_create', { serverId: S.serverId, name: name.value, private: priv, members: [...members] });
        modal.close();
      } catch (x) { err.textContent = x.message; }
    };
    setTimeout(() => name.focus(), 0);
  });
}
async function deleteCategory(cat) {
  if (!(await confirmModal(`Apagar a categoria ${cat.name}?`, 'Os canais dela não são apagados: eles só ficam sem categoria, no topo da lista.', 'Apagar categoria'))) return;
  act('category_delete', { categoryId: cat.id }).catch((e) => toast(e.message, true));
}
function categoryMenu(cat, x, y) {
  closePopovers();
  const item = (label, fn, cls = '') => h('button', { type: 'button', class: 'menu-item ' + cls, onclick: () => { pop.remove(); fn(); } }, h('span', {}, label));
  const collapsed = !!prefs.collapsed?.[cat.id];
  const pop = h('div', { class: 'popover menu ctx' },
    item(collapsed ? 'Expandir categoria' : 'Recolher categoria', () => toggleCategory(cat.id)),
    item('Config. de notificação', () => notifModal()),
    S.me.isAdmin ? h('div', { class: 'menu-sep' }) : null,
    S.me.isAdmin ? item('Criar canal', () => channelModal({ categoryId: cat.id })) : null,
    S.me.isAdmin ? item('Editar categoria', () => categoryModal(cat)) : null,
    S.me.isAdmin ? item('Apagar categoria', () => deleteCategory(cat), 'danger') : null);
  placePopover(pop, x, y);
}
// ---- Arrastar canais entre categorias (e mudar a ordem) — só o administrador
let drag = null; // { kind: 'chan' | 'cat', id }
const chanList = $('#channel-list');
function clearDropMarks() { $$('.drop-before, .drop-after, .drop-into', chanList).forEach((el) => el.classList.remove('drop-before', 'drop-after', 'drop-into')); }
function dropTarget(e) {
  const row = e.target.closest?.('.chan[data-cid], .cat[data-cat]');
  if (!row || !drag) return null;
  // pessoa arrastada: só pode cair em outra sala de voz
  if (drag.kind === 'user') {
    const ch = row.dataset.cid && channelById(row.dataset.cid);
    return ch?.type === 'voice' && ch.id !== drag.from ? { row, into: true, channelId: ch.id } : null;
  }
  const r = row.getBoundingClientRect();
  const after = e.clientY > r.top + r.height / 2;
  if (drag.kind === 'chan') {
    if (row.dataset.cid) return Number(row.dataset.cid) === drag.id ? null : { row, place: after ? 'after' : 'before', targetId: Number(row.dataset.cid) };
    return { row, place: 'start', categoryId: Number(row.dataset.cat), into: true }; // solta em cima do nome da categoria
  }
  if (row.dataset.cat && Number(row.dataset.cat) !== drag.id) return { row, place: after ? 'after' : 'before', targetId: Number(row.dataset.cat) };
  return null;
}
chanList.addEventListener('dragstart', (e) => {
  const el = e.target.closest?.('[draggable="true"]');
  if (!el) return;
  if (el.dataset.uid) drag = { kind: 'user', id: Number(el.dataset.uid), from: Number(el.dataset.from) }; // qualquer um pode mover pessoas
  else if (!S.me?.isAdmin) return;
  else drag = el.dataset.cid ? { kind: 'chan', id: Number(el.dataset.cid) } : { kind: 'cat', id: Number(el.dataset.cat) };
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', '');
  setTimeout(() => el.classList.add('dragging'), 0);
});
chanList.addEventListener('dragover', (e) => {
  const t = dropTarget(e);
  clearDropMarks();
  if (!t) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  t.row.classList.add(t.into ? 'drop-into' : t.place === 'after' ? 'drop-after' : 'drop-before');
});
chanList.addEventListener('dragleave', (e) => { if (!chanList.contains(e.relatedTarget)) clearDropMarks(); });
chanList.addEventListener('drop', async (e) => {
  const t = dropTarget(e);
  const d = drag;
  clearDropMarks();
  if (!t || !d) return;
  e.preventDefault();
  try {
    if (d.kind === 'user') {
      if (d.id === S.me.id) await joinVoice(t.channelId);
      else { await act('voice_move', { userId: d.id, channelId: t.channelId }); toast(`${userName(d.id)} foi movido(a) para ${channelById(t.channelId)?.name}.`); }
    } else if (d.kind === 'chan') {
      if (t.categoryId && prefs.collapsed?.[t.categoryId]) toggleCategory(t.categoryId); // abre a categoria onde soltou
      await act('channel_move', { channelId: d.id, targetId: t.targetId, categoryId: t.categoryId, place: t.place });
    } else await act('category_move', { categoryId: d.id, targetId: t.targetId, place: t.place });
  } catch (x) { toast(x.message, true); }
});
chanList.addEventListener('dragend', () => { drag = null; clearDropMarks(); $$('.dragging', chanList).forEach((el) => el.classList.remove('dragging')); });

function toggleCategory(id) {
  prefs.collapsed ||= {};
  if (prefs.collapsed[id]) delete prefs.collapsed[id]; else prefs.collapsed[id] = true;
  savePrefs();
  renderChannels();
}

// ---- Config. do servidor (por enquanto só o nome)
function serverSettingsModal() {
  openModal((f) => {
    withModalClass(f, 'mx');
    const name = h('input', { maxlength: 40, required: true, value: S.serverName });
    const err = h('p', { class: 'form-error' });
    const pic = h('div', { class: 'srv-pic' });
    const drawPic = () => { pic.innerHTML = ''; pic.append(serverIcon(curServer())); };
    drawPic();
    const setIcon = async (icon) => { try { await act('server_icon', { serverId: S.serverId, icon }); if (curServer()) curServer().icon = icon; drawPic(); renderAll(); } catch (x) { toast(x.message, true); } };
    f.append(h('div', { class: 'mx-pad' }, modalHead('Config. do servidor'),
      h('div', { class: 'mx-sec' }, h('h5', {}, 'Imagem do servidor'),
        h('div', { class: 'srv-pic-row' }, pic,
          h('div', { class: 'srv-pic-acts' },
            h('small', { class: 'hint' }, 'Aparece na barra de servidores, em cima da lista de canais e no topo da janela. Recomendado: imagem quadrada.'),
            h('div', { class: 'row-btns' },
              h('button', { type: 'button', class: 'btn primary', onclick: async () => { const url = await uploadImage(256, 256, 'servidor'); if (url) setIcon(url); } }, 'Enviar imagem'),
              h('button', { type: 'button', class: 'btn', onclick: () => setIcon(null) }, 'Remover'),
              h('button', { type: 'button', class: 'btn', title: 'Usar a abóbora do DiscordIA', onclick: () => setIcon('app') }, 'Ícone do app'))))),
      h('div', { class: 'mx-sec' }, h('h5', {}, 'Nome do servidor'), h('div', { class: 'mx-input' }, name, emojiInput(name)),
        h('small', { class: 'hint', style: { marginTop: '6px' } }, 'Todo mundo vê esse nome em cima da lista de canais. O app continua se chamando DiscordIA.')),
      err,
      h('div', { class: 'mx-actions' }, h('button', { type: 'button', class: 'btn', onclick: () => modal.close() }, 'Cancelar'), h('button', { class: 'btn primary' }, 'Salvar')),
      S.servers.length > 1 ? h('div', { class: 'mx-danger' }, h('div', {}, h('b', {}, 'Excluir servidor'), h('small', {}, 'Apaga o servidor com todos os canais e mensagens. Não dá para desfazer.')),
        h('button', { type: 'button', class: 'btn danger', onclick: deleteServerFlow }, 'Excluir servidor')) : null));
    f.onsubmit = async (e) => {
      e.preventDefault();
      try { await act('server_rename', { serverId: S.serverId, name: name.value }); modal.close(); toast('Nome do servidor alterado.'); }
      catch (x) { err.textContent = x.message === 'Ação desconhecida.' ? 'O servidor está desatualizado: feche a janela do DiscordIA.bat e abra de novo.' : x.message; }
    };
    setTimeout(() => { name.focus(); name.select(); }, 0);
  });
}

async function deleteServerFlow() {
  const s = curServer();
  if (!s || !(await confirmModal(`Excluir o servidor ${s.name}?`, 'Todos os canais, categorias e mensagens desse servidor serão apagados pra sempre, para todo mundo.', 'Excluir servidor'))) return;
  try { await act('server_delete', { serverId: s.id }); toast(`Servidor ${s.name} excluído.`); } catch (e) { toast(e.message, true); }
}
// ---- Editar perfil por servidor (vazio por enquanto)
function serverProfileModal() {
  openModal((f) => {
    withModalClass(f, 'mx');
    f.append(h('div', { class: 'mx-pad' }, modalHead('Editar perfil por servidor'),
      h('div', { class: 'mx-empty' }, 'Nada aqui por enquanto.'),
      h('div', { class: 'mx-actions' }, h('button', { type: 'button', class: 'btn primary', onclick: () => modal.close() }, 'Fechar'))));
  });
}

// ---------- Notificações do servidor (cada pessoa tem as suas, salvas no servidor) ----------
const NOTIF_DEFAULT = { muted: false, muteUntil: 0, level: 'all', suppressEveryone: false, overrides: {} };
// cada servidor tem as suas configurações: S.notif = { servers: { [id]: {...} } } (o formato antigo vale para todos)
const notifRaw = (sid) => (S.notif?.servers ? S.notif.servers[sid] : S.notif) || {};
const notifCfg = (sid = S.serverId) => { const r = notifRaw(sid); return { ...NOTIF_DEFAULT, ...r, overrides: { ...(r.overrides || {}) } }; };
const activeMute = (o) => !!o?.muted && (!o.muteUntil || Date.now() < o.muteUntil);
function serverMuted(sid = S.serverId) { return activeMute(notifCfg(sid)); }
// override de um canal ou da categoria dele: chave "c<id>" ou "k<id>"
function chanOverride(cid) {
  const c = channelById(cid);
  const n = notifCfg(c?.server_id);
  return { chan: n.overrides['c' + cid], cat: c?.category_id ? n.overrides['k' + c.category_id] : null };
}
function chanMuted(cid) {
  if (isDm(cid)) return false;
  const o = chanOverride(cid);
  return activeMute(o.chan) || activeMute(o.cat) || serverMuted(channelById(cid)?.server_id);
}
function chanLevel(cid) {
  if (isDm(cid)) return 'all';
  const o = chanOverride(cid);
  return o.chan?.level || o.cat?.level || notifCfg(channelById(cid)?.server_id).level || 'all';
}
// decide se uma mensagem nova toca som / avisa
function shouldAlert(m, mention) {
  if (isDm(m.channelId)) return true;
  const n = notifCfg(channelById(m.channelId)?.server_id);
  if (mention && n.suppressEveryone && !new RegExp(`@${S.me.username}\\b`, 'i').test(m.content || '') && !(m.reply && m.reply.userId === S.me.id)) mention = false;
  const level = chanLevel(m.channelId);
  if (level === 'none') return false;
  if (chanMuted(m.channelId)) return mention; // silenciado: só quando te mencionam
  return level === 'all' || mention;
}
async function saveNotif(n) {
  const all = S.notif?.servers ? { ...S.notif.servers } : Object.fromEntries(S.servers.map((s) => [s.id, S.notif || {}]));
  all[S.serverId] = n;
  S.notif = { servers: all };
  n = S.notif;
  renderChannels();
  try { await act('notif_set', { notif: n }); } catch (e) { toast(e.message, true); }
}
function notifModal() {
  openModal((f) => {
    withModalClass(f, 'mx');
    const n = notifCfg();
    const body = h('div', { class: 'mx-scroll' });
    const DUR = [[15 * 60e3, 'Por 15 minutos'], [3600e3, 'Por 1 hora'], [3 * 3600e3, 'Por 3 horas'], [8 * 3600e3, 'Por 8 horas'], [24 * 3600e3, 'Por 24 horas'], [0, 'Até eu ligá-las de novo']];
    const draw = () => {
      body.innerHTML = '';
      const muted = activeMute(n);
      const dur = h('select', {}, ...DUR.map(([v, l]) => h('option', { value: v, selected: (n.muteDur ?? 0) === v }, l)));
      dur.onchange = () => { n.muteDur = Number(dur.value); n.muteUntil = n.muteDur ? Date.now() + n.muteDur : 0; };
      body.append(
        h('div', { class: 'mx-switch-row' },
          h('div', {}, h('b', {}, `Silenciar ${S.serverName}`), h('small', {}, 'Silenciar um servidor evita que indicadores de leitura e notificações apareçam, exceto se você for mencionado(a).')),
          switchEl(muted, (v) => { n.muted = v; n.muteDur = n.muteDur ?? 0; n.muteUntil = v && n.muteDur ? Date.now() + n.muteDur : 0; draw(); })),
        muted ? h('div', { class: 'mx-sec' }, h('h5', {}, 'Duração do silêncio'), dur,
          n.muteUntil ? h('small', { class: 'hint', style: { marginTop: '6px' } }, `Silenciado até ${new Date(n.muteUntil).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}.`) : null) : null,
        h('hr'),
        h('h4', {}, 'Configurações de notificação do servidor'),
        h('div', { class: 'mx-radios' + (muted ? ' dim' : '') }, ...[['all', 'Todas as mensagens'], ['mentions', h('span', {}, 'Apenas ', h('b', {}, '@menções'))], ['none', 'Nada']].map(([v, l]) => {
          const r = h('input', { type: 'radio', name: 'lvl', checked: n.level === v });
          r.onchange = () => { n.level = v; };
          return h('label', { class: 'mx-radio' }, r, h('span', {}, l));
        })),
        h('hr'),
        h('div', { class: 'mx-switch-row' }, h('div', {}, h('b', {}, 'Silenciar @todos e @everyone'), h('small', {}, 'Avisos para todo mundo não contam como menção para você.')),
          switchEl(!!n.suppressEveryone, (v) => { n.suppressEveryone = v; })),
        h('hr'),
        overridesBox(n, draw));
    };
    draw();
    f.append(h('div', { class: 'mx-top' }, modalHead('Config. de notificação')), body,
      h('div', { class: 'mx-bottom' }, h('button', { class: 'btn primary mx-full' }, 'Pronto')));
    f.onsubmit = (e) => { e.preventDefault(); saveNotif(n); modal.close(); };
  });
}
// "Selecione um canal ou categoria…" + tabela Todos / Menções / Nada / Silenciar
function overridesBox(n, redraw) {
  const box = h('div', { class: 'mx-sec' }, h('b', {}, 'Selecione um canal ou categoria…'), h('small', { class: 'hint' }, 'Adicione um canal para substituir as configurações de notificação padrão'));
  const sel = h('select', {}, h('option', { value: '' }, 'Selecione um canal ou categoria…'),
    ...S.categories.filter((k) => !n.overrides['k' + k.id]).map((k) => h('option', { value: 'k' + k.id }, `Categoria · ${k.name}`)),
    ...srvChannels().filter((c) => !n.overrides['c' + c.id]).map((c) => h('option', { value: 'c' + c.id }, c.type === 'text' ? `# ${c.name}` : `Voz · ${c.name}`)));
  sel.onchange = () => { if (sel.value) { n.overrides[sel.value] = { level: n.level || 'all', muted: false }; redraw(); } };
  box.append(sel);
  const keys = Object.keys(n.overrides).filter((k) => (k[0] === 'c' ? srvChannels().some((c) => 'c' + c.id === k) : S.categories.some((c) => 'k' + c.id === k)));
  const table = h('div', { class: 'ov-table' }, h('div', { class: 'ov-row ov-head' }, h('span', {}, 'Canal ou categoria'), h('span', {}, 'Todos'), h('span', {}, 'Menções'), h('span', {}, 'Nada'), h('span', {}, 'Silenciar'), h('span', {})));
  for (const k of keys) {
    const o = n.overrides[k];
    const label = k[0] === 'c' ? (() => { const c = S.channels.find((x) => 'c' + x.id === k); return [h('span', { class: 'ic-inline' }, icon(c.type === 'text' ? 'hash' : 'speaker')), c.name]; })() : [h('span', { class: 'ic-inline' }, icon('folder')), S.categories.find((x) => 'k' + x.id === k).name];
    const radio = (v) => { const r = h('input', { type: 'radio', name: 'ov-' + k, checked: (o.level || 'all') === v }); r.onchange = () => { o.level = v; }; return h('span', {}, r); };
    const mute = h('input', { type: 'checkbox', checked: !!o.muted }); mute.onchange = () => { o.muted = mute.checked; o.muteUntil = 0; };
    table.append(h('div', { class: 'ov-row' }, h('span', { class: 'ov-name' }, label), radio('all'), radio('mentions'), radio('none'), h('span', {}, mute),
      h('button', { type: 'button', class: 'icon-btn', title: 'Remover', onclick: () => { delete n.overrides[k]; redraw(); } }, icon('x'))));
  }
  if (keys.length) box.append(table);
  return box;
}

$('#server-name').addEventListener('click', serverMenu);

function renderTitlebar() {
  const box = $('#tb-title');
  if (!box || !S.me) return;
  box.innerHTML = '';
  const dmCh = (S.view === 'chat' && isDm(S.current) && channelById(S.current)) || (S.view === 'voice' && isDm(V.channelId) && channelById(V.channelId));
  if (dmCh) box.append(avatar(S.users.get(dmCh.dm), 'xs'), h('span', {}, dmCh.name));
  else if (S.mode === 'home') box.append(icon('users'), h('span', {}, 'Amigos'));
  else box.append(serverIcon(curServer(), 'tb'), h('span', {}, S.serverName));
  $('#nav-back').disabled = S.histPos <= 0;
  $('#nav-fwd').disabled = S.histPos >= S.hist.length - 1;
}
S.hist = []; S.histPos = -1; S.histBusy = false;
function pushHist(entry) {
  if (S.histBusy) return;
  const cur = S.hist[S.histPos];
  if (cur && cur.t === entry.t && cur.id === entry.id) return;
  S.hist = S.hist.slice(0, S.histPos + 1);
  S.hist.push(entry);
  if (S.hist.length > 100) S.hist.shift();
  S.histPos = S.hist.length - 1;
  renderTitlebar();
}
async function goHist(step) {
  let pos = S.histPos + step;
  // pula lugares que não existem mais (canal apagado, conversa fechada)
  while (pos >= 0 && pos < S.hist.length && S.hist[pos].t === 'chan' && !channelById(S.hist[pos].id)) pos += step;
  if (pos < 0 || pos >= S.hist.length) return;
  S.histPos = pos;
  const e = S.hist[pos];
  S.histBusy = true;
  try { if (e.t === 'friends') showFriends(); else await openChannel(e.id); } finally { S.histBusy = false; }
  renderTitlebar();
}
$('#nav-back').addEventListener('click', () => goHist(-1));
$('#nav-fwd').addEventListener('click', () => goHist(1));
addEventListener('keydown', (e) => {
  if (e.altKey && !e.ctrlKey && !e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { e.preventDefault(); goHist(e.key === 'ArrowLeft' ? -1 : 1); }
});

// ---------- Busca de mensagens (igual ao Discord) ----------
const searchInput = $('#search-input');
const SEARCH_KEYS = {
  de: 'de', from: 'de', em: 'em', in: 'em', tem: 'tem', has: 'tem', menciona: 'menciona', mentions: 'menciona',
  antes: 'antes', before: 'antes', depois: 'depois', after: 'depois', durante: 'durante', during: 'durante',
};
const HAS_OPTS = [['link', 'link'], ['arquivo', 'arquivo'], ['imagem', 'imagem'], ['video', 'vídeo'], ['audio', 'áudio'], ['encaminhada', 'encaminhada']];
const searchScope = () => (S.view === 'chat' && isDm(S.current) ? String(S.current) : 'server:' + S.serverId);
function updateSearchPlaceholder() {
  const ch = S.view === 'chat' && isDm(S.current) ? channelById(S.current) : null;
  searchInput.placeholder = ch ? `Buscar @${ch.name}` : `Buscar ${S.serverName}`;
  $('#search-wrap').hidden = S.view === 'friends';
}
// "dd/mm/aaaa", "dd/mm", "hoje", "ontem" → início do dia
function parseDay(s) {
  s = semAcento(s);
  const d = new Date(); d.setHours(0, 0, 0, 0);
  if (s === 'hoje') return d.getTime();
  if (s === 'ontem') return d.getTime() - 864e5;
  const m = s.match(/^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?$/);
  if (!m) return null;
  const y = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : d.getFullYear();
  const t = new Date(y, Number(m[2]) - 1, Number(m[1])).getTime();
  return Number.isNaN(t) ? null : t;
}
const findUser = (v) => { const n = semAcento(v.replace(/^@/, '')); return [...S.users.values()].find((u) => semAcento(u.username) === n) || [...S.users.values()].find((u) => semAcento(u.displayName) === n); };
const findChan = (v) => { const n = semAcento(v.replace(/^#/, '')); return srvChannels().find((c) => c.type === 'text' && semAcento(c.name) === n); };
// separa o texto dos filtros; aceita aspas: de:"Ana Clara"
function parseSearch(raw) {
  const out = { words: [], from: [], in: [], has: [], mentions: [], before: 0, after: 0, bad: [] };
  const re = /(\S+?):(?:"([^"]+)"|(\S+))|"([^"]+)"|(\S+)/g;
  let m;
  while ((m = re.exec(raw))) {
    const key = m[1] && SEARCH_KEYS[semAcento(m[1])];
    if (m[1] && !key) { out.words.push(m[0]); continue; }
    if (!key) { out.words.push(m[4] || m[5]); continue; }
    const v = m[2] || m[3];
    if (key === 'de' || key === 'menciona') { const u = findUser(v); if (u) out[key === 'de' ? 'from' : 'mentions'].push(u.id); else out.bad.push(`Não achei ninguém chamado “${v}”.`); }
    else if (key === 'em') { const c = findChan(v); if (c) out.in.push(c.id); else out.bad.push(`Não achei o canal “${v}”.`); }
    else if (key === 'tem') { const k = HAS_OPTS.find(([id, label]) => semAcento(v) === id || semAcento(v) === semAcento(label)); if (k) out.has.push(k[0]); else out.bad.push(`“tem:” aceita link, arquivo, imagem, vídeo, áudio ou encaminhada.`); }
    else {
      const t = parseDay(v);
      if (t === null) { out.bad.push(`Data inválida “${v}”. Use dd/mm/aaaa, hoje ou ontem.`); continue; }
      if (key === 'antes') out.before = t;
      else if (key === 'depois') out.after = t + 864e5;
      else { out.after = t; out.before = t + 864e5; }
    }
  }
  return out;
}

S.search = null; // { raw, parsed, scope, sort, results, total, loading }
async function runSearch(more = false) {
  const st = S.search;
  if (!st) return;
  const p = st.parsed;
  const [scope, sid] = st.scope.split(':');
  const qs = new URLSearchParams({ q: p.words.join(' '), scope, sort: st.sort, offset: more ? st.results.length : 0 });
  if (sid) qs.set('server', sid);
  if (p.from.length) qs.set('from', p.from.join(','));
  if (p.in.length) qs.set('in', p.in.join(','));
  if (p.mentions.length) qs.set('mentions', p.mentions.join(','));
  if (p.has.length) qs.set('has', p.has.join(','));
  if (p.before) qs.set('before', p.before);
  if (p.after) qs.set('after', p.after);
  st.loading = true;
  if (!more) { st.results = []; st.total = null; }
  renderSearchPanel();
  try {
    const r = await api('/api/search?' + qs);
    if (S.search !== st) return;
    st.total = r.total;
    st.results = more ? st.results.concat(r.results) : r.results;
  } catch (e) { if (S.search === st) st.error = e.message; }
  st.loading = false;
  if (S.search === st) renderSearchPanel();
}
function startSearch(raw) {
  raw = raw.trim();
  closeSearchMenu();
  if (!raw) return closeSearch();
  const parsed = parseSearch(raw);
  if (!parsed.words.length && !parsed.from.length && !parsed.in.length && !parsed.has.length && !parsed.mentions.length && !parsed.before && !parsed.after) {
    if (parsed.bad.length) toast(parsed.bad[0], true);
    return;
  }
  S.search = { raw, parsed, scope: searchScope(), sort: S.search?.sort || 'new', results: [], total: null };
  $('#app').classList.add('searching');
  $('#search-panel').hidden = false;
  $('#search-clear').hidden = false;
  runSearch();
}
function closeSearch() {
  S.search = null;
  $('#app').classList.remove('searching');
  $('#search-panel').hidden = true;
  $('#search-panel').innerHTML = '';
  $('#search-clear').hidden = !searchInput.value;
}
// destaca as palavras buscadas (sem ligar para acento e maiúscula)
const ACC = { a: '[aáàâãä]', e: '[eéèêë]', i: '[iíìîï]', o: '[oóòôõö]', u: '[uúùûü]', c: '[cç]', n: '[nñ]' };
function highlight(el, words) {
  if (!words.length) return;
  const pat = words.map((w) => [...semAcento(w)].map((ch) => ACC[ch] || ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('')).join('|');
  const re = new RegExp(`(${pat})`, 'gi');
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const n of nodes) {
    if (!re.test(n.nodeValue)) continue;
    re.lastIndex = 0;
    const frag = document.createDocumentFragment();
    n.nodeValue.split(re).forEach((part, i) => frag.append(i % 2 ? h('mark', { class: 'hit' }, part) : document.createTextNode(part)));
    n.replaceWith(frag);
  }
}
function searchResultEl(m, words) {
  const u = S.users.get(m.userId);
  const ch = channelById(m.channelId);
  const when = `${new Date(m.createdAt).toLocaleDateString('pt-BR')} ${fmtTime(m.createdAt)}`;
  const body = h('div', { class: 'sr-body' });
  if (m.forward) {
    const f = h('div', { class: 'forward sr-fwd' }, h('div', { class: 'fwd-head' }, icon('forward'), h('i', {}, 'Encaminhada')));
    if (m.forward.content) f.append(h('div', { class: 'body', html: md(m.forward.content) }));
    if (m.forward.attachment) f.append(h('div', { class: 'sr-file' }, h('span', { class: 'ic-inline' }, icon('clip')), m.forward.attachment.name));
    body.append(f);
  }
  if (m.content) body.append(h('div', { class: 'body', html: md(m.content) }));
  if (m.attachment) {
    if (m.attachment.type?.startsWith('image/')) body.append(h('img', { class: 'sr-img', src: m.attachment.url, alt: m.attachment.name, loading: 'lazy' }));
    else body.append(h('div', { class: 'sr-file' }, h('span', { class: 'ic-inline' }, icon('clip')), m.attachment.name));
  }
  highlight(body, words);
  const card = h('div', { class: 'sr-card', onclick: () => jumpToResult(m) },
    avatar(u, 'lg'),
    h('div', { class: 'sr-main' },
      h('div', { class: 'sr-meta' }, h('b', { style: { color: u?.color } }, u?.displayName || 'alguém'), h('time', {}, when)),
      body),
    h('button', { class: 'sr-jump', onclick: (e) => { e.stopPropagation(); jumpToResult(m); } }, 'Pular'));
  return h('div', { class: 'sr-item' }, h('div', { class: 'sr-chan' }, ch?.dm ? icon('chat') : icon('hash'), h('span', {}, ch?.dm ? ch.name : ch?.name || '')), card);
}
async function jumpToResult(m) {
  if (matchMedia('(max-width: 760px)').matches) closeSearch();
  await jumpTo(m.channelId, m.id);
}
function renderSearchPanel() {
  const st = S.search;
  const panel = $('#search-panel');
  if (!st) return;
  panel.innerHTML = '';
  const tab = (id, label) => h('button', { class: 'sr-sort' + (st.sort === id ? ' on' : ''), onclick: () => { if (st.sort !== id) { st.sort = id; runSearch(); } } }, label);
  const count = st.total === null ? 'Buscando…' : st.total === 0 ? 'Nenhum resultado' : `${st.total} ${st.total === 1 ? 'resultado' : 'resultados'}`;
  panel.append(h('div', { class: 'sr-head' },
    h('div', { class: 'sr-top' }, h('b', {}, count), h('button', { class: 'icon-btn', title: 'Fechar busca', onclick: () => { searchInput.value = ''; closeSearch(); } }, icon('x'))),
    h('div', { class: 'sr-sorts' }, tab('new', 'Mais recentes'), tab('old', 'Mais antigos'))));
  const list = h('div', { class: 'sr-list' });
  if (st.parsed.bad.length) list.append(h('p', { class: 'sr-warn' }, st.parsed.bad.join(' ')));
  if (st.error) list.append(h('p', { class: 'sr-warn' }, st.error));
  for (const m of st.results) list.append(searchResultEl(m, st.parsed.words));
  if (st.loading && !st.results.length) list.append(h('div', { class: 'sr-empty' }, h('div', { class: 'spinner' }), 'Procurando mensagens…'));
  else if (st.total === 0) list.append(h('div', { class: 'sr-empty' }, h('div', { class: 'sr-big' }, icon('search')), h('b', {}, 'Nada por aqui'), h('span', {}, 'Nenhuma mensagem combina com essa busca. Tente outras palavras ou tire algum filtro.')));
  if (st.total && st.results.length < st.total) list.append(h('button', { class: 'btn sr-more', disabled: !!st.loading, onclick: () => runSearch(true) }, st.loading ? 'Carregando…' : `Carregar mais (${st.total - st.results.length})`));
  panel.append(list);
}

// ---- Menu de filtros ao clicar na busca (igual ao Discord)
let searchSel = 0;
function closeSearchMenu() { $('#search-menu')?.remove(); }
function tokenAtCaret() {
  const v = searchInput.value, pos = searchInput.selectionStart ?? v.length;
  const start = v.lastIndexOf(' ', pos - 1) + 1;
  return { start, end: pos, text: v.slice(start, pos) };
}
function replaceToken(tok, text) {
  const v = searchInput.value;
  searchInput.value = v.slice(0, tok.start) + text + v.slice(tok.end);
  const p = tok.start + text.length;
  searchInput.setSelectionRange(p, p);
  searchInput.focus();
  renderSearchMenu();
}
function renderSearchMenu() {
  if (document.activeElement !== searchInput) return closeSearchMenu();
  const tok = tokenAtCaret();
  const m = tok.text.match(/^([^:\s]+):(.*)$/);
  const key = m && SEARCH_KEYS[semAcento(m[1])];
  const val = key ? semAcento(m[2].replace(/^["@#]/, '')) : '';
  let title, items = [];
  if (key === 'de' || key === 'menciona') {
    title = key === 'de' ? 'De usuário' : 'Menciona usuário';
    items = [...S.users.values()].filter((u) => !u.deleted).filter((u) => !val || semAcento(u.username).includes(val) || semAcento(u.displayName).includes(val)).slice(0, 8)
      .map((u) => ({ el: [avatar(u, 'sm'), h('b', {}, u.displayName), h('small', {}, u.username)], pick: () => replaceToken(tok, `${m[1]}:${u.username} `) }));
  } else if (key === 'em') {
    title = 'Em canal';
    items = srvChannels().filter((c) => c.type === 'text' && (!val || semAcento(c.name).includes(val))).slice(0, 8)
      .map((c) => ({ el: [icon('hash'), h('b', {}, c.name)], pick: () => replaceToken(tok, `${m[1]}:${c.name} `) }));
  } else if (key === 'tem') {
    title = 'Tem';
    items = HAS_OPTS.filter(([id, label]) => !val || id.startsWith(val) || semAcento(label).startsWith(val)).map(([id, label]) => ({ el: [h('b', {}, label)], pick: () => replaceToken(tok, `${m[1]}:${id} `) }));
  } else if (key) {
    title = 'Datas';
    items = [['hoje', 'hoje'], ['ontem', 'ontem'], [new Date().toLocaleDateString('pt-BR'), 'dd/mm/aaaa']]
      .map(([v2, hint]) => ({ el: [h('b', {}, v2), h('small', {}, hint === v2 ? '' : hint)], pick: () => replaceToken(tok, `${m[1]}:${v2} `) }));
  } else {
    title = 'Opções de busca';
    const opt = (k, ex, desc) => ({ el: [h('b', {}, k + ':'), h('span', { class: 'sm-ex' }, ex), h('small', {}, desc)], pick: () => replaceToken(tok, k + ':') });
    items = [
      opt('de', 'usuário', 'Mensagens de alguém'),
      searchScope().startsWith('server') ? opt('em', 'canal', 'Só em um canal') : null,
      opt('tem', 'link, imagem…', 'Mensagens com algo'),
      opt('menciona', 'usuário', 'Mensagens que citam alguém'),
      opt('antes', 'data', 'Antes de um dia'),
      opt('depois', 'data', 'Depois de um dia'),
      opt('durante', 'data', 'Num dia específico'),
    ].filter(Boolean);
    if (tok.text && !tok.text.includes(':')) items = items.filter((x) => x.el[0].textContent.startsWith(semAcento(tok.text)));
  }
  searchSel = Math.min(searchSel, Math.max(0, items.length - 1));
  let menu = $('#search-menu');
  if (!items.length) return closeSearchMenu();
  if (!menu) { menu = h('div', { class: 'search-menu', id: 'search-menu' }); $('#search-wrap').append(menu); }
  menu.innerHTML = '';
  menu.append(h('div', { class: 'sm-title' }, title));
  items.forEach((it, i) => menu.append(h('button', { type: 'button', class: 'sm-item' + (i === searchSel ? ' sel' : ''), onmousedown: (e) => { e.preventDefault(); it.pick(); }, onmouseenter: () => { searchSel = i; $$('.sm-item', menu).forEach((b, j) => b.classList.toggle('sel', j === i)); } }, ...it.el)));
  menu._items = items;
  if (!key) menu.append(h('div', { class: 'sm-foot' }, 'Dica: digite e aperte Enter. Ex.: ', h('code', {}, 'print de:jonathan tem:imagem')));
}
searchInput.addEventListener('focus', () => { searchSel = 0; $('#search-wrap').classList.add('open'); renderSearchMenu(); });
searchInput.addEventListener('blur', () => { $('#search-wrap').classList.remove('open'); setTimeout(closeSearchMenu, 100); });
searchInput.addEventListener('input', () => { searchSel = 0; $('#search-clear').hidden = !searchInput.value && !S.search; renderSearchMenu(); });
searchInput.addEventListener('click', renderSearchMenu);
searchInput.addEventListener('keydown', (e) => {
  const menu = $('#search-menu');
  const items = menu?._items || [];
  const tok = tokenAtCaret();
  if (e.key === 'ArrowDown' && items.length) { e.preventDefault(); searchSel = (searchSel + 1) % items.length; renderSearchMenu(); }
  else if (e.key === 'ArrowUp' && items.length) { e.preventDefault(); searchSel = (searchSel - 1 + items.length) % items.length; renderSearchMenu(); }
  else if (e.key === 'Tab' && items.length && /:/.test(tok.text)) { e.preventDefault(); items[searchSel]?.pick(); }
  // Enter completa o filtro pela metade (ex.: "de:feli"); se o filtro já está certo, busca
  else if (e.key === 'Enter' && items.length && /:/.test(tok.text) && (/:$/.test(tok.text) || parseSearch(tok.text).bad.length)) { e.preventDefault(); items[searchSel]?.pick(); }
  else if (e.key === 'Enter') { e.preventDefault(); startSearch(searchInput.value); searchInput.blur(); }
  else if (e.key === 'Escape') { e.preventDefault(); if ($('#search-menu')) closeSearchMenu(); else searchInput.blur(); }
});
$('#search-clear').addEventListener('click', () => { searchInput.value = ''; closeSearch(); });
addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && S.view !== 'friends') { e.preventDefault(); searchInput.focus(); searchInput.select(); } });

// ---------- Música: "Ouvir juntos" (só o áudio; o player do YouTube fica escondido) ----------
// Toca sozinho para quem está na sala de voz. O botão de música do cartão de voz abre o menu de controle.
S.music = S.music || {};
S.musicSkew = 0;
let ytApi = null, yt = null, ytReady = false, ytLoaded = { videoId: null, seq: -1 }, musicOpen = false, seeking = false;
prefs.musicVolume ??= 40;
function loadYouTubeApi() {
  if (ytApi) return ytApi;
  ytApi = new Promise((resolve, reject) => {
    if (window.YT?.Player) return resolve(window.YT);
    window.onYouTubeIframeAPIReady = () => resolve(window.YT);
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => { ytApi = null; reject(new Error('Não consegui carregar a música do YouTube. Confira a internet.')); };
    document.head.append(s);
  });
  return ytApi;
}
const musicHere = () => (V.room && V.channelId ? S.music[V.channelId] : null);
const musicPosSec = (m) => ((m.pausedPos != null ? m.pausedPos : Date.now() + S.musicSkew - m.startedAt) / 1000);
const fmtSec = (s) => { s = Math.max(0, Math.floor(s || 0)); const h2 = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60; return (h2 ? h2 + ':' + String(mm).padStart(2, '0') : mm) + ':' + String(ss).padStart(2, '0'); };
const musicDur = () => { try { return (yt && ytReady && yt.getDuration?.()) || 0; } catch { return 0; } };
const mcmd = (cmd, arg) => act('music', arg === undefined ? { cmd } : { cmd, arg: String(arg) }).catch((x) => toast(x.message, true));

function onMusicEvent(d) {
  S.musicSkew = d.now - Date.now();
  if (d.current) S.music[d.voiceId] = d; else delete S.music[d.voiceId];
  if (d.voiceId === V.channelId) { renderMusic(); syncPlayer(); }
  renderChannels();
}
function openMusic() { if (!V.room) return toast('Entre numa sala de voz para ouvir música junto com a galera.'); musicOpen = true; renderMusic(); syncPlayer(); }
function closeMusic() { musicOpen = false; renderMusic(); }

// menu de controle que abre dentro do cartão de voz
function renderMusic() {
  const m = musicHere();
  const btn = $('#btn-music');
  btn?.classList.toggle('on', !!m);
  btn?.classList.toggle('open', musicOpen && !!V.room);
  const panel = $('#music-panel');
  if (!panel) return;
  if (!V.room || !musicOpen) { panel.hidden = true; panel.innerHTML = ''; return; }
  panel.hidden = false;
  panel.innerHTML = '';
  const add = h('form', { class: 'mp-add', onsubmit: (e) => { e.preventDefault(); const v = inp.value.trim(); if (!v) return; inp.value = ''; mcmd('play', v); } });
  const inp = h('input', { placeholder: m ? 'Pôr outra na fila: cole o link do YouTube' : 'Cole o link do YouTube e aperte Enter', autocomplete: 'off' });
  add.append(inp);
  if (!m) {
    panel.append(h('div', { class: 'mp-none' }, h('b', {}, 'Nada tocando'), h('span', {}, 'Use /play no canal de música ou cole um link aqui.')), add);
    return;
  }
  const t = m.current;
  const dur = musicDur();
  const pos = musicPosSec(m);
  const bar = h('input', { type: 'range', class: 'mp-seek', id: 'mp-seek', min: 0, max: dur ? Math.floor(dur) : 1, step: 1, value: dur ? Math.floor(pos) : 0, disabled: !dur, title: 'Arraste para mudar a minutagem' });
  bar.addEventListener('input', () => { seeking = true; $('#mp-cur').textContent = fmtSec(bar.value); paintSeek(); });
  bar.addEventListener('change', () => { seeking = false; mcmd('seek', bar.value); });
  const paused = m.pausedPos != null;
  const loopIc = icon(m.loop === 'one' ? 'loop-one' : 'loop');
  const loopTitle = { off: 'Repetir: desligado (clique para repetir esta música)', one: 'Repetindo esta música (clique para repetir a fila toda)', all: 'Repetindo a fila toda (clique para desligar)' }[m.loop || 'off'];
  const b2 = (ic, title, fn, cls = '') => h('button', { type: 'button', class: 'mp-btn ' + cls, title, onclick: fn }, ic);
  const vol = h('input', { type: 'range', min: 0, max: 100, value: prefs.musicVolume, class: 'mp-volr', title: 'Volume da música (só para você)' });
  const volName = () => (prefs.musicVolume == 0 ? 'vol-off' : prefs.musicVolume < 50 ? 'vol-low' : 'speaker');
  const volIc = h('button', { type: 'button', class: 'mp-volic', title: prefs.musicVolume == 0 ? 'Ativar o som da música' : 'Silenciar a música' }, icon(volName()));
  const setVol = (v) => { prefs.musicVolume = v; savePrefs(); applyMusicVolume(); volIc.replaceChildren(icon(volName())); volIc.title = v == 0 ? 'Ativar o som da música' : 'Silenciar a música'; vol.value = v; paintRange(vol); };
  vol.oninput = () => setVol(Number(vol.value));
  volIc.onclick = () => { if (prefs.musicVolume > 0) { prefs.musicVolBefore = prefs.musicVolume; setVol(0); } else setVol(prefs.musicVolBefore || 50); };
  panel.append(
    h('div', { class: 'mp-now' },
      h('img', { src: `https://i.ytimg.com/vi/${t.videoId}/mqdefault.jpg`, alt: '' }),
      h('div', { class: 'mp-txt' }, h('b', { title: t.title }, t.title), h('small', {}, `${t.author ? t.author + ' · ' : ''}pedido por ${userName(t.by)}`)),
      h('button', { type: 'button', class: 'icon-btn', title: 'Fechar o menu (a música continua)', onclick: closeMusic }, icon('x'))),
    h('div', { class: 'mp-progress' }, h('span', { id: 'mp-cur' }, fmtSec(pos)), bar, h('span', { id: 'mp-dur' }, dur ? fmtSec(dur) : '--:--')),
    h('div', { class: 'mp-ctrls' },
      b2(loopIc, loopTitle, () => mcmd('loop'), 'loop ' + (m.loop && m.loop !== 'off' ? 'on' : '')),
      b2(icon('prev'), 'Voltar do início', () => mcmd('seek', 0)),
      b2(icon(paused ? 'play' : 'pause'), paused ? 'Continuar' : 'Pausar', () => mcmd(paused ? 'resume' : 'pause'), 'main'),
      b2(icon('next'), 'Pular para a próxima', () => mcmd('skip')),
      b2(icon('stop'), 'Parar e limpar a fila', () => mcmd('stop'))),
    h('div', { class: 'mp-volume' }, volIc, vol),
    m.queue?.length ? h('div', { class: 'mp-queue' }, h('div', { class: 'mp-qhead' }, h('span', {}, `Próximas — ${m.queue.length}`), m.queue.length > 1 ? h('button', { type: 'button', class: 'link-btn', onclick: () => mcmd('shuffle') }, icon('shuffle'), 'embaralhar') : null),
      ...m.queue.map((q2, i) => h('div', { class: 'mp-qrow' }, h('span', { class: 'mp-qn' }, i + 1), h('span', { class: 'mp-qt' }, h('b', { title: q2.title }, q2.title), h('small', {}, userName(q2.by))),
        h('button', { type: 'button', class: 'icon-btn', title: 'Tirar da fila', onclick: () => mcmd('remove', i + 1) }, icon('x'))))) : '',
    add);
  paintSeek(); paintRange(vol);
}
const paintRange = (r) => r && r.style.setProperty('--p', ((r.value - r.min) / ((r.max - r.min) || 1)) * 100 + '%');
const paintSeek = () => paintRange($('#mp-seek'));
function applyMusicVolume() {
  if (!yt || !ytReady) return;
  try { if (V.deafened || V.serverMod?.deaf || !prefs.musicVolume) yt.mute(); else { yt.unMute(); yt.setVolume(prefs.musicVolume); } } catch {}
}
// o player do YouTube fica fora da tela: só o áudio
function ytHost() {
  let host = $('#yt-host');
  if (!host) { host = h('div', { id: 'yt-host', 'aria-hidden': 'true' }, h('div', { id: 'yt-frame' })); document.body.append(host); }
  return host;
}
async function syncPlayer() {
  const m = musicHere();
  if (!m) {
    if (yt && ytReady && ytLoaded.videoId) { try { yt.stopVideo(); } catch {} ytLoaded = { videoId: null, seq: -1 }; }
    return;
  }
  if (!yt) {
    let Y;
    try { Y = await loadYouTubeApi(); } catch (e) { return toast(e.message, true); }
    if (yt) return;
    ytHost();
    yt = new Y.Player('yt-frame', {
      host: 'https://www.youtube-nocookie.com', width: 320, height: 180,
      playerVars: { autoplay: 1, controls: 0, disablekb: 1, playsinline: 1, rel: 0, iv_load_policy: 3, origin: location.origin },
      events: {
        onReady: () => { ytReady = true; applyMusicVolume(); syncPlayer(); },
        onStateChange: (e) => {
          const cur = musicHere();
          if (e.data === 0 && cur && cur.pausedPos == null) act('music_ended', { voiceId: V.channelId, seq: cur.seq }).catch(() => {});
          if (e.data === 1) { applyMusicVolume(); if (musicOpen) renderMusic(); }
        },
        onError: (e) => { const cur = musicHere(); if (cur) act('music_error', { voiceId: V.channelId, seq: cur.seq, code: e.data }).catch(() => {}); },
      },
    });
    return;
  }
  if (!ytReady) return;
  const pos = musicPosSec(m);
  if (ytLoaded.seq !== m.seq || ytLoaded.videoId !== m.current.videoId) {
    ytLoaded = { videoId: m.current.videoId, seq: m.seq };
    yt.loadVideoById({ videoId: m.current.videoId, startSeconds: pos });
    if (m.pausedPos != null) setTimeout(() => { try { yt.pauseVideo(); } catch {} }, 500);
    applyMusicVolume();
    return;
  }
  try {
    const st = yt.getPlayerState();
    if (m.pausedPos != null) { if (st === 1 || st === 3) yt.pauseVideo(); if (Math.abs(yt.getCurrentTime() - pos) > 1.5) yt.seekTo(pos, true); }
    else {
      if (st === 2 || st === 5 || st === -1 || st === 0) yt.playVideo();
      const dur = musicDur();
      if (Math.abs(yt.getCurrentTime() - pos) > 2.5 && (!dur || pos < dur - 1)) yt.seekTo(pos, true); // corrige se ficou fora de sincronia
    }
  } catch {}
}
// barra de progresso ao vivo + correção de sincronia
setInterval(() => {
  const m = musicHere();
  const bar = $('#mp-seek');
  if (!m || !bar || seeking) return;
  const pos = musicPosSec(m), dur = musicDur();
  bar.disabled = !dur;
  bar.max = dur ? Math.floor(dur) : 1;
  bar.value = dur ? Math.floor(Math.min(pos, dur)) : 0;
  $('#mp-cur').textContent = fmtSec(Math.min(pos, dur || pos));
  $('#mp-dur').textContent = dur ? fmtSec(dur) : '--:--';
  paintSeek();
}, 500);
setInterval(syncPlayer, 5000);

// mensagem do "bot" de música (no canal #tempo)
function botMessageEl(m, prev) {
  const grouped = prev?.sys && m.createdAt - prev.createdAt < 5 * 60 * 1000 && sameDay(prev.createdAt, m.createdAt);
  const row = h('div', { class: `msg bot-msg${grouped ? '' : ' first'}`, 'data-id': m.id });
  row.append(h('div', { class: 'avatar lg bot-av' }, icon('music')));
  row.append(h('div', { class: 'meta' }, h('span', { class: 'author bot-name' }, 'DiscordIA Música'), h('span', { class: 'bot-tag' }, '✓ BOT'),
    h('time', { title: new Date(m.createdAt).toLocaleString('pt-BR') }, `${fmtDay(m.createdAt)} às ${fmtTime(m.createdAt)}`)));
  row.append(h('span', { class: 'side-time' }, fmtTime(m.createdAt)));
  row.append(h('div', { class: 'body', html: md(m.sys.text || '') }));
  const t = m.sys.track;
  if (t?.videoId) row.append(h('a', { class: 'bot-card', href: `https://www.youtube.com/watch?v=${t.videoId}`, target: '_blank', rel: 'noopener noreferrer' },
    h('img', { src: `https://i.ytimg.com/vi/${t.videoId}/mqdefault.jpg`, alt: '', loading: 'lazy' }),
    h('span', {}, h('b', {}, t.title), h('small', {}, t.author || 'YouTube'))));
  return row;
}

// sugestões de comando ao digitar "/" no canal de música
const MUSIC_HELP = [['/play', 'link do YouTube', 'Toca ou põe na fila'], ['/pause', '', 'Pausa para todos'], ['/resume', '', 'Continua'], ['/skip', '', 'Pula a música'], ['/loop', 'música | fila | off', 'Repetir'], ['/fila', '', 'Mostra a fila'], ['/tocando', '', 'O que está tocando'], ['/remover', 'número', 'Tira da fila'], ['/embaralhar', '', 'Embaralha a fila'], ['/limpar', '', 'Limpa a fila'], ['/stop', '', 'Para e limpa tudo'], ['/ajuda', '', 'Lista os comandos']];
function renderCmdHints() {
  $('#cmd-hints')?.remove();
  const v = input.value;
  if (!isMusicChannel(S.current) || !/^\/\S*$/.test(v)) return;
  const items = MUSIC_HELP.filter(([c]) => c.startsWith(v.toLowerCase()));
  if (!items.length) return;
  const box = h('div', { class: 'cmd-hints', id: 'cmd-hints' }, h('div', { class: 'sm-title' }, 'Comandos de música'),
    ...items.map(([c, arg, desc]) => h('button', { type: 'button', class: 'sm-item', onmousedown: (e) => { e.preventDefault(); input.value = c + ' '; input.focus(); renderCmdHints(); } },
      h('b', {}, c), arg ? h('span', { class: 'sm-ex' }, arg) : null, h('small', {}, desc))));
  $('#composer').append(box);
}
input.addEventListener('input', renderCmdHints);
input.addEventListener('blur', () => setTimeout(() => $('#cmd-hints')?.remove(), 120));
$('#composer').addEventListener('submit', () => $('#cmd-hints')?.remove(), true);

// ---------- Botão direito em quem está numa sala de voz (igual ao Discord) ----------
prefs.streamVolumes ||= {};
prefs.streamMuted ||= {};
prefs.videoOff ||= {};
const voiceStateOf = (uid) => { for (const [cid, ppl] of Object.entries(S.voice)) if (ppl[uid]) return { channelId: Number(cid), ...ppl[uid] }; return null; };
function menuSlider(label, value, onInput) {
  const out = h('output', {}, Math.round(value * 100) + '%');
  const r = h('input', { type: 'range', min: 0, max: 200, step: 5, value: Math.round(value * 100) });
  const paint = () => r.style.setProperty('--p', (r.value / 2) + '%');
  r.oninput = () => { out.textContent = r.value + '%'; paint(); onInput(Number(r.value) / 100); };
  r.ondblclick = () => { r.value = 100; r.oninput(); };
  paint();
  return h('div', { class: 'menu-slider', onclick: (e) => e.stopPropagation() }, h('div', { class: 'ms-head' }, h('span', {}, label), out), r);
}
function voiceUserMenu(uid, x, y) {
  closePopovers();
  uid = Number(uid);
  const u = S.users.get(uid);
  if (!u || u.deleted) return;
  const me = uid === S.me.id;
  const vs = voiceStateOf(uid);
  const sameRoom = !!V.room && vs?.channelId === V.channelId;
  const item = (label, fn, cls = '') => h('button', { type: 'button', class: 'menu-item ' + cls, onclick: () => { pop.remove(); fn(); } }, h('span', {}, label));
  const check = (label, on, fn, cls = '') => h('button', { type: 'button', class: 'menu-item ' + cls, onclick: () => { pop.remove(); fn(!on); } }, h('span', {}, label), h('span', { class: 'menu-check' + (on ? ' on' : '') }, on ? icon('check') : null));
  const sep = () => h('div', { class: 'menu-sep' });
  const st = friendState(uid);
  const moveItem = vs && !isDm(vs.channelId) ? h('button', { type: 'button', class: 'menu-item', onclick: (e) => { e.stopPropagation(); moveMenu(uid, vs.channelId, e.currentTarget); } }, h('span', {}, 'Mover para'), icon('right')) : null;
  const streaming = sameRoom && vs?.screen;
  const pop = h('div', { class: 'popover menu ctx user-menu voice-menu' },
    item('Perfil', () => profileCard(uid, null)),
    item('Mencionar', () => mentionUser(u)),
    me ? null : item('Mensagem', () => openDm(uid)),
    me ? null : item('Iniciar chamada', () => startCall(uid)),
    !me && sameRoom ? sep() : null,
    !me && sameRoom ? menuSlider('Volume do usuário', prefs.volumes[uid] ?? 1, (v) => { prefs.volumes[uid] = v; savePrefs(); applyVolumes(); }) : null,
    !me && streaming ? menuSlider('Volume da transmissão', prefs.streamVolumes[uid] ?? 1, (v) => { prefs.streamVolumes[uid] = v; savePrefs(); applyVolumes(); }) : null,
    !me && sameRoom ? check('Silenciar', !!prefs.userMuted[uid], (v) => { prefs.userMuted[uid] = v; savePrefs(); applyVolumes(); renderTiles(); renderChannels(); }) : null,
    !me && streaming ? check('Silenciar transmissão', !!prefs.streamMuted[uid], (v) => { prefs.streamMuted[uid] = v; savePrefs(); applyVolumes(); renderTiles(); }) : null,
    !me && sameRoom ? check('Desativar vídeo', !!prefs.videoOff[uid], (v) => { prefs.videoOff[uid] = v; savePrefs(); renderTiles(); }) : null,
    me ? null : sep(),
    me ? null
      : st === 'none' ? item('Adicionar amigo', () => act('friend_request', { userId: uid }).then(() => toast(`Pedido de amizade enviado para ${u.displayName}.`)).catch((e) => toast(e.message, true)))
      : st === 'outgoing' ? item('Cancelar pedido de amizade', () => act('friend_remove', { userId: uid }))
      : st === 'incoming' ? item('Aceitar pedido de amizade', () => act('friend_accept', { userId: uid }).catch((e) => toast(e.message, true)))
      : item('Remover amizade', () => removeFriend(uid), 'danger'),
    vs ? sep() : null,
    moveItem,
    vs && !me && !isDm(vs.channelId) ? check('Silenciar voz no servidor', !!vs.smute, (v) => act('voice_mod', { userId: uid, mute: v }).catch((e) => toast(e.message, true)), 'danger') : null,
    vs && !me && !isDm(vs.channelId) ? check('Desativar áudio no servidor', !!vs.sdeaf, (v) => act('voice_mod', { userId: uid, deaf: v }).catch((e) => toast(e.message, true)), 'danger') : null,
    vs ? item('Desconectar', () => (me ? leaveVoice() : act('voice_kick', { userId: uid }).then(() => toast(`${u.displayName} foi desconectado(a) da sala.`)).catch((e) => toast(e.message, true))), 'danger') : null);
  placePopover(pop, x, y);
}
// submenu "Mover para": as outras salas de voz do servidor
function moveMenu(uid, fromId, anchor) {
  $('.move-menu')?.remove();
  const from = channelById(fromId);
  const rooms = S.channels.filter((c) => c.type === 'voice' && c.server_id === from?.server_id && c.id !== fromId);
  const pop = h('div', { class: 'popover menu ctx move-menu' }, h('div', { class: 'menu-title' }, 'Mover para'),
    ...(rooms.length ? rooms.map((c) => h('button', { type: 'button', class: 'menu-item', onclick: () => {
      closePopovers();
      if (uid === S.me.id) return joinVoice(c.id);
      act('voice_move', { userId: uid, channelId: c.id }).then(() => toast(`${userName(uid)} foi movido(a) para ${c.name}.`)).catch((e) => toast(e.message, true));
    } }, h('span', { class: 'with-icon' }, icon('speaker'), c.name), h('small', { class: 'mm-count' }, Object.keys(S.voice[c.id] || {}).length || ''))) : [h('p', { class: 'hint', style: { padding: '4px 10px' } }, 'Não tem outra sala de voz.')]));
  (modal.open ? modal : document.body).append(pop);
  const r = anchor.getBoundingClientRect();
  let left = r.right + 4;
  if (left + pop.offsetWidth > innerWidth - 8) left = r.left - pop.offsetWidth - 4;
  pop.style.left = Math.max(8, left) + 'px';
  pop.style.top = Math.max(8, Math.min(r.top, innerHeight - pop.offsetHeight - 8)) + 'px';
}
// ordens vindas de outra pessoa da sala
function onVoiceCommand(d) {
  if (d.cmd === 'disconnect') { if (V.room) { leaveVoice(); toast(`${d.by} desconectou você da sala de voz.`, true, 6000); } }
  else if (d.cmd === 'move') { if (V.room) { toast(`${d.by} moveu você para ${channelById(d.channelId)?.name || 'outra sala'}.`, false, 6000); joinVoice(d.channelId); } }
  else if (d.cmd === 'mod') {
    const was = V.serverMod || {};
    V.serverMod = { mute: d.mute, deaf: d.deaf };
    if (d.mute && !was.mute) toast(`${d.by} silenciou sua voz no servidor.`, true, 6000);
    if (!d.mute && was.mute) toast(`${d.by} liberou sua voz.`);
    if (d.deaf && !was.deaf) toast(`${d.by} desativou seu áudio no servidor.`, true, 6000);
    if (!d.deaf && was.deaf) toast(`${d.by} reativou seu áudio.`);
    applyVolumes(); applyMusicVolume(); updateMic(); renderMe();
  }
}

// ---------- Grade de pessoas na sala (igual ao Discord: blocos 16:9, foto no meio, sem esticar) ----------
function layoutTiles() {
  const box = $('#tiles');
  if (!box || box.classList.contains('focus')) return;
  const tiles = [...box.children].filter((el) => el.classList.contains('tile'));
  const n = tiles.length;
  if (!n) return;
  const gap = 8, W = box.clientWidth - 32, H = box.clientHeight - 32;
  let best = { w: 0, c: 1 };
  for (let c = 1; c <= n; c++) {
    const r = Math.ceil(n / c);
    const w = Math.min((W - gap * (c - 1)) / c, ((H - gap * (r - 1)) / r) * 16 / 9);
    if (w > best.w + 0.5) best = { w, c };
  }
  box.style.setProperty('--tw', Math.max(120, Math.floor(best.w)) + 'px');
}
new ResizeObserver(() => layoutTiles()).observe($('#tiles'));
// cor de fundo do bloco: a cor média da foto (como o Discord); sem foto, a cor da pessoa
const avgColors = new Map();
function tileColor(u) {
  if (!u) return '#2a2e33';
  if (u.avatar) {
    if (avgColors.has(u.avatar)) return avgColors.get(u.avatar) || u.color;
    avgColors.set(u.avatar, null);
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement('canvas'); c.width = c.height = 12;
        const g = c.getContext('2d'); g.drawImage(img, 0, 0, 12, 12);
        const d = g.getImageData(0, 0, 12, 12).data;
        let r = 0, gg = 0, b = 0, k = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 128) { r += d[i]; gg += d[i + 1]; b += d[i + 2]; k++; }
        if (k) { avgColors.set(u.avatar, `rgb(${Math.round(r / k)}, ${Math.round(gg / k)}, ${Math.round(b / k)})`); renderTiles(); }
      } catch {}
    };
    img.src = u.avatar;
    return `color-mix(in srgb, ${u.color} 45%, #1a1d20)`;
  }
  return `color-mix(in srgb, ${u.color} 45%, #1a1d20)`;
}

window.__dia = { S, V, checkCalls, renderChannels, onSpeakersChanged, openMusic, renderMusic, cameraPreview, screenPicker, renderTiles, showVoiceView, voiceUserMenu }; // usado nos testes automáticos
boot();
