// Transcreve um arquivo de áudio com o mesmo provedor e a mesma "dica" de vocabulário do bot. Uso: node test/transcrever.mjs "caminho.wav"
import fs from "node:fs";
import path from "node:path";

const arq = process.argv[2];
const env = Object.fromEntries(
  fs.readFileSync("../.env", "utf8").split(/\r?\n/).filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]));

const dica = "Assistente de rotina. Termos: reunião, lembrete, agenda, compromisso, tarefa, academia, gastei, marcar, remarcar, amanhã, hoje, às, horas, consulta, mercado.";
for (const modelo of ["whisper-large-v3", "whisper-large-v3-turbo"]) {
  for (const comDica of [true, false]) {
    const f = new FormData();
    f.append("file", new Blob([fs.readFileSync(arq)], { type: "audio/wav" }), path.basename(arq));
    f.append("model", modelo);
    f.append("language", "pt");
    if (comDica) f.append("prompt", dica);
    const t = Date.now();
    const r = await fetch(`${env.STT_BASE_URL}/audio/transcriptions`, { method: "POST", headers: { authorization: `Bearer ${env.STT_API_KEY}` }, body: f });
    const j = await r.json();
    console.log(`${modelo.padEnd(24)} dica=${String(comDica).padEnd(5)} ${Date.now() - t} ms ->`, r.ok ? JSON.stringify(j.text) : `ERRO ${r.status} ${JSON.stringify(j).slice(0, 120)}`);
  }
}
