// Banco de dados (SQLite embutido no Node 22.13+ / 24+)
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

export function openDb(dataDir) {
  const db = new DatabaseSync(path.join(dataDir, 'resenha.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    -- NORMAL (recomendado com WAL): cada gravação não espera o disco confirmar. O banco não corrompe;
    -- só numa queda de energia as últimas gravações podem se perder.
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      display_name TEXT NOT NULL,
      pass_hash TEXT NOT NULL,
      color TEXT NOT NULL,
      is_admin INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('text','voice')),
      position INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      content TEXT NOT NULL DEFAULT '',
      attachment TEXT,
      created_at INTEGER NOT NULL,
      edited_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, id);
    CREATE TABLE IF NOT EXISTS reads (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      last_id INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, channel_id)
    );
  `);

  // ---- versões novas: reações, respostas, encaminhar, tópicos, favoritos, denúncias ----
  const addColumn = (table, col, def) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
  };
  addColumn('messages', 'reply_to', 'INTEGER');
  addColumn('messages', 'forward', 'TEXT');
  addColumn('messages', 'thread_id', 'INTEGER');
  addColumn('channels', 'parent_id', 'INTEGER');          // tópico: canal "filho" de um canal de texto
  addColumn('channels', 'parent_message_id', 'INTEGER');  // mensagem que deu origem ao tópico
  addColumn('channels', 'creator_id', 'INTEGER');
  // conversas privadas (DM): canal de texto "escondido" entre duas pessoas (dm_a < dm_b)
  addColumn('messages', 'call', 'TEXT'); // registro de ligação privada (quem ligou, duração, quem atendeu)
  addColumn('channels', 'dm_a', 'INTEGER');
  addColumn('channels', 'dm_b', 'INTEGER');
  db.exec(`
    CREATE TABLE IF NOT EXISTS reactions (
      message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      emoji TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (message_id, user_id, emoji)
    );
    CREATE TABLE IF NOT EXISTS bookmarks (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, message_id)
    );
    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
      reporter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      reason TEXT NOT NULL DEFAULT '',
      snapshot TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      resolved INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_reactions_msg ON reactions(message_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_dm_pair ON channels(dm_a, dm_b) WHERE dm_a IS NOT NULL;
    CREATE TABLE IF NOT EXISTS friends (
      a INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      b INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      requester INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending','accepted')),
      created_at INTEGER NOT NULL,
      PRIMARY KEY (a, b)
    );
    CREATE TABLE IF NOT EXISTS dm_closed (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      PRIMARY KEY (user_id, channel_id)
    );
  `);

  const count = db.prepare('SELECT COUNT(*) AS n FROM channels').get().n;
  if (count === 0) {
    const ins = db.prepare('INSERT INTO channels (name, type, position, created_at) VALUES (?, ?, ?, ?)');
    const now = Date.now();
    ins.run('geral', 'text', 0, now);
    ins.run('memes', 'text', 1, now);
    ins.run('Sala de voz', 'voice', 0, now);
    ins.run('Jogatina', 'voice', 1, now);
  }

  // ---- categorias, canais privados, notificações por pessoa ----
  addColumn('channels', 'category_id', 'INTEGER');
  addColumn('channels', 'private', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('users', 'notif', 'TEXT');
  db.exec(`
    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      private INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS access (
      kind TEXT NOT NULL,
      target_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (kind, target_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
  `);
  // uma vez só: os canais que já existiam vão para as categorias "Canais de texto" e "Canais de voz"
  if (!db.prepare("SELECT 1 FROM meta WHERE k = 'categories_v1'").get()) {
    const now = Date.now();
    const insCat = db.prepare('INSERT INTO categories (name, position, private, created_at) VALUES (?, ?, 0, ?)');
    const textCat = Number(insCat.run('Canais de texto', 0, now).lastInsertRowid);
    const voiceCat = Number(insCat.run('Canais de voz', 1, now).lastInsertRowid);
    db.prepare("UPDATE channels SET category_id = ? WHERE type = 'text' AND dm_a IS NULL AND category_id IS NULL").run(textCat);
    db.prepare("UPDATE channels SET category_id = ? WHERE type = 'voice' AND dm_a IS NULL AND category_id IS NULL").run(voiceCat);
    db.prepare("INSERT INTO meta (k, v) VALUES ('categories_v1', '1')").run();
  }

  // ---- música: mensagens do "bot" e o canal #tempo (categoria Músicas), onde os comandos funcionam
  addColumn('messages', 'sys', 'TEXT');
  // ---- vários servidores: cada canal/categoria pertence a um servidor; quem entra fica em server_members
  db.exec(`
    CREATE TABLE IF NOT EXISTS servers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      icon TEXT,
      color TEXT,
      position INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      invite_code TEXT,
      invite_expires INTEGER NOT NULL DEFAULT 0,
      invite_max INTEGER NOT NULL DEFAULT 0,
      invite_uses INTEGER NOT NULL DEFAULT 0,
      music_channel INTEGER
    );
    CREATE TABLE IF NOT EXISTS server_members (
      server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      joined_at INTEGER NOT NULL,
      PRIMARY KEY (server_id, user_id)
    );
  `);
  addColumn('channels', 'server_id', 'INTEGER');
  addColumn('categories', 'server_id', 'INTEGER');
  addColumn('users', 'member', 'INTEGER NOT NULL DEFAULT 1');
  addColumn('users', 'avatar', 'TEXT'); // foto de perfil (/uploads/...)
  addColumn('users', 'banner', 'TEXT'); // banner do perfil: imagem (/uploads/...) ou cor (#rrggbb)  // 0 = expulso do servidor (continua com a conta)
  addColumn('users', 'deleted', 'INTEGER NOT NULL DEFAULT 0'); // 1 = conta excluída (as mensagens ficam como "Usuário excluído")
  if (!db.prepare("SELECT 1 FROM meta WHERE k = 'music_channel'").get()) {
    const norm = (s) => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
    const now = Date.now();
    let cat = db.prepare('SELECT * FROM categories').all().find((c) => norm(c.name) === 'musicas');
    if (!cat) {
      const pos = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM categories').get().p;
      const id = Number(db.prepare('INSERT INTO categories (name, position, private, created_at) VALUES (?, ?, 0, ?)').run('Músicas', pos, now).lastInsertRowid);
      cat = { id };
    }
    let ch = db.prepare("SELECT * FROM channels WHERE type = 'text' AND dm_a IS NULL AND category_id = ?").all(cat.id).find((c) => norm(c.name) === 'tempo');
    if (!ch) ch = { id: Number(db.prepare("INSERT INTO channels (name, type, position, created_at, category_id, private) VALUES ('tempo', 'text', 0, ?, ?, 0)").run(now, cat.id).lastInsertRowid) };
    db.prepare("INSERT INTO meta (k, v) VALUES ('music_channel', ?)").run(String(ch.id));
  }
  // ---- índices: contar "não lidas" e achar a última mensagem de cada conversa sem ler o canal inteiro
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_unread ON messages(channel_id, id, user_id);
    CREATE INDEX IF NOT EXISTS idx_messages_last ON messages(channel_id, created_at);
  `);
  return db;
}
