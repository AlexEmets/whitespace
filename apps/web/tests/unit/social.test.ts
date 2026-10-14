import { describe, expect, it } from 'vitest';
import { COMMUNITY, SOCIAL } from '@/lib/social';

describe('social links', () => {
  /** A bare t.me/WhiteSpaceAnnouncements resolves to no channel at all. */
  it('points English announcements at the channel that exists', () => {
    expect(SOCIAL.announcementsEn).toBe('https://t.me/WhiteSpaceAnnouncementsEN');
    expect(SOCIAL.announcementsUa).toBe('https://t.me/WhiteSpaceAnnouncementsUA');
  });

  it('links every channel over https to its own service', () => {
    expect(SOCIAL.x).toMatch(/^https:\/\/x\.com\/WhiteSpaceFi$/);
    for (const href of [SOCIAL.announcementsEn, SOCIAL.announcementsUa, SOCIAL.chatEn, SOCIAL.chatUa]) {
      expect(href).toMatch(/^https:\/\/t\.me\/WhiteSpace[A-Za-z]+$/);
    }
    expect(SOCIAL.bugReport).toMatch(/^https:\/\/forms\.gle\//);
  });

  it('gives each community card at least one link, all from SOCIAL', () => {
    const known = new Set<string>(Object.values(SOCIAL));
    for (const c of COMMUNITY) {
      expect(c.links.length).toBeGreaterThan(0);
      for (const l of c.links) expect(known.has(l.href)).toBe(true);
    }
  });

  it('offers both languages for announcements and for the chat', () => {
    const hrefs = (id: string) => COMMUNITY.find((c) => c.id === id)!.links.map((l) => l.href);
    expect(hrefs('announcements')).toEqual([SOCIAL.announcementsEn, SOCIAL.announcementsUa]);
    expect(hrefs('chat')).toEqual([SOCIAL.chatEn, SOCIAL.chatUa]);
  });
});
