export interface ChangedFile {
  path: string;
  removed?: boolean | undefined;
  previousPath?: string | undefined;
}

export const classifyPaths = (files: ChangedFile[]): { authorRoots: string[]; otherPaths: string[] } => {
  const paths = files.flatMap(({ path, previousPath }) => (previousPath === undefined ? [path] : [path, previousPath]));
  const authorRoots = new Set<string>();
  const otherPaths = new Set<string>();

  for (const path of paths) {
    const segments = path.split("/");
    const root = segments[0] === "authors" && segments.length >= 3 ? segments[1] : undefined;

    if (root) authorRoots.add(root);
    else otherPaths.add(path);
  }

  return { authorRoots: [...authorRoots], otherPaths: [...otherPaths] };
};

export const collidingAuthorRoots = (changedRoots: string[], baseRoots: string[]): string[] => {
  const names = new Map<string, Set<string>>();

  for (const root of [...changedRoots, ...baseRoots]) {
    const key = root.toLowerCase();
    const variants = names.get(key) ?? new Set<string>();
    variants.add(root);
    names.set(key, variants);
  }

  return changedRoots.filter((root) => (names.get(root.toLowerCase())?.size ?? 0) > 1);
};

export const newAuthorRoots = (files: ChangedFile[], baseRoots: string[]): string[] => {
  const existing = new Set(baseRoots.map((root) => root.toLowerCase()));
  const roots = files.flatMap(({ path, removed }) => {
    const match = /^authors\/([^/]+)\/meta\.ya?ml$/.exec(path);
    const name = match?.[1];
    return name && !removed && !existing.has(name.toLowerCase()) ? [name] : [];
  });

  return [...new Set(roots)];
};
