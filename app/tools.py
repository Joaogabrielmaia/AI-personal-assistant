"""Ferramentas que o agente pode chamar. A IA decide quando usar; o código executa."""
import json
import os
from collections import Counter, defaultdict
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from . import agenda, db, sheets

TZ = ZoneInfo("America/Sao_Paulo")


def agora() -> datetime:
    return datetime.now(TZ)


# Botões que a IA pediu na resposta atual (o llm.py lê e envia junto com o texto)
botoes_pendentes: list[tuple[str, str]] = []


# ---------- implementações ----------

def anotar_tarefa(titulo: str, quando: str | None = None, lembrar_em: str | None = None):
    """lembrar_em: 'AAAA-MM-DDTHH:MM' (Brasília). Se informado, o bot avisa nesse horário."""
    if lembrar_em:
        try:
            lembrar_em = datetime.fromisoformat(lembrar_em).strftime("%Y-%m-%dT%H:%M")
        except ValueError:
            return {"erro": "lembrar_em inválido. Use AAAA-MM-DDTHH:MM, ex: 2026-11-02T20:00"}
    with db.conn() as c:
        igual = c.execute(
            "SELECT id FROM tarefas WHERE feito = 0 AND lower(titulo) = lower(?) "
            "AND COALESCE(lembrar_em, '') = COALESCE(?, '')", (titulo, lembrar_em)).fetchone()
        if igual:  # o modelo às vezes anota duas vezes a mesma coisa
            return {"ok": True, "id": igual["id"], "aviso": "já existia uma tarefa igual; não duplicou"}
        cur = c.execute(
            "INSERT INTO tarefas (titulo, quando, lembrar_em, criado) VALUES (?, ?, ?, ?)",
            (titulo, quando, lembrar_em, agora().isoformat()),
        )
        return {"ok": True, "id": cur.lastrowid, "lembrar_em": lembrar_em}


def _proxima_segunda_9h() -> datetime:
    d = agora().replace(hour=9, minute=0, second=0, microsecond=0)
    return d + timedelta(days=7 - d.weekday())


def reagendar_tarefa(id: int, lembrar_em: str, motivo: str = ""):
    """Remarca o aviso. Conta como adiamento (usado pra detectar enrolação)."""
    try:
        lembrar_em = datetime.fromisoformat(lembrar_em).strftime("%Y-%m-%dT%H:%M")
    except ValueError:
        return {"erro": "lembrar_em inválido. Use AAAA-MM-DDTHH:MM"}
    with db.conn() as c:
        t = c.execute("SELECT titulo, adiamentos FROM tarefas WHERE id = ?", (id,)).fetchone()
        if not t:
            return {"erro": "tarefa não encontrada"}
        n = (t["adiamentos"] or 0) + 1
        c.execute(
            "UPDATE tarefas SET lembrar_em = ?, avisado = 0, cobrancas = 0, aviso_ts = NULL, "
            "adiamentos = ?, feito = 0 WHERE id = ?", (lembrar_em, n, id))
    if motivo:
        registrar_atividade(t["titulo"], False, motivo)
    res = {"ok": True, "titulo": t["titulo"], "novo_horario": lembrar_em, "vezes_adiada": n}
    if n >= 3:
        res["sugestao"] = ("Já foi adiada 3+ vezes: diga isso com gentileza e proponha um passo de 5 minutos "
                           "agora (iniciar_foco) ou quebrar em passos menores.")
    return res


def atualizar_tarefa(id: int, titulo: str | None = None, lembrar_em: str | None = None):
    """Edita título e/ou horário SEM contar como adiamento (ex: trocar 'ligar' por 'mandar mensagem')."""
    with db.conn() as c:
        if titulo:
            c.execute("UPDATE tarefas SET titulo = ? WHERE id = ?", (titulo, id))
        if lembrar_em:
            lembrar_em = datetime.fromisoformat(lembrar_em).strftime("%Y-%m-%dT%H:%M")
            c.execute("UPDATE tarefas SET lembrar_em = ?, avisado = 0, cobrancas = 0, aviso_ts = NULL "
                      "WHERE id = ?", (lembrar_em, id))
    return {"ok": True}


