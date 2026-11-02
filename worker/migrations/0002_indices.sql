-- Índices: o relógio roda a cada minuto, então as consultas dele precisam ler só as linhas necessárias
-- (sem índice, o D1 contaria a tabela inteira como "linhas lidas", e o plano grátis tem limite diário).
CREATE INDEX IF NOT EXISTS idx_tarefas_aviso ON tarefas (feito, avisado, lembrar_em);
CREATE INDEX IF NOT EXISTS idx_tarefas_cobranca ON tarefas (feito, avisado, cobrancas);
CREATE INDEX IF NOT EXISTS idx_envios ON envios (lembrete_id, ts);
CREATE INDEX IF NOT EXISTS idx_avisos_evento ON avisos_evento (avisado, quando);
CREATE INDEX IF NOT EXISTS idx_focos ON focos (avisado, fim);
CREATE INDEX IF NOT EXISTS idx_registros_nome ON registros (nome, data);
CREATE INDEX IF NOT EXISTS idx_registros_data ON registros (data);
CREATE INDEX IF NOT EXISTS idx_gastos_data ON gastos (data);
