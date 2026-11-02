// Servidor local só para testes: entrega arquivos específicos ao navegador (para colar no Telegram Web).
// Uso: node test/servir-arquivos.mjs audio.wav=C:/caminho/Gravando.wav recibo.png=C:/caminho/recibo.png
import fs from "node:fs";
import http from "node:http";

const mapa = Object.fromEntries(process.argv.slice(2).map((a) => [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)]));
const tipos = { wav: "audio/wav", png: "image/png", ogg: "audio/ogg", mp3: "audio/mpeg" };

http.createServer((req, res) => {
  // CORS + Private Network Access: o Telegram Web (https público) pede um arquivo na sua máquina (127.0.0.1)
  res.setHeader("Access-Control-Allow-Origin", "https://web.telegram.org");
  res.setHeader("Access-Control-Allow-Private-Network", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }
  const nome = new URL(req.url, "http://x").pathname.slice(1);
  const arq = mapa[nome];
  if (!arq || !fs.existsSync(arq)) { res.statusCode = 404; return res.end("não encontrado"); }
  res.setHeader("content-type", tipos[nome.split(".").pop()] ?? "application/octet-stream");
  res.end(fs.readFileSync(arq));
}).listen(8799, "127.0.0.1", () => console.log("servindo:", Object.keys(mapa).join(", ")));
