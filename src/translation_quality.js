export const TRANSLATION_QUALITY_FILTER_VALUES = new Set([
  'all',
  'risk',
  'title-risk',
  'summary-risk',
]);

const CJK_CHARACTER = /[\u3400-\u9fff\uf900-\ufaff]/u;
const LATIN_CHARACTER = /[A-Za-z]/u;
const ERROR_RESPONSE = /^(?:翻译)?(?:失败|错误)|^(?:translation|request|api)\b.{0,40}\b(?:failed|error|timeout)/iu;

function plainText(value) {
  return String(value || '')
    .replace(/<[^>]*>/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function countMatchingCharacters(text, matcher) {
  return [...text].filter(character => matcher.test(character)).length;
}

function protectedTokens(text) {
  const dois = text.match(/\b10\.\d{4,9}\/[\w.()/:;-]+/giu) || [];
  const numbers = text.match(/\b\d{2,}(?:[.,]\d+)?%?/gu) || [];
  return [...new Set([...dois, ...numbers].map(token => token
    .replace(/[.,;:]+$/u, '')
    .toLowerCase()))];
}

function fieldText(entry, field, translated = false) {
  if (field === 'title') return plainText(translated ? entry?.title_translated : entry?.title);
  return plainText(translated ? entry?.summary_translated : entry?.summary);
}

function fieldError(entry, field) {
  return String(entry?._translationErrors?.[field] || '').trim();
}

export function translationQualityIssuesForField(entry, field) {
  const source = fieldText(entry, field);
  const translated = fieldText(entry, field, true);
  const error = fieldError(entry, field);
  const issues = [];

  if (error) issues.push({ field, code: 'request-error', label: '上次请求失败' });
  if (!source || !translated) return issues;

  if (ERROR_RESPONSE.test(translated)) {
    issues.push({ field, code: 'error-response', label: '疑似错误响应' });
  }

  const sourceCjk = countMatchingCharacters(source, CJK_CHARACTER);
  const sourceLatin = countMatchingCharacters(source, LATIN_CHARACTER);
  const translatedCjk = countMatchingCharacters(translated, CJK_CHARACTER);
  const translatedLatin = countMatchingCharacters(translated, LATIN_CHARACTER);
  const normalizedSource = source.toLocaleLowerCase();
  const normalizedTranslated = translated.toLocaleLowerCase();
  if (sourceLatin >= 3 && sourceLatin > sourceCjk && translatedLatin >= 3 && translatedCjk === 0) {
    issues.push({ field, code: 'still-english', label: '仍主要为英文' });
  }
  if (sourceLatin >= 3 && normalizedSource === normalizedTranslated) {
    issues.push({ field, code: 'source-repeated', label: '疑似原文重复' });
  }
  if (source.length >= 80 && translated.length < Math.max(18, Math.floor(source.length * 0.14))) {
    issues.push({ field, code: 'too-short', label: '译文异常短' });
  }

  const missingTokens = protectedTokens(source)
    .filter(token => !normalizedTranslated.includes(token));
  if (missingTokens.length) {
    issues.push({ field, code: 'protected-token-missing', label: '关键数字或 DOI 丢失' });
  }

  return issues;
}

export function translationQualityIssues(entry) {
  return [
    ...translationQualityIssuesForField(entry, 'title'),
    ...translationQualityIssuesForField(entry, 'summary'),
  ];
}

export function matchesTranslationQualityFilter(entry, filter) {
  const issues = translationQualityIssues(entry);
  if (filter === 'all') return true;
  if (filter === 'title-risk') return issues.some(issue => issue.field === 'title');
  if (filter === 'summary-risk') return issues.some(issue => issue.field === 'summary');
  return issues.length > 0;
}
