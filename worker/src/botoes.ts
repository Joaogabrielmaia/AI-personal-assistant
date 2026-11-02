/** Ações dos botões do Telegram (callback_data). Cada função devolve o texto de confirmação, ou null. */
import { first, run } from "./db";
import { addDias, addMin, agora, fmtIso } from "./time";
import { enviar, type Botao } from "./telegram";
import { executar, registrarAtividade, type Ctx } from "./tools";

export const botoesTarefa = (id: number): Botao[] => [
  ["✅ Fiz", `tf:ok:${id}`],
  ["❌ Não fiz", `tf:no:${id}`],
  ["📅 Reagendar", `tf:rg:${id}`],
  ["⏰ +10 min", `tf:+10:${id}`],
];

async function tarefa(c: Ctx, id: number) {
  return first<{ titulo: string; adiamentos: number }>(c.env.DB, "SELECT titulo, adiamentos FROM tarefas WHERE id = ?", id);
}

async function oferecerReagendar(c: Ctx, id: number, titulo: string) {
  await enviar(c.env, `📅 Quando quer fazer "${titulo}"?`, undefined, [
    ["⏰ Em 1h", `rg:1h:${id}`], ["🌙 Hoje à noite", `rg:noite:${id}`],
    ["🌅 Amanhã 9h", `rg:am:${id}`], ["📆 Semana que vem", `rg:sem:${id}`],
    ["✏️ Outro horário", `rg:out:${id}`], ["🗑 Desistir", `tf:x:${id}`],
  ]);
}

function quando(op: string): Date {
  const a = agora();
  a.setUTCSeconds(0, 0);
  if (op === "1h") return addMin(a, 60);
  if (op === "noite") {
    const n = new Date(a); n.setUTCHours(20, 0, 0, 0);
    return n.getTime() > addMin(a, 30).getTime() ? n : addDias(n, 1);
  }
  if (op === "am") { const n = addDias(a, 1); n.setUTCHours(9, 0, 0, 0); return n; }
  // "sem": próxima segunda, 09:00
  const seg = new Date(a); seg.setUTCHours(9, 0, 0, 0);
  return addDias(seg, 7 - ((seg.getUTCDay() + 6) % 7));
}