def marcar_nao_feita(id: int, motivo: str = ""):
    """Usuário disse que NÃO fez. Registra a falha e para as cobranças; a tarefa continua pendente."""
    with db.conn() as c:
        t = c.execute("SELECT titulo FROM tarefas WHERE id = ?", (id,)).fetchone()
        if not t:
            return {"erro": "tarefa não encontrada"}
        c.execute("UPDATE tarefas SET cobrancas = 99 WHERE id = ?", (id,))
    registrar_atividade(t["titulo"], False, motivo or "não fez")
    return {"ok": True, "instrucao": "Ofereça reagendar (ou perguntar_com_opcoes) se ele ainda não disse quando."}


def listar_tarefas():
    with db.conn() as c:
        rows = c.execute(
            "SELECT id, titulo, quando, lembrar_em FROM tarefas WHERE feito = 0 ORDER BY id"
        ).fetchall()
        return [dict(r) for r in rows]


def contexto() -> str:
    """Resumo do estado atual, colocado no prompt a cada conversa (a IA não depende de 'lembrar')."""
    hoje = agora().date().isoformat()
    with db.conn() as c:
        tarefas = c.execute(
            "SELECT id, titulo, quando, lembrar_em, avisado, adiamentos FROM tarefas WHERE feito = 0 ORDER BY id"
        ).fetchall()
        lembretes = c.execute("SELECT * FROM lembretes WHERE ativo = 1").fetchall()
        metas = c.execute("SELECT nome, vezes_semana FROM metas").fetchall()
        regs = c.execute(
            "SELECT nome, feito, obs FROM registros WHERE data = ?", (hoje,)
        ).fetchall()

    linhas = ["TAREFAS PENDENTES:"]
    linhas += [
        f"- #{t['id']} {t['titulo']}"
        + (f" ({t['quando']})" if t["quando"] else "")
        + (f" [aviso em {t['lembrar_em']}{', JÁ AVISADO' if t['avisado'] else ''}]" if t["lembrar_em"] else "")
        + (f" [adiada {t['adiamentos']}x]" if t["adiamentos"] else "")
        for t in tarefas
    ] or ["- nenhuma"]

    linhas.append("LEMBRETES ATIVOS:")
    for l in lembretes:
        if l["tipo"] == "fixo":
            linhas.append(f"- #{l['id']} todo dia {l['hora_fixa']}: {l['mensagem']}")
        else:
            linhas.append(
                f"- #{l['id']} {l['vezes_dia']}x/dia entre {l['inicio']} e {l['fim']}: {l['mensagem']}"
            )
    if not lembretes:
        linhas.append("- nenhum")

    with db.conn() as c:
        alarmes = c.execute("SELECT id, hora FROM alarmes WHERE ativo = 1").fetchall()
        focos = c.execute("SELECT titulo, fim FROM focos WHERE avisado = 0").fetchall()
    if alarmes:
        linhas.append("ALARMES: " + ", ".join(f"#{a['id']} {a['hora']}" for a in alarmes))
    if focos:
        linhas.append("FOCO EM ANDAMENTO: " + ", ".join(f"{f['titulo']} até {f['fim'][-5:]}" for f in focos))
    linhas.append("METAS SEMANAIS: " + (
        ", ".join(f"{m['nome']} {m['vezes_semana']}x" for m in metas) or "nenhuma"))
    linhas.append("REGISTROS DE HOJE: " + (
        ", ".join(
            f"{r['nome']}={'feito' if r['feito'] else 'NÃO feito'}" + (f" ({r['obs']})" if r["obs"] else "")
            for r in regs) or "nenhum"))
    return "\n".join(linhas)


def concluir_tarefa(id: int):
    with db.conn() as c:
        c.execute("UPDATE tarefas SET feito = 1 WHERE id = ?", (id,))
        return {"ok": True}


