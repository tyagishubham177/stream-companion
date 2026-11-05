import { describe, expect, it } from 'vitest';
import { netflixAdapter, netflixTitleId } from '../../src/platforms/netflix';
import { badgeText } from '../../src/features/ratings/presentation';
import { automaticRetryDelay, canResumeOnDemand } from '../../src/features/ratings/recovery';

describe('Netflix page identity boundary', () => {
  it('reads the inspected title-level browse links', () => {
    expect(netflixTitleId('/browse?jbv=70136129')).toBe('70136129');
    expect(netflixTitleId('/browse/my-list?jbv=492899')).toBe('492899');
    expect(netflixTitleId('/search?q=Far&jbv=492899')).toBe('492899');
  });
  it.each([
    '/watch/70119610', '/account?jbv=70136129', '/browse?jbv=1&jbv=2',
    '/browse?jbv=not-an-id', '/browse?jbv=1234567890123',
    'https://www.netflix.com.evil.test/browse?jbv=70136129',
    'http://www.netflix.com/browse?jbv=70136129',
    'https://credential@www.netflix.com/browse?jbv=70136129',
  ])('rejects unsupported or ambiguous identity %s', href => {
    expect(netflixTitleId(href)).toBeNull();
  });
  it.each(['/watch/123', '/login', '/account', '/YourAccount', '/profiles/manage', '/games', '/latest', '/browse/person/123'])('fails closed on %s', path => {
    expect(netflixAdapter.supports(new URL(`https://www.netflix.com${path}`))).toBe(false);
  });
  it.each(['/browse', '/browse/my-list', '/browse/genre/83', '/search?q=movie'])('supports the declared browse surface %s', path => {
    expect(netflixAdapter.supports(new URL(`https://www.netflix.com${path}`))).toBe(true);
  });
});

describe('bounded demand recovery', () => {
  it('retries transient responses only three times and respects provider eligibility', () => {
    const state = { kind: 'deferred', reason: 'provider', message: 'Later', retryAfter: 7000 } as const;
    expect(automaticRetryDelay(state, 0, 1000, true)).toBe(6000);
    expect(automaticRetryDelay(state, 1, 8000, true)).toBe(5000);
    expect(automaticRetryDelay(state, 2, 8000, true)).toBe(10000);
    expect(automaticRetryDelay(state, 3, 8000, true)).toBeNull();
    expect(automaticRetryDelay({ ...state, retryAfter: 90000 }, 0, 1000, true)).toBeNull();
  });
  it('does not create retry loops while offline or behind key and quota circuits', () => {
    expect(automaticRetryDelay({ kind: 'deferred', reason: 'offline', message: 'Offline' }, 0, 1000, false)).toBeNull();
    expect(automaticRetryDelay({ kind: 'deferred', reason: 'quota', message: 'Quota', retryAfter: 1000 }, 0, 1000, true)).toBeNull();
    expect(automaticRetryDelay({ kind: 'deferred', reason: 'key', message: 'Key' }, 0, 1000, true)).toBeNull();
  });
  it('renews deferred demand only when its circuit allows it', () => {
    expect(canResumeOnDemand({ kind: 'deferred', reason: 'busy', message: 'Busy' }, 1000)).toBe(true);
    expect(canResumeOnDemand({ kind: 'deferred', reason: 'quota', message: 'Quota', retryAfter: 2000 }, 1000)).toBe(false);
    expect(canResumeOnDemand({ kind: 'deferred', reason: 'quota', message: 'Quota', retryAfter: 2000 }, 2000)).toBe(true);
    expect(canResumeOnDemand({ kind: 'deferred', reason: 'key', message: 'Key' }, 1000)).toBe(false);
  });
});

describe('rating presentation', () => {
  it('never substitutes an example score for unresolved identity or provider errors', () => {
    expect(badgeText(null)).toBe('IMDb …');
    expect(badgeText({ kind: 'needs_match', reason: 'insufficient_evidence' })).toBe('IMDb —');
    expect(badgeText({ kind: 'deferred', reason: 'offline', message: 'Offline' })).toBe('IMDb !');
    expect(badgeText({ kind: 'setup_required' })).toBe('IMDb · Setup');
  });
});
