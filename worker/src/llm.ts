/** Cérebro do agente: conversa com o modelo (com 2 provedores e failover) e executa as ferramentas. */
import type { Env } from "./env";
import { all, run } from "./db";
import { executar, contexto, schemasPara, type Ctx } from "./tools";
import { agora, fmtIso, nomeDiaSemana, tsCompleto } from "./time";
import type { Botao } from "./telegram";
import { contar } from "./contadores";
import { kvGet, kvSet } from "./db";
import { diaUtc } from "./metricas";
import { modoEconomico } from "./metricas";

const SYSTEM = `Você é o assistente pessoal de rotina de {nome}, via chat.
Personalidade: direto, amigável, firme. Ele tende a se distrair e procrastinar, então cobre quando necessário, sem sermão.
Respostas CURTAS (textos longos cansam). Português do Brasil. Texto simples: sem markdown (nada de **negrito**, # títulos ou listas com asterisco).

Regras:
- Use SEMPRE as ferramentas para anotar tarefas, registrar atividades, metas e lembretes. Nunca diga que anotou sem chamar a ferramenta.
- Se ele der dia/hora de uma tarefa, passe 'lembrar_em' (AAAA-MM-DDTHH:MM) para o bot avisar na hora. Se faltar a hora, pergunte.
- Se ele disser que mudou a rotina (ex: não vai à academia pra estudar), chame registrar_atividade com feito=false e o motivo.
- Para "quantas vezes fui...", use resumo_semana e responda com números reais.
- Confirme o que anotou em UMA frase.
- Responda SOMENTE com a mensagem final pra {nome}. Nunca escreva notas, observações internas, raciocínio ou texto em inglês.
- Gastos: "gastei 35 no mercado" -> registrar_gasto (categoria curta). Foto de nota fiscal/recibo: leia o total e registre o gasto.
- Foto de academia, estudo ou comida: registrar_atividade (feito=true) e comente em uma frase.
- "vou estudar 50 min" -> iniciar_foco. "me acorda às 7h" -> criar_alarme.
- {nome} enrola e esquece. Seja esperto: deduza o que der e execute VÁRIAS ações numa resposta só. Ex: "não liguei, prefiro mandar mensagem pro Carlos, marca pra semana que vem e me ajuda a escrever" = atualizar_tarefa (novo título) + reagendar_tarefa (motivo) + a mensagem pronta. Use os IDs do ESTADO ATUAL; se houver só uma tarefa que combine, use-a sem perguntar.
- NUNCA crie tarefa nova (anotar_tarefa) quando a conversa é sobre uma tarefa que já existe no ESTADO ATUAL: use atualizar_tarefa / reagendar_tarefa / marcar_nao_feita nela. Dê UMA resposta só, sem repetir o texto.
- Compromisso com dia e hora (consulta, reunião, evento, "marca/agenda X às 15h"): use criar_evento_agenda UMA vez (e se vier "conflitos", só avise na mesma resposta: o evento JÁ foi criado, não pergunte se mantém e não crie de novo). O bot JÁ avisa no Telegram na hora do evento (veja aviso_bot no resultado e confirme o horário do aviso pra ele); NÃO crie tarefa extra pra isso. "o que tenho na agenda?" = listar_agenda.
- "Semana que vem" sem horário = segunda 09:00; "amanhã" sem horário = 09:00; "à noite" = 20:00. Diga a suposição em poucas palavras.
- Se ele disser que não fez/não vai fazer: marcar_nao_feita (ou reagendar_tarefa com motivo). Se uma tarefa tem [adiada 3x] ou mais, confronte com leveza ("é a 3ª vez") e proponha 5 min agora (iniciar_foco) ou quebrar em passos pequenos. Não sermoneie.
- Se ele mencionar algo a fazer sem dizer quando ("preciso ligar pro dentista"), anote e ofereça horários com perguntar_com_opcoes.
- Quando ele pedir ajuda pra escrever mensagem/e-mail/recado: escreva a mensagem PRONTA, natural, curta e no tom dele, dentro de um bloco \`\`\` \`\`\` (assim ele toca e copia). Antes do bloco, no máximo uma frase. Depois, use perguntar_com_opcoes com ["Mais curta", "Mais formal", "Ficou ótima"].
- Quando faltar informação e as respostas forem poucas, use perguntar_com_opcoes em vez de pedir pra ele digitar.
- Pra "como estou indo?", padrões ou conselhos: chame analise_padroes e resumo_semana, e dê 1 ou 2 insights com números reais. Poucos dados = diga que ainda é cedo.
- NUNCA invente horário. Se ele não disse hora/dia, anote a tarefa SEM lembrar_em e pergunte quando (perguntar_com_opcoes). Se ele listar várias coisas ("estudar, trabalhar, mercado"), crie UMA tarefa por item (várias chamadas de anotar_tarefa), sem horário, e pergunte se quer horários.
- Só afirme fatos que estão no ESTADO ATUAL ou no resultado de uma ferramenta nesta conversa. Não invente histórico (ex: "você adiou X" só se X mostrar [adiada Nx]). Na dúvida, não cite.
- Contas: responda só com o resultado, uma vez, sem repetir o cálculo. Ex: "35 × 30 = R$ 1.050".
- O ESTADO ATUAL abaixo é a verdade sobre o que está pendente. Use-o para responder "o que tenho pra fazer".

Agora: {agora} (horário de Brasília)

ESTADO ATUAL:
{contexto}`;