def definir_meta(nome: str, vezes_semana: int):
    with db.conn() as c:
        c.execute(
            "INSERT INTO metas (nome, vezes_semana) VALUES (?, ?) "
            "ON CONFLICT(nome) DO UPDATE SET vezes_semana = excluded.vezes_semana",
            (nome.lower(), vezes_semana),
        )
        return {"ok": True}


def registrar_atividade(nome: str, feito: bool, obs: str = ""):
    hoje = agora().date().isoformat()
    with db.conn() as c:
        c.execute(
            "INSERT INTO registros (data, nome, feito, obs) VALUES (?, ?, ?, ?)",
            (hoje, nome.lower(), int(feito), obs),
        )
    sheets.registrar("Atividades", ["Data", "Atividade", "Feito", "Obs"],
                     [hoje, nome.lower(), "sim" if feito else "não", obs])
    return {"ok": True}


def _sequencia(nome: str) -> int:
    """Dias seguidos com a atividade feita (hoje ainda pode não ter sido registrado)."""
    with db.conn() as c:
        dias = {r["data"] for r in c.execute(
            "SELECT data FROM registros WHERE nome = ? AND feito = 1", (nome.lower(),))}
    d = agora().date()
    if d.isoformat() not in dias:
        d -= timedelta(days=1)
    n = 0
    while d.isoformat() in dias:
        n += 1
        d -= timedelta(days=1)
    return n


def resumo_semana(nome: str):
    hoje = agora().date()
    segunda = (hoje - timedelta(days=hoje.weekday())).isoformat()
    with db.conn() as c:
        meta = c.execute(
            "SELECT vezes_semana FROM metas WHERE nome = ?", (nome.lower(),)
        ).fetchone()
        rows = c.execute(
            "SELECT data, feito, obs FROM registros WHERE nome = ? AND data >= ? ORDER BY data",
            (nome.lower(), segunda),
        ).fetchall()
    feitos = [r for r in rows if r["feito"]]
    nao_feitos = [dict(r) for r in rows if not r["feito"]]
    return {
        "atividade": nome,
        "meta_semana": meta["vezes_semana"] if meta else None,
        "feitos": len(feitos),
        "dias_feitos": [r["data"] for r in feitos],
        "nao_feitos": nao_feitos,
        "desde": segunda,
        "sequencia_dias": _sequencia(nome),
    }


def criar_lembrete_fixo(mensagem: str, hora: str):
    with db.conn() as c:
        cur = c.execute(
            "INSERT INTO lembretes (tipo, mensagem, hora_fixa) VALUES ('fixo', ?, ?)",
            (mensagem, hora),
        )
        return {"ok": True, "id": cur.lastrowid}


def criar_lembrete_aleatorio(
    mensagem: str,
    vezes_dia: int,
    inicio: str = "08:00",
    fim: str = "21:00",
    intervalo_min: int = 90,
):
    with db.conn() as c:
        cur = c.execute(
            "INSERT INTO lembretes (tipo, mensagem, vezes_dia, inicio, fim, intervalo_min) "
            "VALUES ('aleatorio', ?, ?, ?, ?, ?)",
            (mensagem, vezes_dia, inicio, fim, intervalo_min),
        )
        return {"ok": True, "id": cur.lastrowid}


def listar_lembretes():
    with db.conn() as c:
        rows = c.execute("SELECT * FROM lembretes WHERE ativo = 1").fetchall()
        return [dict(r) for r in rows]


def apagar_lembrete(id: int):
    with db.conn() as c:
        c.execute("UPDATE lembretes SET ativo = 0 WHERE id = ?", (id,))
        return {"ok": True}


# ---------- gastos ----------

GASTOS_CAB = ["ID", "Data", "Valor", "Categoria", "Descrição"]


