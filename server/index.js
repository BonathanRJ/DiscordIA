// DiscordIA — servidor de chat e voz para um grupo pequeno de amigos.
// Sem dependências externas: só Node.js (22.13+ ou 24+).
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const UPLOADS = path.join(DATA, 'uploads');
const PUBLIC = path.join(ROOT, 'public');
fs.mkdirSync(UPLOADS, { recursive: true });

// ---------- Configuração ----------
const CONFIG_PATH = path.join(DATA, 'config.json');
function randomInvite() {
  const w = ['brasa', 'farofa', 'pastel', 'role', 'chopp', 'caju', 'pipoca', 'samba', 'acai', 'coxinha', 'mate', 'pacoca', 'guarana', 'churras'];
  const pick = () => w[crypto.randomInt(w.length)];
  return `${pick()}-${pick()}-${crypto.randomInt(100, 1000)}`;
}
function loadConfig() {
  let cfg = {};
  if (fs.existsSync(CONFIG_PATH)) cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const def = {
    port: 3000,
    serverName: 'SÓ OS CRIA', // nome do servidor (o app continua se chamando DiscordIA)
    inviteCode: randomInvite(),
    inviteExpiresAt: 0, // 0 = nunca expira
    inviteMaxUses: 0,   // 0 = sem limite
    inviteUses: 0,
    maxUploadMB: 25,
    livekit: {
      enabled: true,
      apiKey: 'resenha',
      apiSecret: crypto.randomBytes(32).toString('hex'),
      port: 7880,
      tcpPort: 7881,
      udpStart: 50000,
      udpEnd: 50100,
      nodeIp: '',
    },
  };
  cfg = { ...def, ...cfg, livekit: { ...def.livekit, ...(cfg.livekit || {}) } };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  return cfg;
}
const config = loadConfig();
const saveConfig = () => fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));

const db = openDb(DATA);
// Uma vez só: o servidor que já existia vira o servidor nº 1 (nome, convite e #tempo vêm do config)
if (!db.prepare('SELECT COUNT(*) AS n FROM servers').get().n) {
  const now = Date.now();
  const music = Number(db.prepare("SELECT v FROM meta WHERE k = 'music_channel'").get()?.v) || null;
  const sid = Number(db.prepare('INSERT INTO servers (name, icon, color, position, created_at, invite_code, invite_expires, invite_max, invite_uses, music_channel) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?)')
    .run(config.serverName || 'SÓ OS CRIA', 'app', '#ff8a3d', now, config.inviteCode, config.inviteExpiresAt || 0, config.inviteMaxUses || 0, config.inviteUses || 0, music).lastInsertRowid);
  db.prepare('UPDATE channels SET server_id = ? WHERE dm_a IS NULL AND server_id IS NULL').run(sid);
  db.prepare('UPDATE categories SET server_id = ? WHERE server_id IS NULL').run(sid);
  db.prepare('INSERT OR IGNORE INTO server_members (server_id, user_id, joined_at) SELECT ?, id, created_at FROM users WHERE deleted = 0 AND (member != 0 OR is_admin = 1)').run(sid);
}

// ---------- Utilidades ----------
const COLORS = ['#ff8a3d', '#3ddc97', '#5aa9ff', '#ff5d8f', '#c792ff', '#ffd23f', '#4dd4e6', '#ff6b4a', '#9be15d', '#f78fb3'];

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}
function checkPassword(pw, stored) {
  const [s, h] = stored.split(':');
  const hash = crypto.scryptSync(pw, Buffer.from(s, 'hex'), 64);
  return crypto.timingSafeEqual(hash, Buffer.from(h, 'hex'));
}
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function send(res, status, body, headers = {}) {
  const isObj = body !== null && typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    'Content-Type': isObj ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(isObj ? JSON.stringify(body) : body);
}
async function readBody(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw Object.assign(new Error('Corpo grande demais'), { status: 413 });
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}
async function readJson(req) {
  const buf = await readBody(req);
  try { return JSON.parse(buf.toString('utf8') || '{}'); }
  catch { throw Object.assign(new Error('JSON inválido'), { status: 400 }); }
}
const fail = (status, msg) => Object.assign(new Error(msg), { status });

