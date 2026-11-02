"""Google Agenda (sua agenda principal). Precisa do login: python -m app.google_login"""
import logging
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from . import google_auth

log = logging.getLogger("agenda")
TZ = ZoneInfo("America/Sao_Paulo")
NOME_TZ = "America/Sao_Paulo"


def _servico():
    c = google_auth.credenciais()
    if c is None:
        return None
    from googleapiclient.discovery import build
    return build("calendar", "v3", credentials=c, cache_discovery=False)


def _dt(iso: str) -> datetime:
    d = datetime.fromisoformat(iso)
    return d if d.tzinfo else d.replace(tzinfo=TZ)


def _resumo(e: dict) -> dict:
    ini = e["start"].get("dateTime") or e["start"].get("date")
    fim = e["end"].get("dateTime") or e["end"].get("date")
    return {"id": e["id"], "titulo": e.get("summary", "(sem título)"), "inicio": ini, "fim": fim}


def listar(dias: int = 7, inicio: str | None = None) -> list[dict] | dict:
    s = _servico()
    if s is None:
        return {"erro": "Agenda desligada: rode 'python -m app.google_login' uma vez."}
    de = _dt(inicio) if inicio else datetime.now(TZ)
    ate = de + timedelta(days=dias)
    r = s.events().list(calendarId="primary", timeMin=de.isoformat(), timeMax=ate.isoformat(),
                        singleEvents=True, orderBy="startTime", maxResults=25).execute()
    return [_resumo(e) for e in r.get("items", [])]


def criar(titulo: str, inicio: str, duracao_min: int = 30, descricao: str = "") -> dict:
    """inicio: AAAA-MM-DDTHH:MM (Brasília). Avisa se já existe algo no mesmo horário."""
    s = _servico()
    if s is None:
        return {"erro": "Agenda desligada: rode 'python -m app.google_login' uma vez."}
    ini = _dt(inicio)
    fim = ini + timedelta(minutes=int(duracao_min))
    conflitos = s.events().list(calendarId="primary", timeMin=ini.isoformat(), timeMax=fim.isoformat(),
                                singleEvents=True).execute().get("items", [])
    # idempotente: mesmo título no mesmo horário = o mesmo evento (o modelo às vezes tenta criar duas vezes)
    for c in conflitos:
        ini_c = c["start"].get("dateTime")
        if c.get("summary", "").strip().lower() == titulo.strip().lower() and ini_c and _dt(ini_c) == ini:
            return {"ok": True, "id": c["id"], "link": c.get("htmlLink"), "ja_existia": True}
    ev = s.events().insert(calendarId="primary", body={
        "summary": titulo, "description": descricao,
        "start": {"dateTime": ini.isoformat(), "timeZone": NOME_TZ},
        "end": {"dateTime": fim.isoformat(), "timeZone": NOME_TZ},
        "reminders": {"useDefault": False, "overrides": [{"method": "popup", "minutes": 10}]},
    }).execute()
    res = {"ok": True, "id": ev["id"], "link": ev.get("htmlLink")}
    if conflitos:
        res["conflitos"] = [c.get("summary", "(sem título)") for c in conflitos]
    return res


def apagar(id: str) -> dict:
    s = _servico()
    if s is None:
        return {"erro": "Agenda desligada: rode 'python -m app.google_login' uma vez."}
    s.events().delete(calendarId="primary", eventId=id).execute()
    return {"ok": True}
