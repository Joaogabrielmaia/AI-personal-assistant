# AI Personal Assistant

Um assistente pessoal de rotina que mora no **Telegram**. Você conversa por **texto, áudio ou foto** e ele cuida de tarefas, lembretes, gastos e agenda, e **cobra** quando você enrola.

Projeto pessoal de código aberto (MIT), feito como portfólio e para uso próprio. [Política de privacidade](https://joaogabrielmaia.github.io/AI-personal-assistant/privacy.html)

## A ideia

Apps de tarefas esperam que você abra, preencha e organize. Este faz o contrário: **você só conversa**, do jeito que falaria com uma pessoa ("gastei 35 no mercado", "me acorda às 7h", "não fiz, remarca pra semana que vem"), e o assistente entende, executa e **vai atrás de você** na hora certa.

## O que ele faz

| Área | Exemplos |
|---|---|
| **Tarefas e lembretes** | Avisa na hora, com botões (fiz / não fiz / reagendar). Se você ignora, cobra de novo. Se você adia a mesma coisa várias vezes, ele percebe e propõe começar por 5 minutos |
| **Conversa livre** | "não liguei, prefiro mandar mensagem, marca pra semana que vem e me ajuda a escrever" → ele atualiza a tarefa, reagenda, registra o motivo e entrega a mensagem pronta |
| **Gastos** | Registra por texto ou por foto de recibo, e mantém uma cópia em planilha |
| **Agenda** | Cria e consulta compromissos e avisa no horário |
| **Hábitos** | Metas semanais, sequência de dias, humor e padrões ("você pula a academia às quartas") |
| **Foco e alarme** | Cronômetro de estudo e um alarme que insiste até você acordar |
| **Áudio e foto** | Entende áudios e lê recibos |

## Como funciona

```
 Você (Telegram)  ──►  Webhook  ──►  Agente de IA  ──►  Ferramentas (tarefas, gastos, agenda...)
                                          │                         │
                                  vários provedores            Banco de dados
                                   de IA com reserva                │
 Relógio de 1 minuto  ───────────────────────────────────────────►─┘
 (lembretes, alarmes, avisos, resumos)
```

1. Cada mensagem chega ao assistente, que decide **quais ferramentas chamar** (anotar, registrar, reagendar...). Ele não "finge" que anotou: executa de verdade.
2. O **estado atual** (tarefas, metas, lembretes) acompanha cada pergunta, então ele responde com base no que existe.
3. Um **relógio** roda a cada minuto para disparar o que tem hora marcada, sem você precisar abrir nada.

## Decisões de projeto

- **Agente com ferramentas**, em vez de um chat solto: o modelo escolhe a ação e o código a executa, com validação.
- **Mais de um provedor de IA com reserva automática**: se um falhar ou atingir o limite, o próximo assume, inclusive no meio de uma conversa.
- **Ações destrutivas exigem identificação explícita**: nada é apagado "por palpite".
- **Sem servidor ligado**: roda sob demanda (mensagem ou relógio) em infraestrutura gratuita, com **medição do próprio uso**, avisos antes de atingir limites e um modo econômico automático.
- **Resiliência a falhas**: mensagens reentregues não duplicam, e as interrompidas são retomadas.
- **Mídia não é guardada**: fotos e áudios são processados e descartados.

## Tecnologias

TypeScript · Cloudflare Workers · SQLite (D1) · Telegram Bot API · modelos de linguagem via API compatível com OpenAI · Google Agenda e Planilhas. A versão original, em Python, também está no repositório.

## Privacidade e segurança

- Só o dono responde ao bot; mensagens de outras pessoas são ignoradas.
- Chaves e credenciais ficam fora do repositório.
- Os dados pessoais ficam no banco do próprio dono, nunca neste repositório.

## Status

Em uso pessoal. Feito para uma pessoa, e não como serviço público.

## Licença

MIT. Veja [LICENSE](LICENSE).
