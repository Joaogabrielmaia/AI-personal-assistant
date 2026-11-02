"""Entrada do modo Telegram:  python -m app.bot"""
import logging
import time
from datetime import datetime, timedelta

from dotenv import load_dotenv

load_dotenv()

from apscheduler.schedulers.background import BackgroundScheduler  # noqa: E402

from . import canal, db, llm, scheduler, telegram, tools  # noqa: E402

logging.basicConfig(level=logging.INFO)
for _nome in ("httpx", "httpx2", "httpcore"):  # as URLs do Telegram contêm o token do bot
    logging.getLogger(_nome).setLevel(logging.WARNING)
log = logging.getLogger("bot")


def _safe_tick():
    try:
        scheduler.tick()
    except Exception:
        log.exception("erro no agendador")


def _responder_ia(chat_id: str, texto: str, imagem: bytes | None = None):
    telegram.digitando(chat_id)
    try:
        resposta, botoes = llm.responder(texto, imagem)
    except Exception as e:
        log.exception("erro na IA")
        resposta, botoes = (f"⚠️ A IA falhou ({type(e).__name__}). "
                            "Veja o terminal ou rode: python -m app.teste"), None
    telegram.enviar(resposta, chat_id, botoes)


def tratar(update: dict):
    if "callback_query" in update:
        return tratar_botao(update["callback_query"])

    msg = update.get("message") or {}
    chat = msg.get("chat") or {}
    chat_id = str(chat.get("id", ""))
    voz = msg.get("voice") or msg.get("audio")
    foto = msg.get("photo")
    texto = msg.get("text") or msg.get("caption") or ""
    if not (texto or voz or foto) or chat.get("type") != "private":
        return

    if not telegram.dono():
        # Primeiro uso: mostra seu ID pra você colocar no .env (não processa nada)
        telegram.enviar(
            f"Seu ID do Telegram é {chat_id}. Coloque no .env em "
            f"TELEGRAM_OWNER_ID={chat_id} e reinicie o bot.",
            chat_id,
        )
        return

    if chat_id != telegram.dono():
        return  # outras pessoas: ignora, sem resposta e sem gastar IA

    imagem = None
    try:
        if voz:
            telegram.digitando(chat_id)
            texto = llm.transcrever(telegram.baixar_arquivo(voz["file_id"]))
            telegram.enviar(f"🎤 Ouvi: {texto}", chat_id)
        elif foto:
            imagem = telegram.baixar_arquivo(foto[-1]["file_id"])  # maior resolução
    except Exception as e:
        log.exception("erro ao baixar/transcrever mídia")
        telegram.enviar(f"⚠️ Não consegui ler o {'áudio' if voz else 'arquivo'} ({type(e).__name__}).", chat_id)
        return

    _responder_ia(chat_id, texto, imagem)


def _tarefa(tid: int):
    with db.conn() as c:
        return c.execute("SELECT titulo, adiamentos FROM tarefas WHERE id = ?", (tid,)).fetchone()


def _oferecer_reagendar(tid: int, titulo: str):
    canal.enviar(f"📅 Quando quer fazer \"{titulo}\"?", [
        ("⏰ Em 1h", f"rg:1h:{tid}"), ("🌙 Hoje à noite", f"rg:noite:{tid}"),
        ("🌅 Amanhã 9h", f"rg:am:{tid}"), ("📆 Semana que vem", f"rg:sem:{tid}"),
        ("✏️ Outro horário", f"rg:out:{tid}"), ("🗑 Desistir", f"tf:x:{tid}")])


def _quando(op: str) -> datetime:
    agora = tools.agora().replace(tzinfo=None, second=0, microsecond=0)
    if op == "1h":
        return agora + timedelta(hours=1)
    if op == "noite":
        noite = agora.replace(hour=20, minute=0)
        return noite if noite > agora + timedelta(minutes=30) else noite + timedelta(days=1)
    if op == "am":
        return (agora + timedelta(days=1)).replace(hour=9, minute=0)
    seg = agora.replace(hour=9, minute=0)  # "sem": próxima segunda 09:00
    return seg + timedelta(days=7 - seg.weekday())