def registrar_gasto(valor: float, categoria: str, descricao: str = "", data: str | None = None):
    """data: AAAA-MM-DD (padrão: hoje)."""
    data = data or agora().date().isoformat()
    with db.conn() as c:
        gid = c.execute(
            "INSERT INTO gastos (data, valor, categoria, descricao) VALUES (?, ?, ?, ?)",
            (data, float(valor), categoria.lower(), descricao),
        ).lastrowid
        total = c.execute(
            "SELECT COALESCE(SUM(valor), 0) FROM gastos WHERE data LIKE ?", (f"{data[:7]}%",)
        ).fetchone()[0]
    sheets.registrar("Gastos", GASTOS_CAB, [gid, data, float(valor), categoria.lower(), descricao])
    res = {"ok": True, "id": gid, "total_do_mes": round(total, 2)}
    limite = os.getenv("LIMITE_MENSAL", "").strip()
    if limite:
        res["limite_mensal"] = float(limite)
        res["passou_do_limite"] = total > float(limite)
    return res


def resumo_gastos(mes: str | None = None):
    """mes: AAAA-MM (padrão: mês atual)."""
    mes = mes or agora().strftime("%Y-%m")
    with db.conn() as c:
        rows = c.execute(
            "SELECT categoria, SUM(valor) AS total, COUNT(*) AS n FROM gastos "
            "WHERE data LIKE ? GROUP BY categoria ORDER BY total DESC", (f"{mes}%",)
        ).fetchall()
    return {
        "mes": mes,
        "total": round(sum(r["total"] for r in rows), 2),
        "por_categoria": {r["categoria"]: round(r["total"], 2) for r in rows},
    }


def listar_gastos(limite: int = 10, categoria: str | None = None):
    """Últimos gastos, com ID (use o ID pra apagar_gasto)."""
    q, args = "SELECT id, data, valor, categoria, descricao FROM gastos", []
    if categoria:
        q += " WHERE categoria = ?"
        args.append(categoria.lower())
    with db.conn() as c:
        return [dict(r) for r in c.execute(q + " ORDER BY id DESC LIMIT ?", (*args, int(limite)))]


def apagar_gasto(id: int):
    """Apaga UM gasto pelo ID (banco e linha da planilha). Precisa do id: chame listar_gastos antes pra achá-lo.
    Nunca apague "o último" por palpite: se o gasto que o usuário citou não está na lista, diga isso e pergunte."""
    with db.conn() as c:
        r = c.execute("SELECT id, data, valor, categoria FROM gastos WHERE id = ?", (id,)).fetchone()
        if not r:
            return {"erro": "gasto não encontrado; use listar_gastos pra ver os IDs"}
        c.execute("DELETE FROM gastos WHERE id = ?", (r["id"],))
    return {"ok": True, "apagado": dict(r), "planilha": sheets.apagar_linha("Gastos", r["id"])}


# ---------- agenda ----------

def listar_agenda(dias: int = 7):
    """Próximos eventos do Google Agenda."""
    return agenda.listar(dias)


def criar_evento_agenda(titulo: str, inicio: str, duracao_min: int = 30, descricao: str = ""):
    """inicio: AAAA-MM-DDTHH:MM (Brasília). Avisa se houver conflito de horário.
    Também agenda o AVISO do bot (Telegram) no horário do evento."""
    res = agenda.criar(titulo, inicio, duracao_min, descricao)
    if res.get("ok"):
        res["aviso_bot"] = agendar_aviso_evento(res["id"], titulo, inicio)
    return res


def apagar_evento_agenda(id: str):
    res = agenda.apagar(id)
    if res.get("ok"):
        with db.conn() as c:
            c.execute("DELETE FROM avisos_evento WHERE evento_id = ?", (id,))
    return res


