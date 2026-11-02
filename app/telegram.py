"""Canal Telegram (grátis, sem número de telefone pro bot, sem servidor público)."""
import html
import os
import re

import httpx


def _base() -> str:
    return f"https://api.telegram.org/bot{os.getenv('TELEGRAM_TOKEN', '')}"


def dono() -> str:
    return os.getenv("TELEGRAM_OWNER_ID", "").strip()


def teclado(botoes: list[tuple[str, str]], por_linha: int = 2) -> dict:
    """botoes: [(texto do botão, callback_data)]. callback_data aceita até 64 bytes."""
    linhas = [botoes[i:i + por_linha] for i in range(0, len(botoes), por_linha)]
    return {"inline_keyboard": [[{"text": t, "callback_data": d} for t, d in l] for l in linhas]}


def enviar(texto: str, chat_id: str | None = None, botoes: list[tuple[str, str]] | None = None):
    # ```bloco``` vira <code> (toque pra copiar). O resto é escapado, então nada quebra o HTML.
    corpo = re.sub(r"```(?:\w+\n)?(.*?)```", lambda m: "\x00" + m.group(1).strip() + "\x01",
                   texto, flags=re.DOTALL)
    corpo = html.escape(corpo).replace("\x00", "<code>").replace("\x01", "</code>")
    payload = {"chat_id": chat_id or dono(), "text": corpo, "parse_mode": "HTML"}
    if botoes:
        payload["reply_markup"] = teclado(botoes)
    r = httpx.post(f"{_base()}/sendMessage", json=payload, timeout=30)
    r.raise_for_status()


def responder_botao(callback_id: str, texto: str = ""):
    """Tira o 'relógio' do botão no app (obrigatório após um toque)."""
    try:
        httpx.post(f"{_base()}/answerCallbackQuery",
                   json={"callback_query_id": callback_id, "text": texto}, timeout=10)
    except Exception:
        pass


def editar(chat_id: str, message_id: int, texto: str):
    """Troca o texto da mensagem e remove os botões (já foi respondida)."""
    try:
        httpx.post(f"{_base()}/editMessageText",
                   json={"chat_id": chat_id, "message_id": message_id, "text": texto}, timeout=10)
    except Exception:
        pass


def baixar_arquivo(file_id: str) -> bytes:
    r = httpx.get(f"{_base()}/getFile", params={"file_id": file_id}, timeout=20)
    r.raise_for_status()
    caminho = r.json()["result"]["file_path"]
    token = os.getenv("TELEGRAM_TOKEN", "")
    d = httpx.get(f"https://api.telegram.org/file/bot{token}/{caminho}", timeout=60)
    d.raise_for_status()
    return d.content


def digitando(chat_id: str):
    """Mostra 'digitando...' enquanto a IA pensa (não é crítico, erros são ignorados)."""
    try:
        httpx.post(f"{_base()}/sendChatAction",
                   json={"chat_id": chat_id, "action": "typing"}, timeout=10)
    except Exception:
        pass


def buscar_atualizacoes(offset: int | None):
    """Long polling: espera até 30s por mensagens novas."""
    params = {"timeout": 30, "allowed_updates": '["message","callback_query"]'}
    if offset is not None:
        params["offset"] = offset
    r = httpx.get(f"{_base()}/getUpdates", params=params, timeout=40)
    r.raise_for_status()
    return r.json().get("result", [])