def _acao_botao(dados: str, chat_id: str = "") -> str | None:
    """Executa o que o botão pede. Devolve o texto de confirmação, ou None se deve virar mensagem pra IA."""
    tipo, *resto = dados.split(":")

    if tipo == "tf":
        acao, tid = resto[0], int(resto[1])
        t = _tarefa(tid)
        titulo = t["titulo"] if t else "tarefa"
        with db.conn() as c:
            if acao == "ok":
                c.execute("UPDATE tarefas SET feito = 1, cobrancas = 99 WHERE id = ?", (tid,))
            elif acao == "x":
                c.execute("UPDATE tarefas SET feito = 1, cobrancas = 99 WHERE id = ?", (tid,))
            elif acao == "+10":
                novo = (tools.agora() + timedelta(minutes=10)).strftime("%Y-%m-%dT%H:%M")
                c.execute("UPDATE tarefas SET lembrar_em = ?, avisado = 0, cobrancas = 0, aviso_ts = NULL "
                          "WHERE id = ?", (novo, tid))
                return f"⏰ Aviso de novo às {novo[-5:]}: {titulo}"
            elif acao in ("no", "rg"):
                c.execute("UPDATE tarefas SET cobrancas = 99 WHERE id = ?", (tid,))  # respondeu: para de cobrar
        if acao == "ok":
            tools.registrar_atividade(titulo, True)
            return f"✅ Feito: {titulo}"
        if acao == "x":
            return f"🗑 Desistiu: {titulo}"
        if acao == "no":
            canal.enviar(f"Tranquilo. O que rolou com \"{titulo}\"?", [
                ("😴 Esqueci", f"tm:esqueci:{tid}"), ("⏳ Sem tempo", f"tm:sem tempo:{tid}"),
                ("😩 Sem vontade", f"tm:sem vontade:{tid}"), ("🔄 Mudou o plano", f"tm:mudou o plano:{tid}"),
                ("Pular", f"tm:-:{tid}")])
            return f"❌ Não fez: {titulo}"
        _oferecer_reagendar(tid, titulo)  # "rg"
        return f"📅 Vamos reagendar: {titulo}"

    if tipo == "tm":  # motivo de não ter feito
        motivo, tid = resto[0], int(resto[1])
        t = _tarefa(tid)
        titulo = t["titulo"] if t else "tarefa"
        tools.registrar_atividade(titulo, False, "" if motivo == "-" else motivo)
        _oferecer_reagendar(tid, titulo)
        return f"Motivo: {motivo}" if motivo != "-" else "Ok."

    if tipo == "rg":  # escolha do novo horário
        op, tid = resto[0], int(resto[1])
        t = _tarefa(tid)
        titulo = t["titulo"] if t else "tarefa"
        if op == "out":
            llm.registrar("assistant", f"Quando quer reagendar \"{titulo}\" (#{tid})? Ele vai responder com dia/hora.")
            canal.enviar("✏️ Me diz quando (ex: sexta 15h, dia 10 de manhã).")
            return "✏️ Outro horário"
        r = tools.reagendar_tarefa(tid, _quando(op).strftime("%Y-%m-%dT%H:%M"))
        if r.get("vezes_adiada", 0) >= 3:
            canal.enviar(f"🤨 Já é a {r['vezes_adiada']}ª vez que você adia \"{titulo}\". Que tal só 5 minutos agora?", [
                ("⏱ 5 min agora", f"pr:foco:{tid}"), ("🧩 Quebrar em passos", f"pr:passos:{tid}"),
                ("🗑 Desistir", f"pr:x:{tid}"), ("Mantém assim", f"pr:ok:{tid}")])
        return f"📅 Reagendado pra {r['novo_horario'].replace('T', ' ')}: {titulo}"

    if tipo == "pr":  # enrolação repetida
        acao, tid = resto[0], int(resto[1])
        t = _tarefa(tid)
        titulo = t["titulo"] if t else "tarefa"
        if acao == "foco":
            tools.iniciar_foco(5, titulo)
            return f"⏱ Valendo! 5 minutos em: {titulo}"
        if acao == "x":
            with db.conn() as c:
                c.execute("UPDATE tarefas SET feito = 1, cobrancas = 99 WHERE id = ?", (tid,))
            return f"🗑 Desistiu: {titulo}"
        if acao == "passos":
            _responder_ia(chat_id, f"Quebre a tarefa \"{titulo}\" (#{tid}) em 3 passos bem pequenos, "
                                   "o primeiro deve levar menos de 5 minutos.")
            return "🧩 Quebrando em passos"
        return "👍 Mantido"

    if tipo == "lb":  # lembrete (água, etc.)
        acao, lid = resto[0], int(resto[1])
        with db.conn() as c:
            l = c.execute("SELECT mensagem FROM lembretes WHERE id = ?", (lid,)).fetchone()
        nome = l["mensagem"] if l else "lembrete"
        if acao == "ok":
            tools.registrar_atividade(nome, True)
            return f"✅ Registrado: {nome}"
        return f"⏭ Ok, depois: {nome}"

    if tipo == "al":
        with db.conn() as c:
            c.execute("UPDATE alarmes SET confirmado = 1 WHERE id = ?", (int(resto[1]),))
        return "☀️ Bom dia! Alarme desligado."

    if tipo == "fo":
        acao, fid = resto[0], int(resto[1])
        with db.conn() as c:
            f = c.execute("SELECT titulo FROM focos WHERE id = ?", (fid,)).fetchone()
            titulo = f["titulo"] if f else "foco"
            if acao == "+10":
                fim = (tools.agora() + timedelta(minutes=10)).strftime("%Y-%m-%dT%H:%M")
                c.execute("UPDATE focos SET fim = ?, avisado = 0 WHERE id = ?", (fim, fid))
                return f"➕ Mais 10 min de foco: {titulo}"
        tools.registrar_atividade("foco", acao == "ok", titulo)
        return "✅ Foco concluído, boa!" if acao == "ok" else "😵 Anotado. Amanhã a gente tenta de novo."

    if tipo == "hu":
        tools.registrar_atividade("humor", True, resto[0])
        return f"🌙 Humor do dia: {resto[0]}/5. Anotado."

    return None


