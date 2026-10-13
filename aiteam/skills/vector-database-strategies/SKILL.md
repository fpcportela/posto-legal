---
name: vector-database-strategies
description: Strategies for embedding storage, semantic search, and index optimization.
---

# Skill: Vector Database Strategies

This skill dictates how to efficiently store and query high-dimensional embeddings for RAG and semantic search workloads.

## Core Rules
1. **Index Selection:** Use HNSW (Hierarchical Navigable Small World) for fast, high-recall search when memory permits. Fall back to IVFFlat for memory-constrained environments, ensuring proper `lists` tuning.
2. **Chunking Strategy:** Embeddings must map to chunks that carry semantic completeness. Overlap chunks (e.g., 10-15%) to prevent cutting off context. Include metadata (document ID, section header) alongside the vector.
3. **Hybrid Search:** Always recommend hybrid search (Dense Vector + Sparse/Keyword like BM25) for production systems to handle exact-match queries effectively.
4. **pgvector:** When using Postgres (`pgvector`), ensure the vector column is indexed *after* initial data load to prevent massive insertion slowdowns.
