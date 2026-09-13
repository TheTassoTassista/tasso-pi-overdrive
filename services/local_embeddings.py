#!/usr/bin/env python3
"""Private loopback OpenAI-compatible embedding service for Pi Overdrive."""

from __future__ import annotations

import argparse
import base64
import os
from typing import Any

os.environ.setdefault("ORT_DISABLE_TELEMETRY", "1")

from pydantic import BaseModel, ConfigDict

MODEL_ID = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
DIMENSIONS = 384
MAX_ITEMS = 64
MAX_ITEM_CHARS = 16_000


class EmbeddingRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    input: str | list[str]
    model: str = MODEL_ID
    encoding_format: str = "float"
    dimensions: int | None = None


def load_model(cache_dir: str, model_path: str):
    from fastembed import TextEmbedding

    return TextEmbedding(
        model_name=MODEL_ID,
        cache_dir=cache_dir,
        specific_model_path=model_path,
        local_files_only=True,
        providers=["CPUExecutionProvider"],
    )


def prepare(cache_dir: str, model_path: str) -> int:
    model = load_model(cache_dir, model_path)
    vectors = list(model.embed(["memoria locale italiana", "local English memory"]))
    if len(vectors) != 2 or any(len(vector) != DIMENSIONS for vector in vectors):
        raise RuntimeError("embedding_dimension_mismatch")
    print(f"Local multilingual embeddings: PASS ({MODEL_ID}, dimensions={DIMENSIONS}, cpu-only)")
    return 0


def create_app(cache_dir: str, model_path: str):
    from fastapi import FastAPI, HTTPException
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    model = load_model(cache_dir, model_path)
    app = FastAPI(title="Pi Overdrive Local Embeddings", docs_url=None, redoc_url=None)

    @app.get("/health")
    def health() -> dict[str, Any]:
        return {"status": "ok", "model": MODEL_ID, "dimensions": DIMENSIONS, "device": "cpu"}

    @app.get("/v1/models")
    def models() -> dict[str, Any]:
        return {"object": "list", "data": [{"id": MODEL_ID, "object": "model", "owned_by": "local"}]}

    @app.post("/v1/embeddings")
    def embeddings(request: EmbeddingRequest) -> dict[str, Any]:
        if request.model != MODEL_ID:
            raise HTTPException(status_code=400, detail="unsupported_model")
        if request.encoding_format not in {"float", "base64"}:
            raise HTTPException(status_code=400, detail="unsupported_encoding")
        if request.dimensions not in (None, DIMENSIONS):
            raise HTTPException(status_code=400, detail="unsupported_dimensions")
        values = [request.input] if isinstance(request.input, str) else request.input
        if not values or len(values) > MAX_ITEMS:
            raise HTTPException(status_code=400, detail="input_count_out_of_range")
        if any(not isinstance(value, str) or not value.strip() or len(value) > MAX_ITEM_CHARS for value in values):
            raise HTTPException(status_code=400, detail="input_invalid")
        result = list(model.embed(values))
        def encoded(vector):
            if request.encoding_format == "float":
                return vector.tolist()
            return base64.b64encode(vector.astype("<f4", copy=False).tobytes()).decode("ascii")

        data = [{"object": "embedding", "index": index, "embedding": encoded(vector)} for index, vector in enumerate(result)]
        approximate_tokens = sum(max(1, len(value) // 4) for value in values)
        return {"object": "list", "model": MODEL_ID, "data": data, "usage": {"prompt_tokens": approximate_tokens, "total_tokens": approximate_tokens}}

    return app


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cache-dir", required=True)
    parser.add_argument("--model-path", required=True)
    parser.add_argument("--prepare", action="store_true")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=1934)
    args = parser.parse_args()
    if args.prepare:
        return prepare(args.cache_dir, args.model_path)
    if args.host not in {"127.0.0.1", "::1"}:
        raise SystemExit("loopback_host_required")
    import uvicorn

    uvicorn.run(create_app(args.cache_dir, args.model_path), host=args.host, port=args.port, workers=1, access_log=False, log_level="warning")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
