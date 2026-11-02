"""Cérebro do agente: conversa com o modelo e executa as ferramentas."""
import base64
import io
import json
import logging
import os
import re
import time

from openai import (APIConnectionError, APIError, APITimeoutError, BadRequestError, InternalServerError,
                    OpenAI, RateLimitError)

from . import db, tools

log = logging.getLogger("llm")


def _provedor(prefixo: str, modelo_padrao: str = ""):
    """LLM_* é o principal; LLM2_* é o reserva (opcional). Se o principal falhar, o bot passa pro reserva."""
    chave = os.getenv(f"{prefixo}_API_KEY", "").strip()
    if not chave:
        return None
    modelo = os.getenv(f"{prefixo}_MODEL", modelo_padrao)
    return {
        "nome": prefixo,
        "client": OpenAI(
            api_key=chave,
            base_url=os.getenv(f"{prefixo}_BASE_URL") or None,
            timeout=30,      # não fica pendurado pra sempre
            max_retries=0,   # as tentativas (e esperas) ficam em _chamar_um
        ),
        "modelo": modelo,
        "visao": os.getenv(f"{prefixo}_VISION_MODEL") or modelo,
        # Groq precisa de "null" nos parâmetros opcionais; Gemini não aceita
        "nullable": os.getenv(f"{prefixo}_NULLABLE", "1" if prefixo == "LLM" else "0") == "1",
    }


PROVEDORES = [p for p in (_provedor("LLM", "gemini-flash-latest"), _provedor("LLM2")) if p]
# Se há reserva, o principal tem pouco tempo pra responder: lento demais = passa pro reserva
for _p in PROVEDORES[:-1]:
    _p["client"] = _p["client"].with_options(timeout=float(os.getenv("LLM_TIMEOUT_PRINCIPAL", "12")))
client = PROVEDORES[0]["client"] if PROVEDORES else OpenAI(api_key="x")   # usado pelo app.teste
# Transcrição de áudio pode usar outro provedor (ex: Gemini no chat, Groq no whisper)
stt_client = OpenAI(
    api_key=os.getenv("STT_API_KEY") or os.environ.get("LLM_API_KEY", "x"),
    base_url=os.getenv("STT_BASE_URL") or os.getenv("LLM_BASE_URL"),
    timeout=60,
    max_retries=1,
)
MODEL = PROVEDORES[0]["modelo"] if PROVEDORES else ""
NOME = os.getenv("OWNER_NAME", "usuário")   # como o assistente chama você (OWNER_NAME no .env)
MODEL_VOZ = os.getenv("STT_MODEL", "whisper-large-v3-turbo")

