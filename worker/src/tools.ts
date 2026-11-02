/** Ferramentas que a IA pode chamar. A IA decide quando usar; o código executa. */
import type { Env } from "./env";
import { all, first, run } from "./db";
import * as G from "./google";
import type { Botao } from "./telegram";
import { addDias, addMin, agora, diaSemana, fmtData, fmtIso, parseLocal, tsCompleto } from "./time";

/** Contexto de UMA requisição: segredos, tarefas em segundo plano e botões pedidos pela IA. */
export interface Ctx {
  env: Env;
  bg: (p: Promise<unknown>) => void;
  botoes: Botao[];
}
type A = Record<string, any>;
const bool = (x: unknown) => x === true || x === 1 || (typeof x === "string" && ["true", "1", "sim", "yes"].includes(x.toLowerCase()));
const GASTOS_CAB = ["ID", "Data", "Valor", "Categoria", "Descrição"];

// ---------------- tarefas ----------------
async function anotarTarefa(c: Ctx, a: A) {
  const titulo = String(a.titulo ?? "").trim();
  if (!titulo) return { erro: "faltou o título" };
  let lembrar: string | null = a.lembrar_em ? String(a.lembrar_em) : null;
  if (lembrar) {
    try {
      lembrar = fmtIso(parseLocal(lembrar));
    } catch {
      return { erro: "lembrar_em inválido. Use AAAA-MM-DDTHH:MM, ex: 2026-11-02T20:00" };
    }
  }
  const igual = await first<{ id: number }>(
    c.env.DB,
    "SELECT id FROM tarefas WHERE feito = 0 AND lower(titulo) = lower(?) AND COALESCE(lembrar_em, '') = COALESCE(?, '')",
    titulo, lembrar,
  );
  if (igual) return { ok: true, id: igual.id, aviso: "já existia uma tarefa igual; não duplicou" };
  const r = await run(c.env.DB, "INSERT INTO tarefas (titulo, quando, lembrar_em, criado) VALUES (?, ?, ?, ?)", titulo, a.quando ?? null, lembrar, tsCompleto());
  return { ok: true, id: r.id, lembrar_em: lembrar };
}

const listarTarefas = (c: Ctx) =>
  all(c.env.DB, "SELECT id, titulo, quando, lembrar_em FROM tarefas WHERE feito = 0 ORDER BY id");

async function concluirTarefa(c: Ctx, a: A) {
  await run(c.env.DB, "UPDATE tarefas SET feito = 1 WHERE id = ?", Number(a.id));
  return { ok: true };
}

function segundaDe(d: Date): Date {
  return addDias(d, -diaSemana(d));
}

async function reagendarTarefa(c: Ctx, a: A) {
  const id = Number(a.id);
  let novo: string;
  try {
    novo = fmtIso(parseLocal(String(a.lembrar_em)));
  } catch {
    return { erro: "lembrar_em inválido. Use AAAA-MM-DDTHH:MM" };
  }
  const t = await first<{ titulo: string; adiamentos: number }>(c.env.DB, "SELECT titulo, adiamentos FROM tarefas WHERE id = ?", id);
  if (!t) return { erro: "tarefa não encontrada" };
  const n = (t.adiamentos ?? 0) + 1;
  await run(c.env.DB, "UPDATE tarefas SET lembrar_em = ?, avisado = 0, cobrancas = 0, aviso_ts = NULL, adiamentos = ?, feito = 0 WHERE id = ?", novo, n, id);
  if (a.motivo) await registrarAtividade(c, t.titulo, false, String(a.motivo));
  const res: A = { ok: true, titulo: t.titulo, novo_horario: novo, vezes_adiada: n };
  if (n >= 3)
    res.sugestao = "Já foi adiada 3+ vezes: diga isso com gentileza e proponha um passo de 5 minutos agora (iniciar_foco) ou quebrar em passos menores.";
  return res;
}