def agendar_aviso_evento(evento_id: str, titulo: str, inicio: str) -> str:
    """Grava quando o bot deve avisar deste evento. EVENTO_AVISO_MIN_ANTES=10 avisa 10 min antes (padrão: na hora)."""
    ini = datetime.fromisoformat(inicio)
    ini = ini.astimezone(TZ).replace(tzinfo=None) if ini.tzinfo else ini
    aviso = ini - timedelta(minutes=int(os.getenv("EVENTO_AVISO_MIN_ANTES", "0") or 0))
    if aviso <= agora().replace(tzinfo=None):
        return "não (esse horário já passou)"
    with db.conn() as c:
        c.execute(
            "INSERT INTO avisos_evento (evento_id, titulo, quando) VALUES (?, ?, ?) "
            "ON CONFLICT(evento_id) DO UPDATE SET quando = excluded.quando, titulo = excluded.titulo "
            "WHERE avisado = 0", (evento_id, titulo, aviso.strftime("%Y-%m-%dT%H:%M")))
    return f"o bot avisa no Telegram às {aviso.strftime('%H:%M')}"


# ---------- foco, alarme, botões ----------

def iniciar_foco(minutos: int, tarefa: str):
    fim = (agora() + timedelta(minutes=int(minutos))).strftime("%Y-%m-%dT%H:%M")
    with db.conn() as c:
        cur = c.execute("INSERT INTO focos (titulo, fim) VALUES (?, ?)", (tarefa, fim))
        return {"ok": True, "id": cur.lastrowid, "termina_em": fim}


def criar_alarme(hora: str, mensagem: str = "Acorda!"):
    """Alarme diário insistente: manda mensagem a cada minuto até o usuário tocar em 'Acordei'."""
    datetime.strptime(hora, "%H:%M")
    with db.conn() as c:
        cur = c.execute("INSERT INTO alarmes (hora, mensagem) VALUES (?, ?)", (hora, mensagem))
        return {"ok": True, "id": cur.lastrowid}


def apagar_alarme(id: int):
    with db.conn() as c:
        c.execute("UPDATE alarmes SET ativo = 0 WHERE id = ?", (id,))
        return {"ok": True}


def perguntar_com_opcoes(opcoes: list[str]):
    """Os botões saem junto com a sua resposta final (que deve ser a pergunta)."""
    botoes_pendentes.clear()
    botoes_pendentes.extend((o, f"op:{o[:28]}") for o in opcoes[:6])
    return {"ok": True, "instrucao": "Escreva só a pergunta como resposta final; os botões aparecem sozinhos."}


# ---------- análise ----------

def analise_padroes():
    """Dados crus pra IA analisar: dias da semana, motivos de falta, humor e gastos."""
    dias = ["seg", "ter", "qua", "qui", "sex", "sáb", "dom"]
    desde = (agora().date() - timedelta(days=60)).isoformat()
    with db.conn() as c:
        regs = c.execute(
            "SELECT data, nome, feito, obs FROM registros WHERE data >= ?", (desde,)).fetchall()
        gastos = c.execute(
            "SELECT data, valor, categoria FROM gastos WHERE data >= ?", (desde,)).fetchall()

    por_dia = defaultdict(lambda: defaultdict(lambda: [0, 0]))   # atividade -> dia -> [feitos, total]
    motivos = defaultdict(Counter)
    humor = defaultdict(list)
    for r in regs:
        wd = dias[datetime.fromisoformat(r["data"]).weekday()]
        if r["nome"] == "humor":
            try:
                humor[wd].append(int(r["obs"]))
            except ValueError:
                pass
            continue
        por_dia[r["nome"]][wd][1] += 1
        por_dia[r["nome"]][wd][0] += r["feito"]
        if not r["feito"] and r["obs"]:
            motivos[r["nome"]][r["obs"].lower()] += 1

    ult30 = (agora().date() - timedelta(days=30)).isoformat()
    ant: dict[str, float] = defaultdict(float)
    rec: dict[str, float] = defaultdict(float)
    for g in gastos:
        (rec if g["data"] >= ult30 else ant)[g["categoria"]] += g["valor"]

    return {
        "taxa_por_dia_da_semana": {n: {d: f"{f}/{t}" for d, (f, t) in v.items()} for n, v in por_dia.items()},
        "motivos_de_falta": {n: c.most_common(3) for n, c in motivos.items()},
        "humor_medio_por_dia": {d: round(sum(v) / len(v), 1) for d, v in humor.items()},
        "gastos_ultimos_30d": {k: round(v, 2) for k, v in rec.items()},
        "gastos_30d_anteriores": {k: round(v, 2) for k, v in ant.items()},
        "observacao": "poucos dados = diga que ainda é cedo pra concluir",
    }