SYSTEM = """Você é o assistente pessoal de rotina de {nome}, via chat.
Personalidade: direto, amigável, firme. Ele tende a se distrair e procrastinar, então cobre quando necessário, sem sermão.
Respostas CURTAS (textos longos cansam). Português do Brasil.

Regras:
- Use SEMPRE as ferramentas para anotar tarefas, registrar atividades, metas e lembretes. Nunca diga que anotou sem chamar a ferramenta.
- Se ele der dia/hora de uma tarefa, passe 'lembrar_em' (AAAA-MM-DDTHH:MM) para o bot avisar na hora. Se faltar a hora, pergunte.
- Se ele disser que mudou a rotina (ex: não vai à academia pra estudar), chame registrar_atividade com feito=false e o motivo.
- Para "quantas vezes fui...", use resumo_semana e responda com números reais.
- Confirme o que anotou em UMA frase.
- Responda SOMENTE com a mensagem final pra {nome}. Nunca escreva notas, observações internas, raciocínio ou texto em inglês.
- Gastos: "gastei 35 no mercado" -> registrar_gasto (categoria curta). Foto de nota fiscal/recibo: leia o total e registre o gasto.
- Foto de academia, estudo ou comida: registrar_atividade (feito=true) e comente em uma frase.
- "vou estudar 50 min" -> iniciar_foco. "me acorda às 7h" -> criar_alarme.
- {nome} enrola e esquece. Seja esperto: deduza o que der e execute VÁRIAS ações numa resposta só. Ex: "não liguei, prefiro mandar mensagem pro Carlos, marca pra semana que vem e me ajuda a escrever" = atualizar_tarefa (novo título) + reagendar_tarefa (motivo) + a mensagem pronta. Use os IDs do ESTADO ATUAL; se houver só uma tarefa que combine, use-a sem perguntar.
- NUNCA crie tarefa nova (anotar_tarefa) quando a conversa é sobre uma tarefa que já existe no ESTADO ATUAL: use atualizar_tarefa / reagendar_tarefa / marcar_nao_feita nela. Dê UMA resposta só, sem repetir o texto.
- Compromisso com dia e hora (consulta, reunião, evento, "marca/agenda X às 15h"): use criar_evento_agenda UMA vez (e se vier "conflitos", só avise na mesma resposta: o evento JÁ foi criado, não pergunte se mantém e não crie de novo). O bot JÁ avisa no Telegram na hora do evento (veja aviso_bot no resultado e confirme o horário do aviso pra ele); NÃO crie tarefa extra pra isso. "o que tenho na agenda?" = listar_agenda.
- "Semana que vem" sem horário = segunda 09:00; "amanhã" sem horário = 09:00; "à noite" = 20:00. Diga a suposição em poucas palavras.
- Se ele disser que não fez/não vai fazer: marcar_nao_feita (ou reagendar_tarefa com motivo). Se uma tarefa tem [adiada 3x] ou mais, confronte com leveza ("é a 3ª vez") e proponha 5 min agora (iniciar_foco) ou quebrar em passos pequenos. Não sermoneie.
- Se ele mencionar algo a fazer sem dizer quando ("preciso ligar pro dentista"), anote e ofereça horários com perguntar_com_opcoes.
- Quando ele pedir ajuda pra escrever mensagem/e-mail/recado: escreva a mensagem PRONTA, natural, curta e no tom dele, dentro de um bloco ``` ``` (assim ele toca e copia). Antes do bloco, no máximo uma frase. Depois, use perguntar_com_opcoes com ["Mais curta", "Mais formal", "Ficou ótima"].
- Quando faltar informação e as respostas forem poucas, use perguntar_com_opcoes em vez de pedir pra ele digitar.
- Pra "como estou indo?", padrões ou conselhos: chame analise_padroes e resumo_semana, e dê 1 ou 2 insights com números reais. Poucos dados = diga que ainda é cedo.
- NUNCA invente horário. Se ele não disse hora/dia, anote a tarefa SEM lembrar_em e pergunte quando (perguntar_com_opcoes). Se ele listar várias coisas ("estudar, trabalhar, mercado"), crie UMA tarefa por item (várias chamadas de anotar_tarefa), sem horário, e pergunte se quer horários.
- Só afirme fatos que estão no ESTADO ATUAL ou no resultado de uma ferramenta nesta conversa. Não invente histórico (ex: "você adiou X" só se X mostrar [adiada Nx]). Na dúvida, não cite.
- Contas: responda só com o resultado, uma vez, sem repetir o cálculo. Ex: "35 × 30 = R$ 1.050".
- O ESTADO ATUAL abaixo é a verdade sobre o que está pendente. Use-o para responder "o que tenho pra fazer".

Agora: {agora} (horário de Brasília)

ESTADO ATUAL:
{contexto}"""

MAX_HISTORICO = 8


def _system() -> str:
    agora = tools.agora()
    return SYSTEM.format(
        nome=NOME,
        agora=agora.strftime("%Y-%m-%dT%H:%M") + f" ({agora.strftime('%A')})",
        contexto=tools.contexto(),
    )


def _carregar_historico():
    with db.conn() as c:
        rows = c.execute(
            "SELECT role, content FROM historico ORDER BY id DESC LIMIT ?",
            (MAX_HISTORICO,),
        ).fetchall()
    return [{"role": r["role"], "content": r["content"]} for r in reversed(rows)]