async function atualizarTarefa(c: Ctx, a: A) {
  const id = Number(a.id);
  if (a.titulo) await run(c.env.DB, "UPDATE tarefas SET titulo = ? WHERE id = ?", String(a.titulo), id);
  if (a.lembrar_em) {
    let novo: string;
    try {
      novo = fmtIso(parseLocal(String(a.lembrar_em)));
    } catch {
      return { erro: "lembrar_em inválido" };
    }
    await run(c.env.DB, "UPDATE tarefas SET lembrar_em = ?, avisado = 0, cobrancas = 0, aviso_ts = NULL WHERE id = ?", novo, id);
  }
  return { ok: true };
}

async function marcarNaoFeita(c: Ctx, a: A) {
  const id = Number(a.id);
  const t = await first<{ titulo: string }>(c.env.DB, "SELECT titulo FROM tarefas WHERE id = ?", id);
  if (!t) return { erro: "tarefa não encontrada" };
  await run(c.env.DB, "UPDATE tarefas SET cobrancas = 99 WHERE id = ?", id);
  await registrarAtividade(c, t.titulo, false, a.motivo ? String(a.motivo) : "não fez");
  return { ok: true, instrucao: "Ofereça reagendar (ou perguntar_com_opcoes) se ele ainda não disse quando." };
}

// ---------------- metas e atividades ----------------
async function definirMeta(c: Ctx, a: A) {
  await run(c.env.DB, "INSERT INTO metas (nome, vezes_semana) VALUES (?, ?) ON CONFLICT(nome) DO UPDATE SET vezes_semana = excluded.vezes_semana", String(a.nome).toLowerCase(), Number(a.vezes_semana));
  return { ok: true };
}

export async function registrarAtividade(c: Ctx, nome: string, feito: boolean, obs = "") {
  const hoje = fmtData(agora());
  await run(c.env.DB, "INSERT INTO registros (data, nome, feito, obs) VALUES (?, ?, ?, ?)", hoje, nome.toLowerCase(), feito ? 1 : 0, obs);
  c.bg(G.planilhaAppend(c.env, "Atividades", ["Data", "Atividade", "Feito", "Obs"], [hoje, nome.toLowerCase(), feito ? "sim" : "não", obs]));
  return { ok: true };
}

async function sequencia(c: Ctx, nome: string): Promise<number> {
  const rows = await all<{ data: string }>(c.env.DB, "SELECT data FROM registros WHERE nome = ? AND feito = 1", nome.toLowerCase());
  const dias = new Set(rows.map((r) => r.data));
  let d = agora();
  if (!dias.has(fmtData(d))) d = addDias(d, -1);
  let n = 0;
  while (dias.has(fmtData(d))) {
    n++;
    d = addDias(d, -1);
  }
  return n;
}

async function resumoSemana(c: Ctx, a: A) {
  const nome = String(a.nome).toLowerCase();
  const seg = fmtData(segundaDe(agora()));
  const meta = await first<{ vezes_semana: number }>(c.env.DB, "SELECT vezes_semana FROM metas WHERE nome = ?", nome);
  const rows = await all<{ data: string; feito: number; obs: string }>(c.env.DB, "SELECT data, feito, obs FROM registros WHERE nome = ? AND data >= ? ORDER BY data", nome, seg);
  const feitos = rows.filter((r) => r.feito);
  return {
    atividade: nome,
    meta_semana: meta?.vezes_semana ?? null,
    feitos: feitos.length,
    dias_feitos: feitos.map((r) => r.data),
    nao_feitos: rows.filter((r) => !r.feito),
    desde: seg,
    sequencia_dias: await sequencia(c, nome),
  };
}

// ---------------- lembretes ----------------
async function criarLembreteFixo(c: Ctx, a: A) {
  const r = await run(c.env.DB, "INSERT INTO lembretes (tipo, mensagem, hora_fixa) VALUES ('fixo', ?, ?)", String(a.mensagem), String(a.hora));
  return { ok: true, id: r.id };
}

