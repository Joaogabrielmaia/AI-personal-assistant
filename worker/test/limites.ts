/** Testa o plano de contingência: avisos de limite, modo econômico, /uso, foto leve e áudio longo. */
import { spawnSync } from "node:child_process";

const W = "http://127.0.0.1:8787";
const T = "http://127.0.0.1:8788";
const DONO = 42;
let uid = Math.floor(Date.now() / 1000) + 5000;
const dia = new Date().toISOString().slice(0, 10);

function sql(cmd: string) {
  const r = spawnSync("npx", ["wrangler", "d1", "execute", "assistente", "--local", "--command", `"${cmd.replace(/"/g, '\\"')}"`], { shell: true, encoding: "utf8" });
  if (r.status !== 0) console.log("   (erro sql)", (r.stderr || r.stdout).slice(0, 200));
}
const limpa = () => fetch(`${T}/_reset`);
const saida = async (): Promise<any[]> => (await fetch(`${T}/_log`)).json() as Promise<any[]>;
const textos = (l: any[]) => l.filter((x) => x.metodo === "sendMessage").map((x) => String(x.text).replace(/\n+/g, " ⏎ "));

async function update(corpo: Record<string, unknown>) {
  await fetch(`${W}/telegram`, { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "segredo-de-teste" }, body: JSON.stringify({ update_id: ++uid, ...corpo }) });
}
const msg = (extra: Record<string, unknown>) => ({ message: { message_id: uid, chat: { id: DONO, type: "private" }, ...extra } });
async function tick() { await limpa(); await fetch(`${W}/cdn-cgi/handler/scheduled`); return textos(await saida()); }
async function enviaMsg(extra: Record<string, unknown>) { await limpa(); await update(msg(extra)); return textos(await saida()); }

function mostra(titulo: string, linhas: string[], max = 330) {
  console.log(`\n▶ ${titulo}`);
  if (!linhas.length) console.log("    (nada enviado)");
  for (const l of linhas) console.log("    " + l.slice(0, max) + (l.length > max ? "…" : ""));
  return linhas;
}
const ok = (nome: string, cond: boolean) => console.log(`   ${cond ? "✅" : "❌"} ${nome}`);

// ---- estado limpo ----
sql(`DELETE FROM uso_dia`); sql(`DELETE FROM kv WHERE chave = 'economico'`); sql(`DELETE FROM jobs WHERE chave LIKE 'alerta:%'`);

// 1) /uso sem dados de IA
let l = mostra("/uso (começo do dia)", await enviaMsg({ text: "/uso" }));
ok("responde sem usar IA", l.length === 1 && l[0].includes("Uso de hoje"));

// 2) 72% das leituras -> aviso de 70%, sem modo econômico
sql(`INSERT INTO uso_dia (dia, leituras) VALUES ('${dia}', 3600000) ON CONFLICT(dia) DO UPDATE SET leituras = 3600000`);
l = mostra("tick com leituras em 72%", await tick());
ok("avisou 70%", l.some((t) => t.includes("72%") && t.includes("linhas lidas")));
ok("NÃO ligou modo econômico", !l.some((t) => t.includes("MODO ECONÔMICO")));
l = mostra("tick seguinte (não pode repetir o aviso)", await tick());
ok("sem aviso repetido", !l.some((t) => t.includes("Uso alto")));

// 3) 92% -> aviso de 90% + modo econômico
sql(`UPDATE uso_dia SET leituras = 4600000 WHERE dia = '${dia}'`);
l = mostra("tick com leituras em 92%", await tick());
ok("avisou 90% com causas e ação", l.some((t) => t.includes("92%") && t.includes("Causas prováveis") && t.includes("O que fazer")));
ok("ligou modo econômico", l.some((t) => t.includes("MODO ECONÔMICO")));

// 4) com modo econômico: foto e áudio recusados, texto continua
l = mostra("foto no modo econômico", await enviaMsg({ photo: [{ file_id: "recibo_teste.png", width: 800, file_size: 60000 }] }));
ok("recusou foto", l.some((t) => t.includes("Modo econômico")));
l = mostra("/uso no modo econômico", await enviaMsg({ text: "/uso" }));
ok("mostra LIGADO", l.some((t) => t.includes("LIGADO")));
l = mostra("texto normal no modo econômico", await enviaMsg({ text: "quanto é 2+2?" }));
ok("conversa por texto continua", l.length === 1 && !l[0].includes("econômico"));

// 5) 98% -> aviso crítico
sql(`UPDATE uso_dia SET leituras = 4950000 WHERE dia = '${dia}'`);
l = mostra("tick com leituras em 99%", await tick());
ok("avisou 98% (quase no limite, sem cobrança)", l.some((t) => t.includes("quase no limite") && t.includes("não há cobrança")));

// 6) falhas de serviços externos
sql(`UPDATE uso_dia SET leituras = 100, llm_429 = 6, goog_falhas = 5 WHERE dia = '${dia}'`);
l = mostra("tick com falhas de IA (429) e Google", await tick());
ok("avisou limite da IA", l.some((t) => t.includes("limite de uso (erro 429)")));
ok("avisou login do Google", l.some((t) => t.includes("login expirou")));

// 7) sai do modo econômico (novo dia simulado) e testa mídia
sql(`DELETE FROM kv WHERE chave = 'economico'`); sql(`DELETE FROM uso_dia`);
await new Promise((r) => setTimeout(r, 62000)); // o cache do modo econômico vale 1 minuto
l = mostra("áudio longo (300s)", await enviaMsg({ voice: { file_id: "audio_teste.wav", duration: 300, file_size: 100000 } }));
ok("recusou áudio longo", l.some((t) => t.includes("Áudio longo demais")));
l = mostra("foto em 3 tamanhos: deve usar o do meio (800px), não a gigante", await enviaMsg({
  caption: "recibo", photo: [
    { file_id: "pequena_90.png", width: 90, file_size: 2000 },
    { file_id: "recibo_teste.png", width: 800, file_size: 41874 },
    { file_id: "gigante_2560.png", width: 2560, file_size: 3_500_000 },
  ] }));
const baixados = (await saida()).filter((x) => x.metodo === "getFile").map((x) => x.file_id);
ok(`baixou só o tamanho leve (baixados: ${baixados.join(", ")})`, baixados.length === 1 && baixados[0] === "recibo_teste.png");
ok("leu o recibo", l.some((t) => /74,07|74\.07/.test(t)));

// 8) o uso foi medido de verdade pelo próprio bot
l = mostra("/uso depois de usar o bot", await enviaMsg({ text: "/uso" }), 700);
ok("contou requisições e linhas lidas", l.some((t) => /requisições: [1-9]/.test(t) && /linhas lidas no banco: [1-9]/.test(t)));
console.log("\nfim.");