def registrar(role: str, content: str):
    """Guarda no histórico (também usado pelo agendador pra o bot saber o que ele mesmo enviou)."""
    with db.conn() as c:
        c.execute(
            "INSERT INTO historico (role, content, ts) VALUES (?, ?, ?)",
            (role, content, tools.agora().isoformat()),
        )


def _limpar(texto: str) -> str:
    """Alguns modelos vazam notas internas ('(Note: ...)') no texto. Corta isso fora."""
    # rede de segurança: o registro interno de ferramentas nunca pode chegar ao usuário
    texto = re.sub(r"\[(?:executei|resultado da ferramenta|nota do sistema)[^\]]*\]?", "", texto).strip()
    texto = texto.replace("\u202f", " ").replace("\u00a0", " ")           # espaços "finos" que viram lixo no chat
    texto = re.sub(r"(\d{1,3}(?: \d{3})+)\.\s?\1(?!\d)", r"\1", texto)    # "1 050.1 050" -> "1 050"
    texto = re.split(r"\s*[—–-]*\s*\((?:Note|Nota|Obs)\b", texto, maxsplit=1)[0]
    texto = re.sub(r"<think>.*?</think>", "", texto, flags=re.DOTALL)
    texto = texto.strip()
    # alguns modelos repetem a resposta inteira duas vezes seguidas
    i = texto.find(texto[:40], 1) if len(texto) > 80 else -1
    if i > 0 and texto[i:].strip() == texto[:i].strip():
        texto = texto[:i].strip()
    return texto


def _achatar(msgs: list) -> list:
    """Troca chamadas de ferramenta por texto, pra outro provedor continuar a conversa sem erro de formato."""
    out, achatou = [], False
    for m in msgs:
        if m.get("role") == "assistant" and m.get("tool_calls"):
            achatou = True
            chamadas = "; ".join(f"{c['function']['name']}({c['function']['arguments']})" for c in m["tool_calls"])
            out.append({"role": "assistant", "content": (m.get("content") or "") + f" [executei: {chamadas}]"})
        elif m.get("role") == "tool":
            out.append({"role": "user", "content": f"[resultado da ferramenta: {m['content']}]"})
        else:
            out.append(m)
    if achatou:
        # sem isso o modelo imita os colchetes como se fossem a resposta, em vez de chamar as ferramentas
        out.append({"role": "user", "content": (
            "[nota do sistema] Os trechos entre colchetes acima são só o registro de ferramentas JÁ executadas: "
            f"nunca os repita nem imite. Se ainda falta alguma ação do pedido de {NOME}, chame a ferramenta de verdade "
            "agora. Quando tudo estiver feito, responda só com a mensagem final pra ele.")})
    return out


def _chamar_um(p: dict, modelo: str, msgs: list, ferramentas: bool, tentativas: int):
    """Uma chamada a UM provedor. Com reserva disponível (tentativas<=2) não espera limite de uso: passa logo."""
    kw = {"model": modelo, "messages": msgs}
    if ferramentas:
        kw["tools"] = tools.schemas_para(p["nullable"])
    for t in range(tentativas):
        ultima = t == tentativas - 1
        kw["temperature"] = 0.3 if t == 0 else 0.0
        try:
            return p["client"].chat.completions.create(**kw)
        except (InternalServerError, APITimeoutError, APIConnectionError) as e:
            if ultima or (tentativas <= 2 and isinstance(e, APITimeoutError)):
                raise   # com reserva disponível, timeout não é retentado: passa logo pro próximo
            time.sleep(1 if tentativas <= 2 else 2 * (t + 1))
        except BadRequestError as e:   # ex: modelo inventou nome de ferramenta
            if "tool" not in str(e).lower() or ultima:
                raise
        except RateLimitError as e:
            if ultima or tentativas <= 2 or "per day" in str(e).lower():
                raise
            achou = re.search(r"try again in ([\d.]+)s", str(e))
            time.sleep(min(float(achou.group(1)) * 2 + 3 if achou else 10, 30))