FUNCOES = {f.__name__: f for f in [
    anotar_tarefa, listar_tarefas, concluir_tarefa, definir_meta,
    registrar_atividade, resumo_semana, criar_lembrete_fixo,
    criar_lembrete_aleatorio, listar_lembretes, apagar_lembrete,
    reagendar_tarefa, atualizar_tarefa, marcar_nao_feita,
    registrar_gasto, resumo_gastos, listar_gastos, apagar_gasto, iniciar_foco,
    listar_agenda, criar_evento_agenda, apagar_evento_agenda,
    criar_alarme, apagar_alarme, perguntar_com_opcoes, analise_padroes,
]}


def executar(nome: str, args: dict) -> str:
    try:
        args = {k: v for k, v in args.items() if v is not None}  # o modelo manda null em opcionais
        return json.dumps(FUNCOES[nome](**args), ensure_ascii=False)
    except Exception as e:  # devolve o erro pra IA tentar de novo
        return json.dumps({"erro": str(e)})


# ---------- descrição das ferramentas pra IA ----------

def _fn(nome, descricao, props=None, obrigatorios=None):
    obrigatorios = obrigatorios or []
    # parâmetros opcionais aceitam null (alguns modelos mandam null em vez de omitir)
    # opcionais aceitam null (Groq manda null em vez de omitir); schemas_para() tira isso pra quem não aceita
    props = {k: ({**v, "type": [v["type"], "null"]} if k not in obrigatorios and isinstance(v.get("type"), str)
                 and v["type"] != "array" else v)
             for k, v in (props or {}).items()}
    return {
        "type": "function",
        "function": {
            "name": nome,
            "description": descricao,
            "parameters": {
                "type": "object",
                "properties": props,
                "required": obrigatorios,
            },
        },
    }


S, I, B = {"type": "string"}, {"type": "integer"}, {"type": "boolean"}
N, LS = {"type": "number"}, {"type": "array", "items": {"type": "string"}}

def schemas_para(nullable: bool) -> list:
    """Gemini não aceita "type" em lista (['string','null']); o Groq precisa dela. Devolve a versão certa."""
    if nullable:
        return SCHEMAS
    import copy
    out = copy.deepcopy(SCHEMAS)
    for s in out:
        for p in s["function"]["parameters"]["properties"].values():
            if isinstance(p.get("type"), list):
                p["type"] = p["type"][0]
    return out


