import hashlib


DERIVATION_CONTEXT = "bot-internal-api-v1:"


def resolve_internal_token(configured_token, fallback_seed):
    configured = str(configured_token or "").strip()
    if configured:
        return configured, "configured_internal_token"
    seed = str(fallback_seed or "").strip()
    if not seed:
        return None, "missing"
    token = hashlib.sha256(f"{DERIVATION_CONTEXT}{seed}".encode("utf-8")).hexdigest()
    return token, "derived_from_jwt_secret"
