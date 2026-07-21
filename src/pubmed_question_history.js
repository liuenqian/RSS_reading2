export const PUBMED_QUESTION_HISTORY_LIMIT = 20;

export function normalizePubmedQuestionHistory(value, limit = PUBMED_QUESTION_HISTORY_LIMIT) {
  if (!Array.isArray(value)) return [];

  const seen = new Set();
  const normalized = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const question = item.trim();
    const key = question.toLocaleLowerCase();
    if (!question || seen.has(key)) continue;
    seen.add(key);
    normalized.push(question);
    if (normalized.length >= limit) break;
  }
  return normalized;
}

export function addPubmedQuestionHistory(history, question, limit = PUBMED_QUESTION_HISTORY_LIMIT) {
  const nextQuestion = typeof question === 'string' ? question.trim() : '';
  if (!nextQuestion) return normalizePubmedQuestionHistory(history, limit);
  return normalizePubmedQuestionHistory([nextQuestion, ...(Array.isArray(history) ? history : [])], limit);
}