function publicUser(u) {
  return { id: u.id, username: u.username, displayName: u.display_name, color: u.color, isAdmin: !!u.is_admin, createdAt: u.created_at, deleted: !!u.deleted, avatar: u.avatar || null, banner: u.banner || null };
}
function rowToMessage(m) {
  const out = {
    id: m.id, channelId: m.channel_id, userId: m.user_id, content: m.content,
    attachment: m.attachment ? JSON.parse(m.attachment) : null,
    createdAt: m.created_at, editedAt: m.edited_at,
    reactions: [], reply: null, forward: m.forward ? JSON.parse(m.forward) : null, thread: null, call: m.call ? JSON.parse(m.call) : null, sys: m.sys ? JSON.parse(m.sys) : null,
  };
  // reações agrupadas por emoji, na ordem em que apareceram
  const groups = new Map();
  for (const r of q.reactionsOf.all(m.id)) {
    if (!groups.has(r.emoji)) groups.set(r.emoji, []);
    groups.get(r.emoji).push(r.user_id);
  }
  out.reactions = [...groups].map(([emoji, users]) => ({ emoji, users }));
  if (m.reply_to) {
    const r = q.message.get(m.reply_to);
    out.reply = r ? { id: r.id, userId: r.user_id, content: r.content.slice(0, 200), attachment: !!r.attachment } : { id: m.reply_to, deleted: true };
  }
  return out;
}
const q = {
  userByName: db.prepare('SELECT * FROM users WHERE username = ?'),
  userById: db.prepare('SELECT * FROM users WHERE id = ?'),
  allUsers: db.prepare('SELECT * FROM users ORDER BY display_name COLLATE NOCASE'),
  countUsers: db.prepare('SELECT COUNT(*) AS n FROM users'),
  insertUser: db.prepare('INSERT INTO users (username, display_name, pass_hash, color, is_admin, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
  session: db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?'),
  insertSession: db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)'),
  deleteSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
  channels: db.prepare('SELECT * FROM channels WHERE dm_a IS NULL ORDER BY type DESC, position, id'),
  channel: db.prepare('SELECT * FROM channels WHERE id = ?'),
  maxPos: db.prepare('SELECT COALESCE(MAX(position), -1) AS p FROM channels WHERE type = ? AND parent_id IS NULL'),
  insertChannel: db.prepare('INSERT INTO channels (name, type, position, created_at) VALUES (?, ?, ?, ?)'),
  renameChannel: db.prepare('UPDATE channels SET name = ? WHERE id = ?'),
  deleteChannel: db.prepare('DELETE FROM channels WHERE id = ?'),
  insertMessage: db.prepare('INSERT INTO messages (channel_id, user_id, content, attachment, created_at) VALUES (?, ?, ?, ?, ?)'),
  message: db.prepare('SELECT * FROM messages WHERE id = ?'),
  editMessage: db.prepare('UPDATE messages SET content = ?, edited_at = ? WHERE id = ?'),
  deleteMessage: db.prepare('DELETE FROM messages WHERE id = ?'),
  latest: db.prepare('SELECT * FROM messages WHERE channel_id = ? ORDER BY id DESC LIMIT ?'),
  before: db.prepare('SELECT * FROM messages WHERE channel_id = ? AND id < ? ORDER BY id DESC LIMIT ?'),
  setRead: db.prepare('INSERT INTO reads (user_id, channel_id, last_id) VALUES (?, ?, ?) ON CONFLICT(user_id, channel_id) DO UPDATE SET last_id = MAX(last_id, excluded.last_id)'),
  unread: db.prepare(`
    SELECT c.id AS channel_id,
      (SELECT COUNT(*) FROM messages m WHERE m.channel_id = c.id AND m.user_id != ? AND m.id > COALESCE(r.last_id, 0)) AS n
    FROM channels c LEFT JOIN reads r ON r.channel_id = c.id AND r.user_id = ?
    WHERE c.type = 'text' AND (c.dm_a IS NULL OR c.dm_a = ? OR c.dm_b = ?)`),
  updateProfile: db.prepare('UPDATE users SET display_name = ?, color = ? WHERE id = ?'),
  setAvatar: db.prepare('UPDATE users SET avatar = ? WHERE id = ?'),
  setBanner: db.prepare('UPDATE users SET banner = ? WHERE id = ?'),
  setServerIcon: db.prepare('UPDATE servers SET icon = ? WHERE id = ?'),
  updatePassword: db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?'),
  // reações, respostas, tópicos, favoritos, denúncias
  reactionsOf: db.prepare('SELECT emoji, user_id FROM reactions WHERE message_id = ? ORDER BY created_at, rowid'),
  hasReaction: db.prepare('SELECT 1 FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?'),
  addReaction: db.prepare('INSERT OR IGNORE INTO reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)'),
  delReaction: db.prepare('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?'),
  distinctEmojis: db.prepare('SELECT COUNT(DISTINCT emoji) AS n FROM reactions WHERE message_id = ?'),
  insertFullMessage: db.prepare('INSERT INTO messages (channel_id, user_id, content, attachment, created_at, reply_to, forward) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  threadStats: db.prepare('SELECT COUNT(*) AS n, MAX(created_at) AS last FROM messages WHERE channel_id = ?'),
  insertThread: db.prepare("INSERT INTO channels (name, type, position, created_at, parent_id, parent_message_id, creator_id) VALUES (?, 'text', 0, ?, ?, ?, ?)"),
  setThread: db.prepare('UPDATE messages SET thread_id = ? WHERE id = ?'),
  threadsOf: db.prepare('SELECT id FROM channels WHERE parent_id = ?'),
  bookmarkIds: db.prepare('SELECT message_id FROM bookmarks WHERE user_id = ? ORDER BY created_at DESC'),
  bookmarkRows: db.prepare('SELECT m.*, b.created_at AS saved_at FROM bookmarks b JOIN messages m ON m.id = b.message_id WHERE b.user_id = ? ORDER BY b.created_at DESC LIMIT 200'),
  hasBookmark: db.prepare('SELECT 1 FROM bookmarks WHERE user_id = ? AND message_id = ?'),
  addBookmark: db.prepare('INSERT OR IGNORE INTO bookmarks (user_id, message_id, created_at) VALUES (?, ?, ?)'),
  delBookmark: db.prepare('DELETE FROM bookmarks WHERE user_id = ? AND message_id = ?'),
  forceRead: db.prepare('INSERT INTO reads (user_id, channel_id, last_id) VALUES (?, ?, ?) ON CONFLICT(user_id, channel_id) DO UPDATE SET last_id = excluded.last_id'),
  lastReads: db.prepare('SELECT channel_id, last_id FROM reads WHERE user_id = ?'),
  unreadOne: db.prepare('SELECT COUNT(*) AS n FROM messages WHERE channel_id = ? AND user_id != ? AND id > ?'),
  insertReport: db.prepare('INSERT INTO reports (message_id, reporter_id, reason, snapshot, created_at) VALUES (?, ?, ?, ?, ?)'),
  pendingReports: db.prepare('SELECT * FROM reports WHERE resolved = 0 ORDER BY id DESC LIMIT 100'),
  countReports: db.prepare('SELECT COUNT(*) AS n FROM reports WHERE resolved = 0'),
  resolveReport: db.prepare('UPDATE reports SET resolved = 1 WHERE id = ?'),
  admins: db.prepare('SELECT id FROM users WHERE is_admin = 1'),
  // conversas privadas e amizades
  dmFind: db.prepare('SELECT * FROM channels WHERE dm_a = ? AND dm_b = ?'),
  dmInsert: db.prepare("INSERT INTO channels (name, type, position, created_at, creator_id, dm_a, dm_b) VALUES ('dm', 'text', 0, ?, ?, ?, ?)"),
  dmsOf: db.prepare(`SELECT c.*, (SELECT MAX(id) FROM messages WHERE channel_id = c.id) AS last_id,
      (SELECT MAX(created_at) FROM messages WHERE channel_id = c.id) AS last_at,
      EXISTS (SELECT 1 FROM dm_closed d WHERE d.user_id = ? AND d.channel_id = c.id) AS closed
    FROM channels c WHERE c.dm_a = ? OR c.dm_b = ?`),
  dmClose: db.prepare('INSERT OR IGNORE INTO dm_closed (user_id, channel_id) VALUES (?, ?)'),
  dmReopen: db.prepare('DELETE FROM dm_closed WHERE channel_id = ? AND user_id = ?'),
  friendGet: db.prepare('SELECT * FROM friends WHERE a = ? AND b = ?'),
  friendPut: db.prepare('INSERT OR REPLACE INTO friends (a, b, requester, status, created_at) VALUES (?, ?, ?, ?, ?)'),
  friendDel: db.prepare('DELETE FROM friends WHERE a = ? AND b = ?'),
  friendsOf: db.prepare('SELECT * FROM friends WHERE a = ? OR b = ?'),
  setCall: db.prepare('UPDATE messages SET call = ? WHERE id = ?'),
  categories: db.prepare('SELECT * FROM categories ORDER BY position, id'),
  category: db.prepare('SELECT * FROM categories WHERE id = ?'),
  maxCatPos: db.prepare('SELECT COALESCE(MAX(position), -1) AS p FROM categories'),
  insertCategory: db.prepare('INSERT INTO categories (name, position, private, created_at, server_id) VALUES (?, ?, ?, ?, ?)'),
  updateCategory: db.prepare('UPDATE categories SET name = ?, private = ? WHERE id = ?'),
  deleteCategory: db.prepare('DELETE FROM categories WHERE id = ?'),
  uncategorize: db.prepare('UPDATE channels SET category_id = NULL WHERE category_id = ?'),
  insertChannel2: db.prepare('INSERT INTO channels (name, type, position, created_at, category_id, private, server_id) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  servers: db.prepare('SELECT * FROM servers ORDER BY position, id'),
  server: db.prepare('SELECT * FROM servers WHERE id = ?'),
  serverByInvite: db.prepare('SELECT * FROM servers WHERE lower(invite_code) = lower(?)'),
  insertServer: db.prepare('INSERT INTO servers (name, icon, color, position, created_at, invite_code) VALUES (?, NULL, ?, ?, ?, ?)'),
  renameServer: db.prepare('UPDATE servers SET name = ? WHERE id = ?'),
  deleteServer: db.prepare('DELETE FROM servers WHERE id = ?'),
  setInvite: db.prepare('UPDATE servers SET invite_code = ?, invite_expires = ?, invite_max = ?, invite_uses = 0 WHERE id = ?'),
  useInvite: db.prepare('UPDATE servers SET invite_uses = invite_uses + 1 WHERE id = ?'),
  setMusicChannel: db.prepare('UPDATE servers SET music_channel = ? WHERE id = ?'),
  maxServerPos: db.prepare('SELECT COALESCE(MAX(position), -1) AS p FROM servers'),
  isMember: db.prepare('SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?'),
  membersOf: db.prepare('SELECT user_id FROM server_members WHERE server_id = ?'),
  addMember: db.prepare('INSERT OR IGNORE INTO server_members (server_id, user_id, joined_at) VALUES (?, ?, ?)'),
  removeMember: db.prepare('DELETE FROM server_members WHERE server_id = ? AND user_id = ?'),
  removeMemberAll: db.prepare('DELETE FROM server_members WHERE user_id = ?'),
  maxPosIn: db.prepare('SELECT COALESCE(MAX(position), -1) AS p FROM channels WHERE type = ? AND server_id = ?'),
  maxCatPosIn: db.prepare('SELECT COALESCE(MAX(position), -1) AS p FROM categories WHERE server_id = ?'),
  channelsOfServer: db.prepare('SELECT * FROM channels WHERE server_id = ?'),
  categoriesOfServer: db.prepare('SELECT * FROM categories WHERE server_id = ?'),
  updateChannel: db.prepare('UPDATE channels SET name = ?, private = ? WHERE id = ?'),
  accessOf: db.prepare('SELECT user_id FROM access WHERE kind = ? AND target_id = ?'),
  accessHas: db.prepare('SELECT 1 FROM access WHERE kind = ? AND target_id = ? AND user_id = ?'),
  accessClear: db.prepare('DELETE FROM access WHERE kind = ? AND target_id = ?'),
  accessAdd: db.prepare('INSERT OR IGNORE INTO access (kind, target_id, user_id) VALUES (?, ?, ?)'),
  setNotif: db.prepare('UPDATE users SET notif = ? WHERE id = ?'),
  setSys: db.prepare('UPDATE messages SET sys = ? WHERE id = ?'),
  setMember: db.prepare('UPDATE users SET member = ? WHERE id = ?'),
  anonymize: db.prepare("UPDATE users SET username = ?, display_name = 'Usuário excluído', pass_hash = ?, color = '#5d6269', member = 0, deleted = 1, notif = NULL WHERE id = ?"),
  deleteSessionsOf: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
  deleteFriendsOf: db.prepare('DELETE FROM friends WHERE a = ? OR b = ?'),
  deleteAccessOf: db.prepare('DELETE FROM access WHERE user_id = ?'),
  clearChannel: db.prepare('DELETE FROM messages WHERE channel_id = ?'),
  moveChannel: db.prepare('UPDATE channels SET category_id = ?, position = ? WHERE id = ?'),
  moveCategory: db.prepare('UPDATE categories SET position = ? WHERE id = ?'),
};
const pair = (x, y) => (x < y ? [x, y] : [y, x]);
// Quem pode ver um canal: conversa privada = as duas pessoas; canal/categoria privada = quem foi escolhido
// (o administrador sempre vê tudo do servidor, mas não as conversas privadas dos outros)
function canSee(user, ch) {
  if (!ch || !user) return false;
  if (ch.dm_a) return ch.dm_a === user.id || ch.dm_b === user.id;
  if (user.is_admin) return !!q.server.get(ch.server_id);
  if (user.deleted || !q.isMember.get(ch.server_id, user.id)) return false; // só quem é membro daquele servidor
  if (ch.private && !q.accessHas.get('channel', ch.id, user.id)) return false;
  const cat = ch.category_id && q.category.get(ch.category_id);
  if (cat?.private && !q.accessHas.get('category', cat.id, user.id)) return false;
  return true;
}
const canSeeCat = (user, cat) => !!user && (user.is_admin || (!!q.isMember.get(cat.server_id, user.id) && (!cat.private || !!q.accessHas.get('category', cat.id, user.id))));
const restricted = (ch) => !!ch && !!(ch.dm_a || ch.private || (ch.category_id && q.category.get(ch.category_id)?.private));
const accessList = (kind, id) => q.accessOf.all(kind, id).map((r) => r.user_id);
function setAccess(kind, id, members) {
  q.accessClear.run(kind, id);
  for (const uid of [...new Set((Array.isArray(members) ? members : []).map(Number))]) if (q.userById.get(uid)) q.accessAdd.run(kind, id, uid);
}
function channelsFor(user) {
  return q.channels.all().filter((c) => canSee(user, c)).map((c) => (user.is_admin && c.private ? { ...c, members: accessList('channel', c.id) } : c));
}
function categoriesFor(user) {
  return q.categories.all().filter((c) => canSeeCat(user, c)).map((c) => (user.is_admin && c.private ? { ...c, members: accessList('category', c.id) } : c));
}
function pushChannels() {
  for (const c of clients.values()) {
    const u = q.userById.get(c.userId);
    if (u) c.res.write(`event: channels\ndata: ${JSON.stringify({ channels: channelsFor(u), categories: categoriesFor(u) })}\n\n`);
  }
  // quem perdeu acesso a uma sala de voz privada sai dela
  let kicked = false;
  for (const [cid, members] of voice) {
    const ch = q.channel.get(cid);
    if (!ch || ch.dm_a) continue;
    for (const uid of [...members.keys()]) if (!canSee(q.userById.get(uid), ch)) { members.delete(uid); kicked = true; }
  }
  if (kicked) broadcastVoice();
}
const inviteInfo = (s) => ({ code: s.invite_code, expiresAt: s.invite_expires || 0, maxUses: s.invite_max || 0, uses: s.invite_uses || 0 });
// servidores de cada pessoa (o administrador vê todos)
function serversFor(user) {
  if (!user || user.deleted) return [];
  return q.servers.all().filter((s) => user.is_admin || q.isMember.get(s.id, user.id)).map((s) => ({
    id: s.id, name: s.name, icon: s.icon, color: s.color, musicChannel: s.music_channel || 0,
    members: q.membersOf.all(s.id).map((r) => r.user_id),
    invite: user.is_admin ? inviteInfo(s) : undefined,
  }));
}
function pushServers() {
  for (const c of clients.values()) { const u = q.userById.get(c.userId); if (u) c.res.write(`event: servers\ndata: ${JSON.stringify(serversFor(u))}\n\n`); }
}
// confere um convite (link ou código) e devolve o servidor dele
function checkInvite(raw) {
  const code = String(raw || '').trim().replace(/^.*[?&]convite=/, '').replace(/[&#].*$/, '');
  const s = code && q.serverByInvite.get(code);
  if (!s) throw fail(403, 'Código de convite incorreto.');
  if (s.invite_expires && Date.now() > s.invite_expires) throw fail(403, 'Esse convite expirou. Peça um link novo para quem te chamou.');
  if (s.invite_max && s.invite_uses >= s.invite_max) throw fail(403, 'Esse convite já foi usado o máximo de vezes. Peça um link novo para quem te chamou.');
  return s;
}
// cria as categorias/canais padrão de um servidor novo (com o #tempo da música)
function seedServer(sid) {
  const now = Date.now();
  const cat = (name, pos) => Number(q.insertCategory.run(name, pos, 0, now, sid).lastInsertRowid);
  const ch = (name, type, pos, c) => Number(q.insertChannel2.run(name, type, pos, now, c, 0, sid).lastInsertRowid);
  const t = cat('Canais de texto', 0), v = cat('Canais de voz', 1), m = cat('Músicas', 2);
  ch('geral', 'text', 0, t);
  ch('Geral', 'voice', 0, v);
  q.setMusicChannel.run(ch('tempo', 'text', 1, m), sid);
}
const dmOther = (ch, uid) => (ch.dm_a === uid ? ch.dm_b : ch.dm_a);
// lista de conversas privadas de alguém (some as vazias criadas por outra pessoa e as que a pessoa fechou)
function dmsFor(uid) {
  return q.dmsOf.all(uid, uid, uid)
    .filter((c) => (!c.closed && (c.last_id || c.creator_id === uid)) || voice.get(c.id)?.size) // chamada rolando sempre aparece
    .map((c) => ({ id: c.id, type: 'text', dm: dmOther(c, uid), lastId: c.last_id || 0, lastAt: c.last_at || c.created_at }));
}
function friendsFor(uid) {
  const out = {};
  for (const f of q.friendsOf.all(uid, uid)) {
    const other = f.a === uid ? f.b : f.a;
    out[other] = f.status === 'accepted' ? 'friend' : f.requester === uid ? 'outgoing' : 'incoming';
  }
  return out;
}
function getOrCreateDm(user, otherId) {
  const other = q.userById.get(Number(otherId));
  if (!other) throw fail(404, 'Pessoa não encontrada.');
  if (other.id === user.id) throw fail(400, 'Você não pode mandar mensagem privada para você mesmo.');
  if (other.deleted) throw fail(400, 'Essa conta foi excluída.');
  const [a, b] = pair(user.id, other.id);
  let ch = q.dmFind.get(a, b);
  if (!ch) { q.dmInsert.run(Date.now(), user.id, a, b); ch = q.dmFind.get(a, b); }
  return ch;
}
// manda o evento só para quem pode ver o canal (DM = as duas pessoas; canal normal = todo mundo)
function emit(ch, event, data) {
  if (!restricted(ch)) return broadcast(event, data);
  if (ch.dm_a) return sendTo([ch.dm_a, ch.dm_b], event, data);
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients.values()) if (canSee(q.userById.get(c.userId), ch)) c.res.write(payload);
}
function pushDms(...uids) { for (const u of uids) sendTo([u], 'dms', dmsFor(u)); }
function pushFriends(...uids) { for (const u of uids) sendTo([u], 'friends', friendsFor(u)); }
const isEmoji = (s) => typeof s === 'string' && s.length > 0 && s.length <= 24 && /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20E3/u.test(s) && !/[<>\s]/.test(s);
function reportOut(r) {
  return { id: r.id, messageId: r.message_id, reporterId: r.reporter_id, reason: r.reason, snapshot: JSON.parse(r.snapshot), createdAt: r.created_at };
}

function authUser(req) {
  const token = parseCookies(req).rs_session;
  return token ? q.session.get(token) : undefined;
}
function sessionCookie(token, req) {
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  return `rs_session=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${60 * 60 * 24 * 365}${secure}`;
}

// ---------- Tempo real (Server-Sent Events) ----------
const clients = new Map(); // connId -> { res, userId }
const voice = new Map();   // channelId -> Map(userId -> { connId, muted, deafened, video, screen })

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients.values()) c.res.write(payload);
}
function sendTo(userIds, event, data) {
  const ids = new Set(userIds);
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients.values()) if (ids.has(c.userId)) c.res.write(payload);
}
function onlineIds() {
  return [...new Set([...clients.values()].map((c) => c.userId))];
}
const voiceMod = new Map(); // userId -> { mute, deaf } (silenciado / áudio desativado "no servidor")
// tira alguém da sala também direto no LiveKit (se a pessoa não sair sozinha)
function livekitKick(room, identity) {
  if (!livekitProc) return;
  const now = Math.floor(Date.now() / 1000);
  const tok = (() => {
    const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const body = b64url(JSON.stringify({ iss: config.livekit.apiKey, nbf: now - 10, exp: now + 60, video: { room, roomAdmin: true } }));
    return `${head}.${body}.${crypto.createHmac('sha256', config.livekit.apiSecret).update(`${head}.${body}`).digest('base64url')}`;
  })();
  const req = http.request({ host: '127.0.0.1', port: config.livekit.port, method: 'POST', path: '/twirp/livekit.RoomService/RemoveParticipant', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' } }, (r) => r.resume());
  req.on('error', () => {});
  req.end(JSON.stringify({ room, identity: String(identity) }));
}
function voiceSnapshot(uid) {
  const out = {};
  for (const [cid, members] of voice) {
    if (!members.size) continue;
    const ch = q.channel.get(cid);
    if (uid !== undefined && restricted(ch) && !canSee(q.userById.get(uid), ch)) continue;
    out[cid] = Object.fromEntries([...members].map(([uid, s]) => [uid, { muted: s.muted, deafened: s.deafened, video: s.video, screen: s.screen, smute: !!voiceMod.get(uid)?.mute, sdeaf: !!voiceMod.get(uid)?.deaf }]));
  }
  return out;
}
// ---------- Ligações privadas (tocam como no celular; dá para recusar) ----------
const calls = new Map(); // channelId -> { msgId, startedAt, joined:Set, declined:Set, ringing:Set, timer }
const RING_MS = 45000;
const callOut = (c) => ({ startedAt: c.startedAt, endedAt: c.endedAt || null, joined: [...c.joined], declined: [...c.declined] });
function saveCall(ch, c) {
  q.setCall.run(JSON.stringify(callOut(c)), c.msgId);
  const row = q.message.get(c.msgId);
  if (row) emit(ch, 'message_edit', rowToMessage(row));
}
function callInfo(uid) {
  const out = {};
  for (const [cid, c] of calls) {
    const ch = q.channel.get(cid);
    if (ch && (ch.dm_a === uid || ch.dm_b === uid)) out[cid] = { ringing: [...c.ringing], startedAt: c.startedAt };
  }
  return out;
}
function pushCall(ch) { for (const u of [ch.dm_a, ch.dm_b]) sendTo([u], 'calls', callInfo(u)); }
function stopRinging(ch, c) { clearTimeout(c.timer); c.ringing.clear(); pushCall(ch); }
function syncCalls() {
  for (const [cid, members] of voice) {
    if (!members.size) continue;
    const ch = q.channel.get(cid);
    if (!ch?.dm_a) continue;
    let c = calls.get(cid);
    if (!c) {
      const starter = [...members.keys()][0];
      c = { startedAt: Date.now(), joined: new Set(members.keys()), declined: new Set(), ringing: new Set() };
      const other = dmOther(ch, starter);
      if (!members.has(other)) c.ringing.add(other);
      const r = q.insertFullMessage.run(ch.id, starter, '', null, c.startedAt, null, null);
      c.msgId = Number(r.lastInsertRowid);
      q.setCall.run(JSON.stringify(callOut(c)), c.msgId);
      q.setRead.run(starter, ch.id, c.msgId);
      calls.set(cid, c);
      emit(ch, 'message', rowToMessage(q.message.get(c.msgId)));
      q.dmReopen.run(ch.id, ch.dm_a); q.dmReopen.run(ch.id, ch.dm_b); pushDms(ch.dm_a, ch.dm_b);
      if (c.ringing.size) c.timer = setTimeout(() => stopRinging(ch, c), RING_MS);
      pushCall(ch);
      continue;
    }
    let changed = false;
    for (const uid of members.keys()) if (!c.joined.has(uid)) { c.joined.add(uid); changed = true; }
    if ([...c.ringing].some((u) => members.has(u))) { for (const u of members.keys()) c.ringing.delete(u); if (!c.ringing.size) clearTimeout(c.timer); pushCall(ch); }
    if (changed) saveCall(ch, c);
  }
  for (const [cid, c] of calls) {
    if (voice.get(cid)?.size) continue;
    calls.delete(cid);
    clearTimeout(c.timer); c.ringing.clear();
    c.endedAt = Date.now();
    const ch = q.channel.get(cid);
    if (!ch) continue;
    saveCall(ch, c);
    pushCall(ch);
  }
}
// ---------- Música ("Ouvir juntos" com o player oficial do YouTube) ----------
// O servidor só guarda a fila e o tempo; cada pessoa toca o vídeo do YouTube no próprio app, sincronizado.
const music = new Map(); // voiceChannelId -> { queue: [track], current: track|null, startedAt, pausedPos, seq }
const MUSIC_CMDS = /^\/(loop|repetir|play|p|tocar|skip|s|pular|next|pause|pausar|resume|continuar|stop|parar|queue|q|fila|np|tocando|remove|remover|clear|limpar|help|ajuda|comandos|shuffle|embaralhar)\b/i;
const musicChannelOf = (sid) => q.server.get(sid)?.music_channel || 0;
function youtubeId(s) {
  s = String(s || '').trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  let u;
  try { u = new URL(s); } catch { return null; }
  const host = u.hostname.replace(/^(www|m|music)\./, '');
  if (host === 'youtu.be') return /^\/([\w-]{11})/.exec(u.pathname)?.[1] || null;
  if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (u.searchParams.get('v') && /^[\w-]{11}$/.test(u.searchParams.get('v'))) return u.searchParams.get('v');
    return /^\/(?:shorts|embed|live|v)\/([\w-]{11})/.exec(u.pathname)?.[1] || null;
  }
  return null;
}
const startAt = (s) => { try { const t = new URL(s).searchParams.get('t'); if (!t) return 0; const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/.exec(t); return m ? ((+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0)) : 0; } catch { return 0; } };
async function youtubeInfo(id) {
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 6000);
    const r = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent('https://www.youtube.com/watch?v=' + id)}`, { signal: ac.signal });
    clearTimeout(timer);
    if (r.status === 401 || r.status === 403) return { blocked: true };
    if (r.status === 404 || r.status === 400) return { missing: true };
    if (!r.ok) return {};
    const j = await r.json();
    return { title: String(j.title || '').slice(0, 200), author: String(j.author_name || '').slice(0, 100) };
  } catch { return {}; }
}
function musicOut(vid) {
  const m = music.get(vid);
  if (!m) return { voiceId: vid, current: null, queue: [], now: Date.now() };
  return { voiceId: vid, current: m.current, queue: m.queue, startedAt: m.startedAt, pausedPos: m.pausedPos, seq: m.seq, loop: m.loop || 'off', now: Date.now() };
}
function pushMusic(vid) { emit(q.channel.get(vid), 'music', musicOut(vid)); }
const musicPos = (m) => (m.pausedPos != null ? m.pausedPos : Date.now() - m.startedAt);
// mensagem do "bot" no #tempo
function botSay(sid, text, extra = {}) {
  const ch = q.channel.get(musicChannelOf(sid));
  if (!ch) return;
  const author = extra.userId || q.admins.all()[0]?.id || q.allUsers.all()[0]?.id;
  if (!author) return;
  const r = q.insertFullMessage.run(ch.id, author, '', null, Date.now(), null, null);
  const id = Number(r.lastInsertRowid);
  q.setSys.run(JSON.stringify({ kind: 'music', text, track: extra.track || null }), id);
  emit(ch, 'message', rowToMessage(q.message.get(id)));
}
const trackLine = (t) => `**${t.title}**${t.author ? ` — ${t.author}` : ''}`;
function playNext(vid, announce = true, ended = false) {
  const m = music.get(vid);
  if (!m) return;
  // repetir: 'one' = a mesma música de novo (só quando ela acaba sozinha); 'all' = a música volta pro fim da fila
  if (ended && m.loop === 'one' && m.current) {
    m.seq = (m.seq || 0) + 1; m.startedAt = Date.now(); m.pausedPos = null;
    return pushMusic(vid);
  }
  if (m.loop === 'all' && m.current) m.queue.push({ ...m.current, key: crypto.randomUUID(), start: 0 });
  m.current = m.queue.shift() || null;
  m.seq = (m.seq || 0) + 1;
  m.startedAt = Date.now() - (m.current?.start || 0) * 1000;
  m.pausedPos = null;
  if (!m.current) { music.delete(vid); if (announce) botSay(m.serverId, '⏹️ A fila acabou. Use `/play link-do-youtube` para tocar mais.'); }
  else if (announce) botSay(m.serverId, `🎶 Tocando agora: ${trackLine(m.current)}`, { track: m.current });
  pushMusic(vid);
}
function voiceOf(uid) { for (const [cid, members] of voice) if (members.has(uid)) return cid; return 0; }
// encerra a música das salas que ficaram vazias
function syncMusic() {
  for (const vid of [...music.keys()]) if (!voice.get(vid)?.size) { music.delete(vid); pushMusic(vid); }
}
// Comandos (no chat #tempo) e botões do player usam a mesma função
async function musicCommand(user, cmd, arg = '', sid = 0) {
  cmd = cmd.toLowerCase();
  const vid = voiceOf(user.id);
  const name = user.display_name;
  const help = 'Comandos: `/play link` (ou `/tocar`), `/pause`, `/resume`, `/skip` (ou `/pular`), `/loop` (ou `/repetir`: música, fila ou off), `/fila`, `/tocando`, `/remover número`, `/embaralhar`, `/limpar`, `/stop` (ou `/parar`).';
  if (['help', 'ajuda', 'comandos'].includes(cmd)) return { reply: `🎵 ${help} O volume da música é de cada um: ajuste no player.` };
  if (!vid) return { reply: '🔇 Entre numa sala de voz primeiro: a música toca para quem está na mesma sala que você.' };
  const vch = q.channel.get(vid);
  let m = music.get(vid);
  switch (cmd) {
    case 'play': case 'p': case 'tocar': {
      if (!arg) {
        if (m?.pausedPos != null) return musicCommand(user, 'resume', '', sid);
        return { reply: '🎵 Use assim: `/play https://www.youtube.com/watch?v=...`' };
      }
      const id = youtubeId(arg);
      if (!id) return { reply: '❌ Esse link não parece ser de um vídeo do YouTube. Cole o link do vídeo (youtube.com/watch?v=... ou youtu.be/...). Busca por nome e playlists ainda não funcionam.' };
      const info = await youtubeInfo(id);
      if (info.missing) return { reply: '❌ Não achei esse vídeo (ele pode ter sido apagado ou ser privado).' };
      if (info.blocked) return { reply: '❌ O dono desse vídeo não deixa ele tocar fora do YouTube. Tenta outro link (geralmente o "lyric video" ou um upload de fã funciona).' };
      const track = { key: crypto.randomUUID(), videoId: id, title: info.title || 'Vídeo do YouTube', author: info.author || '', by: user.id, start: startAt(arg) };
      m = music.get(vid);
      if (!m) { m = { queue: [], current: null, seq: 0, serverId: sid || vch?.server_id }; music.set(vid, m); }
      if (!m.current) { m.queue.unshift(track); playNext(vid, false); return { reply: `🎶 Tocando agora em 🔊 ${vch?.name}: ${trackLine(track)} (pedido por ${name})`, track }; }
      m.queue.push(track);
      pushMusic(vid);
      return { reply: `➕ ${name} adicionou à fila (posição ${m.queue.length}): ${trackLine(track)}`, track };
    }
    case 'pause': case 'pausar':
      if (!m?.current) return { reply: '🔇 Não tem nada tocando.' };
      if (m.pausedPos == null) { m.pausedPos = musicPos(m); pushMusic(vid); }
      return { reply: `⏸️ ${name} pausou a música.` };
    case 'resume': case 'continuar':
      if (!m?.current) return { reply: '🔇 Não tem nada tocando.' };
      if (m.pausedPos != null) { m.startedAt = Date.now() - m.pausedPos; m.pausedPos = null; pushMusic(vid); }
      return { reply: `▶️ ${name} continuou a música.` };
    case 'skip': case 's': case 'pular': case 'next': {
      if (!m?.current) return { reply: '🔇 Não tem nada tocando.' };
      const was = m.current;
      playNext(vid, false);
      const now = music.get(vid)?.current;
      return { reply: `⏭️ ${name} pulou ${trackLine(was)}.${now ? ` Tocando agora: ${trackLine(now)}` : ' A fila acabou.'}`, track: now };
    }
    case 'stop': case 'parar':
      if (!m) return { reply: '🔇 Não tem nada tocando.' };
      music.delete(vid); pushMusic(vid);
      return { reply: `⏹️ ${name} parou a música e limpou a fila.` };
    case 'clear': case 'limpar':
      if (!m?.queue.length) return { reply: '📭 A fila já está vazia.' };
      m.queue = []; pushMusic(vid);
      return { reply: `🧹 ${name} limpou a fila (a música atual continua).` };
    case 'shuffle': case 'embaralhar':
      if (!m || m.queue.length < 2) return { reply: '🔀 Precisa ter pelo menos 2 músicas na fila.' };
      for (let i = m.queue.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [m.queue[i], m.queue[j]] = [m.queue[j], m.queue[i]]; }
      pushMusic(vid);
      return { reply: `🔀 ${name} embaralhou a fila.` };
    case 'remove': case 'remover': {
      const n = parseInt(arg, 10);
      if (!m?.queue.length) return { reply: '📭 A fila está vazia.' };
      if (!(n >= 1 && n <= m.queue.length)) return { reply: `❌ Use \`/remover número\` (de 1 a ${m.queue.length}). Veja os números com \`/fila\`.` };
      const [t] = m.queue.splice(n - 1, 1); pushMusic(vid);
      return { reply: `🗑️ ${name} tirou da fila: ${trackLine(t)}` };
    }
    case 'loop': case 'repetir': {
      if (!m?.current) return { reply: '🔇 Não tem nada tocando.' };
      const a = (arg || '').toLowerCase();
      const next = /^(off|nao|não|desligar|0)$/.test(a) ? 'off' : /^(musica|música|one|1|essa)$/.test(a) ? 'one' : /^(fila|all|tudo|todas)$/.test(a) ? 'all'
        : { off: 'one', one: 'all', all: 'off' }[m.loop || 'off'];
      m.loop = next; pushMusic(vid);
      return { reply: { off: `➡️ ${name} desligou a repetição.`, one: `🔂 ${name} ligou a repetição desta música.`, all: `🔁 ${name} ligou a repetição da fila toda.` }[next] };
    }
    case 'seek': { // mudar a minutagem (barra de progresso, voltar do início, ±10 s)
      if (!m?.current) return { reply: '🔇 Não tem nada tocando.' };
      const sec = Math.max(0, Math.min(24 * 3600, Number(arg) || 0));
      if (m.pausedPos != null) m.pausedPos = sec * 1000; else m.startedAt = Date.now() - sec * 1000;
      m.seq = (m.seq || 0); pushMusic(vid);
      return { reply: `⏩ ${name} mudou a música para ${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}.` };
    }
    case 'np': case 'tocando':
      if (!m?.current) return { reply: '🔇 Não tem nada tocando.' };
      return { reply: `🎶 Tocando agora${m.pausedPos != null ? ' (pausada)' : ''}: ${trackLine(m.current)} — pedido por ${userNameOf(m.current.by)}`, track: m.current };
    case 'queue': case 'q': case 'fila': {
      if (!m?.current) return { reply: '📭 Não tem nada tocando nem na fila.' };
      const lines = m.queue.slice(0, 15).map((t, i) => `${i + 1}. ${trackLine(t)} — ${userNameOf(t.by)}`);
      return { reply: `🎶 Agora: ${trackLine(m.current)}\n${lines.length ? lines.join('\n') + (m.queue.length > 15 ? `\n… e mais ${m.queue.length - 15}` : '') : 'A fila está vazia.'}` };
    }
  }
  return { reply: help };
}
const userNameOf = (id) => q.userById.get(id)?.display_name || 'alguém';

