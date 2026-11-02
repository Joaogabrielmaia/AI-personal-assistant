-- Medição de uso diário (o dia é UTC, igual ao reinício dos limites da Cloudflare: 21:00 em Brasília).
-- Uma linha por dia: atualizar custa só 1 escrita por minuto.
CREATE TABLE IF NOT EXISTS uso_dia (
  dia TEXT PRIMARY KEY,
  req INTEGER DEFAULT 0,          -- requisições (mensagens, botões, relógio)
  leituras INTEGER DEFAULT 0,     -- linhas lidas no D1
  escritas INTEGER DEFAULT 0,     -- linhas escritas no D1
  bytes INTEGER DEFAULT 0,        -- tamanho do banco
  llm INTEGER DEFAULT 0,          -- chamadas à IA
  llm_falhas INTEGER DEFAULT 0,   -- falhas de provedor de IA
  llm_429 INTEGER DEFAULT 0,      -- ... das quais por limite de uso
  tg_falhas INTEGER DEFAULT 0,    -- falhas ao falar com o Telegram
  goog_falhas INTEGER DEFAULT 0   -- falhas do Google (login, agenda, planilha)
);
