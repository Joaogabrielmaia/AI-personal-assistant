import logging
from contextlib import asynccontextmanager

from apscheduler.schedulers.background import BackgroundScheduler
from dotenv import load_dotenv
from fastapi import BackgroundTasks, FastAPI, Request

load_dotenv()

from . import canal, db, llm, scheduler, whatsapp  # noqa: E402

logging.basicConfig(level=logging.INFO)
for _nome in ("httpx", "httpx2", "httpcore"):  # as URLs do Telegram contêm o token do bot
    logging.getLogger(_nome).setLevel(logging.WARNING)
log = logging.getLogger("bot")


def _safe_tick():
    try:
        scheduler.tick()
    except Exception:
        log.exception("erro no agendador")


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init()
    sched = BackgroundScheduler(timezone="America/Sao_Paulo")
    sched.add_job(_safe_tick, "interval", minutes=scheduler.TICK_MIN)
    sched.start()
    yield
    sched.shutdown()


app = FastAPI(lifespan=lifespan)


def _processar(texto: str):
    try:
        resposta, botoes = llm.responder(texto)
    except Exception as e:
        log.exception("erro na IA")
        resposta, botoes = f"⚠️ A IA falhou ({type(e).__name__}). Rode: python -m app.teste", None
    try:
        canal.enviar(resposta, botoes)
    except Exception:
        log.exception("erro ao enviar")


@app.post("/webhook")
async def webhook(request: Request, bg: BackgroundTasks):
    payload = await request.json()
    msg = whatsapp.extrair_texto(payload)
    if msg:
        bg.add_task(_processar, msg[1])
    return {"ok": True}


@app.get("/health")
def health():
    return {"status": "ok"}
