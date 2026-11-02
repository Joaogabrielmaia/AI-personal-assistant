/**
 * Google Agenda e Planilhas por REST. O login (refresh token) é feito UMA vez no PC (python -m app.google_login)
 * e guardado como segredo; aqui só renovamos o token de acesso quando precisa.
 */
import type { Env } from "./env";
import { contar } from "./contadores";
import { economicoSabido } from "./metricas";
import { addDias, agora, fmtIso, isoComFuso, parseLocal } from "./time";

const SEM_LOGIN = { erro: "Google desligado: falta o login (GOOGLE_REFRESH_TOKEN)." };

export const googleAtivo = (env: Env) =>
  !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REFRESH_TOKEN);
export const planilhaAtiva = (env: Env) => googleAtivo(env) && !!(env.GOOGLE_SHEET_ID ?? "").trim();

let cache: { token: string; exp: number } | null = null;

async function tokenAcesso(env: Env): Promise<string | null> {
  if (!googleAtivo(env)) return null;
  if (cache && cache.exp > Date.now() + 60_000) return cache.token;
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID!,
      client_secret: env.GOOGLE_CLIENT_SECRET!,
      refresh_token: env.GOOGLE_REFRESH_TOKEN!,
      grant_type: "refresh_token",
    }),
  });
  const j: any = await r.json();
  if (!r.ok || !j.access_token) throw new Error(`login do Google recusado: ${j.error ?? r.status}`);
  cache = { token: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000 };
  return cache.token;
}

