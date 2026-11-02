import type { Env } from "./env";

/** Alarme no celular via ntfy (prioridade 5 = urgente). Sem NTFY_TOPIC, não faz nada. */
export async function alarme(env: Env, mensagem: string, titulo = "Alarme"): Promise<boolean> {
  const topico = (env.NTFY_TOPIC ?? "").trim();
  if (!topico) return false;
  try {
    const r = await fetch(`${(env.NTFY_SERVER ?? "https://ntfy.sh").replace(/\/$/, "")}/${topico}`, {
      method: "POST",
      body: mensagem,
      headers: { Title: titulo, Priority: "5", Tags: "alarm_clock" },
    });
    return r.ok;
  } catch {
    return false;
  }
}
