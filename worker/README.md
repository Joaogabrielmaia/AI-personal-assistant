# Versão serverless (TypeScript + Cloudflare Workers)

Implementação atual do assistente: roda **sob demanda**, sem servidor ligado.

| Peça | Papel |
|---|---|
| **Webhook** | Recebe cada mensagem e cada toque em botão do Telegram |
| **Relógio de 1 minuto** | Dispara lembretes, cobranças, alarmes, avisos de agenda, foco e resumos |
| **Banco** | SQLite gerenciado (D1), com esquema versionado em `migrations/` |
| **Agente** | Decide quais ferramentas chamar, com mais de um provedor de IA e reserva automática |

## Princípios
- **Leve por padrão**: mídia nunca é guardada, consultas indexadas, limpeza periódica de registros antigos.
- **Mede o próprio uso** e avisa antes de chegar aos limites da infraestrutura gratuita (veja [CONTINGENCIA.md](CONTINGENCIA.md)).
- **Tolerante a falhas**: reentrega de mensagens sem duplicar, retomada das interrompidas e troca automática de provedor de IA.
- **Segredos fora do código**: nada sensível é versionado.

## Estrutura
```
src/
  index.ts      entrada: webhook e relógio
  llm.ts        agente, provedores de IA com reserva, foto e áudio
  tools.ts      ferramentas que o agente pode chamar
  scheduler.ts  tarefas periódicas
  botoes.ts     ações dos botões
  metricas.ts   medição de uso e avisos de contingência
  google.ts     Agenda e Planilhas
  telegram.ts, ntfy.ts, db.ts, time.ts, env.ts
migrations/     esquema do banco
test/           roteiros de teste automatizados
```
