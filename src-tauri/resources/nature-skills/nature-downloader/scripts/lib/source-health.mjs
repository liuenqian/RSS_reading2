import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ALPHA = 0.2;
const DEFAULT_LATENCY_MS = 15000;
const SOURCE_PRIORS = Object.freeze({
  "PMC OA": 0.98,
  "Europe PMC": 0.88,
  OpenAlex: 0.84,
  Unpaywall: 0.86,
  "bioRxiv/medRxiv": 0.92,
  "Semantic Scholar": 0.72,
  DOAJ: 0.70,
  arXiv: 0.90,
});

export function sourceHealthPath(env = process.env) {
  if (env.LIT_DL_SOURCE_HEALTH_FILE) return path.resolve(env.LIT_DL_SOURCE_HEALTH_FILE);
  const configDir = env.LIT_DL_CONFIG_DIR || path.join(os.homedir(), ".config", "lit-dl");
  return path.join(configDir, "source-health.json");
}

export function loadSourceHealth(file = sourceHealthPath()) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

export function adaptiveSourceScore(source, scores = {}) {
  const prior = SOURCE_PRIORS[source] ?? 0.5;
  const entry = scores[source];
  if (!entry || Number(entry.attempts || 0) <= 0) return prior;
  const attempts = Math.max(0, Number(entry.attempts || 0));
  const success = Math.min(1, Math.max(0, Number(entry.success_ema ?? prior)));
  const latency = Math.max(0, Number(entry.latency_ema_ms ?? DEFAULT_LATENCY_MS));
  const latencyScore = 1 / (1 + latency / DEFAULT_LATENCY_MS);
  const measured = (0.85 * success) + (0.15 * latencyScore);
  const confidence = Math.min(0.85, attempts / 10);
  return ((1 - confidence) * prior) + (confidence * measured);
}

export function rankCandidatesByHealth(candidates, scores = {}) {
  return candidates
    .map((candidate, index) => ({ candidate, index }))
    .sort((left, right) => {
      const scoreDiff = adaptiveSourceScore(right.candidate.source, scores)
        - adaptiveSourceScore(left.candidate.source, scores);
      return scoreDiff || left.index - right.index;
    })
    .map(({ candidate }) => candidate);
}

export function recordSourceResult(
  source,
  success,
  latencyMs,
  { file = sourceHealthPath(), now = Date.now() } = {}
) {
  const name = String(source || "").trim();
  if (!name) return;
  const scores = loadSourceHealth(file);
  const prior = SOURCE_PRIORS[name] ?? 0.5;
  const entry = scores[name] && typeof scores[name] === "object" ? scores[name] : {};
  const previousSuccess = Number(entry.success_ema ?? prior);
  const previousLatency = Number(entry.latency_ema_ms ?? DEFAULT_LATENCY_MS);
  const latency = Math.max(0, Number(latencyMs || 0));

  scores[name] = {
    success_ema: Number((ALPHA * (success ? 1 : 0) + (1 - ALPHA) * previousSuccess).toFixed(6)),
    latency_ema_ms: Number((latency > 0
      ? ALPHA * latency + (1 - ALPHA) * previousLatency
      : previousLatency).toFixed(3)),
    attempts: Number(entry.attempts || 0) + 1,
    last_success: Boolean(success),
    updated_at: Number(now),
  };

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(temp, `${JSON.stringify(scores, null, 2)}\n`, "utf8");
    fs.renameSync(temp, file);
  } catch {
    // Source health is an optimization; download success must not depend on it.
  }
}