async function criarLembreteAleatorio(c: Ctx, a: A) {
  const r = await run(
    c.env.DB,
    "INSERT INTO lembretes (tipo, mensagem, vezes_dia, inicio, fim, intervalo_min) VALUES ('aleatorio', ?, ?, ?, ?, ?)",
    String(a.mensagem), Number(a.vezes_dia), String(a.inicio ?? "08:00"), String(a.fim ?? "21:00"), Number(a.intervalo_min ?? 90),
  );
  return { ok: true, id: r.id };
}

const listarLembretes = (c: Ctx) => all(c.env.DB, "SELECT * FROM lembretes WHERE ativo = 1");

async function apagarLembrete(c: Ctx, a: A) {
  await run(c.env.DB, "UPDATE lembretes SET ativo = 0 WHERE id = ?", Number(a.id));
  return { ok: true };
}

// ---------------- gastos ----------------
async function registrarGasto(c: Ctx, a: A) {
  const data = a.data ? String(a.data) : fmtData(agora());
  const valor = Number(a.valor);
  if (!isFinite(valor) || valor <= 0) return { erro: "valor inválido (precisa ser maior que zero)" };
  const categoria = String(a.categoria).toLowerCase();
  const r = await run(c.env.DB, "INSERT INTO gastos (data, valor, categoria, descricao) VALUES (?, ?, ?, ?)", data, valor, categoria, a.descricao ?? "");
  const tot = await first<{ t: number }>(c.env.DB, "SELECT COALESCE(SUM(valor), 0) AS t FROM gastos WHERE data LIKE ?", `${data.slice(0, 7)}%`);
  c.bg(G.planilhaAppend(c.env, "Gastos", GASTOS_CAB, [r.id, data, valor, categoria, a.descricao ?? ""]));
  const res: A = { ok: true, id: r.id, total_do_mes: Math.round((tot?.t ?? 0) * 100) / 100 };
  const lim = (c.env.LIMITE_MENSAL ?? "").trim();
  if (lim) {
    res.limite_mensal = Number(lim);
    res.passou_do_limite = (tot?.t ?? 0) > Number(lim);
  }
  return res;
}

async function resumoGastos(c: Ctx, a: A) {
  const mes = a.mes ? String(a.mes) : fmtData(agora()).slice(0, 7);
  const rows = await all<{ categoria: string; total: number }>(
    c.env.DB, "SELECT categoria, SUM(valor) AS total FROM gastos WHERE data LIKE ? GROUP BY categoria ORDER BY total DESC", `${mes}%`);
  const r2 = (x: number) => Math.round(x * 100) / 100;
  return { mes, total: r2(rows.reduce((s, r) => s + r.total, 0)), por_categoria: Object.fromEntries(rows.map((r) => [r.categoria, r2(r.total)])) };
}

async function listarGastos(c: Ctx, a: A) {
  const limite = Number(a.limite ?? 10);
  return a.categoria
    ? all(c.env.DB, "SELECT id, data, valor, categoria, descricao FROM gastos WHERE categoria = ? ORDER BY id DESC LIMIT ?", String(a.categoria).toLowerCase(), limite)
    : all(c.env.DB, "SELECT id, data, valor, categoria, descricao FROM gastos ORDER BY id DESC LIMIT ?", limite);
}

async function apagarGasto(c: Ctx, a: A) {
  // ferramenta destrutiva: exige o id (nunca "o último" por palpite)
  if (!a.id) return { erro: "informe o id; use listar_gastos pra achá-lo" };
  const r = await first<{ id: number; data: string; valor: number; categoria: string }>(c.env.DB, "SELECT id, data, valor, categoria FROM gastos WHERE id = ?", Number(a.id));
  if (!r) return { erro: "gasto não encontrado; use listar_gastos pra ver os IDs" };
  await run(c.env.DB, "DELETE FROM gastos WHERE id = ?", r.id);
  return { ok: true, apagado: r, planilha: await G.planilhaApagarLinha(c.env, "Gastos", r.id) };
}

// ---------------- agenda ----------------
const listarAgenda = (c: Ctx, a: A) => G.agendaListar(c.env, Number(a.dias ?? 7));

