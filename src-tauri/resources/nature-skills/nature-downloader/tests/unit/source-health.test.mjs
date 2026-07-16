import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadSourceHealth,
  rankCandidatesByHealth,
  recordSourceResult,
  sourceHealthPath,
} from "../../scripts/lib/source-health.mjs";

const tempDirs = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cento-source-health-"));
  tempDirs.push(dir);
  return path.join(dir, "source-health.json");
}

describe("source health", () => {
  test("uses the configured local state file", () => {
    assert.equal(
      sourceHealthPath({ LIT_DL_SOURCE_HEALTH_FILE: "/tmp/custom-source-health.json" }),
      "/tmp/custom-source-health.json"
    );
  });

  test("records only aggregate source health", () => {
    const file = tempFile();
    recordSourceResult("OpenAlex", true, 250, { file, now: 123 });
    const stored = loadSourceHealth(file);
    assert.equal(stored.OpenAlex.attempts, 1);
    assert.equal(stored.OpenAlex.last_success, true);
    assert.equal(stored.OpenAlex.updated_at, 123);
    assert.deepEqual(Object.keys(stored.OpenAlex).sort(), [
      "attempts", "last_success", "latency_ema_ms", "success_ema", "updated_at",
    ]);
  });

  test("moves a historically reliable source ahead of a failing source", () => {
    const candidates = [
      { source: "OpenAlex", url: "https://a.test/p.pdf" },
      { source: "DOAJ", url: "https://b.test/p.pdf" },
    ];
    const scores = {
      OpenAlex: { attempts: 10, success_ema: 0.05, latency_ema_ms: 30000 },
      DOAJ: { attempts: 10, success_ema: 0.99, latency_ema_ms: 100 },
    };
    assert.equal(rankCandidatesByHealth(candidates, scores)[0].source, "DOAJ");
  });
});
