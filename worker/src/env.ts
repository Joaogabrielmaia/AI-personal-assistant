/** Variáveis e bindings do Worker. Segredos entram com `wrangler secret put NOME` (nunca no código). */
export interface Env {
  DB: D1Database;

  // Telegram
  TELEGRAM_TOKEN: string;
  TELEGRAM_OWNER_ID: string;
  TELEGRAM_WEBHOOK_SECRET: string; // o Telegram manda isso num cabeçalho; só ele e nós sabemos
  TELEGRAM_API_BASE?: string; // só pra testes (servidor falso)

  OWNER_NAME?: string;

  // IA principal e reserva (qualquer API compatível com OpenAI)
  LLM_API_KEY: string;
  LLM_BASE_URL: string;
  LLM_MODEL: string;
  LLM_VISION_MODEL?: string;
  LLM_NULLABLE?: string;
  LLM_TIMEOUT_PRINCIPAL?: string;
  LLM2_API_KEY?: string;
  LLM2_BASE_URL?: string;
  LLM2_MODEL?: string;
  LLM2_VISION_MODEL?: string;
  LLM2_NULLABLE?: string;
  LLM3_API_KEY?: string;
  LLM3_BASE_URL?: string;
  LLM3_MODEL?: string;
  LLM3_VISION_MODEL?: string;
  LLM3_NULLABLE?: string;

  // Áudio (whisper)
  STT_API_KEY?: string;
  STT_BASE_URL?: string;
  STT_MODEL?: string;

  // Google (OAuth de computador; o refresh token vem do login feito uma vez no PC)
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REFRESH_TOKEN?: string;
  GOOGLE_SHEET_ID?: string;

  // Extras
  NTFY_TOPIC?: string;
  NTFY_SERVER?: string;
  LIMITE_MENSAL?: string;
  EVENTO_AVISO_MIN_ANTES?: string;
}