function broadcastVoice() {
  syncCalls();
  syncMusic();
  for (const c of clients.values()) c.res.write(`event: voice\ndata: ${JSON.stringify(voiceSnapshot(c.userId))}\n\n`);
}
function removeFromVoice(userId, connId) {
  let changed = false;
  for (const members of voice.values()) {
    const s = members.get(userId);
    if (s && (!connId || s.connId === connId)) { members.delete(userId); changed = true; }
  }
  return changed;
}
setInterval(() => { for (const c of clients.values()) c.res.write(': ping\n\n'); }, 25000);

// ---------- Token do LiveKit (JWT HS256) ----------
const b64url = (b) => Buffer.from(b).toString('base64url');
function livekitToken(user, room) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    iss: config.livekit.apiKey, sub: String(user.id), name: user.display_name,
    nbf: now - 10, exp: now + 6 * 3600, jti: crypto.randomUUID(),
    video: { room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true },
  };
  const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = crypto.createHmac('sha256', config.livekit.apiSecret).update(unsigned).digest('base64url');
  return `${unsigned}.${sig}`;
}

// ---------- Limite de tentativas de login ----------
const attempts = new Map();
function rateLimit(key) {
  const now = Date.now();
  const a = (attempts.get(key) || []).filter((t) => now - t < 10 * 60 * 1000);
  if (a.length >= 10) throw fail(429, 'Muitas tentativas. Espere alguns minutos.');
  a.push(now);
  attempts.set(key, a);
}

