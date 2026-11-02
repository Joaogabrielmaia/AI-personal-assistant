"""Alarme no celular via ntfy (grátis). Prioridade máxima toca como alarme e fura o 'não perturbe'
(depois de liberado nas configurações do app). Se NTFY_TOPIC não estiver definido, não faz nada."""
import logging
import os

import httpx

log = logging.getLogger("ntfy")


def ativo() -> bool:
    return bool(os.getenv("NTFY_TOPIC", "").strip())


def alarme(mensagem: str, titulo: str = "Alarme") -> bool:
    """Prioridade 5 = urgente. Devolve True se o ntfy aceitou. (Título em ASCII: vai em cabeçalho HTTP.)"""
    if not ativo():
        return False
    servidor = os.getenv("NTFY_SERVER", "https://ntfy.sh").rstrip("/")
    try:
        httpx.post(
            f"{servidor}/{os.getenv('NTFY_TOPIC').strip()}",
            content=mensagem.encode("utf-8"),
            headers={"Title": titulo, "Priority": "5", "Tags": "alarm_clock"},
            timeout=15,
        ).raise_for_status()
        return True
    except Exception:
        log.exception("falha ao enviar pro ntfy")
        return False


if __name__ == "__main__":  # python -m app.ntfy  -> manda um teste
    from dotenv import load_dotenv
    load_dotenv()
    if not ativo():
        print("NTFY_TOPIC não está no .env")
    else:
        print("enviado" if alarme("Teste 2 do assistente: se tocou, o ntfy esta funcionando.", "Teste")
              else "FALHOU (veja o erro acima)")
