# AI Personal Assistant

Um assistente de rotina que mora no **Telegram**. Você conversa por **texto, áudio ou foto** e ele cuida de tarefas, lembretes, gastos, agenda e planilha, e **cobra** quando você enrola.

Projeto pessoal e de código aberto (MIT), pensado para rodar 24h num servidor pequeno. [Política de privacidade](https://joaogabrielmaia.github.io/AI-personal-assistant/privacy.html)

## O que ele faz

| Área | Exemplos |
|---|---|
| **Tarefas e lembretes** | "me lembra de ligar pro banco às 15h" → aviso na hora com botões **Fiz / Não fiz / Reagendar / +10 min**; se você ignora, cobra de novo; no 3º adiamento, confronta e propõe 5 minutos agora |
| **Conversa livre** | "não liguei, prefiro mandar mensagem, marca pra semana que vem e me ajuda a escrever" → atualiza a tarefa, reagenda, registra o motivo e entrega a mensagem pronta |
| **Gastos** | "gastei 35 no mercado", ou foto do recibo → banco local + planilha do Google; "apaga o gasto do uber" remove a linha inteira |
| **Agenda (Google)** | "marca reunião amanhã às 16h" → cria o evento, avisa conflitos e **notifica no horário**; também avisa eventos criados direto no app da Agenda |
| **Hábitos e análise** | metas semanais, sequência de dias, motivos de falta, humor e padrões ("você pula a academia às quartas") |
| **Foco e alarme** | cronômetro de estudo; alarme que insiste até você tocar em **Acordei** (e também como notificação urgente no celular via ntfy) |
| **Áudio e foto** | transcreve áudios (Whisper) e lê recibos com um modelo de visão |
| **Resumos automáticos** | bom dia com agenda e tarefas, check-in de humor à noite, resumo semanal |

## Como funciona

```
Telegram ──► bot.py (long polling) ──► llm.py ──► provedor de IA principal ──┐
   ▲             │                        │  ▲                                │ falhou / limite / lento?
   │             │                        │  └──────── reserva (outro) ◄──────┘
   │             ▼                        ▼
   │        botões (callback)       tools.py  ◄── a IA escolhe e chama ferramentas
   │                                  │
   │            ┌─────────────────────┼───────────────────────┐
   │            ▼                     ▼                       ▼
   │        SQLite (db.py)     Google Planilhas / Agenda   ntfy (alarme)
   │
   └──── scheduler.py (a cada minuto): lembretes, cobranças, alarmes, eventos, resumos
```

- **Agente com ferramentas (tool calling):** a IA não "inventa" que anotou; ela chama funções reais (`anotar_tarefa`, `registrar_gasto`, `criar_evento_agenda`, ...) e o código as executa. O estado atual (tarefas, lembretes, metas) vai no prompt a cada mensagem.
- **Dois provedores de IA com failover:** qualquer API compatível com OpenAI. Se o principal der erro, limite de tokens ou demorar demais, o bot passa ao reserva no meio da conversa, sem repetir ações já executadas.
- **Ferramentas destrutivas exigem confirmação de contexto:** apagar um gasto precisa do `id` (a IA lista antes), para nunca apagar "o último" por palpite.
- **Segurança por padrão:** o bot só responde ao seu ID do Telegram; outras pessoas são ignoradas (sem gastar IA).

## Stack

Python 3.11+ · SQLite · APScheduler · httpx · SDK `openai` (qualquer provedor compatível) · `gspread` e Google API Client · Telegram Bot API · ntfy · Docker / systemd.

## Duas versões

- **Python** (`app/`): bot que roda continuamente num servidor (VPS, Docker, PC).
- **Cloudflare Workers** (`worker/`): mesma ideia em TypeScript, **sem servidor ligado** (webhook + relógio de 1 minuto + banco D1), no plano grátis. Veja [worker/README.md](worker/README.md).

## Rodar localmente

```bash
git clone https://github.com/Joaogabrielmaia/AI-personal-assistant.git
cd AI-personal-assistant
pip install -r requirements.txt
cp .env.example .env        # preencha (veja a tabela abaixo)
python -m app.teste         # confere a chave e o modelo de IA
python -m app.bot           # sobe o bot
```

1. No Telegram, fale com **@BotFather** → `/newbot` → cole o token em `TELEGRAM_TOKEN`.
2. Mande "oi" pro seu bot: ele responde com o **seu ID**. Cole em `TELEGRAM_OWNER_ID` e reinicie.

### Variáveis principais (`.env`)

| Variável | Para quê |
|---|---|
| `TELEGRAM_TOKEN`, `TELEGRAM_OWNER_ID` | bot e dono (só o dono conversa) |
| `OWNER_NAME` | como o assistente te chama |
| `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL` | IA principal (ex.: Groq ou Gemini) |
| `LLM2_*` | IA reserva (recomendado) |
| `LLM_VISION_MODEL`, `STT_MODEL` | foto e áudio |
| `GOOGLE_SHEET_ID` | planilha (criada pelo login do Google) |
| `NTFY_TOPIC` | alarme no celular (tópico longo e secreto) |
| `LIMITE_MENSAL`, `EVENTO_AVISO_MIN_ANTES` | alerta de gasto e antecedência do aviso de eventos |

A lista completa e comentada está em [`.env.example`](.env.example).

### Google Planilhas e Agenda (opcional)

1. No Google Cloud: crie um projeto, ative **Google Sheets API** e **Google Calendar API**, e crie um cliente OAuth do tipo **App para computador**. Salve o JSON como `credenciais_oauth.json`.
2. Rode **uma vez**: `python -m app.google_login`. O navegador abre, você autoriza, e o login fica em `token_google.json`. A planilha "Assistente de Rotina" é criada e o ID gravado no `.env`.
3. Enquanto o app do Google estiver em modo "Teste", o login expira em 7 dias; publicar o app (modo produção) evita isso.

## Hospedar 24h

- **Docker:** `docker compose up -d --build` (o `docker-compose.yml` monta o banco e os arquivos de login).
- **Servidor sem Docker:** use [`deploy/assistente.service`](deploy/assistente.service) (systemd, reinicia sozinho) e [`deploy/backup.sh`](deploy/backup.sh) (cópia diária do banco).
- Só **uma** cópia do bot pode rodar por vez (o Telegram recusa duas).

## Segurança e privacidade

- `.env`, `credenciais_oauth.json`, `token_google.json` e a pasta `data/` estão no `.gitignore` e **nunca** devem ser commitados.
- Os logs do cliente HTTP são silenciados porque as URLs do Telegram contêm o token do bot.
- O conteúdo das mensagens vai para os provedores de IA configurados. Em planos gratuitos, alguns usam o conteúdo para melhorar produtos: use plano pago se isso importar.

## Limitações conhecidas

- O Telegram não permite que bots **liguem**; o alarme insiste por mensagens e por notificação urgente (ntfy).
- Planos gratuitos de IA têm limite de tokens por minuto; o failover para o provedor reserva absorve isso.
- Modo WhatsApp (`docker-compose.whatsapp.yml`, Evolution API) é experimental.

## Estrutura

```
app/
  bot.py        entrada do Telegram, botões, áudio e foto
  llm.py        agente: prompt, provedores com failover, loop de ferramentas
  tools.py      ferramentas que a IA pode chamar (tarefas, gastos, agenda...)
  scheduler.py  lembretes, cobranças, alarmes, eventos, resumos (a cada minuto)
  db.py         esquema SQLite
  sheets.py     espelho no Google Planilhas
  agenda.py     Google Agenda
  google_auth.py / google_login.py   login OAuth do Google
  ntfy.py       alarme no celular
deploy/         systemd e backup
docs/           páginas públicas (GitHub Pages): início e política de privacidade
```

## Licença

MIT. Veja [LICENSE](LICENSE).
