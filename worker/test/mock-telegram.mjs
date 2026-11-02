// Telegram falso para testes locais: guarda tudo que o bot "enviaria" e devolve respostas válidas.
// MOCK_DIR: pasta com arquivos de teste (foto/áudio) servidos como se fossem do Telegram.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

let log = [];
let nextMsg = 1000;
const DIR = process.env.MOCK_DIR || ".";

const srv = http.createServer((req, res) => {
  let corpo = "";
  req.on("data", (d) => (corpo += d));
  req.on("end", () => {
    const url = new URL(req.url, "http://x");
    const json = (o) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(o)); };
    if (url.pathname === "/_log") return json(log);
    if (url.pathname === "/_reset") { log = []; return json({ ok: true }); }
    if (url.pathname.startsWith("/file/")) {
      const arq = path.join(DIR, path.basename(url.pathname));
      res.setHeader("content-type", "application/octet-stream");
      return res.end(fs.existsSync(arq) ? fs.readFileSync(arq) : Buffer.from("vazio"));
    }
    const metodo = url.pathname.split("/").pop();
    let dados = {};
    try { dados = corpo ? JSON.parse(corpo) : Object.fromEntries(url.searchParams); } catch { /* ignora */ }
    log.push({ metodo, ...dados });
    if (metodo === "getFile") return json({ ok: true, result: { file_path: dados.file_id } }); // file_id = nome do arquivo
    if (metodo === "sendMessage") return json({ ok: true, result: { message_id: nextMsg++ } });
    return json({ ok: true, result: true });
  });
});
srv.listen(8788, "127.0.0.1", () => console.log("telegram falso em http://127.0.0.1:8788"));
