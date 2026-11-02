// Liga o webhook do Telegram apontando para o Worker publicado. Uso:  node scripts/ligar-webhook.mjs https://SEU-WORKER.workers.dev
import fs from "node:fs";

const url = (process.argv[2] ?? "").replace(/\/$/, "");
if (!url.startsWith("https://")) { console.error("informe a URL https do Worker"); process.exit(1); }
const segredo = fs.readFileSync(".webhook-secret", "utf8").trim();

const r = await fetch(`${url}/admin/setup`, { method: "POST", headers: { authorization: `Bearer ${segredo}` } });
console.log("HTTP", r.status, await r.text());