async function g(env: Env, url: string, init: RequestInit = {}): Promise<any> {
  try {
    const t = await tokenAcesso(env);
    if (!t) throw new Error(SEM_LOGIN.erro);
    const r = await fetch(url, {
      ...init,
      headers: { authorization: `Bearer ${t}`, "content-type": "application/json", ...(init.headers ?? {}) },
    });
    if (r.status === 204) return {};
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Google ${r.status}: ${j?.error?.message ?? "erro"}`);
    return j;
  } catch (e) {
    contar("goog_falhas");
    throw e;
  }
}

// ---------------- Agenda ----------------
const CAL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

export interface EventoResumo { id: string; titulo: string; inicio: string; fim: string }
const resumo = (e: any): EventoResumo => ({
  id: e.id,
  titulo: e.summary ?? "(sem título)",
  inicio: e.start?.dateTime ?? e.start?.date,
  fim: e.end?.dateTime ?? e.end?.date,
});

export async function agendaListar(env: Env, dias = 7, inicio?: string): Promise<EventoResumo[] | { erro: string }> {
  if (!googleAtivo(env)) return SEM_LOGIN;
  const de = inicio ? parseLocal(inicio) : agora();
  const ate = addDias(de, dias);
  const q = new URLSearchParams({
    timeMin: isoComFuso(de), timeMax: isoComFuso(ate), singleEvents: "true", orderBy: "startTime", maxResults: "25",
  });
  const j = await g(env, `${CAL}?${q}`);
  return (j.items ?? []).map(resumo);
}

export async function agendaCriar(env: Env, titulo: string, inicio: string, duracaoMin = 30, descricao = "") {
  if (!googleAtivo(env)) return SEM_LOGIN;
  const ini = parseLocal(inicio);
  const fim = new Date(ini.getTime() + duracaoMin * 60000);
  const q = new URLSearchParams({ timeMin: isoComFuso(ini), timeMax: isoComFuso(fim), singleEvents: "true" });
  const existentes: any[] = (await g(env, `${CAL}?${q}`)).items ?? [];
  // idempotente: mesmo título no mesmo horário = o mesmo evento (o modelo às vezes tenta criar duas vezes)
  for (const c of existentes) {
    const ic = c.start?.dateTime;
    if ((c.summary ?? "").trim().toLowerCase() === titulo.trim().toLowerCase() && ic && parseLocal(ic).getTime() === ini.getTime())
      return { ok: true, id: c.id as string, link: c.htmlLink as string, ja_existia: true };
  }
  const ev = await g(env, CAL, {
    method: "POST",
    body: JSON.stringify({
      summary: titulo,
      description: descricao,
      start: { dateTime: isoComFuso(ini), timeZone: "America/Sao_Paulo" },
      end: { dateTime: isoComFuso(fim), timeZone: "America/Sao_Paulo" },
      reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 10 }] },
    }),
  });
  const res: Record<string, unknown> = { ok: true, id: ev.id, link: ev.htmlLink };
  if (existentes.length) res.conflitos = existentes.map((c) => c.summary ?? "(sem título)");
  return res;
}

export async function agendaApagar(env: Env, id: string) {
  if (!googleAtivo(env)) return SEM_LOGIN;
  await g(env, `${CAL}/${encodeURIComponent(id)}`, { method: "DELETE" });
  return { ok: true };
}

// ---------------- Planilhas ----------------
const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";

async function garantirAba(env: Env, aba: string, cabecalho: string[]): Promise<number> {
  const id = env.GOOGLE_SHEET_ID!.trim();
  const meta = await g(env, `${SHEETS}/${id}?fields=sheets.properties(sheetId,title)`);
  const achada = (meta.sheets ?? []).find((s: any) => s.properties.title === aba);
  if (achada) return achada.properties.sheetId;
  const r = await g(env, `${SHEETS}/${id}:batchUpdate`, {
    method: "POST",
    body: JSON.stringify({ requests: [{ addSheet: { properties: { title: aba } } }] }),
  });
  await g(env, `${SHEETS}/${id}/values/${encodeURIComponent(aba)}!A1:append?valueInputOption=USER_ENTERED`, {
    method: "POST",
    body: JSON.stringify({ values: [cabecalho] }),
  });
  return r.replies[0].addSheet.properties.sheetId;
}

/** Acrescenta uma linha. Falhas aqui nunca derrubam o bot (o banco é a fonte principal). */
export async function planilhaAppend(env: Env, aba: string, cabecalho: string[], linha: (string | number)[]): Promise<boolean> {
  if (!planilhaAtiva(env) || economicoSabido()) return false; // modo econômico: sem espelho na planilha
  try {
    await garantirAba(env, aba, cabecalho);
    await g(env, `${SHEETS}/${env.GOOGLE_SHEET_ID!.trim()}/values/${encodeURIComponent(aba)}!A1:append?valueInputOption=USER_ENTERED`, {
      method: "POST",
      body: JSON.stringify({ values: [linha] }),
    });
    return true;
  } catch {
    return false;
  }
}

/** Apaga a linha INTEIRA cujo ID (coluna A) é idRegistro. */
export async function planilhaApagarLinha(env: Env, aba: string, idRegistro: number): Promise<string> {
  if (!planilhaAtiva(env)) return "desligada";
  try {
    const sid = env.GOOGLE_SHEET_ID!.trim();
    const meta = await g(env, `${SHEETS}/${sid}?fields=sheets.properties(sheetId,title)`);
    const a = (meta.sheets ?? []).find((s: any) => s.properties.title === aba);
    if (!a) return "nao_achei";
    const col = await g(env, `${SHEETS}/${sid}/values/${encodeURIComponent(aba)}!A:A`);
    const ids: string[][] = col.values ?? [];
    for (let i = ids.length; i >= 2; i--) {
      if (ids[i - 1]?.[0] === String(idRegistro)) {
        await g(env, `${SHEETS}/${sid}:batchUpdate`, {
          method: "POST",
          body: JSON.stringify({
            requests: [{ deleteDimension: { range: { sheetId: a.properties.sheetId, dimension: "ROWS", startIndex: i - 1, endIndex: i } } }],
          }),
        });
        return "apagada";
      }
    }
    return "nao_achei";
  } catch {
    return "erro";
  }
}

export { fmtIso };
