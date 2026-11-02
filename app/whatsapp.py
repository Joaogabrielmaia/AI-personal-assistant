"""Ponte com a Evolution API (WhatsApp não oficial)."""
import os

import httpx

URL = os.getenv("EVOLUTION_URL", "http://localhost:8080")
KEY = os.getenv("EVOLUTION_API_KEY", "")
INSTANCE = os.getenv("EVOLUTION_INSTANCE", "bot")
OWNER = os.getenv("OWNER_NUMBER", "")


def enviar(texto: str, numero: str | None = None):
    r = httpx.post(
        f"{URL}/message/sendText/{INSTANCE}",
        headers={"apikey": KEY},
        json={"number": numero or OWNER, "text": texto},
        timeout=30,
    )
    r.raise_for_status()


def e_do_dono(jid: str) -> bool:
    """Compara os últimos 8 dígitos (evita problema do 9 extra em números BR)."""
    digitos = "".join(ch for ch in jid.split("@")[0] if ch.isdigit())
    return bool(OWNER) and digitos[-8:] == OWNER[-8:]


def extrair_texto(payload: dict):
    """Devolve (jid, texto) de um webhook messages.upsert, ou None se não for texto do dono."""
    data = payload.get("data") or {}
    key = data.get("key") or {}
    if key.get("fromMe"):
        return None
    jid = key.get("remoteJid", "")
    if "@g.us" in jid or not e_do_dono(jid):
        return None
    m = data.get("message") or {}
    texto = m.get("conversation") or (m.get("extendedTextMessage") or {}).get("text")
    return (jid, texto) if texto else None
