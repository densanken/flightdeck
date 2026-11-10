export class HeadStatusTracker {
  private readonly known = new Set<string>();
  private readonly pending = new Set<string>();
  private readonly protected = new Set<string>();
  private readonly protectionFailed = new Set<string>();

  constructor(
    public current: string,
    previous?: string
  ) {
    this.remember(current);
    if (previous !== undefined) this.remember(previous);
  }

  setCurrent(sha: string): void {
    this.current = sha;
    this.remember(sha);
  }

  remember(sha: string): void {
    this.known.add(sha);
    if (!this.protected.has(sha)) this.pending.add(sha);
  }

  beginRecovery(): void {
    this.pending.clear();
    for (const sha of this.known) {
      if (!this.protected.has(sha)) this.pending.add(sha);
    }
  }

  register(sha: string): void {
    this.known.add(sha);
    this.pending.add(sha);
    this.protected.delete(sha);
  }

  confirm(sha: string): void {
    this.pending.delete(sha);
  }

  protect(sha: string): void {
    this.pending.delete(sha);
    this.protected.add(sha);
  }

  isProtected(sha: string): boolean {
    return this.protected.has(sha);
  }

  isPending(sha: string): boolean {
    return this.pending.has(sha);
  }

  failProtection(sha: string): void {
    this.protectionFailed.add(sha);
  }

  next(visited: ReadonlySet<string> = new Set()): string | undefined {
    const eligible = (sha: string) => this.pending.has(sha) && !this.protectionFailed.has(sha) && !visited.has(sha);
    if (eligible(this.current)) return this.current;
    return [...this.pending].find(eligible);
  }
}
