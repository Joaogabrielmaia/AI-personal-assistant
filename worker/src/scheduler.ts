/** Relógio de 1 minuto (Cron Trigger): lembretes, cobranças, alarmes, eventos, foco e resumos. */
import { botoesTarefa } from "./botoes";
import { all, first, kvGet, kvSet, run } from "./db";
import * as G from "./google";
import { gerarMensagemProativa, registrar } from "./llm";
import * as ntfy from "./ntfy";
import { enviar, type Botao } from "./telegram";
import { agendarAvisoEvento, executar, type Ctx } from "./tools";
import { addMin, agora, diaSemana, fmtData, fmtIso, minutosDoDia, parseLocal, tsCompleto } from "./time";

const HORA_MANHA = "07:30";
const HORA_NOITE = "21:30";
const HORA_SEMANAL = "20:00"; // domingo
const ALARME_MAX_TOQUES = 20;
const COBRANCA_MIN = 15; // sem resposta ao aviso: cutuca de novo após 15 min, depois 30 min
const COBRANCA_MAX = 2;
const SYNC_AGENDA_MIN = 5;

const minutos = (hhmm: string) => { const [h, m] = hhmm.split(":"); return +h * 60 + +m; };
const fim = (hhmm: string) => minutos(hhmm);

async function avisarTarefas(c: Ctx) {
  const vencidas = await all<{ id: number; titulo: string }>(
    c.env.DB, "SELECT id, titulo FROM tarefas WHERE feito = 0 AND avisado = 0 AND lembrar_em IS NOT NULL AND lembrar_em <= ?", fmtIso(agora()));
  for (const t of vencidas) {
    const texto = `⏰ Hora de: ${t.titulo}\nConseguiu fazer?`;
    await enviar(c.env, texto, undefined, botoesTarefa(t.id));
    await registrar(c.env, "assistant", texto.replace("\n", " ") + ` (tarefa #${t.id})`);
    await run(c.env.DB, "UPDATE tarefas SET avisado = 1, cobrancas = 0, aviso_ts = ? WHERE id = ?", tsCompleto(), t.id);
  }
}

async function cobrarTarefas(c: Ctx) {
  const pendentes = await all<{ id: number; titulo: string; cobrancas: number; aviso_ts: string }>(
    c.env.DB, "SELECT id, titulo, cobrancas, aviso_ts FROM tarefas WHERE feito = 0 AND avisado = 1 AND aviso_ts IS NOT NULL AND cobrancas < ?", COBRANCA_MAX);
  const frases = ["Ei, e aí: {t}? Fez ou vai adiar?", "Última cutucada: {t}. Resolve agora ou reagenda?"];
  for (const t of pendentes) {
    const espera = COBRANCA_MIN * (t.cobrancas + 1) * 60000;
    if (agora().getTime() - parseLocal(t.aviso_ts).getTime() < espera) continue;
    await enviar(c.env, "👀 " + frases[t.cobrancas].replace("{t}", t.titulo), undefined, botoesTarefa(t.id));
    await run(c.env.DB, "UPDATE tarefas SET cobrancas = cobrancas + 1 WHERE id = ?", t.id);
  }
}

/** Eventos da agenda: lê a Google Agenda (próximas 36h) e garante um aviso pra cada um, mesmo os criados fora do bot. */
async function sincronizarAgenda(c: Ctx) {
  const ultimo = await kvGet(c.env.DB, "sync_agenda");
  const a = agora();
  if (ultimo && a.getTime() - Number(ultimo) < SYNC_AGENDA_MIN * 60000) return;
  await kvSet(c.env.DB, "sync_agenda", String(a.getTime()));
  const eventos = await G.agendaListar(c.env, 1.5);
  if (!Array.isArray(eventos)) return; // sem login do Google: segue sem agenda
  const ids = new Set<string>();
  for (const e of eventos) {
    if (!e.inicio.includes("T")) continue; // dia inteiro não tem horário pra avisar
    ids.add(e.id);
    await agendarAvisoEvento(c.env, e.id, e.titulo, e.inicio);
  }
  const limite = fmtIso(addMin(a, 36 * 60));
  const rows = await all<{ evento_id: string }>(c.env.DB, "SELECT evento_id FROM avisos_evento WHERE avisado = 0 AND quando <= ?", limite);
  for (const r of rows) if (!ids.has(r.evento_id)) await run(c.env.DB, "DELETE FROM avisos_evento WHERE evento_id = ?", r.evento_id); // apagado/movido
}

