interface PositionOwner { users: number; value: string; priority: string; owned: boolean }
const owners = new WeakMap<HTMLElement, PositionOwner>();

/** Shared by independently toggleable card features. Preserve later site changes. */
export function acquirePositioning(element: HTMLElement): () => void {
  let owner = owners.get(element);
  if (!owner) {
    owner = { users: 0, value: element.style.getPropertyValue('position'), priority: element.style.getPropertyPriority('position'),
      owned: getComputedStyle(element).position === 'static' };
    owners.set(element, owner);
    if (owner.owned) element.style.setProperty('position', 'relative');
  }
  owner.users++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--owner.users) return;
    if (owner.owned && element.style.getPropertyValue('position') === 'relative' && !element.style.getPropertyPriority('position')) {
      if (owner.value) element.style.setProperty('position', owner.value, owner.priority);
      else element.style.removeProperty('position');
    }
    owners.delete(element);
  };
}
