"""Agendador: a cada minuto decide se algum lembrete, tarefa, foco, alarme ou resumo deve ser enviado."""
import json
import logging
import os
import random
from datetime import datetime, timedelta

from . import agenda, canal, db, llm, ntfy, tools

log = logging.getLogger("scheduler")
TICK_MIN = 1

# horários dos resumos automáticos (horário de Brasília)
HORA_MANHA = "07:30"
HORA_NOITE = "21:30"
HORA_SEMANAL = "20:00"     # domingo
ALARME_MAX_TOQUES = 20     # quantas vezes o alarme insiste antes de desistir


def _minutos(hhmm: str) -> int:
    h, m = hhmm.split(":")
    return int(h) * 60 + int(m)


COBRANCA_MIN = 15     # sem resposta ao aviso: cutuca de novo após 15 min, depois 30 min
COBRANCA_MAX = 2


def botoes_tarefa(tarefa_id: int):
    return [("✅ Fiz", f"tf:ok:{tarefa_id}"), ("❌ Não fiz", f"tf:no:{tarefa_id}"),
            ("📅 Reagendar", f"tf:rg:{tarefa_id}"), ("⏰ +10 min", f"tf:+10:{tarefa_id}")]


def _enviar(lembrete_id: int, instrucao: str):
    texto = llm.gerar_mensagem_proativa(instrucao)
    canal.enviar(texto, [("✅ Feito", f"lb:ok:{lembrete_id}"), ("⏭ Depois", f"lb:no:{lembrete_id}")])
    with db.conn() as c:
        c.execute(
            "INSERT INTO envios (lembrete_id, ts) VALUES (?, ?)",
            (lembrete_id, tools.agora().isoformat()),
        )


def _envios_hoje(c, lembrete_id: int, hoje: str):
    return c.execute(
        "SELECT ts FROM envios WHERE lembrete_id = ? AND ts LIKE ? ORDER BY ts",
        (lembrete_id, f"{hoje}%"),
    ).fetchall()


def avisar_tarefas():
    """Tarefas com horário: avisa quando chega a hora (texto simples, sem depender da IA)."""
    agora = tools.agora().strftime("%Y-%m-%dT%H:%M")
    with db.conn() as c:
        vencidas = [dict(r) for r in c.execute(
            "SELECT id, titulo, lembrar_em FROM tarefas "
            "WHERE feito = 0 AND avisado = 0 AND lembrar_em IS NOT NULL AND lembrar_em <= ?",
            (agora,),
        )]
    for t in vencidas:
        texto = f"⏰ Hora de: {t['titulo']}\nConseguiu fazer?"
        canal.enviar(texto, botoes_tarefa(t["id"]))
        llm.registrar("assistant", texto.replace("\n", " ") + f" (tarefa #{t['id']})")
        with db.conn() as c:
            c.execute("UPDATE tarefas SET avisado = 1, cobrancas = 0, aviso_ts = ? WHERE id = ?",
                      (tools.agora().isoformat(), t["id"]))


SYNC_AGENDA_MIN = 5       # de quantos em quantos minutos olha a Google Agenda
_ultimo_sync = {"t": None}


def sincronizar_agenda():
    """Lê a Google Agenda (próximas 36h) e garante um aviso pra cada evento, mesmo os criados fora do bot."""
    agora = tools.agora()
    if _ultimo_sync["t"] and (agora - _ultimo_sync["t"]).total_seconds() < SYNC_AGENDA_MIN * 60:
        return
    _ultimo_sync["t"] = agora
    eventos = agenda.listar(1.5)
    if not isinstance(eventos, list):       # sem login do Google: segue sem agenda
        return
    ids = set()
    for e in eventos:
        if "T" not in e["inicio"]:          # evento de dia inteiro não tem horário pra avisar
            continue
        ids.add(e["id"])
        tools.agendar_aviso_evento(e["id"], e["titulo"], e["inicio"])
    limite = (agora + timedelta(hours=36)).strftime("%Y-%m-%dT%H:%M")
    with db.conn() as c:                    # evento apagado/movido na agenda: tira o aviso que ficou
        for r in c.execute("SELECT evento_id FROM avisos_evento WHERE avisado = 0 AND quando <= ?", (limite,)).fetchall():
            if r["evento_id"] not in ids:
                c.execute("DELETE FROM avisos_evento WHERE evento_id = ?", (r["evento_id"],))


