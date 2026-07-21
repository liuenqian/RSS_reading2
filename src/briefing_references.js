export function normalizeBriefingReferencesMarkdown(markdown) {
  const lines = String(markdown || '').split(/\r?\n/);
  let inReferences = false;

  return lines.map(line => {
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      inReferences = /^参考文献\s*$/u.test(heading[2].trim());
      return line;
    }
    if (!inReferences) return line;
    const reference = line.match(/^\s*\[(\d+)\]\s+(.+)$/u);
    return reference ? `- [${reference[1]}] ${reference[2]}` : line;
  }).join('\n');
}
