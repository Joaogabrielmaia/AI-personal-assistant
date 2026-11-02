/** Entrada do Worker: webhook do Telegram (fetch) e relógio de 1 minuto (scheduled). */
import { acaoBotao } from "./botoes";
import { contar } from "./contadores";
import { run } from "./db";
import type { Env } from "./env";
import { registrar, responder, transcrever } from "./llm";
import { checarLimites, flush, modoEconomico, textoUso } from "./metricas";
import { tick } from "./scheduler";
import { baixarArquivo, definirWebhook, digitando, dono, editar, enviar, responderBotao } from "./telegram";
import { addDias, agora, fmtData, fmtIso } from "./time";
import type { Ctx } from "./tools";

const novoCtx = (env: Env, exec: ExecutionContext): Ctx => ({ env, bg: (p) => exec.waitUntil(p), botoes: [] });

/** Limites de mídia: foto e áudio grandes gastam CPU (10 ms por execução no plano grátis) e tokens de IA. */
const FOTO_MAX_LARGURA = 1280;
const FOTO_MAX_BYTES = 500_000;
const AUDIO_MAX_SEGUNDOS = 120;
const AUDIO_MAX_BYTES = 2_000_000;

/** Telegram manda a mesma foto em vários tamanhos. Pega o maior que ainda é leve (legível pra recibo, barato de processar). */
function escolherFoto(fotos: any[]): any {
  const porTamanho = [...fotos].sort((a, b) => (b.file_size ?? 0) - (a.file_size ?? 0));
  return porTamanho.find((f) => (f.width ?? 0) <= FOTO_MAX_LARGURA && (f.file_size ?? 0) <= FOTO_MAX_BYTES) ?? porTamanho[porTamanho.length - 1];
}

/** Responde com a IA e manda o resultado (com botões, se a IA pediu). */
async function responderIA(c: Ctx, chatId: string, texto: string, imagem?: ArrayBuffer) {
  await digitando(c.env, chatId);
  let resposta: string;
  let botoes: Awaited<ReturnType<typeof responder>>["botoes"] = [];
  try {
    ({ texto: resposta, botoes } = await responder(c, texto, imagem));
  } catch (e) {
    console.error("erro na IA:", (e as Error).message);
    resposta = `⚠️ A IA falhou (${(e as Error).name}). Tente de novo em instantes.`;
  }
  await enviar(c.env, resposta, chatId, botoes);
}

async function tratarMensagem(c: Ctx, msg: any) {
  const chatId = String(msg.chat?.id ?? "");
  const voz = msg.voice ?? msg.audio;
  const foto = msg.photo;
  let texto: string = msg.text ?? msg.caption ?? "";
  if (!(texto || voz || foto) || msg.chat?.type !== "private") return;

  if (!dono(c.env)) { // primeiro uso: mostra seu ID pra você configurar (não processa nada)
    await enviar(c.env, `Seu ID do Telegram é ${chatId}. Configure TELEGRAM_OWNER_ID=${chatId} e reimplante.`, chatId);
    return;
  }
  if (chatId !== dono(c.env)) return; // outras pessoas: ignora, sem resposta e sem gastar IA

  // comando de uso: responde direto do banco, sem gastar nada de IA
  if (/^\/(uso|status)\b/i.test(texto.trim())) {
    await enviar(c.env, await textoUso(c.env), chatId);
    return;
  }

  // mídia: nunca é guardada; só passa pela memória. Mesmo assim, é a parte mais pesada: limites e modo econômico
  if (voz || foto) {
    if (await modoEconomico(c.env)) {
      await enviar(c.env, "🟡 Modo econômico ligado hoje (uso perto do limite grátis). Me mande por texto; foto e áudio voltam às 21:00.", chatId);
      return;
    }
    if (voz && ((voz.duration ?? 0) > AUDIO_MAX_SEGUNDOS || (voz.file_size ?? 0) > AUDIO_MAX_BYTES)) {
      await enviar(c.env, `🎤 Áudio longo demais (limite ${AUDIO_MAX_SEGUNDOS}s). Manda um mais curto ou escreve.`, chatId);
      return;
    }
  }

  let imagem: ArrayBuffer | undefined;
  try {
    if (voz) {
      await digitando(c.env, chatId);
      const a = await baixarArquivo(c.env, voz.file_id);
      texto = await transcrever(c.env, a.dados, a.nome);
      await enviar(c.env, `🎤 Ouvi: ${texto}`, chatId);
    } else if (foto) {
      imagem = (await baixarArquivo(c.env, escolherFoto(foto).file_id)).dados;
    }
  } catch (e) {
    console.error("erro ao baixar/transcrever mídia:", (e as Error).message);
    await enviar(c.env, `⚠️ Não consegui ler o ${voz ? "áudio" : "arquivo"} (${(e as Error).name}).`, chatId);
    return;
  }
  await responderIA(c, chatId, texto, imagem);
}