def avisar_eventos():
    """Eventos da agenda: manda o aviso no Telegram quando chega a hora."""
    agora = tools.agora().replace(tzinfo=None)
    with db.conn() as c:
        vencidos = [dict(r) for r in c.execute(
            "SELECT id, titulo, quando FROM avisos_evento WHERE avisado = 0 AND quando <= ?",
            (agora.strftime("%Y-%m-%dT%H:%M"),))]
    antes = int(os.getenv("EVENTO_AVISO_MIN_ANTES", "0") or 0)
    enviados = set()
    for v in vencidos:
        # bot desligado por muito tempo: não avisa de evento que já foi há mais de 30 min
        # (e nunca manda duas vezes a mesma mensagem, mesmo que haja eventos duplicados na agenda)
        chave = (v["titulo"].strip().lower(), v["quando"])
        if chave not in enviados and agora - datetime.fromisoformat(v["quando"]) <= timedelta(minutes=30):
            enviados.add(chave)
            texto = f"📅 Agora: {v['titulo']}" if antes == 0 else f"📅 Em {antes} min: {v['titulo']}"
            canal.enviar(texto)
            llm.registrar("assistant", texto)
        with db.conn() as c:
            c.execute("UPDATE avisos_evento SET avisado = 1 WHERE id = ?", (v["id"],))


def cobrar_tarefas():
    """Avisou e não teve resposta (nenhum botão, nenhuma conversa): cutuca de novo, no máximo COBRANCA_MAX vezes."""
    agora = tools.agora()
    with db.conn() as c:
        pendentes = [dict(r) for r in c.execute(
            "SELECT id, titulo, cobrancas, aviso_ts FROM tarefas "
            "WHERE feito = 0 AND avisado = 1 AND aviso_ts IS NOT NULL AND cobrancas < ?", (COBRANCA_MAX,))]
    frases = ["Ei, e aí: {t}? Fez ou vai adiar?", "Última cutucada: {t}. Resolve agora ou reagenda?"]
    for t in pendentes:
        espera = timedelta(minutes=COBRANCA_MIN * (t["cobrancas"] + 1))
        if agora - datetime.fromisoformat(t["aviso_ts"]) < espera:
            continue
        canal.enviar("👀 " + frases[t["cobrancas"]].format(t=t["titulo"]), botoes_tarefa(t["id"]))
        with db.conn() as c:
            c.execute("UPDATE tarefas SET cobrancas = cobrancas + 1 WHERE id = ?", (t["id"],))


def avisar_focos():
    agora = tools.agora().strftime("%Y-%m-%dT%H:%M")
    with db.conn() as c:
        fim = [dict(r) for r in c.execute(
            "SELECT id, titulo FROM focos WHERE avisado = 0 AND fim <= ?", (agora,))]
    for f in fim:
        canal.enviar(f"⏱ Acabou o foco: {f['titulo']}. Como foi?",
                     [("✅ Concentrei", f"fo:ok:{f['id']}"), ("😵 Me distraí", f"fo:no:{f['id']}"),
                      ("➕ Mais 10 min", f"fo:+10:{f['id']}")])
        llm.registrar("assistant", f"⏱ Acabou o foco: {f['titulo']}. Como foi?")
        with db.conn() as c:
            c.execute("UPDATE focos SET avisado = 1 WHERE id = ?", (f["id"],))


def tocar_alarmes():
    """Alarme insistente: a partir da hora, manda uma mensagem por minuto até tocar em 'Acordei'."""
    agora = tools.agora()
    hoje = agora.date().isoformat()
    minuto_atual = agora.hour * 60 + agora.minute
    with db.conn() as c:
        alarmes = [dict(r) for r in c.execute("SELECT * FROM alarmes WHERE ativo = 1")]
    for a in alarmes:
        alvo = _minutos(a["hora"])
        if not (0 <= minuto_atual - alvo < 90):
            continue
        toques, confirmado = a["toques"], a["confirmado"]
        if a["dia"] != hoje:  # primeiro toque do dia
            toques, confirmado = 0, 0
        if confirmado or toques >= ALARME_MAX_TOQUES:
            continue
        toques += 1
        canal.enviar(f"🔔🔔 {a['mensagem']} ({toques}/{ALARME_MAX_TOQUES})",
                     [("☀️ Acordei", f"al:ok:{a['id']}")])
        ntfy.alarme(f"{a['mensagem']} ({toques}/{ALARME_MAX_TOQUES})", "Acorda!")
        with db.conn() as c:
            c.execute("UPDATE alarmes SET dia = ?, toques = ?, confirmado = ? WHERE id = ?",
                      (hoje, toques, confirmado, a["id"]))


