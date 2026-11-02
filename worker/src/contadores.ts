/** Contadores em memória (sem dependências, pra qualquer módulo poder contar). O metricas.ts grava no banco. */
const acc: Record<string, number> = {};

/** Tamanho mais recente do banco (o D1 informa a cada escrita). */
export const ultimo: { bytes: number } = { bytes: 0 };

export function contar(chave: string, n = 1) {
  if (n) acc[chave] = (acc[chave] ?? 0) + n;
}

/** Entrega o que foi contado desde a última vez e zera. */
export function retirar(): Record<string, number> {
  const c = { ...acc };
  for (const k of Object.keys(acc)) delete acc[k];
  return c;
}
