-- Esquema do assistente (mesmo modelo da versão Python/SQLite).
CREATE TABLE IF NOT EXISTS tarefas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  titulo TEXT NOT NULL,
  quando TEXT,
  lembrar_em TEXT,                 -- 'AAAA-MM-DDTHH:MM' (horário de Brasília)
  avisado INTEGER DEFAULT 0,
  feito INTEGER DEFAULT 0,
  criado TEXT,
  adiamentos INTEGER DEFAULT 0,    -- quantas vezes remarcou/não fez
  cobrancas INTEGER DEFAULT 0,     -- cutucadas sem resposta (99 = já respondeu)
  aviso_ts TEXT                    -- quando o aviso saiu (ISO)
);
CREATE TABLE IF NOT EXISTS metas (
  nome TEXT PRIMARY KEY,
  vezes_semana INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS registros (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  data TEXT NOT NULL,
  nome TEXT NOT NULL,
  feito INTEGER NOT NULL,
  obs TEXT
);
CREATE TABLE IF NOT EXISTS lembretes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tipo TEXT NOT NULL,              -- 'fixo' ou 'aleatorio'
  mensagem TEXT NOT NULL,
  hora_fixa TEXT,
  vezes_dia INTEGER,
  inicio TEXT,
  fim TEXT,
  intervalo_min INTEGER,
  ativo INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS envios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lembrete_id INTEGER NOT NULL,
  ts TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS gastos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  data TEXT NOT NULL,
  valor REAL NOT NULL,
  categoria TEXT NOT NULL,
  descricao TEXT
);
CREATE TABLE IF NOT EXISTS focos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  titulo TEXT NOT NULL,
  fim TEXT NOT NULL,
  avisado INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS alarmes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hora TEXT NOT NULL,
  mensagem TEXT NOT NULL,
  ativo INTEGER DEFAULT 1,
  dia TEXT,
  toques INTEGER DEFAULT 0,
  confirmado INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS jobs (
  chave TEXT PRIMARY KEY           -- evita mandar resumo em duplicidade
);
CREATE TABLE IF NOT EXISTS avisos_evento (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  evento_id TEXT NOT NULL UNIQUE,
  titulo TEXT NOT NULL,
  quando TEXT NOT NULL,
  avisado INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS historico (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  ts TEXT NOT NULL
);
-- estado pequeno do próprio worker (ex: última sincronização da agenda)
CREATE TABLE IF NOT EXISTS kv (
  chave TEXT PRIMARY KEY,
  valor TEXT
);