const MAX_HISTORICO = 8;
const MAX_HISTORICO_ECONOMICO = 4; // modo econômico: menos contexto = menos tokens por pergunta
const nomeDono = (env: Env) => env.OWNER_NAME || "usuário";

async function sistema(env: Env): Promise<string> {
  const a = agora();
  return SYSTEM.replaceAll("{nome}", nomeDono(env))
    .replace("{agora}", `${fmtIso(a)} (${nomeDiaSemana(a)})`)
    .replace("{contexto}", await contexto(env));
}

// ---------------- histórico ----------------
async function carregarHistorico(env: Env, limite: number): Promise<Msg[]> {
  const rows = await all<{ role: string; content: string }>(env.DB, "SELECT role, content FROM historico ORDER BY id DESC LIMIT ?", limite);
  return rows.reverse().map((r) => ({ role: r.role, content: r.content }));
}

/** Guarda no histórico (também usado pelo agendador pro bot saber o que ele mesmo enviou). */
export async function registrar(env: Env, role: "user" | "assistant", content: string) {
  await run(env.DB, "INSERT INTO historico (role, content, ts) VALUES (?, ?, ?)", role, content, tsCompleto());
}

// ---------------- limpeza da resposta ----------------
/** Alguns modelos vazam notas internas, repetem a resposta ou imitam o registro de ferramentas. Corta isso. */
export function limpar(t: string): string {
  t = t.replace(/\[(?:executei|resultado da ferramenta|nota do sistema)[^\]]*\]?/g, "").trim(); // registro interno nunca vai pro usuário
  t = t.replace(/[  ]/g, " ");
  t = t.replace(/(\d{1,3}(?: \d{3})+)\.\s?\1(?!\d)/g, "$1"); // "1 050.1 050" -> "1 050"
  t = t.split(/\s*[—–-]*\s*\((?:Note|Nota|Obs)\b/)[0];
  t = t.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  const i = t.length >= 12 ? t.indexOf(t.slice(0, Math.min(40, Math.floor(t.length / 2))), 1) : -1;
  if (i > 0 && t.slice(i).trim() === t.slice(0, i).trim()) t = t.slice(0, i).trim();
  return t;
}

// ---------------- provedores ----------------
type Msg = { role: string; content?: any; tool_calls?: any[]; tool_call_id?: string };
interface Prov { nome: string; base: string; key: string; modelo: string; visao: string; nullable: boolean; timeoutMs: number }

function provedores(env: Env): Prov[] {
  const e = env as unknown as Record<string, string | undefined>;
  const lista: Prov[] = [];
  // LLM = principal; LLM2, LLM3 = reservas, nessa ordem. Cada um com sua chave, endereço e modelo.
  for (const p of ["LLM", "LLM2", "LLM3"]) {
    const key = e[`${p}_API_KEY`], base = e[`${p}_BASE_URL`], modelo = e[`${p}_MODEL`];
    if (!key || !base || !modelo) continue;
    lista.push({ nome: p, base, key, modelo, visao: e[`${p}_VISION_MODEL`] || modelo,
      // Groq precisa de "null" nos parâmetros opcionais; Gemini e a maioria dos outros não aceitam
      nullable: (e[`${p}_NULLABLE`] ?? (p === "LLM" ? "1" : "0")) === "1", timeoutMs: 30000 });
  }
  // quem não é o último tem pouco tempo: lento demais = passa pro próximo (o principal, 12 s; os do meio, 20 s)
  lista.forEach((p, i) => { if (i < lista.length - 1) p.timeoutMs = (i === 0 ? Number(env.LLM_TIMEOUT_PRINCIPAL || 12) : 20) * 1000; });
  return lista;
}

