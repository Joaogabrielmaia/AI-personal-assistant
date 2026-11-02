export {};
/** Roteiro de teste de ponta a ponta: fala com o Worker local como se fosse o Telegram. */
const W = "http://127.0.0.1:8787";
const T = "http://127.0.0.1:8788";
const DONO = 42;
let uid = Math.floor(Date.now() / 1000);

async function limpa() { await fetch(`${T}/_reset`); }
async function saida(): Promise<any[]> { return (await fetch(`${T}/_log`)).json() as Promise<any[]>; }

function resumo(l: any[]) {
  return l.filter((x) => ["sendMessage", "editMessageText"].includes(x.metodo)).map((x) => {
    const bt = x.reply_markup?.inline_keyboard?.flat().map((b: any) => b.text);
    return `${x.metodo === "editMessageText" ? "[edit] " : ""}${String(x.text).replace(/\n/g, " ⏎ ").slice(0, 200)}${bt ? "  [" + bt.join(" | ") + "]" : ""}`;
  });
}

async function update(corpo: Record<string, unknown>) {
  const t = Date.now();
  const r = await fetch(`${W}/telegram`, {
    method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "segredo-de-teste" },
    body: JSON.stringify({ update_id: ++uid, ...corpo }),
  });
  return { status: r.status, ms: Date.now() - t };
}
const msg = (extra: Record<string, unknown>) => ({ message: { message_id: uid, chat: { id: DONO, type: "private" }, ...extra } });
const botao = (data: string, texto = "msg original") => ({ callback_query: { id: "cb" + uid, data, message: { message_id: 1000, text: texto, chat: { id: DONO } } } });

async function passo(titulo: string, corpo: Record<string, unknown>, esperaMs = 0) {
  await limpa();
  const { status, ms } = await update(corpo);
  if (esperaMs) await new Promise((r) => setTimeout(r, esperaMs));
  const l = await saida();
  console.log(`\n▶ ${titulo}  (HTTP ${status}, ${ms} ms)`);
  for (const s of resumo(l)) console.log("   ", s);
  if (!resumo(l).length) console.log("    (nada enviado)");
  return l;
}

async function tick() {
  await limpa();
  const r = await fetch(`${W}/cdn-cgi/handler/scheduled`);
  const l = await saida();
  console.log(`\n⏱  tick do agendador (HTTP ${r.status})`);
  for (const s of resumo(l)) console.log("   ", s);
  return l;
}

const quais = process.argv[2] ?? "todos";
const roda = (n: string) => quais === "todos" || quais.split(",").includes(n);

if (roda("basico")) {
  await passo("conversa", msg({ text: "oi, tudo bem?" }));
  await passo("gasto", msg({ text: "gastei 20 no lanche" }));
  await passo("total", msg({ text: "quanto gastei esse mês?" }));
  await passo("conta", msg({ text: "quanto é 18% de 237,50?" }));
  await passo("estranho", msg({ text: "asdkjh ???" }));
  await passo("outra pessoa (deve ser ignorada)", { message: { message_id: 1, chat: { id: 999, type: "private" }, text: "oi" } });
}

if (roda("tarefa")) {
  await passo("tarefa com horário no passado (vai disparar no tick)", msg({ text: "anota: ligar pro banco hoje às 00:05" }));
  const l = await tick();
  const id = String(l.find((x) => x.reply_markup)?.reply_markup.inline_keyboard[0][0].callback_data ?? "").split(":")[2];
  if (id) {
    await passo(`botão Não fiz (#${id})`, botao(`tf:no:${id}`, "⏰ Hora de: ligar pro banco"));
    await passo("botão motivo", botao(`tm:esqueci:${id}`));
    await passo("botão semana que vem", botao(`rg:sem:${id}`));
    await passo("texto livre sobre a tarefa", msg({ text: "na verdade vou mandar mensagem pro banco, me ajuda a escrever" }));
  }
}

if (roda("agenda")) {
  await passo("marca evento amanhã", msg({ text: "marca reunião de teste amanhã às 16h por 1 hora" }));
  await passo("lista agenda", msg({ text: "o que tenho na agenda amanhã?" }));
  await passo("cancela evento", msg({ text: "cancela a reunião de teste" }));
}

if (roda("midia")) {
  await passo("foto de recibo", msg({ caption: "olha o recibo do mercado", photo: [{ file_id: "recibo_teste.png" }] }), 0);
  await passo("áudio", msg({ voice: { file_id: "audio_teste.wav" } }), 0);
}

if (roda("alarme")) {
  await passo("alarme", msg({ text: "me acorda às 00:01" }));
  await tick();
  await passo("botão Acordei", botao("al:ok:1"));
}

if (roda("failover")) {
  console.log("\n(failover: veja no log do wrangler as linhas 'provedor ... falhou')");
}
console.log("\nfim.");
