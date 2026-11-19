export const listWithinLimit = <T>(
  items: readonly T[],
  render: (item: T) => string,
  separator: string,
  limit: number
): string => {
  const entries = items.map(render);
  const total =
    entries.reduce((length, entry) => length + entry.length, 0) + Math.max(0, entries.length - 1) * separator.length;
  if (total <= limit) return entries.join(separator);

  const lines: string[] = [];
  let length = 0;

  for (const [index, line] of entries.entries()) {
    const remaining = items.length - index - 1;
    const suffix = remaining ? `${separator}…ほか ${String(remaining)} 件` : "";
    const prefixLength = lines.length ? separator.length : 0;
    if (length + prefixLength + line.length + suffix.length > limit) break;

    length += prefixLength + line.length;
    lines.push(line);
  }

  const omitted = items.length - lines.length;
  if (omitted) lines.push(`…ほか ${String(omitted)} 件`);
  return lines.join(separator);
};
