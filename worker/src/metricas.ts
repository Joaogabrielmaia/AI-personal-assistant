/**
 * Medidor de uso e plano de contingência.
 * - Conta requisições, linhas lidas/escritas no D1, chamadas e falhas de IA/Telegram/Google.
 * - Avisa no Telegram quando algum limite do plano grátis passa de 70%, 90% e 98%, dizendo o que pode estar errado.
 * - Aos 90% liga o MODO ECONÔMICO (some só o que é supérfluo) até o limite reiniciar (00:00 UTC = 21:00 em Brasília).
 */
import { retirar, ultimo } from "./contadores";
import type { Env } from "./env";
import { first, kvGet, kvSet, run } from "./db";
import { enviar } from "./telegram";

/** Limites diários do plano grátis (Cloudflare Workers + D1), conferidos na documentação oficial. */
export const LIMITES = { req: 100_000, leituras: 5_000_000, escritas: 100_000, bytes: 5 * 1024 ** 3 };

/** Os limites reiniciam à meia-noite UTC, não à meia-noite de Brasília. */
export const diaUtc = () => new Date().toISOString().slice(0, 10);

export interface Uso {
  dia: string; req: number; leituras: number; escritas: number; bytes: number;
  llm: number; llm_falhas: number; llm_429: number; tg_falhas: number; goog_falhas: number;
}

/** Grava no banco o que foi contado em memória desde o último envio (1 escrita). */
export async function flush(env: Env) {
  const d = retirar();
  if (!Object.keys(d).length) return;
  const g = (k: string) => d[k] ?? 0;
  await run(env.DB,
    `INSERT INTO uso_dia (dia, req, leituras, escritas, bytes, llm, llm_falhas, llm_429, tg_falhas, goog_falhas)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(dia) DO UPDATE SET
       req = req + excluded.req, leituras = leituras + excluded.leituras, escritas = escritas + excluded.escritas,
       llm = llm + excluded.llm, llm_falhas = llm_falhas + excluded.llm_falhas, llm_429 = llm_429 + excluded.llm_429,
       tg_falhas = tg_falhas + excluded.tg_falhas, goog_falhas = goog_falhas + excluded.goog_falhas,
       bytes = CASE WHEN excluded.bytes > 0 THEN excluded.bytes ELSE bytes END`,
    diaUtc(), g("req"), g("leituras"), g("escritas"), ultimo.bytes, g("llm"), g("llm_falhas"), g("llm_429"), g("tg_falhas"), g("goog_falhas"));
}

export const lerUso = (env: Env) => first<Uso>(env.DB, "SELECT * FROM uso_dia WHERE dia = ?", diaUtc());

// ---------------- modo econômico ----------------
let eco: { dia: string; v: boolean; t: number } | null = null;

/** True se o modo econômico está ligado hoje (consulta o banco no máximo 1x por minuto por instância). */
export async function modoEconomico(env: Env): Promise<boolean> {
  const dia = diaUtc();
  if (eco && eco.dia === dia && Date.now() - eco.t < 60_000) return eco.v;
  const v = (await kvGet(env.DB, "economico")) === dia;
  eco = { dia, v, t: Date.now() };
  return v;
}
/** Só o que já se sabe nesta instância, sem consultar o banco (pra uso em código síncrono). */
export const economicoSabido = () => !!eco && eco.dia === diaUtc() && eco.v;

async function ligarEconomico(env: Env) {
  await kvSet(env.DB, "economico", diaUtc());
  eco = { dia: diaUtc(), v: true, t: Date.now() };
}

// ---------------- alertas ----------------
const fmt = (n: number) => n.toLocaleString("pt-BR");
const mb = (b: number) => `${(b / 1024 / 1024).toFixed(1)} MB`;
const REINICIO = "às 21:00 (meia-noite UTC)";

interface Regra { m: keyof Uso; nome: string; limite: number; valor: (n: number) => string; causas: string; acao: string }
const REGRAS: Regra[] = [
  { m: "req", nome: "requisições", limite: LIMITES.req, valor: fmt,
    causas: "muitas mensagens ou toques em botões seguidos; alguém chamando o endereço do bot (ele recusa sem o segredo, mas a chamada ainda conta).",
    acao: "se foi você conversando muito, é só esperar o reinício. Se não foi, me peça pra trocar o segredo do webhook e o endereço." },
  { m: "leituras", nome: "linhas lidas no banco", limite: LIMITES.leituras, valor: fmt,
    causas: "alguma consulta lendo a tabela inteira (índice faltando) ou tabelas muito grandes; uma tarefa nova do relógio mais pesada que o normal.",
    acao: "me peça pra revisar as consultas do relógio. Enquanto isso o modo econômico reduz o trabalho." },
  { m: "escritas", nome: "linhas escritas no banco", limite: LIMITES.escritas, valor: fmt,
    causas: "muitos registros em sequência (gastos, atividades), um lembrete disparando em repetição, ou um erro fazendo o relógio gravar sempre a mesma coisa.",
    acao: "veja se um lembrete ou alarme está repetindo; me peça pra investigar o log ao vivo (wrangler tail)." },
  { m: "bytes", nome: "tamanho do banco", limite: LIMITES.bytes, valor: mb,
    causas: "histórico de conversa e registros acumulados por muito tempo.",
    acao: "exporte um backup (npm run backup) e me peça pra limpar dados antigos." },
];