SCHEMAS = [
    _fn("anotar_tarefa",
        "Anota uma tarefa. Se o usuário der dia/hora, preencha 'lembrar_em' em ISO "
        "AAAA-MM-DDTHH:MM (Brasília) para o bot AVISAR nesse horário. 'quando' é o texto original.",
        {"titulo": S, "quando": S, "lembrar_em": S}, ["titulo"]),
    _fn("listar_tarefas", "Lista tarefas pendentes."),
    _fn("concluir_tarefa", "Marca tarefa como feita.", {"id": I}, ["id"]),
    _fn("reagendar_tarefa",
        "Remarca o aviso de uma tarefa (lembrar_em AAAA-MM-DDTHH:MM). Use quando ele quiser deixar pra outro dia/hora. "
        "'motivo' = por que não fez, se ele disser. Conta como adiamento.",
        {"id": I, "lembrar_em": S, "motivo": S}, ["id", "lembrar_em"]),
    _fn("atualizar_tarefa",
        "Muda o título e/ou o horário de uma tarefa sem contar como adiamento (ex: trocar 'ligar pro X' por 'mandar mensagem pro X').",
        {"id": I, "titulo": S, "lembrar_em": S}, ["id"]),
    _fn("marcar_nao_feita",
        "Ele disse que NÃO fez a tarefa. Registra a falha (com o motivo, se houver) e para as cobranças.",
        {"id": I, "motivo": S}, ["id"]),
    _fn("definir_meta", "Define meta semanal (ex: academia 4x por semana).",
        {"nome": S, "vezes_semana": I}, ["nome", "vezes_semana"]),
    _fn("registrar_atividade",
        "Registra que o usuário fez (feito=true) ou NÃO fez (feito=false) uma atividade hoje, com o motivo em obs.",
        {"nome": S, "feito": B, "obs": S}, ["nome", "feito"]),
    _fn("resumo_semana", "Resumo da semana atual de uma atividade: meta, quantas vezes foi, dias que faltou e motivos.",
        {"nome": S}, ["nome"]),
    _fn("criar_lembrete_fixo", "Lembrete todo dia num horário fixo (HH:MM).",
        {"mensagem": S, "hora": S}, ["mensagem", "hora"]),
    _fn("criar_lembrete_aleatorio",
        "Lembrete em horários aleatórios do dia (ex: beber água). Horários HH:MM.",
        {"mensagem": S, "vezes_dia": I, "inicio": S, "fim": S, "intervalo_min": I},
        ["mensagem", "vezes_dia"]),
    _fn("listar_lembretes", "Lista lembretes ativos."),
    _fn("apagar_lembrete", "Desativa um lembrete.", {"id": I}, ["id"]),
    _fn("registrar_gasto",
        "Registra um gasto (salva no banco e na planilha). Escolha uma categoria curta "
        "(comida, transporte, mercado, lazer, saúde, estudos, contas, outros). data só se não for hoje (AAAA-MM-DD).",
        {"valor": N, "categoria": S, "descricao": S, "data": S}, ["valor", "categoria"]),
    _fn("resumo_gastos", "Total de gastos do mês e por categoria. mes no formato AAAA-MM (padrão: atual).",
        {"mes": S}),
    _fn("listar_gastos", "Lista os últimos gastos com ID. Use antes de apagar quando houver dúvida de qual é.",
        {"limite": I, "categoria": S}),
    _fn("apagar_gasto",
        "Apaga um gasto pelo id (banco e linha inteira da planilha). SEMPRE chame listar_gastos antes pra achar o id "
        "do gasto que o usuário citou; se não achar na lista, avise e pergunte, nunca apague outro por palpite.",
        {"id": I}, ["id"]),
    _fn("listar_agenda", "Eventos do Google Agenda nos próximos N dias (padrão 7).", {"dias": I}),
    _fn("criar_evento_agenda",
        "Cria evento no Google Agenda (inicio AAAA-MM-DDTHH:MM, Brasília). Avisa conflitos: se vier 'conflitos', diga ao usuário.",
        {"titulo": S, "inicio": S, "duracao_min": I, "descricao": S}, ["titulo", "inicio"]),
    _fn("apagar_evento_agenda", "Apaga um evento da agenda pelo id (veja listar_agenda).", {"id": S}, ["id"]),
    _fn("iniciar_foco",
        "Inicia um cronômetro de foco/estudo. O bot avisa quando acabar e pergunta como foi.",
        {"minutos": I, "tarefa": S}, ["minutos", "tarefa"]),
    _fn("criar_alarme",
        "Alarme diário pra acordar: o bot manda mensagem a cada minuto até o usuário tocar em 'Acordei'. hora=HH:MM.",
        {"hora": S, "mensagem": S}, ["hora"]),
    _fn("apagar_alarme", "Desativa um alarme.", {"id": I}, ["id"]),
    _fn("perguntar_com_opcoes",
        "Use quando faltar informação e as respostas possíveis forem poucas (até 6, curtas, máx 28 caracteres): "
        "mostra botões pro usuário tocar. Depois escreva só a pergunta como resposta final.",
        {"opcoes": LS}, ["opcoes"]),
    _fn("analise_padroes",
        "Dados dos últimos 60 dias (dias da semana, motivos de falta, humor, gastos) para você achar padrões e dar conselhos."),
]