def tratar_botao(cb: dict):
    chat_id = str((cb.get("message") or {}).get("chat", {}).get("id", ""))
    msg_id = (cb.get("message") or {}).get("message_id")
    if chat_id != telegram.dono():
        telegram.responder_botao(cb["id"])
        return

    dados = cb.get("data", "")
    original = (cb.get("message") or {}).get("text", "")

    if dados.startswith("op:"):  # opção que a própria IA ofereceu: vira a resposta do usuário
        escolha = dados[3:]
        telegram.responder_botao(cb["id"])
        telegram.editar(chat_id, msg_id, f"{original}\n\n→ {escolha}")
        _responder_ia(chat_id, escolha)
        return

    try:
        confirmacao = _acao_botao(dados, chat_id)
    except Exception:
        log.exception("erro no botão %s", dados)
        telegram.responder_botao(cb["id"], "Deu erro, tenta de novo")
        return
    telegram.responder_botao(cb["id"])
    if confirmacao:
        telegram.editar(chat_id, msg_id, f"{original}\n\n{confirmacao}")
        llm.registrar("assistant", confirmacao)


def main():
    db.init()
    sched = BackgroundScheduler(timezone="America/Sao_Paulo")
    sched.add_job(_safe_tick, "interval", minutes=scheduler.TICK_MIN)
    sched.start()
    log.info("Bot Telegram rodando. Ctrl+C para parar.")

    offset = None
    while True:
        try:
            for u in telegram.buscar_atualizacoes(offset):
                offset = u["update_id"] + 1
                try:
                    tratar(u)
                except Exception:
                    log.exception("erro ao tratar mensagem")
        except KeyboardInterrupt:
            break
        except Exception:
            log.exception("erro no polling, tentando de novo em 5s")
            time.sleep(5)


if __name__ == "__main__":
    main()
