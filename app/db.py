import os
import sqlite3
from contextlib import contextmanager

DB_PATH = os.getenv("DB_PATH", "data/assistente.db")

SCHEMA = """
CREATE TABLE IF NOT EXISTS tarefas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    titulo TEXT NOT NULL,
    quando TEXT,
    lembrar_em TEXT,               -- ISO 'AAAA-MM-DDTHH:MM' (horário de Brasília)
    avisado INTEGER DEFAULT 0,
    feito INTEGER DEFAULT 0,
    criado TEXT
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
    tipo TEXT NOT NULL,            -- 'fixo' ou 'aleatorio'
    mensagem TEXT NOT NULL,
    hora_fixa TEXT,                -- 'HH:MM' (fixo)
    vezes_dia INTEGER,             -- (aleatorio)
    inicio TEXT,                   -- 'HH:MM' (aleatorio)
    fim TEXT,                      -- 'HH:MM' (aleatorio)
    intervalo_min INTEGER,         -- minutos mínimos entre envios (aleatorio)
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
    fim TEXT NOT NULL,             -- ISO 'AAAA-MM-DDTHH:MM'
    avisado INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS alarmes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hora TEXT NOT NULL,            -- 'HH:MM'
    mensagem TEXT NOT NULL,
    ativo INTEGER DEFAULT 1,
    dia TEXT,                      -- último dia em que tocou
    toques INTEGER DEFAULT 0,
    confirmado INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS jobs (
    chave TEXT PRIMARY KEY         -- ex: 'manha:2026-11-02' (evita mandar resumo em duplicidade)
);
CREATE TABLE IF NOT EXISTS avisos_evento (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    evento_id TEXT NOT NULL UNIQUE,   -- id do evento no Google Agenda
    titulo TEXT NOT NULL,
    quando TEXT NOT NULL,             -- 'AAAA-MM-DDTHH:MM' (Brasília): quando o bot deve avisar
    avisado INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS historico (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    ts TEXT NOT NULL
);
"""


@contextmanager
def conn():
    os.makedirs(os.path.dirname(DB_PATH) or ".", exist_ok=True)
    c = sqlite3.connect(DB_PATH)
    c.row_factory = sqlite3.Row
    try:
        yield c
        c.commit()
    finally:
        c.close()


def init():
    with conn() as c:
        c.executescript(SCHEMA)
        # migração: bancos criados na versão anterior não têm estas colunas
        cols = {r["name"] for r in c.execute("PRAGMA table_info(tarefas)")}
        if "lembrar_em" not in cols:
            c.execute("ALTER TABLE tarefas ADD COLUMN lembrar_em TEXT")
        if "avisado" not in cols:
            c.execute("ALTER TABLE tarefas ADD COLUMN avisado INTEGER DEFAULT 0")
        for col, ddl in [("adiamentos", "INTEGER DEFAULT 0"),   # quantas vezes remarcou/não fez
                         ("cobrancas", "INTEGER DEFAULT 0"),    # cutucadas sem resposta (99 = já respondeu)
                         ("aviso_ts", "TEXT")]:                 # quando o aviso saiu
            if col not in cols:
                c.execute(f"ALTER TABLE tarefas ADD COLUMN {col} {ddl}")