async function avisarEventos(c: Ctx) {
  const a = agora();
  const vencidos = await all<{ id: number; titulo: string; quando: string }>(c.env.DB, "SELECT id, titulo, quando FROM avisos_evento WHERE avisado = 0 AND quando <= ?", fmtIso(a));
  const antes = Number(c.env.EVENTO_AVISO_MIN_ANTES || 0);
  const enviados = new Set<string>();
  for (const v of vencidos) {
    const chave = `${v.titulo.trim().toLowerCase()}|${v.quando}`; // nunca manda duas vezes a mesma mensagem
    // bot fora do ar por muito tempo: não avisa de evento que já foi há mais de 30 min
    if (!enviados.has(chave) && a.getTime() - parseLocal(v.quando).getTime() <= 30 * 60000) {
      enviados.add(chave);
      const texto = antes === 0 ? `📅 Agora: ${v.titulo}` : `📅 Em ${antes} min: ${v.titulo}`;
      await enviar(c.env, texto);
      await registrar(c.env, "assistant", texto);
    }
    await run(c.env.DB, "UPDATE avisos_evento SET avisado = 1 WHERE id = ?", v.id);
  }
}

async function avisarFocos(c: Ctx) {
  const rows = await all<{ id: number; titulo: string }>(c.env.DB, "SELECT id, titulo FROM focos WHERE avisado = 0 AND fim <= ?", fmtIso(agora()));
  for (const f of rows) {
    const texto = `⏱ Acabou o foco: ${f.titulo}. Como foi?`;
    await enviar(c.env, texto, undefined, [["✅ Concentrei", `fo:ok:${f.id}`], ["😵 Me distraí", `fo:no:${f.id}`], ["➕ Mais 10 min", `fo:+10:${f.id}`]]);
    await registrar(c.env, "assistant", texto);
    await run(c.env.DB, "UPDATE focos SET avisado = 1 WHERE id = ?", f.id);
  }
}

/** Alarme insistente: a partir da hora, uma mensagem por minuto (e ntfy) até tocar em 'Acordei'. */
async function tocarAlarmes(c: Ctx) {
  const a = agora(); const hoje = fmtData(a); const m = minutosDoDia(a);
  const alarmes = await all<any>(c.env.DB, "SELECT * FROM alarmes WHERE ativo = 1");
  for (const al of alarmes) {
    const dif = m - minutos(al.hora);
    if (dif < 0 || dif >= 90) continue;
    let toques = al.toques, confirmado = al.confirmado;
    if (al.dia !== hoje) { toques = 0; confirmado = 0; } // primeiro toque do dia
    if (confirmado || toques >= ALARME_MAX_TOQUES) continue;
    toques++;
    await enviar(c.env, `🔔🔔 ${al.mensagem} (${toques}/${ALARME_MAX_TOQUES})`, undefined, [["☀️ Acordei", `al:ok:${al.id}`]]);
    await ntfy.alarme(c.env, `${al.mensagem} (${toques}/${ALARME_MAX_TOQUES})`, "Acorda!");
    await run(c.env.DB, "UPDATE alarmes SET dia = ?, toques = ?, confirmado = ? WHERE id = ?", hoje, toques, confirmado, al.id);
  }
}

/** True se ainda não rodou; já marca como feito. */
async function jobPendente(c: Ctx, chave: string): Promise<boolean> {
  if (await first(c.env.DB, "SELECT 1 FROM jobs WHERE chave = ?", chave)) return false;
  await run(c.env.DB, "INSERT INTO jobs (chave) VALUES (?)", chave);
  return true;
}

