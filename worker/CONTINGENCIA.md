# Plano de contingência: operar leve e avisar antes de estourar

O assistente roda no **plano grátis** da Cloudflare, sem cartão cadastrado. Por isso o plano é: gastar o mínimo, medir o uso e avisar no Telegram **antes** de bater em qualquer limite. Passar do limite não gera cobrança: o serviço só dá erro até o reinício diário.

## 1. Como ele economiza (sempre ligado)
| Medida | Efeito |
|---|---|
| **Imagens e áudios nunca são salvos.** Passam só pela memória da requisição; no histórico entra apenas o texto ("[foto] legenda") | zero armazenamento de mídia |
| Foto: usa o maior tamanho que seja ≤ 1280 px e ≤ 500 KB (o Telegram manda vários) | menos CPU e menos tokens de visão |
| Áudio: recusa acima de 120 s ou 2 MB | evita gasto de CPU e de transcrição |
| Histórico de conversa limitado a 8 mensagens | menos tokens por pergunta |
| Índices no banco + limpeza diária (03:10) de registros antigos | o relógio de 1 minuto lê poucas linhas |
| Logs de conteúdo desligados | privacidade e nada a mais para gravar |
| Medição de uso com 1 escrita por minuto | custo mínimo para ter alertas |

## 2. Limites do plano grátis acompanhados (reiniciam 00:00 UTC = 21:00 em Brasília)
| Limite diário | Valor | Avisos |
|---|---|---|
| Requisições | 100.000 | 70% · 90% · 98% |
| Linhas lidas no D1 | 5.000.000 | 70% · 90% · 98% |
| Linhas escritas no D1 | 100.000 | 70% · 90% · 98% |
| Tamanho do banco | 5 GB | 70% · 90% · 98% |

Cada aviso chega **uma vez por nível por dia**, com as **causas prováveis** e **o que fazer**.

## 3. Modo econômico (liga sozinho aos 90%, desliga no reinício)
| Continua funcionando | Pausa até 21:00 |
|---|---|
| Conversa por texto, ferramentas, botões | Foto e áudio (o bot pede para mandar por texto) |
| Lembretes, alarmes, foco, avisos de evento já agendados | Texto gerado por IA nos avisos automáticos (saem em texto simples) |
| Histórico de 4 mensagens (menos tokens) | Espelho na planilha do Google |
| | Leitura periódica da Agenda |

## 4. Falhas de serviços externos (aviso 1x por dia cada)
| Sinal | Causa provável | O que fazer |
|---|---|---|
| IA recusando por limite (erro 429) | plano grátis do Groq/Gemini estourou. O Groq grátis permite cerca de **200 mil tokens por dia** (algumas dezenas de conversas) | esperar; o reserva (LLM2) assume sozinho. Se o limite for **diário**, o bot pula o provedor esgotado até as 21:00, sem gastar chamada à toa |
| Muitas falhas de IA | provedor fora do ar ou chave inválida | conferir `LLM_API_KEY` / `LLM2_API_KEY` |
| Falhas do Google | login expirado ou revogado | `python -m app.google_login` e atualizar o segredo |
| Falhas do Telegram | instabilidade ou token revogado | conferir o bot no @BotFather |

Lembretes e alarmes **não dependem da IA**, então seguem funcionando mesmo com a IA fora.

## 4.1 Mensagem que o Telegram reenvia ou cancela
O Telegram reentrega uma mensagem se a conexão cai ou se demoramos. Cada mensagem tem marcação em **duas fases**: "iniciada" e "ok". Reentrega de mensagem já concluída é ignorada; se uma execução foi cortada e passou de 90 s sem concluir, a mensagem é **tratada de novo** (assim nenhuma é perdida em silêncio).

## 5. Comandos e ferramentas
- **`/uso`** (ou `/status`) no Telegram: mostra o uso de hoje e se o modo econômico está ligado. Não gasta IA.
- `npx wrangler tail`: log ao vivo do Worker (os logs de conteúdo ficam desligados).
- `npm run backup`: exporta o banco para `backups/` (pasta ignorada pelo git, pois contém dados pessoais).

## 6. Se algo passar do limite
O serviço devolve erro até as 21:00 e volta sozinho; **não há cobrança**, porque não há forma de pagamento na conta. Para ter certeza, confira em *Billing → Subscriptions* que continua "Workers Free" e "No payment method on file".

## 7. Plano B: voltar para o bot Python (PC ou servidor)
1. Exporte o banco: `npm run backup`.
2. Desligue o webhook: `https://api.telegram.org/bot<TOKEN>/deleteWebhook`.
3. Suba a versão Python (`python -m app.bot`, veja o README da raiz). Ela usa SQLite próprio; os dados do D1 não migram sozinhos (o backup serve de referência).
