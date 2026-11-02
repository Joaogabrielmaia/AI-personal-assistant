/** Testa a proteção contra reentrega do Telegram (marcação em duas fases). */
import { spawnSync } from "node:child_process";

const W = "http://127.0.0.1:8787";
const T = "http://127.0.0.1:8788";
const DONO = 42;
const uid = Math.floor(Date.now() / 1000) + 90000;

const sql = (cmd: string) => spawnSync("npx", ["wrangler", "d1", "execute", "assistente", "--local", "--command", `"${cmd}"`], { shell: true, encoding: "utf8" });
const enviadas = async () => ((await (await fetch(`${T}/_log`)).json()) as any[]).filter((x) => x.metodo === "sendMessage").length;
const post = (id: number) => fetch(`${W}/telegram`, {
  method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "segredo-de-teste" },
  body: JSON.stringify({ update_id: id, message: { message_id: id, chat: { id: DONO, type: "private" }, text: "/uso" } }),
});
const ok = (nome: string, cond: boolean) => console.log(`   ${cond ? "✅" : "❌"} ${nome}`);
const limpa = () => fetch(`${T}/_reset`);

console.log("1) mensagem nova é tratada");
await limpa(); await post(uid);
ok("respondeu 1 vez", (await enviadas()) === 1);

console.log("2) o Telegram reenvia a mesma mensagem (já terminou): ignora");
await limpa(); await post(uid);
ok("não respondeu de novo", (await enviadas()) === 0);

console.log("3) execução INTERROMPIDA há pouco (início recente, sem 'ok'): ainda é considerada em andamento");
sql(`INSERT OR REPLACE INTO kv (chave, valor) VALUES ('u:${uid + 1}', '${Date.now()}')`);
await limpa(); await post(uid + 1);
ok("não duplicou enquanto pode estar rodando", (await enviadas()) === 0);

console.log("4) execução interrompida há mais de 90 s (conexão cancelada, nunca terminou): trata de novo");
sql(`INSERT OR REPLACE INTO kv (chave, valor) VALUES ('u:${uid + 2}', '${Date.now() - 120000}')`);
await limpa(); await post(uid + 2);
ok("a mensagem perdida foi recuperada", (await enviadas()) === 1);
console.log("fim.");
