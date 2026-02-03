"""
Embedding Service - Local sentence embeddings for semantic deduplication

FastAPI service running MiniLM-L6-v2 for memory consolidation.
Listens on localhost:8384.

@module deploy/loa-identity/embedding-service
"""

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from sentence_transformers import SentenceTransformer
import numpy as np
from typing import List, Optional
import logging
import time

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("embedding-service")

app = FastAPI(
    title="Loa Embedding Service",
    description="Local sentence embeddings for memory consolidation",
    version="1.0.0",
)

# Global model instance
model: Optional[SentenceTransformer] = None
MODEL_NAME = "sentence-transformers/all-MiniLM-L6-v2"


class EmbeddingRequest(BaseModel):
    """Request for embedding generation"""
    texts: List[str]
    normalize: bool = True


class EmbeddingResponse(BaseModel):
    """Response containing embeddings"""
    embeddings: List[List[float]]
    model: str
    dimension: int
    count: int
    elapsed_ms: float


class SimilarityRequest(BaseModel):
    """Request for similarity calculation"""
    text1: str
    text2: str


class SimilarityResponse(BaseModel):
    """Response containing similarity score"""
    similarity: float
    model: str


class BatchSimilarityRequest(BaseModel):
    """Request for batch similarity calculation"""
    query: str
    candidates: List[str]
    threshold: float = 0.85


class BatchSimilarityResponse(BaseModel):
    """Response containing batch similarity results"""
    scores: List[float]
    above_threshold: List[int]
    model: str


class HealthResponse(BaseModel):
    """Health check response"""
    status: str
    model_loaded: bool
    model_name: str
    dimension: int


@app.on_event("startup")
async def load_model():
    """Load the embedding model on startup"""
    global model
    logger.info(f"Loading model: {MODEL_NAME}")
    start = time.time()

    try:
        model = SentenceTransformer(MODEL_NAME)
        elapsed = (time.time() - start) * 1000
        logger.info(f"Model loaded in {elapsed:.0f}ms")
        logger.info(f"Embedding dimension: {model.get_sentence_embedding_dimension()}")
    except Exception as e:
        logger.error(f"Failed to load model: {e}")
        raise


@app.get("/health", response_model=HealthResponse)
async def health_check():
    """Health check endpoint"""
    if model is None:
        raise HTTPException(status_code=503, detail="Model not loaded")

    return HealthResponse(
        status="healthy",
        model_loaded=True,
        model_name=MODEL_NAME,
        dimension=model.get_sentence_embedding_dimension(),
    )


@app.post("/embed", response_model=EmbeddingResponse)
async def generate_embeddings(request: EmbeddingRequest):
    """Generate embeddings for a list of texts"""
    if model is None:
        raise HTTPException(status_code=503, detail="Model not loaded")

    if not request.texts:
        raise HTTPException(status_code=400, detail="No texts provided")

    if len(request.texts) > 100:
        raise HTTPException(status_code=400, detail="Maximum 100 texts per request")

    start = time.time()

    try:
        embeddings = model.encode(
            request.texts,
            normalize_embeddings=request.normalize,
            show_progress_bar=False,
        )

        elapsed = (time.time() - start) * 1000

        return EmbeddingResponse(
            embeddings=embeddings.tolist(),
            model=MODEL_NAME,
            dimension=model.get_sentence_embedding_dimension(),
            count=len(request.texts),
            elapsed_ms=round(elapsed, 2),
        )
    except Exception as e:
        logger.error(f"Embedding error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/similarity", response_model=SimilarityResponse)
async def calculate_similarity(request: SimilarityRequest):
    """Calculate cosine similarity between two texts"""
    if model is None:
        raise HTTPException(status_code=503, detail="Model not loaded")

    try:
        embeddings = model.encode(
            [request.text1, request.text2],
            normalize_embeddings=True,
            show_progress_bar=False,
        )

        # Cosine similarity (dot product of normalized vectors)
        similarity = float(np.dot(embeddings[0], embeddings[1]))

        return SimilarityResponse(
            similarity=round(similarity, 4),
            model=MODEL_NAME,
        )
    except Exception as e:
        logger.error(f"Similarity error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/batch-similarity", response_model=BatchSimilarityResponse)
async def batch_similarity(request: BatchSimilarityRequest):
    """Calculate similarity between a query and multiple candidates"""
    if model is None:
        raise HTTPException(status_code=503, detail="Model not loaded")

    if not request.candidates:
        raise HTTPException(status_code=400, detail="No candidates provided")

    if len(request.candidates) > 100:
        raise HTTPException(status_code=400, detail="Maximum 100 candidates per request")

    try:
        # Encode query and all candidates together
        all_texts = [request.query] + request.candidates
        embeddings = model.encode(
            all_texts,
            normalize_embeddings=True,
            show_progress_bar=False,
        )

        query_embedding = embeddings[0]
        candidate_embeddings = embeddings[1:]

        # Calculate cosine similarities
        scores = [
            float(np.dot(query_embedding, candidate))
            for candidate in candidate_embeddings
        ]

        # Find indices above threshold
        above_threshold = [
            i for i, score in enumerate(scores)
            if score >= request.threshold
        ]

        return BatchSimilarityResponse(
            scores=[round(s, 4) for s in scores],
            above_threshold=above_threshold,
            model=MODEL_NAME,
        )
    except Exception as e:
        logger.error(f"Batch similarity error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "main:app",
        host="127.0.0.1",
        port=8384,
        log_level="info",
    )
