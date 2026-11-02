"""Espelho no Google Sheets (opcional). Se não estiver configurado, não faz nada.
O SQLite continua sendo a fonte principal; falha aqui nunca derruba o bot.
Cada linha começa com o ID do registro no banco, pra conseguir apagar a linha certa depois."""
import logging
import os
import threading

from . import google_auth

log = logging.getLogger("sheets")
_lock = threading.Lock()
_planilha = None


def ativo() -> bool:
    return bool(os.getenv("GOOGLE_SHEET_ID", "").strip()) and google_auth.credenciais() is not None


def _abrir():
    global _planilha
    if not ativo():
        return None
    if _planilha is None:
        import gspread
        _planilha = gspread.authorize(google_auth.credenciais()).open_by_key(
            os.getenv("GOOGLE_SHEET_ID").strip())
    return _planilha


def _aba(p, nome: str, cabecalho: list[str]):
    try:
        return p.worksheet(nome)
    except Exception:
        ws = p.add_worksheet(title=nome, rows=1000, cols=len(cabecalho))
        ws.append_row(cabecalho)
        return ws


def enviar_agora(aba: str, cabecalho: list[str], linha: list) -> bool:
    try:
        with _lock:
            p = _abrir()
            if p is None:
                return False
            _aba(p, aba, cabecalho).append_row(linha, value_input_option="USER_ENTERED")
            return True
    except Exception:
        log.exception("falha ao gravar na planilha (segue só no SQLite)")
        return False


def registrar(aba: str, cabecalho: list[str], linha: list):
    """Grava em segundo plano pra não atrasar a resposta no Telegram."""
    if os.getenv("GOOGLE_SHEET_ID", "").strip():
        threading.Thread(target=enviar_agora, args=(aba, cabecalho, linha), daemon=True).start()


def apagar_linha(aba: str, id_registro: int) -> str:
    """Apaga a linha inteira cujo ID (coluna A) é id_registro. Devolve 'apagada', 'nao_achei' ou 'desligada'/'erro'."""
    try:
        with _lock:
            p = _abrir()
            if p is None:
                return "desligada"
            ws = p.worksheet(aba)
            ids = ws.col_values(1)
            for i in range(len(ids), 1, -1):          # de baixo pra cima; linha 1 é o cabeçalho
                if ids[i - 1] == str(id_registro):
                    ws.delete_rows(i)
                    return "apagada"
            return "nao_achei"
    except Exception:
        log.exception("falha ao apagar linha na planilha")
        return "erro"
