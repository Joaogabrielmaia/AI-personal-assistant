# AI Personal Assistant: versão serverless (Cloudflare Workers + D1)

Mesmo assistente da versão Python, mas **sem servidor ligado**: roda nos Workers da Cloudflare, no plano grátis, sem cartão e sem "dormir".

| Peça | Como funciona |
|---|---|
| **Mensagens** | O Telegram chama o Worker por **webhook** (`POST /telegram`) a cada mensagem ou toque em botão |
| **Relógio** | Um **Cron Trigger** roda a cada minuto: lembretes, cobranças, alarmes, avisos de evento, foco e resumos |
| **Banco** | **D1** (SQLite da Cloudflare), esquema em `migrations/` |
| **Segredos** | **Workers Secrets** (criptografados; depois de gravados nem o painel mostra) |
| **Google** | Agenda e Planilhas por REST; o login (refresh token) é feito uma vez no PC |

## Limites do plano grátis (conferidos na documentação em 11/2026)
100 mil requisições por dia · 10 ms de CPU por execução (esperar IA/Telegram/Google **não conta**) · cron a cada minuto, até 5 relógios · D1 com 5 GB, 5 milhões de leituras e 100 mil escritas por dia · 50 chamadas externas por execução.

## Rodar e testar localmente
```bash
cd worker
npm install
node test/devvars.mjs        # gera .dev.vars (segredos SÓ de teste) a partir do .env do bot Python
npm run db:local             # cria o banco local
node test/mock-telegram.mjs  # Telegram falso (outro terminal)
npm run dev                  # Worker local em http://127.0.0.1:8787 (outro terminal)
npx tsx test/run.ts basico,tarefa,agenda,midia,alarme
```
O roteiro de teste fala com o Worker como se fosse o Telegram: texto, botões, foto, áudio, alarme e o relógio.

## Publicar
1. Crie a conta grátis em <https://dash.cloudflare.com/sign-up>.
2. `npx wrangler login` (abre o navegador para autorizar).
3. `npx wrangler d1 create assistente` e cole o `database_id` em `wrangler.jsonc`.
4. `npm run db:remoto` (cria as tabelas no D1 da nuvem).
5. `npm run segredos` (envia as chaves do `.env` para a Cloudflare sem imprimir nada).
6. `npm run deploy` (mostra a URL do Worker).
7. **Desligue o bot Python** (o Telegram não entrega por webhook e por polling ao mesmo tempo) e rode `npm run webhook -- https://SEU-WORKER.workers.dev`.

## Diferenças em relação à versão Python
- O banco é o D1, não o arquivo SQLite local.
- O relógio é da Cloudflare: pode atrasar alguns segundos, sem a precisão de um servidor.
- Cada update do Telegram é processado uma única vez (proteção contra reentrega).
- Os logs de conteúdo ficam desligados (`observability` off): suas mensagens não aparecem em painéis.

## Estrutura
```
src/
  index.ts      webhook do Telegram + relógio (scheduled)
  llm.ts        agente: prompt, 2 provedores com failover, ferramentas, foto e áudio
  tools.ts      ferramentas que a IA chama (tarefas, gastos, agenda, alarme...)
  scheduler.ts  tudo que roda a cada minuto
  botoes.ts     ações dos botões (Fiz / Não fiz / Reagendar...)
  google.ts     Agenda e Planilhas (REST + renovação do token)
  telegram.ts, ntfy.ts, db.ts, time.ts, env.ts
migrations/     esquema do D1
scripts/        enviar-segredos.mjs, ligar-webhook.mjs
test/           Telegram falso e roteiro de testes
```