def _chamar(msgs: list, visao: bool = False, ferramentas: bool = True, origem=frozenset()):
    """Tenta cada provedor em ordem. Devolve (resposta, nome_do_provedor)."""
    if not PROVEDORES:
        raise RuntimeError("Nenhum provedor de IA configurado (LLM_API_KEY no .env)")
    ultimo = None
    for i, p in enumerate(PROVEDORES):
        e_ultimo = i == len(PROVEDORES) - 1
        # chamadas de ferramenta feitas por OUTRO provedor viram texto (formatos diferem)
        enviar = msgs if origem <= {p["nome"]} else _achatar(msgs)
        try:
            resp = _chamar_um(p, p["visao"] if visao else p["modelo"], enviar, ferramentas,
                              tentativas=7 if e_ultimo else 2)
            return resp, p["nome"]
        except APIError as e:
            ultimo = e
            log.warning("provedor %s (%s) falhou: %s%s", p["nome"], p["modelo"], type(e).__name__,
                        "" if e_ultimo else " -> tentando o próximo")
    raise ultimo


def transcrever(audio: bytes, nome: str = "audio.ogg") -> str:
    # a "dica" (prompt) ajuda o whisper a acertar o vocabulário do assistente (ex: "reunião", não "união")
    dica = os.getenv("STT_PROMPT", "Assistente de rotina. Termos: reunião, lembrete, agenda, compromisso, tarefa, "
                     "academia, gastei, marcar, remarcar, amanhã, hoje, às, horas, consulta, mercado.")
    r = stt_client.audio.transcriptions.create(
        model=MODEL_VOZ, file=(nome, io.BytesIO(audio)), language="pt", prompt=dica)
    return r.text.strip()


def responder(texto: str, imagem: bytes | None = None):
    """Devolve (texto, botoes). Pode levantar exceção (erro de API); quem chama avisa o usuário."""
    msgs = [{"role": "system", "content": _system()}] + _carregar_historico()
    if imagem:
        b64 = base64.b64encode(imagem).decode()
        msgs.append({"role": "user", "content": [
            {"type": "text", "text": texto or "Veja esta foto."},
            {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}},
        ]})
        texto = f"[foto] {texto}".strip()
    else:
        msgs.append({"role": "user", "content": texto})

    tools.botoes_pendentes.clear()
    final = None
    origem: set = set()   # quais provedores já fizeram chamadas de ferramenta nesta conversa
    for _ in range(6):  # limite de voltas de ferramenta
        resp, nome = _chamar(msgs, visao=bool(imagem), origem=frozenset(origem))
        msg = resp.choices[0].message
        if not msg.tool_calls:
            final = msg.content or "Feito."
            break

        origem.add(nome)
        msgs.append(msg.model_dump(exclude_none=True))
        for call in msg.tool_calls:
            args = json.loads(call.function.arguments or "{}")
            msgs.append({
                "role": "tool",
                "tool_call_id": call.id,
                "content": tools.executar(call.function.name, args),
            })

    final = _limpar(final or "") or "Me perdi aqui, pode repetir?"
    # só grava a conversa se deu certo (evita histórico com mensagens "penduradas")
    registrar("user", texto)
    registrar("assistant", final)
    botoes = list(tools.botoes_pendentes)
    tools.botoes_pendentes.clear()
    return final, botoes


def gerar_mensagem_proativa(instrucao: str) -> str:
    """Usado pelo agendador. Se a IA falhar, manda a mensagem simples (o lembrete nunca deixa de sair)."""
    try:
        resp, _ = _chamar([
            {"role": "system", "content": _system()},
            {"role": "user", "content": f"[Tarefa interna] Mande a {NOME} uma mensagem curta: {instrucao}"},
        ], ferramentas=False)
        texto = _limpar(resp.choices[0].message.content or "") or instrucao
    except Exception:
        texto = instrucao
    registrar("assistant", texto)
    return texto