async function tratarBotao(c: Ctx, cb: any) {
  const chatId = String(cb.message?.chat?.id ?? "");
  const msgId: number = cb.message?.message_id;
  if (chatId !== dono(c.env)) { await responderBotao(c.env, cb.id); return; }
  const dados: string = cb.data ?? "";
  const original: string = cb.message?.text ?? "";

  if (dados.startsWith("op:")) { // opção que a própria IA ofereceu: vira a resposta do usuário
    const escolha = dados.slice(3);
    await responderBotao(c.env, cb.id);
    await editar(c.env, chatId, msgId, `${original}\n\n→ ${escolha}`);
    await responderIA(c, chatId, escolha);
    return;
  }
  let confirmacao: string | null = null;
  try {
    confirmacao = await acaoBotao(c, dados, (t) => responderIA(c, chatId, t));
  } catch (e) {
    console.error(`erro no botão ${dados}:`, (e as Error).message);
    await responderBotao(c.env, cb.id, "Deu erro, tenta de novo");
    return;
  }
  await responderBotao(c.env, cb.id);
  if (confirmacao) {
    await editar(c.env, chatId, msgId, `${original}\n\n${confirmacao}`);
    await registrar(c.env, "assistant", confirmacao);
  }
}

async function tratarUpdate(env: Env, update: any, exec: ExecutionContext) {
  // o Telegram reenvia se demoramos: cada update_id é processado uma só vez
  const marca = await run(env.DB, "INSERT OR IGNORE INTO jobs (chave) VALUES (?)", `u:${update.update_id}`);
  if (!marca.changes) return;
  const c = novoCtx(env, exec);
  if (update.callback_query) await tratarBotao(c, update.callback_query);
  else if (update.message) await tratarMensagem(c, update.message);
}

/** Uma vez por dia (03:10 de Brasília): apaga o que só serve por alguns dias, pra banco e consultas não crescerem sem parar. */
async function limpezaDiaria(env: Env) {
  const a = agora();
  if (a.getUTCHours() !== 3 || a.getUTCMinutes() !== 10) return;
  await run(env.DB, "DELETE FROM envios WHERE ts < ?", fmtData(addDias(a, -60)));
  await run(env.DB, "DELETE FROM avisos_evento WHERE avisado = 1 AND quando < ?", fmtIso(addDias(a, -7)));
  await run(env.DB, "DELETE FROM uso_dia WHERE dia < ?", fmtData(addDias(a, -60)));
  // marcas de updates do Telegram (guarda as últimas 200) e de alertas/resumos de dias passados
  await run(env.DB, "DELETE FROM jobs WHERE chave LIKE 'u:%' AND rowid NOT IN (SELECT rowid FROM jobs WHERE chave LIKE 'u:%' ORDER BY rowid DESC LIMIT 200)");
  const velho = fmtData(addDias(a, -7));
  for (const prefixo of ["alerta:", "manha:", "noite:", "semana:"])
    await run(env.DB, "DELETE FROM jobs WHERE chave LIKE ? AND chave < ?", `${prefixo}%`, `${prefixo}${velho}`);
}

export default {
  async fetch(req: Request, env: Env, exec: ExecutionContext): Promise<Response> {
    contar("req");
    const url = new URL(req.url);

    if (req.method === "POST" && url.pathname === "/telegram") {
      if (req.headers.get("x-telegram-bot-api-secret-token") !== env.TELEGRAM_WEBHOOK_SECRET) return new Response("forbidden", { status: 403 });
      const update = await req.json().catch(() => null);
      if (update) {
        try { await tratarUpdate(env, update, exec); } catch (e) { console.error("erro ao tratar update:", (e as Error).message); }
      }
      exec.waitUntil(flush(env).catch(() => {})); // grava o uso desta requisição (1 escrita)
      return new Response("ok");
    }

    // liga o webhook no Telegram (protegido pelo mesmo segredo): POST /admin/setup
    if (req.method === "POST" && url.pathname === "/admin/setup") {
      if (req.headers.get("authorization") !== `Bearer ${env.TELEGRAM_WEBHOOK_SECRET}`) return new Response("forbidden", { status: 403 });
      const r = await definirWebhook(env, `${url.origin}/telegram`);
      return Response.json({ ok: r?.ok === true, descricao: r?.description ?? null });
    }

    return new Response("AI Personal Assistant (Worker) ok");
  },

  async scheduled(_evento: ScheduledController, env: Env, exec: ExecutionContext): Promise<void> {
    contar("req");
    await modoEconomico(env); // aprende se o modo econômico está ligado (1 leitura por minuto)
    await tick(novoCtx(env, exec));
    await limpezaDiaria(env);
    await flush(env);          // grava o uso do minuto
    await checarLimites(env);  // avisa se algum limite passou de 70/90/98%
  },
} satisfies ExportedHandler<Env>;
