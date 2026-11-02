import type { Env } from "./env";

/** [texto do botão, callback_data (até 64 bytes)] */
export type Botao = [string, string];

const base = (env: Env) => `${env.TELEGRAM_API_BASE ?? "https://api.telegram.org"}/bot${env.TELEGRAM_TOKEN}`;

export const dono = (env: Env) => (env.TELEGRAM_OWNER_ID ?? "").trim();

function teclado(botoes: Botao[], porLinha = 2) {
  const linhas: Botao[][] = [];
  for (let i = 0; i < botoes.length; i += porLinha) linhas.push(botoes.slice(i, i + porLinha));
  return { inline_keyboard: linhas.map((l) => l.map(([text, callback_data]) => ({ text, callback_data }))) };
}

const escapa = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Blocos ```...``` viram <code> (toque pra copiar). O resto é escapado, então nada quebra o HTML. */
export function formatar(texto: string): string {
  const blocos: string[] = [];
  const semBlocos = texto.replace(/```(?:\w+\n)?([\s\S]*?)```/g, (_, c: string) => {
    blocos.push(c.trim());
    return `\u0000${blocos.length - 1}\u0001`;
  });
  return escapa(semBlocos).replace(/\u0000(\d+)\u0001/g, (_, i) => `<code>${escapa(blocos[+i])}</code>`);
}

async function chamar(env: Env, metodo: string, corpo: unknown, ms = 15000): Promise<any> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(`${base(env)}/${metodo}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(corpo),
      signal: ctl.signal,
    });
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

export async function enviar(env: Env, texto: string, chatId?: string, botoes?: Botao[]) {
  const payload: Record<string, unknown> = { chat_id: chatId || dono(env), text: formatar(texto), parse_mode: "HTML" };
  if (botoes?.length) payload.reply_markup = teclado(botoes);
  const r = await chamar(env, "sendMessage", payload);
  if (!r?.ok) throw new Error(`telegram sendMessage falhou: ${r?.description ?? "sem resposta"}`);
}

export const responderBotao = (env: Env, id: string, texto = "") =>
  chamar(env, "answerCallbackQuery", { callback_query_id: id, text: texto }, 8000).catch(() => {});

/** Troca o texto e remove os botões (a pergunta já foi respondida). */
export const editar = (env: Env, chatId: string, messageId: number, texto: string) =>
  chamar(env, "editMessageText", { chat_id: chatId, message_id: messageId, text: texto }, 8000).catch(() => {});

export const digitando = (env: Env, chatId: string) =>
  chamar(env, "sendChatAction", { chat_id: chatId, action: "typing" }, 5000).catch(() => {});

export async function baixarArquivo(env: Env, fileId: string): Promise<{ dados: ArrayBuffer; nome: string }> {
  const r = await fetch(`${base(env)}/getFile?file_id=${encodeURIComponent(fileId)}`);
  const j: any = await r.json();
  if (!j?.ok) throw new Error("getFile falhou");
  const raiz = env.TELEGRAM_API_BASE ?? "https://api.telegram.org";
  const d = await fetch(`${raiz}/file/bot${env.TELEGRAM_TOKEN}/${j.result.file_path}`);
  if (!d.ok) throw new Error("download do arquivo falhou");
  return { dados: await d.arrayBuffer(), nome: String(j.result.file_path).split("/").pop() || "arquivo" };
}

export const definirWebhook = (env: Env, url: string) =>
  chamar(env, "setWebhook", {
    url,
    secret_token: env.TELEGRAM_WEBHOOK_SECRET,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: false,
    max_connections: 1, // um update por vez, em ordem
  });
