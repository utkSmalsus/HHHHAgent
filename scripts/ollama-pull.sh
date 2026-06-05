#!/bin/bash
# Pull recommended Ollama models for this project (run once)
set -e
echo "Pulling Ollama models for OMT AI backend..."
echo "Embeddings: nomic-embed-text (768 dims)"
ollama pull nomic-embed-text
echo "Chat: llama3.2 (good quality + speed on Mac)"
ollama pull llama3.2
echo ""
echo "Done. Verify: ollama list"
ollama list