/** Grava quando o bot deve avisar deste evento (EVENTO_AVISO_MIN_ANTES=10 avisa 10 min antes; padrão: na hora). */
export async function agendarAvisoEvento(env: Env, eventoId: string, titulo: string, inicio: string): Promise<string> {
  const ini = parseLocal(inicio);
  const aviso = addMin(ini, -Number(env.EVENTO_AVISO_MIN_ANTES || 0));
  if (aviso.getTime() <= agora().getTime()) return "não (esse horário já passou)";
  await run(
    env.DB,
    "INSERT INTO avisos_evento (evento_id, titulo, quando) VALUES (?, ?, ?) ON CONFLICT(evento_id) DO UPDATE SET quando = excluded.quando, titulo = excluded.titulo WHERE avisado = 0",
    eventoId, titulo, fmtIso(aviso),
  );
  return `o bot avisa no Telegram às ${fmtIso(aviso).slice(11)}`;
}

async function criarEventoAgenda(c: Ctx, a: A) {
  const res: any = await G.agendaCriar(c.env, String(a.titulo), String(a.inicio), Number(a.duracao_min ?? 30), String(a.descricao ?? ""));
  if (res.ok && !res.ja_existia) res.aviso_bot = await agendarAvisoEvento(c.env, res.id, String(a.titulo), String(a.inicio));
  return res;
}

async function apagarEventoAgenda(c: Ctx, a: A) {
  const res: any = await G.agendaApagar(c.env, String(a.id));
  if (res.ok) await run(c.env.DB, "DELETE FROM avisos_evento WHERE evento_id = ?", String(a.id));
  return res;
}

// ---------------- foco, alarme, botões ----------------
async function iniciarFoco(c: Ctx, a: A) {
  const fim = fmtIso(addMin(agora(), Number(a.minutos)));
  const r = await run(c.env.DB, "INSERT INTO focos (titulo, fim) VALUES (?, ?)", String(a.tarefa), fim);
  return { ok: true, id: r.id, termina_em: fim };
}

async function criarAlarme(c: Ctx, a: A) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(a.hora).trim());
  if (!m || +m[1] > 23 || +m[2] > 59) return { erro: "hora inválida; use HH:MM" };
  const hora = `${m[1].padStart(2, "0")}:${m[2]}`;
  const r = await run(c.env.DB, "INSERT INTO alarmes (hora, mensagem) VALUES (?, ?)", hora, String(a.mensagem ?? "Acorda!"));
  return { ok: true, id: r.id };
}

async function apagarAlarme(c: Ctx, a: A) {
  await run(c.env.DB, "UPDATE alarmes SET ativo = 0 WHERE id = ?", Number(a.id));
  return { ok: true };
}

async function perguntarComOpcoes(c: Ctx, a: A) {
  const ops: string[] = Array.isArray(a.opcoes) ? a.opcoes.map(String) : [];
  c.botoes.length = 0;
  for (const o of ops.slice(0, 6)) c.botoes.push([o, `op:${o.slice(0, 28)}`]);
  return { ok: true, instrucao: "Escreva só a pergunta como resposta final; os botões aparecem sozinhos." };
}