/** Executa o que o botão pede. `responderIA` é usado quando o botão vira mensagem pra IA (ex: "quebrar em passos"). */
export async function acaoBotao(c: Ctx, dados: string, responderIA: (t: string) => Promise<void>): Promise<string | null> {
  const [tipo, ...r] = dados.split(":");
  const db = c.env.DB;

  if (tipo === "tf") {
    const [acao, tidS] = r; const tid = Number(tidS);
    const t = await tarefa(c, tid); const titulo = t?.titulo ?? "tarefa";
    if (acao === "ok" || acao === "x") await run(db, "UPDATE tarefas SET feito = 1, cobrancas = 99 WHERE id = ?", tid);
    else if (acao === "+10") {
      const novo = fmtIso(addMin(agora(), 10));
      await run(db, "UPDATE tarefas SET lembrar_em = ?, avisado = 0, cobrancas = 0, aviso_ts = NULL WHERE id = ?", novo, tid);
      return `⏰ Aviso de novo às ${novo.slice(-5)}: ${titulo}`;
    } else await run(db, "UPDATE tarefas SET cobrancas = 99 WHERE id = ?", tid); // no/rg: respondeu, para de cobrar
    if (acao === "ok") { await registrarAtividade(c, titulo, true); return `✅ Feito: ${titulo}`; }
    if (acao === "x") return `🗑 Desistiu: ${titulo}`;
    if (acao === "no") {
      await enviar(c.env, `Tranquilo. O que rolou com "${titulo}"?`, undefined, [
        ["😴 Esqueci", `tm:esqueci:${tid}`], ["⏳ Sem tempo", `tm:sem tempo:${tid}`],
        ["😩 Sem vontade", `tm:sem vontade:${tid}`], ["🔄 Mudou o plano", `tm:mudou o plano:${tid}`], ["Pular", `tm:-:${tid}`],
      ]);
      return `❌ Não fez: ${titulo}`;
    }
    await oferecerReagendar(c, tid, titulo);
    return `📅 Vamos reagendar: ${titulo}`;
  }

  if (tipo === "tm") { // motivo de não ter feito
    const [motivo, tidS] = r; const tid = Number(tidS);
    const titulo = (await tarefa(c, tid))?.titulo ?? "tarefa";
    await registrarAtividade(c, titulo, false, motivo === "-" ? "" : motivo);
    await oferecerReagendar(c, tid, titulo);
    return motivo !== "-" ? `Motivo: ${motivo}` : "Ok.";
  }

  if (tipo === "rg") { // escolha do novo horário
    const [op, tidS] = r; const tid = Number(tidS);
    const titulo = (await tarefa(c, tid))?.titulo ?? "tarefa";
    if (op === "out") {
      const { registrar } = await import("./llm");
      await registrar(c.env, "assistant", `Quando quer reagendar "${titulo}" (#${tid})? Ele vai responder com dia/hora.`);
      await enviar(c.env, "✏️ Me diz quando (ex: sexta 15h, dia 10 de manhã).");
      return "✏️ Outro horário";
    }
    const res = JSON.parse(await executar(c, "reagendar_tarefa", { id: tid, lembrar_em: fmtIso(quando(op)) }));
    if ((res.vezes_adiada ?? 0) >= 3)
      await enviar(c.env, `🤨 Já é a ${res.vezes_adiada}ª vez que você adia "${titulo}". Que tal só 5 minutos agora?`, undefined, [
        ["⏱ 5 min agora", `pr:foco:${tid}`], ["🧩 Quebrar em passos", `pr:passos:${tid}`], ["🗑 Desistir", `pr:x:${tid}`], ["Mantém assim", `pr:ok:${tid}`],
      ]);
    return `📅 Reagendado pra ${String(res.novo_horario ?? "").replace("T", " ")}: ${titulo}`;
  }

  if (tipo === "pr") { // enrolação repetida
    const [acao, tidS] = r; const tid = Number(tidS);
    const titulo = (await tarefa(c, tid))?.titulo ?? "tarefa";
    if (acao === "foco") { await executar(c, "iniciar_foco", { minutos: 5, tarefa: titulo }); return `⏱ Valendo! 5 minutos em: ${titulo}`; }
    if (acao === "x") { await run(db, "UPDATE tarefas SET feito = 1, cobrancas = 99 WHERE id = ?", tid); return `🗑 Desistiu: ${titulo}`; }
    if (acao === "passos") {
      await responderIA(`Quebre a tarefa "${titulo}" (#${tid}) em 3 passos bem pequenos, o primeiro deve levar menos de 5 minutos.`);
      return "🧩 Quebrando em passos";
    }
    return "👍 Mantido";
  }

  if (tipo === "lb") { // lembrete (água, etc.)
    const [acao, lidS] = r;
    const l = await first<{ mensagem: string }>(db, "SELECT mensagem FROM lembretes WHERE id = ?", Number(lidS));
    const nome = l?.mensagem ?? "lembrete";
    if (acao === "ok") { await registrarAtividade(c, nome, true); return `✅ Registrado: ${nome}`; }
    return `⏭ Ok, depois: ${nome}`;
  }

  if (tipo === "al") {
    await run(db, "UPDATE alarmes SET confirmado = 1 WHERE id = ?", Number(r[1]));
    return "☀️ Bom dia! Alarme desligado.";
  }

  if (tipo === "fo") {
    const [acao, fidS] = r; const fid = Number(fidS);
    const titulo = (await first<{ titulo: string }>(db, "SELECT titulo FROM focos WHERE id = ?", fid))?.titulo ?? "foco";
    if (acao === "+10") {
      await run(db, "UPDATE focos SET fim = ?, avisado = 0 WHERE id = ?", fmtIso(addMin(agora(), 10)), fid);
      return `➕ Mais 10 min de foco: ${titulo}`;
    }
    await registrarAtividade(c, "foco", acao === "ok", titulo);
    return acao === "ok" ? "✅ Foco concluído, boa!" : "😵 Anotado. Amanhã a gente tenta de novo.";
  }

  if (tipo === "hu") {
    await registrarAtividade(c, "humor", true, r[0]);
    return `🌙 Humor do dia: ${r[0]}/5. Anotado.`;
  }
  return null;
}
