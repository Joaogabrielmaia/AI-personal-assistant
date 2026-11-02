"""Diagnóstico da IA:  python -m app.teste
Mostra se a chave/modelo funcionam, quanto tempo demora e se o modelo aceita ferramentas."""
import time

from dotenv import load_dotenv

load_dotenv()

from . import llm, tools  # noqa: E402


def tentar(nome, **extra):
    t0 = time.time()
    try:
        r = llm.client.chat.completions.create(
            model=llm.MODEL,
            messages=[{"role": "user", "content": "Responda só: ok"}],
            **extra,
        )
        print(f"[OK ] {nome}: {time.time() - t0:.1f}s -> {r.choices[0].message.content!r}")
        return True
    except Exception as e:
        print(f"[ERRO] {nome}: {time.time() - t0:.1f}s -> {type(e).__name__}: {e}")
        return False


print(f"Modelo: {llm.MODEL}")
print(f"Endereço: {llm.client.base_url}")
if tentar("chamada simples"):
    tentar("chamada com ferramentas", tools=tools.SCHEMAS)
print("\nDicas: 404 = nome do modelo errado | 401/403 = chave errada | 429 = limite grátis atingido, espere 1 minuto.")
