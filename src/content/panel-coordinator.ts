let current: { owner: object; close(): void } | undefined;

/** One extension popover across independent feature modules. */
export function claimPanel(owner: object, close: () => void): void {
  if (current?.owner === owner) return;
  const previous = current;
  current = undefined;
  previous?.close();
  current = { owner, close };
}
export function releasePanel(owner: object): void { if (current?.owner === owner) current = undefined; }
