// Envia os segredos do bot para a Cloudflare (Workers Secrets), lendo o .env do bot em Python e os arquivos do login do Google.
// NÃO imprime nenhum valor. O arquivo temporário vai para a pasta temporária do sistema e é apagado no fim.
//   uso:  node scripts/enviar-segredos.mjs
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const lerEnv = (p) => Object.fromEntries(
  fs.readFileSync(p, "utf8").split(/\r?\n/).filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]));

const e = lerEnv("../.env");
const cli = JSON.parse(fs.readFileSync("../credenciais_oauth.json", "utf8")).installed;
const tok = JSON.parse(fs.readFileSync("../token_google.json", "utf8"));

// o segredo do webhook é novo e aleatório: só o Telegram e o Worker o conhecem
const webhook = crypto.randomBytes(24).toString("hex");

const segredos = {
  TELEGRAM_TOKEN: e.TELEGRAM_TOKEN, TELEGRAM_OWNER_ID: e.TELEGRAM_OWNER_ID, TELEGRAM_WEBHOOK_SECRET: webhook,
  OWNER_NAME: e.OWNER_NAME,
  LLM_API_KEY: e.LLM_API_KEY, LLM_BASE_URL: e.LLM_BASE_URL, LLM_MODEL: e.LLM_MODEL, LLM_VISION_MODEL: e.LLM_VISION_MODEL, LLM_NULLABLE: e.LLM_NULLABLE,
  LLM2_API_KEY: e.LLM2_API_KEY, LLM2_BASE_URL: e.LLM2_BASE_URL, LLM2_MODEL: e.LLM2_MODEL, LLM2_VISION_MODEL: e.LLM2_VISION_MODEL, LLM2_NULLABLE: e.LLM2_NULLABLE,
  LLM3_API_KEY: e.LLM3_API_KEY, LLM3_BASE_URL: e.LLM3_BASE_URL, LLM3_MODEL: e.LLM3_MODEL, LLM3_VISION_MODEL: e.LLM3_VISION_MODEL, LLM3_NULLABLE: e.LLM3_NULLABLE,
  STT_API_KEY: e.STT_API_KEY, STT_BASE_URL: e.STT_BASE_URL, STT_MODEL: e.STT_MODEL,
  GOOGLE_CLIENT_ID: cli.client_id, GOOGLE_CLIENT_SECRET: cli.client_secret, GOOGLE_REFRESH_TOKEN: tok.refresh_token, GOOGLE_SHEET_ID: e.GOOGLE_SHEET_ID,
  NTFY_TOPIC: e.NTFY_TOPIC, LIMITE_MENSAL: e.LIMITE_MENSAL, EVENTO_AVISO_MIN_ANTES: e.EVENTO_AVISO_MIN_ANTES,
};
const final = Object.fromEntries(Object.entries(segredos).filter(([, v]) => v));
console.log("segredos a enviar:", Object.keys(final).join(", "));

const arq = path.join(os.tmpdir(), `segredos-${crypto.randomBytes(4).toString("hex")}.json`);
fs.writeFileSync(arq, JSON.stringify(final), { mode: 0o600 });
try {
  const r = spawnSync("npx", ["wrangler", "secret", "bulk", arq], { stdio: "inherit", shell: true });
  if (r.status !== 0) process.exitCode = r.status ?? 1;
} finally {
  fs.rmSync(arq, { force: true }); // nunca deixa o arquivo de segredos no disco
}
// o segredo do webhook também é guardado localmente (fora do git) pra ligar o webhook depois
fs.writeFileSync(".webhook-secret", webhook, { mode: 0o600 });
console.log("segredo do webhook salvo em worker/.webhook-secret (ignorado pelo git)");