class ErroApi extends Error {
  constructor(public status: number, public corpo: string) { super(`API ${status}: ${corpo.slice(0, 500)}`); }
}
const dorme = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Troca chamadas de ferramenta por texto, pra outro provedor continuar sem erro de formato. */
function achatar(msgs: Msg[], nome: string): Msg[] {
  const out: Msg[] = [];
  let achatou = false;
  for (const m of msgs) {
    if (m.role === "assistant" && m.tool_calls?.length) {
      achatou = true;
      const chamadas = m.tool_calls.map((c: any) => `${c.function.name}(${c.function.arguments})`).join("; ");
      out.push({ role: "assistant", content: `${m.content ?? ""} [executei: ${chamadas}]` });
    } else if (m.role === "tool") {
      out.push({ role: "user", content: `[resultado da ferramenta: ${m.content}]` });
    } else out.push(m);
  }
  if (achatou)
    out.push({ role: "user", content:
      "[nota do sistema] Os trechos entre colchetes acima são só o registro de ferramentas JÁ executadas: nunca os repita nem imite. " +
      `Se ainda falta alguma ação do pedido de ${nome}, chame a ferramenta de verdade agora. Quando tudo estiver feito, responda só com a mensagem final pra ele.` });
  return out;
}

async function chamarUm(p: Prov, modelo: string, msgs: Msg[], ferramentas: boolean, tentativas: number): Promise<any> {
  for (let t = 0; t < tentativas; t++) {
    const ultima = t === tentativas - 1;
    const corpo: Record<string, unknown> = { model: modelo, messages: msgs, temperature: t === 0 ? 0.3 : 0 };
    if (ferramentas) corpo.tools = schemasPara(p.nullable);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), p.timeoutMs);
    try {
      const r = await fetch(`${p.base.replace(/\/$/, "")}/chat/completions`, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${p.key}` }, body: JSON.stringify(corpo), signal: ctl.signal,
      });
      if (r.ok) { contar("llm"); return await r.json(); }
      const txt = await r.text();
      const erro = new ErroApi(r.status, txt);
      if (r.status === 429) {
        if (ultima || tentativas <= 2 || txt.toLowerCase().includes("per day")) throw erro;
        const m = /try again in ([\d.]+)s/.exec(txt);
        await dorme(Math.min(m ? Number(m[1]) * 2000 + 3000 : 10000, 30000));
      } else if (r.status >= 500) {
        if (ultima) throw erro;
        await dorme(tentativas <= 2 ? 1000 : 2000 * (t + 1));
      } else if (r.status === 400 && txt.toLowerCase().includes("tool") && !ultima) {
        // ex: o modelo inventou o nome de uma ferramenta: tenta de novo, mais "comportado"
      } else throw erro;
    } catch (e: any) {
      if (e instanceof ErroApi) throw e;
      // timeout ou rede: com reserva disponível não retenta, passa logo pro próximo
      if (ultima || tentativas <= 2) throw e;
      await dorme(2000 * (t + 1));
    } finally {
      clearTimeout(timer);
    }
  }
}

async function chamar(env: Env, msgs: Msg[], opc: { visao?: boolean; ferramentas?: boolean; origem?: Set<string> } = {}): Promise<{ resp: any; nome: string }> {
  const lista = provedores(env);
  if (!lista.length) throw new Error("Nenhum provedor de IA configurado (LLM_API_KEY)");
  let ultimo: unknown;
  for (let i = 0; i < lista.length; i++) {
    const p = lista[i];
    const eUltimo = i === lista.length - 1;
    // limite DIÁRIO esgotado (ex: Groq grátis = 200 mil tokens/dia): não gasta chamada nem espera à toa até o dia virar
    if (!eUltimo && (await kvGet(env.DB, `llm_off:${p.nome}`)) === diaUtc()) continue;
    const origem = opc.origem ?? new Set<string>();
    const enviar = [...origem].every((o) => o === p.nome) ? msgs : achatar(msgs, nomeDono(env));
    try {
      const resp = await chamarUm(p, opc.visao ? p.visao : p.modelo, enviar, opc.ferramentas ?? true, eUltimo ? 7 : 2);
      return { resp, nome: p.nome };
    } catch (e) {
      ultimo = e;
      contar("llm_falhas");
      if (e instanceof ErroApi && e.status === 429) {
        contar("llm_429");
        if (e.corpo.toLowerCase().includes("per day")) await kvSet(env.DB, `llm_off:${p.nome}`, diaUtc()); // só volta no dia seguinte (UTC)
      }
      console.warn(`provedor ${p.nome} falhou: ${(e as Error).name}: ${(e as Error).message.slice(0, 500)}${eUltimo ? "" : " -> tentando o próximo"}`);
    }
  }
  throw ultimo;
}

// ---------------- áudio e foto ----------------
export async function transcrever(env: Env, audio: ArrayBuffer, nome = "audio.ogg"): Promise<string> {
  const base = (env.STT_BASE_URL || env.LLM_BASE_URL).replace(/\/$/, "");
  const dica = "Assistente de rotina. Termos: reunião, lembrete, agenda, compromisso, tarefa, academia, gastei, marcar, remarcar, amanhã, hoje, às, horas, consulta, mercado.";
  const f = new FormData();
  // o Telegram entrega voz como .oga; o provedor só aceita .ogg (mesmo formato)
  const arq = nome.replace(/.oga$/i, ".ogg");
  const tipos: Record<string, string> = { ogg: "audio/ogg", opus: "audio/ogg", mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", webm: "audio/webm", flac: "audio/flac" };
  f.append("file", new Blob([audio], { type: tipos[arq.split(".").pop()!.toLowerCase()] ?? "audio/ogg" }), arq);
  f.append("model", env.STT_MODEL || "whisper-large-v3");
  f.append("language", "pt");
  f.append("prompt", dica);
  const r = await fetch(`${base}/audio/transcriptions`, { method: "POST", headers: { authorization: `Bearer ${env.STT_API_KEY || env.LLM_API_KEY}` }, body: f });
  if (!r.ok) throw new ErroApi(r.status, await r.text());
  return String(((await r.json()) as any).text ?? "").trim();
}

function paraBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// ---------------- conversa ----------------
/** Devolve a resposta e os botões. Pode lançar erro de API; quem chama avisa o usuário. */
export async function responder(c: Ctx, texto: string, imagem?: ArrayBuffer): Promise<{ texto: string; botoes: Botao[] }> {
  const env = c.env;
  const msgs: Msg[] = [{ role: "system", content: await sistema(env) }, ...(await carregarHistorico(env, (await modoEconomico(env)) ? MAX_HISTORICO_ECONOMICO : MAX_HISTORICO))];
  let paraHistorico = texto;
  if (imagem) {
    msgs.push({ role: "user", content: [
      { type: "text", text: texto || "Veja esta foto." },
      { type: "image_url", image_url: { url: `data:image/jpeg;base64,${paraBase64(imagem)}` } },
    ] });
    paraHistorico = `[foto] ${texto}`.trim();
  } else msgs.push({ role: "user", content: texto });

  c.botoes.length = 0;
  let final: string | null = null;
  const origem = new Set<string>(); // quais provedores já fizeram chamadas de ferramenta nesta conversa
  for (let volta = 0; volta < 6; volta++) {
    const { resp, nome } = await chamar(env, msgs, { visao: !!imagem, origem });
    const msg = resp.choices[0].message;
    if (!msg.tool_calls?.length) {
      final = msg.content || "Feito.";
      break;
    }
    origem.add(nome);
    msgs.push({ role: "assistant", content: msg.content ?? null, tool_calls: msg.tool_calls, ...(msg.extra_content ? { extra_content: msg.extra_content } : {}) });
    for (const call of msg.tool_calls) {
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(call.function.arguments || "{}"); } catch { /* argumentos inválidos: ferramenta responde com erro */ }
      msgs.push({ role: "tool", tool_call_id: call.id, content: await executar(c, call.function.name, args) });
    }
  }
  const limpo = limpar(final ?? "") || "Me perdi aqui, pode repetir?";
  // só grava a conversa se deu certo (evita histórico com mensagens "penduradas")
  await registrar(env, "user", paraHistorico);
  await registrar(env, "assistant", limpo);
  return { texto: limpo, botoes: [...c.botoes] };
}

/** Usado pelo agendador. Se a IA falhar, manda a mensagem simples (o lembrete nunca deixa de sair). */
export async function gerarMensagemProativa(env: Env, instrucao: string): Promise<string> {
  let texto: string;
  if (await modoEconomico(env)) { // modo econômico: o aviso sai com o texto simples, sem gastar IA
    await registrar(env, "assistant", instrucao);
    return instrucao;
  }
  try {
    const { resp } = await chamar(env, [
      { role: "system", content: await sistema(env) },
      { role: "user", content: `[Tarefa interna] Mande a ${nomeDono(env)} uma mensagem curta: ${instrucao}` },
    ], { ferramentas: false });
    texto = limpar(resp.choices[0].message.content ?? "") || instrucao;
  } catch {
    texto = instrucao;
  }
  await registrar(env, "assistant", texto);
  return texto;
}