// ---------- Rotas da API ----------
function cleanName(s, max = 32) { return String(s || '').replace(/\s+/g, ' ').trim().slice(0, max); }
function requireAdmin(u) { if (!u.is_admin) throw fail(403, 'Só o administrador pode fazer isso.'); }

async function api(req, res, url) {
  const p = url.pathname;
  const m = req.method;

  if (p === '/api/register' && m === 'POST') {
    rateLimit('reg:' + req.socket.remoteAddress);
    const b = await readJson(req);
    const username = cleanName(b.username, 24).toLowerCase();
    const displayName = cleanName(b.displayName || b.username);
    const srv = checkInvite(b.invite);
    if (!/^[a-z0-9._-]{3,24}$/.test(username)) throw fail(400, 'Usuário: 3 a 24 caracteres (letras, números, ponto, hífen ou _).');
    if (String(b.password || '').length < 6) throw fail(400, 'A senha precisa de pelo menos 6 caracteres.');
    if (q.userByName.get(username)) throw fail(409, 'Esse usuário já existe.');
    const isFirst = q.countUsers.get().n === 0;
    const color = COLORS[q.countUsers.get().n % COLORS.length];
    const r = q.insertUser.run(username, displayName || username, hashPassword(String(b.password)), color, isFirst ? 1 : 0, Date.now());
    const newId = Number(r.lastInsertRowid);
    q.addMember.run(srv.id, newId, Date.now());
    if (isFirst) for (const s of q.servers.all()) q.addMember.run(s.id, newId, Date.now()); // o primeiro (administrador) entra em todos
    q.useInvite.run(srv.id);
    const token = crypto.randomBytes(32).toString('hex');
    q.insertSession.run(token, newId, Date.now());
    broadcast('users', q.allUsers.all().map(publicUser));
    pushServers();
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(token, req) });
  }

  if (p === '/api/invite-info' && m === 'GET') { // nome do servidor de um convite (para a tela de entrar)
    const code = String(url.searchParams.get('code') || '');
    const s = code && q.serverByInvite.get(code.trim());
    if (!s) return send(res, 200, { valid: false });
    const expired = (s.invite_expires && Date.now() > s.invite_expires) || (s.invite_max && s.invite_uses >= s.invite_max);
    return send(res, 200, { valid: !expired, name: s.name, members: q.membersOf.all(s.id).length });
  }

  if (p === '/api/login' && m === 'POST') {
    rateLimit('login:' + req.socket.remoteAddress);
    const b = await readJson(req);
    const u = q.userByName.get(cleanName(b.username, 24).toLowerCase());
    if (!u || !checkPassword(String(b.password || ''), u.pass_hash)) throw fail(401, 'Usuário ou senha incorretos.');
    const token = crypto.randomBytes(32).toString('hex');
    q.insertSession.run(token, u.id, Date.now());
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(token, req) });
  }

  const user = authUser(req);
  if (!user) throw fail(401, 'Não autenticado.');

  if (p === '/api/logout' && m === 'POST') {
    q.deleteSession.run(parseCookies(req).rs_session);
    return send(res, 200, { ok: true }, { 'Set-Cookie': 'rs_session=; Path=/; Max-Age=0' });
  }

  if (p === '/api/state' && m === 'GET') {
    const visible = new Set(channelsFor(user).map((c) => c.id));
    const unread = Object.fromEntries(q.unread.all(user.id, user.id, user.id, user.id).filter((r) => r.channel_id && (visible.has(r.channel_id) || q.channel.get(r.channel_id)?.dm_a)).map((r) => [r.channel_id, r.n]));
    return send(res, 200, {
      me: publicUser(user),
      users: q.allUsers.all().map(publicUser),
      channels: channelsFor(user),
      categories: categoriesFor(user),
      notif: user.notif ? JSON.parse(user.notif) : null,
      servers: serversFor(user),
      online: onlineIds(),
      voice: voiceSnapshot(user.id),
      dms: dmsFor(user.id),
      friends: friendsFor(user.id),
      calls: callInfo(user.id),
      music: Object.fromEntries([...music.keys()].filter((vid) => canSee(user, q.channel.get(vid))).map((vid) => [vid, musicOut(vid)])),

      unread,
      voiceEnabled: !!config.livekit.enabled,
      desktopDownload: fs.existsSync(path.join(PUBLIC, 'download', 'DiscordIA-Windows.zip')) ? '/download/DiscordIA-Windows.zip' : null,

      lastRead: Object.fromEntries(q.lastReads.all(user.id).map((r) => [r.channel_id, r.last_id])),
    });
  }

  if (p === '/api/events' && m === 'GET') {
    const connId = String(url.searchParams.get('c') || crypto.randomUUID()).slice(0, 64);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    const wasOnline = onlineIds().includes(user.id);
    const old = clients.get(connId);
    if (old) old.res.end();
    clients.set(connId, { res, userId: user.id });
    if (!wasOnline) broadcast('presence', onlineIds());
    req.on('close', () => {
      if (clients.get(connId)?.res !== res) return;
      clients.delete(connId);
      if (removeFromVoice(user.id, connId)) broadcastVoice();
      if (!onlineIds().includes(user.id)) broadcast('presence', onlineIds());
    });
    return;
  }

  if (p === '/api/messages' && m === 'GET') {
    const channelId = Number(url.searchParams.get('channel'));
    const before = Number(url.searchParams.get('before')) || 0;
    const ch = q.channel.get(channelId);
    if (!ch || ch.type !== 'text' || !canSee(user, ch)) throw fail(404, 'Canal não encontrado.');
    const rows = before ? q.before.all(channelId, before, 50) : q.latest.all(channelId, 50);
    return send(res, 200, rows.reverse().map(rowToMessage));
  }

  // Busca de mensagens (igual ao Discord: texto + filtros de:, em:, tem:, menciona:, antes:, depois:, durante:)
  if (p === '/api/search' && m === 'GET') {
    const sp = url.searchParams;
    const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    const words = norm(sp.get('q')).split(/\s+/).filter(Boolean).slice(0, 12);
    const ids = (k) => (sp.get(k) || '').split(',').map(Number).filter(Boolean);
    const from = ids('from'), inCh = ids('in'), mentions = ids('mentions');
    const has = (sp.get('has') || '').split(',').filter(Boolean);
    const before = Number(sp.get('before')) || 0, after = Number(sp.get('after')) || 0;
    const scope = sp.get('scope') || 'server';
    const sort = sp.get('sort') === 'old' ? 'old' : 'new';
    const offset = Math.max(0, Number(sp.get('offset')) || 0);
    // canais onde dá para buscar: no servidor = canais de texto; numa conversa privada = só ela
    let allowed;
    if (scope === 'server') { const sid = Number(sp.get('server')) || 0; allowed = channelsFor(user).filter((c) => c.type === 'text' && !c.parent_id && (!sid || c.server_id === sid)).map((c) => c.id); }
    else { const ch = q.channel.get(Number(scope)); if (!ch || !canSee(user, ch)) throw fail(404, 'Conversa não encontrada.'); allowed = [ch.id]; }
    if (inCh.length) allowed = allowed.filter((id) => inCh.includes(id));
    if (!allowed.length) return send(res, 200, { total: 0, results: [] });
    const conds = [`channel_id IN (${allowed.map(() => '?').join(',')})`, 'call IS NULL'];
    const args = [...allowed];
    if (from.length) { conds.push(`user_id IN (${from.map(() => '?').join(',')})`); args.push(...from); }
    if (before) { conds.push('created_at < ?'); args.push(before); }
    if (after) { conds.push('created_at >= ?'); args.push(after); }
    const rows = db.prepare(`SELECT * FROM messages WHERE ${conds.join(' AND ')} ORDER BY id ${sort === 'old' ? 'ASC' : 'DESC'}`).all(...args);
    const mentionNames = mentions.map((id) => q.userById.get(id)?.username).filter(Boolean).map((n) => new RegExp(`@${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'));
    const hits = rows.filter((r) => {
      const fwd = r.forward ? JSON.parse(r.forward) : null;
      const att = r.attachment ? JSON.parse(r.attachment) : fwd?.attachment || null;
      const text = [r.content, fwd?.content].filter(Boolean).join('\n');
      if (words.length) { const hay = norm(text + ' ' + (att?.name || '')); if (!words.every((w) => hay.includes(w))) return false; }
      if (mentionNames.length && !mentionNames.every((re) => re.test(text))) return false;
      for (const k of has) {
        if (k === 'link' && !/https?:\/\//i.test(text)) return false;
        if (k === 'arquivo' && !att) return false;
        if (k === 'imagem' && !att?.type?.startsWith('image/')) return false;
        if (k === 'video' && !att?.type?.startsWith('video/')) return false;
        if (k === 'audio' && !att?.type?.startsWith('audio/')) return false;
        if (k === 'encaminhada' && !fwd) return false;
      }
      return true;
    });
    return send(res, 200, { total: hits.length, results: hits.slice(offset, offset + 25).map(rowToMessage) });
  }

  if (p === '/api/upload' && m === 'POST') {
    const max = config.maxUploadMB * 1024 * 1024;
    const name = cleanName(decodeURIComponent(req.headers['x-filename'] || 'arquivo'), 120).replace(/[\\/:*?"<>|]/g, '_') || 'arquivo';
    const type = String(req.headers['content-type'] || 'application/octet-stream').split(';')[0];
    const stored = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${path.extname(name).slice(0, 10).replace(/[^.\w]/g, '')}`;
    const dest = path.join(UPLOADS, stored);
    const out = fs.createWriteStream(dest);
    let size = 0;
    try {
      for await (const chunk of req) {
        size += chunk.length;
        if (size > max) throw fail(413, `Arquivo maior que ${config.maxUploadMB} MB.`);
        if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      }
      await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
    } catch (e) {
      out.destroy();
      fs.rm(dest, { force: true }, () => {});
      throw e;
    }
    fs.writeFileSync(dest + '.meta', JSON.stringify({ name, type }));
    return send(res, 200, { url: `/uploads/${stored}`, name, size, type });
  }

  if (p === '/api/voice-token' && m === 'GET') {
    if (!config.livekit.enabled) throw fail(503, 'Voz desativada no servidor.');
    const ch = q.channel.get(Number(url.searchParams.get('channel')));
    if (!ch || !(ch.type === 'voice' || ch.dm_a) || !canSee(user, ch)) throw fail(404, 'Canal de voz não encontrado.');
    if (!livekitProc) throw fail(503, 'O servidor de voz não está rodando no PC do servidor. Quem cuida do servidor precisa fechar e abrir o DiscordIA.bat de novo.');
    return send(res, 200, { token: livekitToken(user, `canal-${ch.id}`), path: '/livekit' });
  }

  if (p === '/api/action' && m === 'POST') {
    const b = await readJson(req);
    const result = await action(user, b);
    return send(res, 200, result || { ok: true });
  }

  throw fail(404, 'Rota não encontrada.');
}

// Quando chega/sai mensagem num tópico, atualiza o contador na mensagem de origem
function touchThreadParent(ch) {
  if (!ch?.parent_message_id) return;
  const pm = q.message.get(ch.parent_message_id);
  if (pm) broadcast('message_edit', rowToMessage(pm));
}

async function action(user, b) {
  switch (b.type) {
    case 'send': {
      const ch = q.channel.get(Number(b.channelId));
      if (!ch || ch.type !== 'text' || ch.parent_id || !canSee(user, ch)) throw fail(404, 'Canal não encontrado.');
      const content = String(b.content || '').slice(0, 4000).trim();
      if (ch.dm_a && q.userById.get(dmOther(ch, user.id))?.deleted) throw fail(400, 'Essa conta foi excluída. Não dá para mandar mensagem.');
      // comandos de música só no canal #tempo (assim não polui os outros canais)
      const cmdMatch = MUSIC_CMDS.exec(content);
      if (cmdMatch && ch.id !== musicChannelOf(ch.server_id)) {
        const mc = q.channel.get(musicChannelOf(ch.server_id));
        throw fail(400, mc ? `Comandos de música só funcionam no canal #${mc.name}.` : 'O canal de música foi apagado. Peça para o administrador criar de novo.');
      }
      let attachment = null;
      if (b.attachment && typeof b.attachment.url === 'string' && /^\/uploads\/[\w.-]+$/.test(b.attachment.url)) {
        attachment = { url: b.attachment.url, name: String(b.attachment.name || '').slice(0, 120), size: Number(b.attachment.size) || 0, type: String(b.attachment.type || '').slice(0, 100) };
      }
      if (!content && !attachment) throw fail(400, 'Mensagem vazia.');
      let replyTo = null;
      if (b.replyTo) {
        const target = q.message.get(Number(b.replyTo));
        if (target && target.channel_id === ch.id) replyTo = target.id;
      }
      const r = q.insertFullMessage.run(ch.id, user.id, content, attachment ? JSON.stringify(attachment) : null, Date.now(), replyTo, null);
      const msg = rowToMessage(q.message.get(Number(r.lastInsertRowid)));
      q.setRead.run(user.id, ch.id, msg.id);
      emit(ch, 'message', msg);
      if (ch.dm_a) { q.dmReopen.run(ch.id, ch.dm_a); q.dmReopen.run(ch.id, ch.dm_b); pushDms(ch.dm_a, ch.dm_b); }
      touchThreadParent(ch);
      if (cmdMatch) {
        const res = await musicCommand(user, cmdMatch[1], content.slice(cmdMatch[0].length).trim(), ch.server_id);
        botSay(ch.server_id, res.reply, { track: res.track });
      }
      return { ok: true, id: msg.id };
    }
    case 'edit': {
      const msg = q.message.get(Number(b.id));
      if (!msg || msg.user_id !== user.id || msg.call) throw fail(403, 'Você só pode editar suas mensagens.');
      const content = String(b.content || '').slice(0, 4000).trim();
      if (!content && !msg.attachment) throw fail(400, 'Mensagem vazia.');
      q.editMessage.run(content, Date.now(), msg.id);
      emit(q.channel.get(msg.channel_id), 'message_edit', rowToMessage(q.message.get(msg.id)));
      return;
    }
    case 'delete': {
      const msg = q.message.get(Number(b.id));
      if (!msg) return;
      const mch = q.channel.get(msg.channel_id);
      if (msg.user_id !== user.id && (!user.is_admin || mch?.dm_a)) throw fail(403, 'Sem permissão.');
      q.deleteMessage.run(msg.id);
      emit(mch, 'message_delete', { id: msg.id, channelId: msg.channel_id });
      touchThreadParent(q.channel.get(msg.channel_id));
      return;
    }
    case 'read': {
      q.setRead.run(user.id, Number(b.channelId), Number(b.messageId) || 0);
      return;
    }
    case 'react': {
      const msg = q.message.get(Number(b.messageId));
      if (!msg || !canSee(user, q.channel.get(msg.channel_id))) throw fail(404, 'Mensagem não encontrada.');
      const emoji = String(b.emoji || '');
      if (!isEmoji(emoji)) throw fail(400, 'Emoji inválido.');
      const has = !!q.hasReaction.get(msg.id, user.id, emoji);
      const on = b.on === undefined ? !has : !!b.on;
      if (on && !has) {
        if (q.distinctEmojis.get(msg.id).n >= 20 && !q.reactionsOf.all(msg.id).some((r) => r.emoji === emoji)) throw fail(400, 'Limite de 20 reações diferentes por mensagem (igual ao Discord).');
        q.addReaction.run(msg.id, user.id, emoji, Date.now());
      } else if (!on && has) q.delReaction.run(msg.id, user.id, emoji);
      emit(q.channel.get(msg.channel_id), 'message_edit', rowToMessage(q.message.get(msg.id)));
      return { on };
    }
    case 'forward': {
      const src = q.message.get(Number(b.messageId));
      const from = src && q.channel.get(src.channel_id);
      if (!src || !canSee(user, from)) throw fail(404, 'Mensagem não encontrada.');
      const dest = b.userId ? getOrCreateDm(user, b.userId) : q.channel.get(Number(b.channelId));
      if (!dest || dest.type !== 'text' || dest.parent_id || !canSee(user, dest)) throw fail(404, 'Canal não encontrado.');
      const fwd = src.forward ? JSON.parse(src.forward) : {
        fromChannelId: src.channel_id, fromChannelName: from?.dm_a ? '' : from?.name || '', fromDm: from?.dm_a ? [from.dm_a, from.dm_b] : undefined, messageId: src.id, userId: src.user_id,
        content: src.content, attachment: src.attachment ? JSON.parse(src.attachment) : null, createdAt: src.created_at,
      };
      const comment = String(b.comment || '').slice(0, 2000).trim();
      const r = q.insertFullMessage.run(dest.id, user.id, comment, null, Date.now(), null, JSON.stringify(fwd));
      const msg = rowToMessage(q.message.get(Number(r.lastInsertRowid)));
      q.setRead.run(user.id, dest.id, msg.id);
      emit(dest, 'message', msg);
      if (dest.dm_a) { q.dmReopen.run(dest.id, dest.dm_a); q.dmReopen.run(dest.id, dest.dm_b); pushDms(dest.dm_a, dest.dm_b); }
      touchThreadParent(dest);
      return { ok: true, id: msg.id };
    }
    case 'typing': {
      const ch = q.channel.get(Number(b.channelId));
      if (canSee(user, ch)) emit(ch, 'typing', { channelId: ch.id, userId: user.id });
      return;
    }
    case 'voice_join': {
      const ch = q.channel.get(Number(b.channelId));
      if (!ch || !(ch.type === 'voice' || ch.dm_a) || !canSee(user, ch)) throw fail(404, 'Canal de voz não encontrado.');
      removeFromVoice(user.id);
      if (!voice.has(ch.id)) voice.set(ch.id, new Map());
      voice.get(ch.id).set(user.id, { connId: String(b.connId || ''), muted: !!b.muted, deafened: !!b.deafened, video: false, screen: false });
      if (ch.dm_a) { q.dmReopen.run(ch.id, ch.dm_a); q.dmReopen.run(ch.id, ch.dm_b); pushDms(ch.dm_a, ch.dm_b); }
      broadcastVoice();
      return;
    }
    // ---- quem está na sala: desconectar, mover e silenciar no servidor (qualquer membro que vê a sala pode)
    case 'voice_kick':
    case 'voice_move':
    case 'voice_mod': {
      const target = q.userById.get(Number(b.userId));
      const cid = target && voiceOf(target.id);
      const ch = cid && q.channel.get(cid);
      if (!ch || ch.dm_a || !canSee(user, ch)) throw fail(404, 'Essa pessoa não está numa sala de voz.');
      if (b.type === 'voice_kick') {
        sendTo([target.id], 'voice_command', { cmd: 'disconnect', by: user.display_name });
        removeFromVoice(target.id);
        livekitKick(`canal-${ch.id}`, target.id);
        broadcastVoice();
        return;
      }
      if (b.type === 'voice_move') {
        const dest = q.channel.get(Number(b.channelId));
        if (!dest || dest.type !== 'voice' || dest.id === ch.id || !canSee(user, dest) || !canSee(target, dest)) throw fail(400, 'Não dá para mover para essa sala.');
        sendTo([target.id], 'voice_command', { cmd: 'move', channelId: dest.id, by: user.display_name });
        return;
      }
      const cur = voiceMod.get(target.id) || {};
      if (b.mute !== undefined) cur.mute = !!b.mute;
      if (b.deaf !== undefined) cur.deaf = !!b.deaf;
      if (cur.mute || cur.deaf) voiceMod.set(target.id, cur); else voiceMod.delete(target.id);
      sendTo([target.id], 'voice_command', { cmd: 'mod', mute: !!cur.mute, deaf: !!cur.deaf, by: user.display_name });
      broadcastVoice();
      return;
    }
    case 'voice_leave': {
      if (removeFromVoice(user.id)) broadcastVoice();
      return;
    }
    case 'voice_state': {
      for (const members of voice.values()) {
        const s = members.get(user.id);
        if (s) Object.assign(s, { muted: !!b.muted, deafened: !!b.deafened, video: !!b.video, screen: !!b.screen });
      }
      broadcastVoice();
      return;
    }
    case 'profile': {
      const name = cleanName(b.displayName) || user.display_name;
      const color = /^#[0-9a-f]{6}$/i.test(b.color || '') ? b.color : user.color;
      q.updateProfile.run(name, color, user.id);
      // foto e banner: só arquivos enviados para este servidor (ou cor, no banner); null tira
      const okUpload = (v) => typeof v === 'string' && /^\/uploads\/[\w.-]+$/.test(v);
      if (b.avatar !== undefined) q.setAvatar.run(okUpload(b.avatar) ? b.avatar : null, user.id);
      if (b.banner !== undefined) q.setBanner.run(okUpload(b.banner) || /^#[0-9a-f]{6}$/i.test(b.banner || '') ? b.banner : null, user.id);
      if (b.newPassword) {
        if (!checkPassword(String(b.currentPassword || ''), user.pass_hash)) throw fail(403, 'Senha atual incorreta.');
        if (String(b.newPassword).length < 6) throw fail(400, 'A nova senha precisa de pelo menos 6 caracteres.');
        q.updatePassword.run(hashPassword(String(b.newPassword)), user.id);
      }
      broadcast('users', q.allUsers.all().map(publicUser));
      return;
    }
    case 'channel_create': {
      requireAdmin(user);
      const type = b.channelType === 'voice' ? 'voice' : 'text';
      let name = cleanName(b.name, 40);
      if (type === 'text') name = name.toLowerCase().replace(/\s+/g, '-');
      if (!name) throw fail(400, 'Dê um nome ao canal.');
      const cat = b.categoryId ? q.category.get(Number(b.categoryId)) : null;
      const sid = cat?.server_id || Number(b.serverId);
      if (!q.server.get(sid)) throw fail(404, 'Servidor não encontrado.');
      const r = q.insertChannel2.run(name, type, q.maxPosIn.get(type, sid).p + 1, Date.now(), cat ? cat.id : null, b.private ? 1 : 0, sid);
      const id = Number(r.lastInsertRowid);
      if (b.private) setAccess('channel', id, b.members);
      pushChannels();
      return { id };
    }
    case 'channel_rename':
    case 'channel_update': {
      requireAdmin(user);
      const ch = q.channel.get(Number(b.channelId));
      if (!ch || ch.dm_a) throw fail(404, 'Canal não encontrado.');
      let name = b.name === undefined ? ch.name : cleanName(b.name, 40);
      if (ch.type === 'text') name = name.toLowerCase().replace(/\s+/g, '-');
      if (!name) throw fail(400, 'Dê um nome ao canal.');
      const priv = b.private === undefined ? ch.private : (b.private ? 1 : 0);
      q.updateChannel.run(name, priv, ch.id);
      if (b.private !== undefined) { if (priv) setAccess('channel', ch.id, b.members); else q.accessClear.run('channel', ch.id); }
      pushChannels();
      return;
    }
    case 'channel_delete': {
      const ch = q.channel.get(Number(b.channelId));
      if (!ch || ch.dm_a) return;
      if (!(ch.parent_id && ch.creator_id === user.id)) requireAdmin(user); // quem criou o tópico também pode apagar
      const remaining = q.channels.all().filter((c) => c.type === 'text' && !c.parent_id && c.id !== ch.id && c.server_id === ch.server_id);
      if (ch.type === 'text' && !ch.parent_id && remaining.length === 0) throw fail(400, 'Precisa existir pelo menos um canal de texto.');
      for (const th of q.threadsOf.all(ch.id)) q.deleteChannel.run(th.id);
      q.deleteChannel.run(ch.id);
      q.accessClear.run('channel', ch.id);
      voice.delete(ch.id);
      pushChannels();
      broadcastVoice();
      return;
    }
    // ---- música pelos botões do player
    case 'music': {
      const cmd = String(b.cmd || '');
      if (!/^(play|pause|resume|skip|stop|remove|shuffle|clear|loop|seek)$/.test(cmd)) throw fail(400, 'Comando inválido.');
      const vnow = voiceOf(user.id);
      const sid = music.get(vnow)?.serverId || q.channel.get(vnow)?.server_id || q.servers.all()[0]?.id;
      const res = await musicCommand(user, cmd, String(b.arg ?? '').slice(0, 500), sid);
      const failed = /^(❌|🔇|📭|🔀 Precisa)/.test(res.reply);
      if (failed) throw fail(400, res.reply.replace(/^\S+\s/, ''));
      if (!['pause', 'resume', 'seek', 'loop'].includes(cmd)) botSay(sid, res.reply, { track: res.track }); // controles do player não enchem o #tempo
      return { reply: res.reply };
    }
    case 'music_ended':
    case 'music_error': {
      const vid = Number(b.voiceId);
      const m = music.get(vid);
      if (!m?.current || m.seq !== Number(b.seq) || voiceOf(user.id) !== vid) return; // só o primeiro aviso conta
      if (b.type === 'music_error') botSay(m.serverId, `⚠️ Não deu para tocar ${trackLine(m.current)} (o dono não deixa tocar fora do YouTube ou o vídeo saiu do ar). Pulando…`);
      playNext(vid, true, b.type === 'music_ended');
      return;
    }
    // ---- arrastar canais/categorias (muda a ordem e a categoria)
    case 'channel_move': {
      requireAdmin(user);
      const ch = q.channel.get(Number(b.channelId));
      if (!ch || ch.dm_a || ch.parent_id) throw fail(404, 'Canal não encontrado.');
      const catOf = (c) => (c.category_id && q.category.get(c.category_id) ? c.category_id : null);
      const target = b.targetId ? q.channel.get(Number(b.targetId)) : null;
      if (target && target.server_id !== ch.server_id) throw fail(400, 'Não dá para mover um canal para outro servidor.');
      let catId = target ? catOf(target) : (b.categoryId ? Number(b.categoryId) : null);
      if (catId && q.category.get(catId)?.server_id !== ch.server_id) catId = null;
      const list = q.channels.all().filter((c) => !c.parent_id && c.id !== ch.id && c.server_id === ch.server_id && catOf(c) === catId)
        .sort((x, y) => x.position - y.position || x.id - y.id);
      let i = target ? list.findIndex((c) => c.id === target.id) : -1;
      if (i < 0) i = b.place === 'start' ? 0 : list.length; else if (b.place === 'after') i++;
      list.splice(i, 0, ch);
      list.forEach((c, pos) => q.moveChannel.run(catId, pos, c.id));
      pushChannels();
      return;
    }
    case 'category_move': {
      requireAdmin(user);
      const cat = q.category.get(Number(b.categoryId));
      if (!cat) throw fail(404, 'Categoria não encontrada.');
      const list = q.categories.all().filter((c) => c.id !== cat.id && c.server_id === cat.server_id);
      let i = list.findIndex((c) => c.id === Number(b.targetId));
      if (i < 0) i = list.length; else if (b.place === 'after') i++;
      list.splice(i, 0, cat);
      list.forEach((c, pos) => q.moveCategory.run(pos, c.id));
      pushChannels();
      return;
    }
    // ---- categorias
    case 'category_create': {
      requireAdmin(user);
      const name = cleanName(b.name, 40);
      if (!name) throw fail(400, 'Dê um nome à categoria.');
      const sid = Number(b.serverId);
      if (!q.server.get(sid)) throw fail(404, 'Servidor não encontrado.');
      const r = q.insertCategory.run(name, q.maxCatPosIn.get(sid).p + 1, b.private ? 1 : 0, Date.now(), sid);
      const id = Number(r.lastInsertRowid);
      if (b.private) setAccess('category', id, b.members);
      pushChannels();
      return { id };
    }
    case 'category_update': {
      requireAdmin(user);
      const cat = q.category.get(Number(b.categoryId));
      if (!cat) throw fail(404, 'Categoria não encontrada.');
      const name = b.name === undefined ? cat.name : cleanName(b.name, 40);
      if (!name) throw fail(400, 'Dê um nome à categoria.');
      const priv = b.private === undefined ? cat.private : (b.private ? 1 : 0);
      q.updateCategory.run(name, priv, cat.id);
      if (b.private !== undefined) { if (priv) setAccess('category', cat.id, b.members); else q.accessClear.run('category', cat.id); }
      pushChannels();
      return;
    }
    case 'category_delete': { // os canais dela continuam, só ficam sem categoria
      requireAdmin(user);
      const cat = q.category.get(Number(b.categoryId));
      if (!cat) return;
      q.uncategorize.run(cat.id);
      q.accessClear.run('category', cat.id);
      q.deleteCategory.run(cat.id);
      pushChannels();
      return;
    }
    // ---- notificações (cada pessoa tem as suas)
    case 'notif_set': {
      const json = JSON.stringify(b.notif || {});
      if (json.length > 8000) throw fail(400, 'Configuração grande demais.');
      q.setNotif.run(json, user.id);
      sendTo([user.id], 'notif', JSON.parse(json));
      return;
    }
    case 'server_rename': {
      requireAdmin(user);
      const name = cleanName(b.name, 40);
      if (!name) throw fail(400, 'Dê um nome ao servidor.');
      const s = q.server.get(Number(b.serverId)) || q.servers.all()[0];
      if (!s) throw fail(404, 'Servidor não encontrado.');
      q.renameServer.run(name, s.id);
      pushServers();
      return;
    }
    // ---- administração de pessoas
    case 'member_kick': { // expulsar do servidor (a conta continua; pode voltar com um convite)
      requireAdmin(user);
      const u = q.userById.get(Number(b.userId));
      if (!u || u.deleted) throw fail(404, 'Pessoa não encontrada.');
      if (u.id === user.id || u.is_admin) throw fail(400, 'Não dá para expulsar um administrador.');
      const s = q.server.get(Number(b.serverId));
      if (!s) throw fail(404, 'Servidor não encontrado.');
      q.removeMember.run(s.id, u.id);
      sendTo([u.id], 'kicked', { serverId: s.id, server: s.name });
      pushServers();
      pushChannels(); // ela perde os canais e sai das salas de voz desse servidor
      return;
    }
    case 'member_restore': { // trazer de volta ao servidor quem foi expulso (pela lista de usuários)
      requireAdmin(user);
      const u = q.userById.get(Number(b.userId));
      if (!u || u.deleted) throw fail(404, 'Pessoa não encontrada.');
      const s = q.server.get(Number(b.serverId));
      if (!s) throw fail(404, 'Servidor não encontrado.');
      q.addMember.run(s.id, u.id, Date.now());
      pushServers();
      pushChannels();
      return;
    }
    case 'user_delete': { // excluir a conta (as mensagens ficam como "Usuário excluído", igual ao Discord)
      requireAdmin(user);
      const u = q.userById.get(Number(b.userId));
      if (!u || u.deleted) throw fail(404, 'Pessoa não encontrada.');
      if (u.id === user.id || u.is_admin) throw fail(400, 'Não dá para excluir um administrador.');
      sendTo([u.id], 'deleted', {});
      q.anonymize.run(`excluido-${u.id}-${crypto.randomBytes(3).toString('hex')}`, hashPassword(crypto.randomBytes(24).toString('hex')), u.id);
      q.deleteSessionsOf.run(u.id);
      q.deleteFriendsOf.run(u.id, u.id);
      q.deleteAccessOf.run(u.id);
      q.removeMemberAll.run(u.id);
      for (const [cid, c] of clients) if (c.userId === u.id) { try { c.res.end(); } catch {} clients.delete(cid); }
      removeFromVoice(u.id);
      broadcast('users', q.allUsers.all().map(publicUser));
      broadcast('presence', onlineIds());
      pushServers();
      pushChannels();
      broadcastVoice();
      return;
    }
    case 'server_icon': { // imagem do servidor (ou null para voltar às iniciais)
      requireAdmin(user);
      const s = q.server.get(Number(b.serverId));
      if (!s) throw fail(404, 'Servidor não encontrado.');
      const v = b.icon === 'app' ? 'app' : typeof b.icon === 'string' && /^\/uploads\/[\w.-]+$/.test(b.icon) ? b.icon : null;
      q.setServerIcon.run(v, s.id);
      pushServers();
      return;
    }
    case 'server_join': { // entrar num servidor com convite (link ou código)
      const s = checkInvite(b.invite);
      if (q.isMember.get(s.id, user.id)) return { serverId: s.id, already: true };
      q.addMember.run(s.id, user.id, Date.now());
      q.useInvite.run(s.id);
      pushServers();
      pushChannels();
      return { serverId: s.id };
    }
    case 'server_create': { // só o administrador cria servidores
      requireAdmin(user);
      const name = cleanName(b.name, 40);
      if (!name) throw fail(400, 'Dê um nome ao servidor.');
      const sid = Number(q.insertServer.run(name, COLORS[crypto.randomInt(COLORS.length)], q.maxServerPos.get().p + 1, Date.now(), randomInvite()).lastInsertRowid);
      for (const a of q.admins.all()) q.addMember.run(sid, a.id, Date.now());
      seedServer(sid);
      pushServers();
      pushChannels();
      return { serverId: sid };
    }
    case 'server_delete': {
      requireAdmin(user);
      const s = q.server.get(Number(b.serverId));
      if (!s) return;
      if (q.servers.all().length <= 1) throw fail(400, 'Precisa existir pelo menos um servidor.');
      for (const c of q.channelsOfServer.all(s.id)) { q.accessClear.run('channel', c.id); voice.delete(c.id); music.delete(c.id); q.deleteChannel.run(c.id); }
      for (const c of q.categoriesOfServer.all(s.id)) { q.accessClear.run('category', c.id); q.deleteCategory.run(c.id); }
      q.deleteServer.run(s.id);
      pushServers();
      pushChannels();
      broadcastVoice();
      return;
    }
    // ---- /clean: apagar todas as mensagens de um canal (só o administrador)
    case 'channel_clean': {
      requireAdmin(user);
      const ch = q.channel.get(Number(b.channelId));
      if (!ch || ch.type !== 'text' || ch.dm_a) throw fail(404, 'Canal não encontrado.');
      q.clearChannel.run(ch.id);
      emit(ch, 'channel_cleared', { channelId: ch.id });
      return;
    }
    case 'invite_regen': { // gera um link novo; dá para escolher validade e número de usos
      requireAdmin(user);
      const s = q.server.get(Number(b.serverId));
      if (!s) throw fail(404, 'Servidor não encontrado.');
      const exp = Number(b.expiresIn) || 0;
      q.setInvite.run(randomInvite(), exp > 0 ? Date.now() + Math.min(exp, 365 * 864e5) : 0, Math.max(0, Math.min(1000, Number(b.maxUses) || 0)), s.id);
      pushServers();
      return { inviteInfo: inviteInfo(q.server.get(s.id)) };
    }
    default:
      throw fail(400, 'Ação desconhecida.');
  }
}

// ---------- Arquivos estáticos e anexos ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.mp3': 'audio/mpeg', '.woff2': 'font/woff2', '.zip': 'application/zip',
};
const SAFE_INLINE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'video/mp4', 'video/webm', 'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/webm']);

