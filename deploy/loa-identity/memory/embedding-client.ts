/**
 * Embedding Client - HTTP client for local embedding service
 *
 * Connects to the FastAPI embedding service with health checks,
 * timeouts, and retry with backoff.
 *
 * @module deploy/loa-identity/memory/embedding-client
 */

export interface EmbeddingResponse {
  embeddings: number[][];
  model: string;
  dimension: number;
  count: number;
  elapsed_ms: number;
}

export interface SimilarityResponse {
  similarity: number;
  model: string;
}

export interface BatchSimilarityResponse {
  scores: number[];
  above_threshold: number[];
  model: string;
}

export interface HealthResponse {
  status: string;
  model_loaded: boolean;
  model_name: string;
  dimension: number;
}

export interface EmbeddingClientConfig {
  baseUrl: string;
  timeout: number; // ms
  maxRetries: number;
  retryDelay: number; // ms, base delay for exponential backoff
}

export type ServiceStatus = 'available' | 'unavailable' | 'unknown';

/**
 * EmbeddingClient provides a TypeScript interface to the local embedding service.
 */
export class EmbeddingClient {
  private config: EmbeddingClientConfig;
  private status: ServiceStatus = 'unknown';
  private lastHealthCheck: Date | null = null;

  constructor(config?: Partial<EmbeddingClientConfig>) {
    this.config = {
      baseUrl: config?.baseUrl ?? 'http://127.0.0.1:8384',
      timeout: config?.timeout ?? 5000, // 5 seconds
      maxRetries: config?.maxRetries ?? 3,
      retryDelay: config?.retryDelay ?? 500, // 500ms base
    };
  }

  /**
   * Check if embedding service is available
   */
  async isAvailable(): Promise<boolean> {
    try {
      const health = await this.healthCheck();
      this.status = health.model_loaded ? 'available' : 'unavailable';
      return health.model_loaded;
    } catch {
      this.status = 'unavailable';
      return false;
    }
  }

  /**
   * Health check endpoint
   */
  async healthCheck(): Promise<HealthResponse> {
    const response = await this.fetch('/health', {
      method: 'GET',
    });

    if (!response.ok) {
      throw new Error(`Health check failed: ${response.status}`);
    }

    const result = (await response.json()) as HealthResponse;
    this.lastHealthCheck = new Date();
    this.status = result.model_loaded ? 'available' : 'unavailable';

    return result;
  }

  /**
   * Generate embeddings for texts
   */
  async embed(texts: string[], normalize = true): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    const response = await this.fetchWithRetry('/embed', {
      method: 'POST',
      body: JSON.stringify({ texts, normalize }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Embedding failed: ${response.status} - ${error}`);
    }

    const result = (await response.json()) as EmbeddingResponse;
    return result.embeddings;
  }

  /**
   * Calculate similarity between two texts
   */
  async similarity(text1: string, text2: string): Promise<number> {
    const response = await this.fetchWithRetry('/similarity', {
      method: 'POST',
      body: JSON.stringify({ text1, text2 }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Similarity failed: ${response.status} - ${error}`);
    }

    const result = (await response.json()) as SimilarityResponse;
    return result.similarity;
  }

  /**
   * Calculate similarity between a query and multiple candidates
   */
  async batchSimilarity(
    query: string,
    candidates: string[],
    threshold = 0.85
  ): Promise<{
    scores: number[];
    aboveThreshold: number[];
  }> {
    if (candidates.length === 0) {
      return { scores: [], aboveThreshold: [] };
    }

    const response = await this.fetchWithRetry('/batch-similarity', {
      method: 'POST',
      body: JSON.stringify({ query, candidates, threshold }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Batch similarity failed: ${response.status} - ${error}`);
    }

    const result = (await response.json()) as BatchSimilarityResponse;
    return {
      scores: result.scores,
      aboveThreshold: result.above_threshold,
    };
  }

  /**
   * Calculate cosine similarity between two embeddings locally
   */
  cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) {
      throw new Error('Embedding dimensions must match');
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
    if (magnitude === 0) return 0;

    return dotProduct / magnitude;
  }

  /**
   * Find similar texts above threshold
   */
  async findSimilar(
    query: string,
    candidates: string[],
    threshold = 0.85
  ): Promise<Array<{ index: number; text: string; score: number }>> {
    if (candidates.length === 0) {
      return [];
    }

    const result = await this.batchSimilarity(query, candidates, threshold);

    return result.aboveThreshold.map((index) => ({
      index,
      text: candidates[index],
      score: result.scores[index],
    }));
  }

  /**
   * Fetch with timeout
   */
  private async fetch(
    path: string,
    init: RequestInit
  ): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      this.config.timeout
    );

    try {
      return await fetch(`${this.config.baseUrl}${path}`, {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          ...init.headers,
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Fetch with retry and exponential backoff
   */
  private async fetchWithRetry(
    path: string,
    init: RequestInit
  ): Promise<Response> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < this.config.maxRetries; attempt++) {
      try {
        const response = await this.fetch(path, init);

        // Don't retry on client errors (4xx)
        if (response.status >= 400 && response.status < 500) {
          return response;
        }

        // Retry on server errors (5xx)
        if (response.status >= 500) {
          lastError = new Error(`Server error: ${response.status}`);
          await this.delay(attempt);
          continue;
        }

        return response;
      } catch (e) {
        lastError = e as Error;

        // Don't retry on abort (timeout)
        if ((e as Error).name === 'AbortError') {
          lastError = new Error('Request timeout');
        }

        await this.delay(attempt);
      }
    }

    throw lastError ?? new Error('Max retries exceeded');
  }

  /**
   * Exponential backoff delay
   */
  private async delay(attempt: number): Promise<void> {
    const delay = this.config.retryDelay * Math.pow(2, attempt);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  /**
   * Get current service status
   */
  getStatus(): {
    status: ServiceStatus;
    lastHealthCheck: Date | null;
    baseUrl: string;
  } {
    return {
      status: this.status,
      lastHealthCheck: this.lastHealthCheck,
      baseUrl: this.config.baseUrl,
    };
  }
}

/**
 * Create an EmbeddingClient with default configuration
 */
export function createEmbeddingClient(): EmbeddingClient {
  return new EmbeddingClient({
    baseUrl: 'http://127.0.0.1:8384',
    timeout: 5000,
    maxRetries: 3,
    retryDelay: 500,
  });
}