/** Bom dia (briefing), check-in da noite e resumo semanal. Cada um roda uma vez por dia. */
async function resumos(c: Ctx) {
  const a = agora(); const hoje = fmtData(a); const m = minutosDoDia(a);
  const chegou = (hhmm: string) => { const d = m - minutos(hhmm); return d >= 0 && d < 180; }; // janela de 3h: recupera se estava fora do ar

  if (chegou(HORA_MANHA) && (await jobPendente(c, `manha:${hoje}`))) {
    let agenda: unknown = [];
    try { agenda = await G.agendaListar(c.env, 1); } catch { /* sem agenda */ }
    const texto = await gerarMensagemProativa(c.env,
      "Bom dia! Faça o briefing do dia: tarefas pendentes, metas da semana e uma frase de foco. Bem curto. " +
      "Compromissos da agenda (json, ignore se for erro): " + JSON.stringify(agenda));
    await enviar(c.env, texto);
  }

  if (chegou(HORA_NOITE) && (await jobPendente(c, `noite:${hoje}`))) {
    const emojis = ["😞", "😕", "😐", "🙂", "😄"];
    await enviar(c.env, "🌙 Como foi seu dia?", undefined, emojis.map((e, i): Botao => [`${e} ${i + 1}`, `hu:${i + 1}`]));
    await registrar(c.env, "assistant", "🌙 Como foi seu dia? (nota de 1 a 5)");
  }

  if (diaSemana(a) === 6 && chegou(HORA_SEMANAL) && (await jobPendente(c, `semana:${hoje}`))) {
    const metas = await all<{ nome: string }>(c.env.DB, "SELECT nome FROM metas");
    const dados = {
      metas: await Promise.all(metas.map(async (x) => JSON.parse(await executar(c, "resumo_semana", { nome: x.nome })))),
      gastos: JSON.parse(await executar(c, "resumo_gastos", {})),
      padroes: JSON.parse(await executar(c, "analise_padroes", {})),
    };
    const texto = await gerarMensagemProativa(c.env,
      "Resumo semanal com estes dados reais (json): " + JSON.stringify(dados) +
      ". Diga o que bateu, o que faltou, quanto gastou e uma sugestão pra próxima semana. Curto.");
    await enviar(c.env, texto);
  }
}

/** Lembretes fixos e aleatórios (ex: beber água). */
async function lembretes(c: Ctx) {
  const a = agora(); const hoje = fmtData(a); const m = minutosDoDia(a);
  const lista = await all<any>(c.env.DB, "SELECT * FROM lembretes WHERE ativo = 1");
  for (const l of lista) {
    const envios = await all<{ ts: string }>(c.env.DB, "SELECT ts FROM envios WHERE lembrete_id = ? AND ts >= ? AND ts < ? ORDER BY ts", l.id, hoje, `${hoje}~`);
    let enviarAgora = false;
    if (l.tipo === "fixo") {
      const d = m - minutos(l.hora_fixa);
      enviarAgora = !envios.length && d >= 0 && d < 30;
    } else {
      const ini = minutos(l.inicio), f = fim(l.fim);
      if (m < ini || m > f) continue;
      const faltam = l.vezes_dia - envios.length;
      if (faltam <= 0) continue;
      if (envios.length && (a.getTime() - parseLocal(envios[envios.length - 1].ts).getTime()) / 60000 < l.intervalo_min) continue;
      const restantes = Math.max(1, f - m); // ticks restantes (1 por minuto)
      enviarAgora = Math.random() < faltam / restantes;
    }
    if (!enviarAgora) continue;
    const texto = await gerarMensagemProativa(c.env, l.mensagem);
    await enviar(c.env, texto, undefined, [["✅ Feito", `lb:ok:${l.id}`], ["⏭ Depois", `lb:no:${l.id}`]]);
    await run(c.env.DB, "INSERT INTO envios (lembrete_id, ts) VALUES (?, ?)", l.id, tsCompleto());
  }
}

/** Um minuto de trabalho. Cada etapa é isolada: se uma falhar, as outras seguem. */
export async function tick(c: Ctx) {
  const etapas: [string, (c: Ctx) => Promise<void>][] = [
    ["tarefas", avisarTarefas], ["eventos", avisarEventos], ["agenda", sincronizarAgenda], ["cobrancas", cobrarTarefas],
    ["focos", avisarFocos], ["alarmes", tocarAlarmes], ["resumos", resumos], ["lembretes", lembretes],
  ];
  for (const [nome, fn] of etapas) {
    try { await fn(c); } catch (e) { console.error(`erro no agendador (${nome}):`, (e as Error).message); }
  }
}