function serveFile(res, file, headers, req) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Não encontrado');
    // ETag: se o arquivo não mudou, o navegador usa o que já tem (não baixa de novo pelo Tailscale)
    const etag = `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
    if (req && req.headers['if-none-match'] === etag) { res.writeHead(304, { ETag: etag, ...headers }); return res.end(); }
    res.writeHead(200, { 'Content-Length': st.size, ETag: etag, ...headers });
    fs.createReadStream(file).pipe(res);
  });
}

function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p.startsWith('/uploads/')) {
    if (!authUser(req)) return send(res, 401, 'Não autenticado');
    const name = path.basename(p);
    const file = path.join(UPLOADS, name);
    let meta = { name, type: 'application/octet-stream' };
    try { meta = JSON.parse(fs.readFileSync(file + '.meta', 'utf8')); } catch {}
    const inline = SAFE_INLINE.has(meta.type);
    return serveFile(res, file, {
      'Content-Type': inline ? meta.type : 'application/octet-stream',
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(meta.name)}`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, max-age=31536000, immutable',
    });
  }
  if (p === '/') p = '/index.html';
  const file = path.join(PUBLIC, path.normalize(p).replace(/^([/\\])+/, ''));
  if (!file.startsWith(PUBLIC)) return send(res, 403, 'Proibido');
  // bibliotecas grandes (voz, supressão de ruído) nunca mudam: ficam guardadas no aparelho por 1 dia
  const cache = /^\/vendor\//.test(p) ? 'public, max-age=86400' : 'no-cache';
  serveFile(res, file, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': cache }, req);
}