/** True na primeira vez que a chave aparece (evita avisar duas vezes a mesma coisa no mesmo dia). */
async function primeiraVez(env: Env, chave: string): Promise<boolean> {
  return (await run(env.DB, "INSERT OR IGNORE INTO jobs (chave) VALUES (?)", chave)).changes > 0;
}

/** Roda a cada minuto (depois do flush). Só consulta mais coisas quando algum nível é atingido. */
export async function checarLimites(env: Env) {
  const u = await lerUso(env);
  if (!u) return;

  for (const r of REGRAS) {
    const pct = (Number(u[r.m]) / r.limite) * 100;
    const nivel = [98, 90, 70].find((n) => pct >= n);
    if (!nivel || !(await primeiraVez(env, `alerta:${u.dia}:${r.m}:${nivel}`))) continue;
    const economico = nivel >= 90;
    if (economico) await ligarEconomico(env);
    await enviar(env,
      `⚠️ Uso alto: ${r.nome} em ${pct.toFixed(0)}% do limite grátis de hoje (${r.valor(Number(u[r.m]))} de ${r.valor(r.limite)}).\n\n` +
      `Causas prováveis: ${r.causas}\n\nO que fazer: ${r.acao}\n\n` +
      (nivel >= 98
        ? `Estou quase no limite: se passar, o serviço dá erro até o reinício ${REINICIO} (não há cobrança, não tenho cartão cadastrado).`
        : economico
          ? `🟡 MODO ECONÔMICO ligado até ${REINICIO}: sem foto nem áudio, avisos sem texto gerado por IA, sem espelho na planilha. Lembretes, alarmes, botões e conversa por texto continuam.`
          : `Ainda não é grave. Aos 90% eu ligo o modo econômico sozinho. Reinicia ${REINICIO}.`));
  }

  // falhas de serviços externos: aviso 1x por dia cada
  const falhas: [boolean, string, string][] = [
    [u.llm_429 >= 5, "llm429",
      `⚠️ A IA recusou ${u.llm_429} chamadas hoje por limite de uso (erro 429). Causa provável: o plano grátis do provedor (Groq/Gemini) bateu o limite por minuto ou por DIA (o Groq grátis permite cerca de 200 mil tokens por dia, o que são algumas dezenas de conversas). Se o limite for diário, o bot passa a usar só o reserva até as 21:00. Se não houver reserva, algumas respostas falham.`],
    [u.llm_falhas >= 10, "llm",
      `⚠️ A IA falhou ${u.llm_falhas} vezes hoje. Causas prováveis: provedor fora do ar ou chave inválida/expirada. Confira as chaves (LLM_API_KEY e LLM2_API_KEY); lembretes e alarmes continuam funcionando porque não dependem da IA.`],
    [u.goog_falhas >= 5, "google",
      `⚠️ O Google falhou ${u.goog_falhas} vezes hoje (Agenda/Planilha). Causa provável: o login expirou ou foi revogado. Solução: rodar de novo "python -m app.google_login" no PC e me pedir pra atualizar o segredo. O resto do bot continua.`],
    [u.tg_falhas >= 5, "telegram",
      `⚠️ Tive ${u.tg_falhas} falhas ao falar com o Telegram hoje. Causa provável: instabilidade do Telegram ou token revogado no BotFather.`],
  ];
  for (const [cond, chave, texto] of falhas)
    if (cond && (await primeiraVez(env, `alerta:${u.dia}:${chave}`))) await enviar(env, texto);
}

/** Texto do comando /uso: não gasta nada de IA. */
export async function textoUso(env: Env): Promise<string> {
  // começo do dia (UTC): ainda não há linha, então mostra tudo zerado
  const u: Uso = (await lerUso(env)) ?? { dia: diaUtc(), req: 0, leituras: 0, escritas: 0, bytes: 0, llm: 0, llm_falhas: 0, llm_429: 0, tg_falhas: 0, goog_falhas: 0 };
  const eco2 = await modoEconomico(env);
  const lin = (nome: string, r: Regra) => {
    const n = Number(u[r.m]);
    return `• ${nome}: ${r.valor(n)} de ${r.valor(r.limite)} (${((n / r.limite) * 100).toFixed(1)}%)`;
  };
  return [
    `📊 Uso de hoje (dia UTC ${u.dia}, reinicia ${REINICIO}):`,
    ...REGRAS.map((r) => lin(r.nome, r)),
    `• chamadas de IA: ${u.llm} (falhas: ${u.llm_falhas}, por limite: ${u.llm_429})`,
    `• falhas Telegram: ${u.tg_falhas} · falhas Google: ${u.goog_falhas}`,
    eco2 ? "🟡 Modo econômico: LIGADO" : "🟢 Modo econômico: desligado",
  ].join("\n");
}