def _job_pendente(chave: str) -> bool:
    """True se ainda não rodou; já marca como feito."""
    with db.conn() as c:
        if c.execute("SELECT 1 FROM jobs WHERE chave = ?", (chave,)).fetchone():
            return False
        c.execute("INSERT INTO jobs (chave) VALUES (?)", (chave,))
        return True


def resumos():
    """Bom dia (briefing), check-in da noite e resumo semanal. Cada um roda uma vez por dia."""
    agora = tools.agora()
    hoje = agora.date().isoformat()
    m = agora.hour * 60 + agora.minute

    def chegou(hhmm):  # janela de 3h pra recuperar se o bot estava desligado na hora exata
        return 0 <= m - _minutos(hhmm) < 180

    if chegou(HORA_MANHA) and _job_pendente(f"manha:{hoje}"):
        try:
            hoje_agenda = agenda.listar(1)
        except Exception:
            hoje_agenda = []
        texto = llm.gerar_mensagem_proativa(
            "Bom dia! Faça o briefing do dia: tarefas pendentes, metas da semana e uma frase de foco. Bem curto. "
            "Compromissos da agenda (json, ignore se for erro): " + json.dumps(hoje_agenda, ensure_ascii=False))
        canal.enviar(texto)

    if chegou(HORA_NOITE) and _job_pendente(f"noite:{hoje}"):
        canal.enviar("🌙 Como foi seu dia?",
                     [(f"{e} {n}", f"hu:{n}") for n, e in enumerate(["😞", "😕", "😐", "🙂", "😄"], 1)])
        llm.registrar("assistant", "🌙 Como foi seu dia? (nota de 1 a 5)")

    if agora.weekday() == 6 and chegou(HORA_SEMANAL) and _job_pendente(f"semana:{hoje}"):
        with db.conn() as c:
            metas = [r["nome"] for r in c.execute("SELECT nome FROM metas")]
        dados = {
            "metas": [tools.resumo_semana(n) for n in metas],
            "gastos": tools.resumo_gastos(),
            "padroes": tools.analise_padroes(),
        }
        texto = llm.gerar_mensagem_proativa(
            "Resumo semanal com estes dados reais (json): " + json.dumps(dados, ensure_ascii=False) +
            ". Diga o que bateu, o que faltou, quanto gastou e uma sugestão pra próxima semana. Curto.")
        canal.enviar(texto)


def tick():
    avisar_tarefas()
    avisar_eventos()
    try:
        sincronizar_agenda()
    except Exception:
        log.exception("falha ao sincronizar a Google Agenda (os avisos de eventos criados fora do bot param até voltar)")
    cobrar_tarefas()
    avisar_focos()
    tocar_alarmes()
    resumos()

    agora = tools.agora()
    hoje = agora.date().isoformat()
    minuto_atual = agora.hour * 60 + agora.minute

    with db.conn() as c:
        lembretes = [dict(r) for r in c.execute("SELECT * FROM lembretes WHERE ativo = 1")]

    for l in lembretes:
        with db.conn() as c:
            envios = _envios_hoje(c, l["id"], hoje)

        if l["tipo"] == "fixo":
            alvo = _minutos(l["hora_fixa"])
            if not envios and 0 <= minuto_atual - alvo < 30:
                _enviar(l["id"], l["mensagem"])

        elif l["tipo"] == "aleatorio":
            ini, fim = _minutos(l["inicio"]), _minutos(l["fim"])
            if not (ini <= minuto_atual <= fim):
                continue
            faltam = l["vezes_dia"] - len(envios)
            if faltam <= 0:
                continue
            if envios:
                ultimo = datetime.fromisoformat(envios[-1]["ts"])
                if (agora - ultimo).total_seconds() / 60 < l["intervalo_min"]:
                    continue
            ticks_restantes = max(1, (fim - minuto_atual) // TICK_MIN)
            if random.random() < faltam / ticks_restantes:
                _enviar(l["id"], l["mensagem"])
