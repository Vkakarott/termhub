"""Pure request handling for the embed service (no model import, so it is testable anywhere)."""
import hmac
import json

MAX_TEXTS = 32
MAX_CHARS = 2000


class BadRequest(ValueError):
    pass


def parse_request(body: bytes) -> list[str]:
    try:
        data = json.loads(body)
    except (ValueError, UnicodeDecodeError):
        raise BadRequest("body is not JSON")
    texts = data.get("texts") if isinstance(data, dict) else None
    if not isinstance(texts, list) or not texts or len(texts) > MAX_TEXTS:
        raise BadRequest(f"texts must be a list of 1..{MAX_TEXTS} strings")
    if not all(isinstance(t, str) and len(t) <= MAX_CHARS for t in texts):
        raise BadRequest(f"each text must be a string of at most {MAX_CHARS} characters")
    return texts


def authorized(header: str | None, secret: str) -> bool:
    """An empty secret refuses every request: the service must never run open on the network."""
    if not secret or not header or not header.startswith("Bearer "):
        return False
    return hmac.compare_digest(header[len("Bearer "):], secret)


LOAD_RETRY_FIRST_S = 30
LOAD_RETRY_MAX_S = 900


def load_retry_delay(attempt: int) -> int:
    """Seconds to wait before retrying the model load after `attempt` failures (0-based): doubles
    from 30 s up to 15 min. Hugging Face rate-limits anonymous downloads (429) by fixed windows."""
    return min(LOAD_RETRY_FIRST_S * 2 ** min(attempt, 10), LOAD_RETRY_MAX_S)