// ---------------- análise ----------------
async function analisePadroes(c: Ctx) {
  const dias = ["seg", "ter", "qua", "qui", "sex", "sáb", "dom"];
  const hoje = agora();
  const desde = fmtData(addDias(hoje, -60));
  const regs = await all<{ data: string; nome: string; feito: number; obs: string }>(c.env.DB, "SELECT data, nome, feito, obs FROM registros WHERE data >= ?", desde);
  const gastos = await all<{ data: string; valor: number; categoria: string }>(c.env.DB, "SELECT data, valor, categoria FROM gastos WHERE data >= ?", desde);

  const porDia: Record<string, Record<string, [number, number]>> = {};
  const motivos: Record<string, Record<string, number>> = {};
  const humor: Record<string, number[]> = {};
  for (const r of regs) {
    const wd = dias[diaSemana(parseLocal(r.data))];
    if (r.nome === "humor") {
      const n = parseInt(r.obs, 10);
      if (!isNaN(n)) (humor[wd] ??= []).push(n);
      continue;
    }
    const pd = ((porDia[r.nome] ??= {})[wd] ??= [0, 0]);
    pd[1] += 1;
    pd[0] += r.feito;
    if (!r.feito && r.obs) {
      const m = (motivos[r.nome] ??= {});
      m[r.obs.toLowerCase()] = (m[r.obs.toLowerCase()] ?? 0) + 1;
    }
  }
  const ult30 = fmtData(addDias(hoje, -30));
  const rec: Record<string, number> = {};
  const ant: Record<string, number> = {};
  for (const g of gastos) {
    const alvo = g.data >= ult30 ? rec : ant;
    alvo[g.categoria] = (alvo[g.categoria] ?? 0) + g.valor;
  }
  const r2 = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.round(v * 100) / 100]));
  return {
    taxa_por_dia_da_semana: Object.fromEntries(Object.entries(porDia).map(([n, v]) => [n, Object.fromEntries(Object.entries(v).map(([d, [f, t]]) => [d, `${f}/${t}`]))])),
    motivos_de_falta: Object.fromEntries(Object.entries(motivos).map(([n, m]) => [n, Object.entries(m).sort((x, y) => y[1] - x[1]).slice(0, 3)])),
    humor_medio_por_dia: Object.fromEntries(Object.entries(humor).map(([d, v]) => [d, Math.round((v.reduce((s, x) => s + x, 0) / v.length) * 10) / 10])),
    gastos_ultimos_30d: r2(rec),
    gastos_30d_anteriores: r2(ant),
    observacao: "poucos dados = diga que ainda é cedo pra concluir",
  };
}

// ---------------- estado atual (vai no prompt) ----------------
export async function contexto(env: Env): Promise<string> {
  const hoje = fmtData(agora());
  const tarefas = await all<any>(env.DB, "SELECT id, titulo, quando, lembrar_em, avisado, adiamentos FROM tarefas WHERE feito = 0 ORDER BY id");
  const lembretes = await all<any>(env.DB, "SELECT * FROM lembretes WHERE ativo = 1");
  const metas = await all<any>(env.DB, "SELECT nome, vezes_semana FROM metas");
  const regs = await all<any>(env.DB, "SELECT nome, feito, obs FROM registros WHERE data = ?", hoje);
  const alarmes = await all<any>(env.DB, "SELECT id, hora FROM alarmes WHERE ativo = 1");
  const focos = await all<any>(env.DB, "SELECT titulo, fim FROM focos WHERE avisado = 0");

  const L: string[] = ["TAREFAS PENDENTES:"];
  if (!tarefas.length) L.push("- nenhuma");
  for (const t of tarefas)
    L.push(
      `- #${t.id} ${t.titulo}` +
        (t.quando ? ` (${t.quando})` : "") +
        (t.lembrar_em ? ` [aviso em ${t.lembrar_em}${t.avisado ? ", JÁ AVISADO" : ""}]` : "") +
        (t.adiamentos ? ` [adiada ${t.adiamentos}x]` : ""),
    );
  L.push("LEMBRETES ATIVOS:");
  if (!lembretes.length) L.push("- nenhum");
  for (const l of lembretes)
    L.push(l.tipo === "fixo" ? `- #${l.id} todo dia ${l.hora_fixa}: ${l.mensagem}` : `- #${l.id} ${l.vezes_dia}x/dia entre ${l.inicio} e ${l.fim}: ${l.mensagem}`);
  if (alarmes.length) L.push("ALARMES: " + alarmes.map((x) => `#${x.id} ${x.hora}`).join(", "));
  if (focos.length) L.push("FOCO EM ANDAMENTO: " + focos.map((f) => `${f.titulo} até ${String(f.fim).slice(-5)}`).join(", "));
  L.push("METAS SEMANAIS: " + (metas.map((m) => `${m.nome} ${m.vezes_semana}x`).join(", ") || "nenhuma"));
  L.push("REGISTROS DE HOJE: " + (regs.map((r) => `${r.nome}=${r.feito ? "feito" : "NÃO feito"}${r.obs ? ` (${r.obs})` : ""}`).join(", ") || "nenhum"));
  return L.join("\n");
}