// ---------- Servidor HTTP ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/livekit/')) return proxyLivekitHttp(req, res, url);
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Método não permitido');
    serveStatic(req, res, url);
  } catch (e) {
    if (!e.status) console.error(e);
    if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : 'Erro interno no servidor.' });
    else res.end();
  }
});

// ---------- Proxy para o LiveKit (sinalização por WebSocket) ----------
// O navegador só libera o microfone em HTTPS; o Tailscale entrega HTTPS na porta 443
// e tudo (inclusive o WebSocket do LiveKit) passa por este servidor.
function proxyLivekitHttp(req, res, url) {
  const upstream = http.request({
    host: '127.0.0.1', port: config.livekit.port, method: req.method,
    path: url.pathname.slice('/livekit'.length) + url.search, headers: req.headers,
  }, (up) => { res.writeHead(up.statusCode, up.headers); up.pipe(res); });
  upstream.on('error', () => send(res, 502, { error: 'Servidor de voz indisponível.' }));
  req.pipe(upstream);
}
server.on('upgrade', (req, socket, head) => {
  if (!req.url.startsWith('/livekit/')) return socket.destroy();
  const up = net.connect(config.livekit.port, '127.0.0.1', () => {
    let raw = `${req.method} ${req.url.slice('/livekit'.length)} HTTP/1.1\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
    up.write(raw + '\r\n');
    if (head?.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  up.on('error', () => socket.destroy());
  socket.on('error', () => up.destroy());
});

// ---------- Inicia o LiveKit junto ----------
function tailscaleIp() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const [x, y] = a.address.split('.').map(Number);
      if (x === 100 && y >= 64 && y <= 127) return a.address; // faixa 100.64.0.0/10 do Tailscale
    }
  }
  return '';
}

let livekitProc = null;
function startLivekit() {
  const lk = config.livekit;
  if (!lk.enabled) return console.log('  Voz: desativada em data/config.json');
  const exe = path.join(ROOT, 'livekit', process.platform === 'win32' ? 'livekit-server.exe' : 'livekit-server');
  if (!fs.existsSync(exe)) {
    console.log('  Voz: livekit-server não encontrado. Abra o DiscordIA.bat de novo para baixar.');
    return;
  }
  const ip = lk.nodeIp || tailscaleIp();
  if (!ip) console.log('  Aviso: não achei o IP do Tailscale. O Tailscale está ligado? A voz só vai funcionar neste PC.');
  const yaml = [
    `port: ${lk.port}`,
    'rtc:',
    `  tcp_port: ${lk.tcpPort}`,
    `  port_range_start: ${lk.udpStart}`,
    `  port_range_end: ${lk.udpEnd}`,
    '  use_external_ip: false',
    ...(ip ? [`  node_ip: ${ip}`, '  ips:', '    includes:', '      - 100.64.0.0/10'] : []),
    'keys:',
    `  ${lk.apiKey}: ${lk.apiSecret}`,
    'logging:',
    '  level: warn',
    '',
  ].join('\n');
  const yamlPath = path.join(DATA, 'livekit.yaml');
  fs.writeFileSync(yamlPath, yaml);
  livekitProc = spawn(exe, ['--config', yamlPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  // Esconde o aviso inofensivo "CPU monitoring unsupported" (comum no Windows) e o rastro técnico que vem junto.
  let skipping = false;
  const log = (d) => {
    const out = [];
    for (const l of String(d).split(/\r?\n/)) {
      if (!l.trim()) continue;
      if (/CPU monitoring unsupported/i.test(l)) { skipping = true; continue; }
      if (skipping && !/^\d{4}-\d{2}-\d{2}T/.test(l)) continue;
      skipping = false;
      out.push(`  [voz] ${l}\n`);
    }
    if (out.length) process.stdout.write(out.join(''));
  };
  livekitProc.stdout.on('data', log);
  livekitProc.stderr.on('data', log);
  livekitProc.on('exit', (code) => { if (code) console.log(`  [voz] o servidor de voz parou (código ${code})`); livekitProc = null; });
  console.log(`  Voz: ligada${ip ? ` (Tailscale ${ip})` : ''}`);
}
const stopAll = () => { livekitProc?.kill(); process.exit(0); };
process.on('SIGINT', stopAll);
process.on('SIGTERM', stopAll);

server.listen(config.port, () => {
  console.log('\n  =================== DiscordIA ===================');
  console.log(`  Aberto em:  http://localhost:${config.port}`);
  for (const s of q.servers.all()) console.log(`  Convite:    ${s.invite_code}  (${s.name})`);
  startLivekit();
  console.log('  Para fechar, feche esta janela ou aperte Ctrl+C.');
  console.log('  =================================================\n');
});
