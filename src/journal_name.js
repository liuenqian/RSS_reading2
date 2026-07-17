export function shortJournalDisplayName(value) {
  const name = String(value || '').trim();
  if (!name) return '';
  return name
    .split(/\s*(?::|=)\s+/u, 1)[0]
    .replace(/\s*[（(][^()（）]*[)）]/gu, '')
    .trim();
}