// ---------------- registro das ferramentas ----------------
const S = { type: "string" }, I = { type: "integer" }, N = { type: "number" }, B = { type: "boolean" };
const LS = { type: "array", items: { type: "string" } };

interface Tool { name: string; description: string; props?: Record<string, any>; required?: string[]; fn: (c: Ctx, a: A) => Promise<unknown> }

const TOOLS: Tool[] = [
  { name: "anotar_tarefa", fn: anotarTarefa, required: ["titulo"], props: { titulo: S, quando: S, lembrar_em: S },
    description: "Anota uma tarefa. Se o usuário der dia/hora, preencha 'lembrar_em' em ISO AAAA-MM-DDTHH:MM (Brasília) para o bot AVISAR nesse horário. 'quando' é o texto original." },
  { name: "listar_tarefas", fn: (c) => listarTarefas(c), description: "Lista tarefas pendentes." },
  { name: "concluir_tarefa", fn: concluirTarefa, required: ["id"], props: { id: I }, description: "Marca tarefa como feita." },
  { name: "reagendar_tarefa", fn: reagendarTarefa, required: ["id", "lembrar_em"], props: { id: I, lembrar_em: S, motivo: S },
    description: "Remarca o aviso de uma tarefa (lembrar_em AAAA-MM-DDTHH:MM). Use quando ele quiser deixar pra outro dia/hora. 'motivo' = por que não fez, se ele disser. Conta como adiamento." },
  { name: "atualizar_tarefa", fn: atualizarTarefa, required: ["id"], props: { id: I, titulo: S, lembrar_em: S },
    description: "Muda o título e/ou o horário de uma tarefa sem contar como adiamento (ex: trocar 'ligar pro X' por 'mandar mensagem pro X')." },
  { name: "marcar_nao_feita", fn: marcarNaoFeita, required: ["id"], props: { id: I, motivo: S },
    description: "Ele disse que NÃO fez a tarefa. Registra a falha (com o motivo, se houver) e para as cobranças." },
  { name: "definir_meta", fn: definirMeta, required: ["nome", "vezes_semana"], props: { nome: S, vezes_semana: I }, description: "Define meta semanal (ex: academia 4x por semana)." },
  { name: "registrar_atividade", fn: (c, a) => registrarAtividade(c, String(a.nome), bool(a.feito), String(a.obs ?? "")), required: ["nome", "feito"], props: { nome: S, feito: B, obs: S },
    description: "Registra que o usuário fez (feito=true) ou NÃO fez (feito=false) uma atividade hoje, com o motivo em obs." },
  { name: "resumo_semana", fn: resumoSemana, required: ["nome"], props: { nome: S }, description: "Resumo da semana atual de uma atividade: meta, quantas vezes foi, dias que faltou e motivos." },
  { name: "criar_lembrete_fixo", fn: criarLembreteFixo, required: ["mensagem", "hora"], props: { mensagem: S, hora: S }, description: "Lembrete todo dia num horário fixo (HH:MM)." },
  { name: "criar_lembrete_aleatorio", fn: criarLembreteAleatorio, required: ["mensagem", "vezes_dia"], props: { mensagem: S, vezes_dia: I, inicio: S, fim: S, intervalo_min: I },
    description: "Lembrete em horários aleatórios do dia (ex: beber água). Horários HH:MM." },
  { name: "listar_lembretes", fn: (c) => listarLembretes(c), description: "Lista lembretes ativos." },
  { name: "apagar_lembrete", fn: apagarLembrete, required: ["id"], props: { id: I }, description: "Desativa um lembrete." },
  { name: "registrar_gasto", fn: registrarGasto, required: ["valor", "categoria"], props: { valor: N, categoria: S, descricao: S, data: S },
    description: "Registra um gasto (salva no banco e na planilha). Escolha uma categoria curta (comida, transporte, mercado, lazer, saúde, estudos, contas, outros). data só se não for hoje (AAAA-MM-DD)." },
  { name: "resumo_gastos", fn: resumoGastos, props: { mes: S }, description: "Total de gastos do mês e por categoria. mes no formato AAAA-MM (padrão: atual)." },
  { name: "listar_gastos", fn: listarGastos, props: { limite: I, categoria: S }, description: "Lista os últimos gastos com ID. Use antes de apagar quando houver dúvida de qual é." },
  { name: "apagar_gasto", fn: apagarGasto, required: ["id"], props: { id: I },
    description: "Apaga um gasto pelo id (banco e linha inteira da planilha). SEMPRE chame listar_gastos antes pra achar o id do gasto que o usuário citou; se não achar na lista, avise e pergunte, nunca apague outro por palpite." },
  { name: "listar_agenda", fn: listarAgenda, props: { dias: I }, description: "Eventos do Google Agenda nos próximos N dias (padrão 7)." },
  { name: "criar_evento_agenda", fn: criarEventoAgenda, required: ["titulo", "inicio"], props: { titulo: S, inicio: S, duracao_min: I, descricao: S },
    description: "Cria evento no Google Agenda (inicio AAAA-MM-DDTHH:MM, Brasília). Avisa conflitos: se vier 'conflitos', diga ao usuário." },
  { name: "apagar_evento_agenda", fn: apagarEventoAgenda, required: ["id"], props: { id: S }, description: "Apaga um evento da agenda pelo id (veja listar_agenda)." },
  { name: "iniciar_foco", fn: iniciarFoco, required: ["minutos", "tarefa"], props: { minutos: I, tarefa: S }, description: "Inicia um cronômetro de foco/estudo. O bot avisa quando acabar e pergunta como foi." },
  { name: "criar_alarme", fn: criarAlarme, required: ["hora"], props: { hora: S, mensagem: S },
    description: "Alarme diário pra acordar: o bot manda mensagem a cada minuto até o usuário tocar em 'Acordei'. hora=HH:MM." },
  { name: "apagar_alarme", fn: apagarAlarme, required: ["id"], props: { id: I }, description: "Desativa um alarme." },
  { name: "perguntar_com_opcoes", fn: perguntarComOpcoes, required: ["opcoes"], props: { opcoes: LS },
    description: "Use quando faltar informação e as respostas possíveis forem poucas (até 6, curtas, máx 28 caracteres): mostra botões pro usuário tocar. Depois escreva só a pergunta como resposta final." },
  { name: "analise_padroes", fn: (c) => analisePadroes(c),
    description: "Dados dos últimos 60 dias (dias da semana, motivos de falta, humor, gastos) para você achar padrões e dar conselhos." },
];

