// Gera o .dev.vars (segredos SÓ para teste local) a partir do .env do bot em Python. Não imprime nenhum valor.
import fs from "node:fs";

const lerEnv = (p) => Object.fromEntries(
  fs.readFileSync(p, "utf8").split(/\r?\n/).filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]));

const e = lerEnv("../.env");
const cli = JSON.parse(fs.readFileSync("../credenciais_oauth.json", "utf8")).installed;
const tok = JSON.parse(fs.readFileSync("../token_google.json", "utf8"));

const v = {
  TELEGRAM_TOKEN: "TOKEN_DE_TESTE", TELEGRAM_OWNER_ID: "42", TELEGRAM_WEBHOOK_SECRET: "segredo-de-teste",
  TELEGRAM_API_BASE: "http://127.0.0.1:8788", OWNER_NAME: e.OWNER_NAME || "João",
  LLM_API_KEY: e.LLM_API_KEY, LLM_BASE_URL: e.LLM_BASE_URL, LLM_MODEL: e.LLM_MODEL, LLM_VISION_MODEL: e.LLM_VISION_MODEL, LLM_NULLABLE: e.LLM_NULLABLE || "1",
  LLM2_API_KEY: e.LLM2_API_KEY, LLM2_BASE_URL: e.LLM2_BASE_URL, LLM2_MODEL: e.LLM2_MODEL, LLM2_VISION_MODEL: e.LLM2_VISION_MODEL, LLM2_NULLABLE: e.LLM2_NULLABLE || "0",
  STT_API_KEY: e.STT_API_KEY, STT_BASE_URL: e.STT_BASE_URL, STT_MODEL: e.STT_MODEL,
  GOOGLE_CLIENT_ID: cli.client_id, GOOGLE_CLIENT_SECRET: cli.client_secret, GOOGLE_REFRESH_TOKEN: tok.refresh_token,
  // GOOGLE_SHEET_ID fica de fora no teste local: não mexe na sua planilha real
};
fs.writeFileSync(".dev.vars", Object.entries(v).filter(([, x]) => x).map(([k, x]) => `${k}=${x}`).join("\n") + "\n");
console.log(".dev.vars gerado com", Object.values(v).filter(Boolean).length, "variáveis");
