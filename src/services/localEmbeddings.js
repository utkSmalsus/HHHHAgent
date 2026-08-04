import { pipeline } from '@xenova/transformers';
import { config } from '../config.js';

let extractor = null;
let loading = null;

async function getExtractor() {
  if (extractor) return extractor;
  if (loading) return loading;

  loading = pipeline('feature-extraction', config.embeddings.localModel, {
    quantized: true,
  }).then((pipe) => {
    extractor = pipe;
    console.log(`Local embedding model ready: ${config.embeddings.localModel}`);
    return pipe;
  });

  return loading;
}

function tensorToVector(output) {
  const data = output.data ?? output;
  if (data.length && typeof data[0] === 'number') {
    return Array.from(data);
  }
  const dims = output.dims?.[1] ?? output.size?.[1];
  if (dims) {
    const mean = new Array(dims).fill(0);
    const rows = output.dims?.[0] ?? 1;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < dims; c++) {
        mean[c] += data[r * dims + c];
      }
    }
    return mean.map((v) => v / rows);
  }
  return Array.from(data);
}

export async function embedText(text) {
  const pipe = await getExtractor();
  // No truncation here — services/ai.js rejects oversized input before it reaches any provider.
  const output = await pipe(String(text ?? ''), { pooling: 'mean', normalize: true });
  const vec = tensorToVector(output);
  if (!vec.length) {
    throw new Error('Local embedding returned empty vector');
  }
  return vec;
}
