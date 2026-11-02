"""Escolhe por onde o bot fala com você: telegram (padrão) ou whatsapp."""
import os


def enviar(texto: str, botoes: list[tuple[str, str]] | None = None):
    """botoes: [(rótulo, callback_data)]. No WhatsApp não há botões: viram texto."""
    if os.getenv("CANAL", "telegram") == "whatsapp":
        from . import whatsapp
        if botoes:
            texto += "\n" + " | ".join(r for r, _ in botoes)
        whatsapp.enviar(texto)
    else:
        from . import telegram
        telegram.enviar(texto, botoes=botoes)
