"""Login do Google (OAuth de computador) usado pela Planilha e pela Agenda.

1ª vez:  python -m app.google_login   (abre o navegador, você aprova, o token fica em token_google.json)
Depois o bot renova o token sozinho. Se não houver token, Planilha e Agenda ficam desligadas."""
import logging
import re
from pathlib import Path

log = logging.getLogger("google")

RAIZ = Path(__file__).resolve().parent.parent
CLIENTE = RAIZ / "credenciais_oauth.json"
TOKEN = RAIZ / "token_google.json"
SCOPES = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/drive.file",   # só arquivos criados pelo próprio bot
]


def credenciais():
    """Devolve as credenciais válidas, ou None se o login ainda não foi feito / expirou."""
    if not TOKEN.exists():
        return None
    try:
        from google.auth.transport.requests import Request
        from google.oauth2.credentials import Credentials
        c = Credentials.from_authorized_user_file(str(TOKEN), SCOPES)
        if not c.valid:
            if not c.refresh_token:
                return None
            c.refresh(Request())
            TOKEN.write_text(c.to_json(), encoding="utf-8")
        return c
    except Exception:
        log.exception("login do Google inválido; rode: python -m app.google_login")
        return None


def login():
    from google_auth_oauthlib.flow import InstalledAppFlow
    if not CLIENTE.exists():
        raise SystemExit(f"Falta o arquivo {CLIENTE.name} na raiz do projeto.")
    flow = InstalledAppFlow.from_client_secrets_file(str(CLIENTE), SCOPES)
    c = flow.run_local_server(port=8765, prompt="consent", timeout_seconds=600)
    TOKEN.write_text(c.to_json(), encoding="utf-8")
    return c


def _criar_planilha(c) -> str:
    """Cria a planilha do assistente na sua conta e grava o ID no .env."""
    import gspread
    p = gspread.authorize(c).create("Assistente de Rotina")
    env = RAIZ / ".env"
    texto = env.read_text(encoding="utf-8") if env.exists() else ""
    if re.search(r"^GOOGLE_SHEET_ID=.*$", texto, flags=re.M):
        texto = re.sub(r"^GOOGLE_SHEET_ID=.*$", f"GOOGLE_SHEET_ID={p.id}", texto, flags=re.M)
    else:
        texto += f"\nGOOGLE_SHEET_ID={p.id}\n"
    env.write_text(texto, encoding="utf-8")
    return p.url


def principal():
    import os
    from dotenv import load_dotenv
    load_dotenv(RAIZ / ".env")
    creds = login()
    print("Login feito. Token salvo em", TOKEN.name)
    if not os.getenv("GOOGLE_SHEET_ID", "").strip():
        print("Planilha criada:", _criar_planilha(creds))
    else:
        print("Usando a planilha já configurada em GOOGLE_SHEET_ID.")
    print("Reinicie o bot para ativar.")
