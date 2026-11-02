/**
 * Horário de Brasília (UTC-3 fixo; o Brasil não usa mais horário de verão).
 * Trabalhamos com um Date "deslocado": use SEMPRE os getters getUTC*, que então devolvem a hora local de Brasília.
 */
const OFFSET_MS = -3 * 3600 * 1000;
const p2 = (n: number) => String(n).padStart(2, "0");

export const agora = (): Date => new Date(Date.now() + OFFSET_MS);
export const fmtData = (d: Date) => `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
export const fmtHM = (d: Date) => `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
/** 'AAAA-MM-DDTHH:MM' */
export const fmtIso = (d: Date) => `${fmtData(d)}T${fmtHM(d)}`;
/** timestamp completo com fuso, como o isoformat() do Python */
export const tsCompleto = (d: Date = agora()) =>
  `${fmtData(d)}T${fmtHM(d)}:${p2(d.getUTCSeconds())}.${String(d.getUTCMilliseconds()).padStart(3, "0")}-03:00`;
/** minutos desde 00:00 */
export const minutosDoDia = (d: Date) => d.getUTCHours() * 60 + d.getUTCMinutes();
/** segunda=0 ... domingo=6 */
export const diaSemana = (d: Date) => (d.getUTCDay() + 6) % 7;
const NOMES = ["segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado", "domingo"];
export const nomeDiaSemana = (d: Date) => NOMES[diaSemana(d)];
export const addMin = (d: Date, n: number) => new Date(d.getTime() + n * 60000);
export const addDias = (d: Date, n: number) => new Date(d.getTime() + n * 86400000);

/** 'AAAA-MM-DDTHH:MM' (ou só data, ou com fuso) -> Date deslocado de Brasília */
export function parseLocal(s: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/.exec(s.trim());
  if (!m) throw new Error(`data inválida: ${s}`);
  const [, y, mo, d, h = "0", mi = "0", se = "0", tz] = m;
  let t = Date.UTC(+y, +mo - 1, +d, +h, +mi, +se);
  if (tz) {
    // veio com fuso explícito: converte do instante real pra "hora local deslocada"
    const sign = tz === "Z" ? 0 : (tz[0] === "-" ? -1 : 1) * (+tz.slice(1, 3) * 60 + +tz.slice(4, 6));
    t = t - sign * 60000 + OFFSET_MS;
  }
  return new Date(t);
}
/** ISO com fuso -03:00 pra APIs externas (ex: Google Agenda) */
export const isoComFuso = (d: Date) => `${fmtData(d)}T${fmtHM(d)}:00-03:00`;