/** Esquemas pra IA. Groq precisa de "null" nos opcionais; Gemini não aceita "type" em lista. */
export function schemasPara(nullable: boolean) {
  return TOOLS.map((t) => {
    const req = t.required ?? [];
    const props = Object.fromEntries(
      Object.entries(t.props ?? {}).map(([k, v]) => [k, nullable && !req.includes(k) && typeof v.type === "string" && v.type !== "array" ? { ...v, type: [v.type, "null"] } : v]),
    );
    return { type: "function", function: { name: t.name, description: t.description, parameters: { type: "object", properties: props, required: req } } };
  });
}

export const NOMES_FERRAMENTAS = TOOLS.map((t) => t.name);

/** Executa uma ferramenta; devolve JSON (erros viram {erro}, a IA tenta de novo). */
export async function executar(c: Ctx, nome: string, args: A): Promise<string> {
  const t = TOOLS.find((x) => x.name === nome);
  if (!t) return JSON.stringify({ erro: `ferramenta desconhecida: ${nome}` });
  try {
    const limpos = Object.fromEntries(Object.entries(args ?? {}).filter(([, v]) => v !== null && v !== undefined)); // o modelo manda null em opcionais
    const faltando = (t.required ?? []).filter((k) => limpos[k] === undefined);
    if (faltando.length) return JSON.stringify({ erro: `faltou: ${faltando.join(", ")}` });
    return JSON.stringify(await t.fn(c, limpos));
  } catch (e: any) {
    return JSON.stringify({ erro: String(e?.message ?? e) });
  }
}
