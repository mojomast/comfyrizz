"""pipeline-py: the Comfy SDK runner for Comfyrizz (WS-B, owner Hermes).

B2 adds the runner, attempt records and manifest handling; this package starts with
the shared package validator (B1) that both languages must agree on.
"""

from .schema import (  # noqa: F401
    LAYOUTS,
    SEMANTIC_CODES,
    apply_defaults,
    load_schema,
    schema_path,
    semantic_check,
    validate_package,
)

__all__ = [
    "LAYOUTS",
    "SEMANTIC_CODES",
    "apply_defaults",
    "load_schema",
    "schema_path",
    "semantic_check",
    "validate_package",
]
__version__ = "0.1.0"
