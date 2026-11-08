import { afterEach, describe, expect, it, vi } from 'vitest';
import { acquirePositioning } from '../../src/content/positioning';

function fixture(value = '', priority = '', computed = 'static'): HTMLElement {
  const properties = new Map<string, { value: string; priority: string }>();
  if (value) properties.set('position', { value, priority });
  const node = { style: {
    getPropertyValue(name: string) { return properties.get(name)?.value ?? ''; },
    getPropertyPriority(name: string) { return properties.get(name)?.priority ?? ''; },
    setProperty(name: string, next: string, nextPriority = '') { properties.set(name, { value: next, priority: nextPriority }); },
    removeProperty(name: string) { const old = properties.get(name)?.value; properties.delete(name); return old ?? ''; },
  }, computed };
  vi.stubGlobal('getComputedStyle', (element: typeof node) => ({ position: element.style.getPropertyValue('position') || element.computed }));
  return node as unknown as HTMLElement;
}
afterEach(() => vi.unstubAllGlobals());
describe('shared relative-container ownership', () => {
  it('keeps positioning while either ratings or marks needs it, then restores the original', () => {
    const node = fixture();
    const ratings = acquirePositioning(node), marks = acquirePositioning(node);
    expect(node.style.getPropertyValue('position')).toBe('relative');
    ratings(); expect(node.style.getPropertyValue('position')).toBe('relative');
    marks(); expect(node.style.getPropertyValue('position')).toBe('');
  });
  it('also works when marks releases before ratings and ignores duplicate releases', () => {
    const node = fixture('static', 'important');
    const marks = acquirePositioning(node), ratings = acquirePositioning(node);
    marks(); marks(); expect(node.style.getPropertyValue('position')).toBe('relative');
    ratings(); expect(node.style.getPropertyValue('position')).toBe('static');
    expect(node.style.getPropertyPriority('position')).toBe('important');
  });
  it('does not take ownership of a positioned native container', () => {
    const node = fixture('absolute', 'important');
    const release = acquirePositioning(node); release();
    expect(node.style.getPropertyValue('position')).toBe('absolute');
    expect(node.style.getPropertyPriority('position')).toBe('important');
  });
  it('preserves later Netflix position changes when all features detach', () => {
    const node = fixture();
    const release = acquirePositioning(node);
    node.style.setProperty('position', 'absolute', 'important'); release();
    expect(node.style.getPropertyValue('position')).toBe('absolute');
    expect(node.style.getPropertyPriority('position')).toBe('important');
  });
});
