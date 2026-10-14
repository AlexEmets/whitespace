/**
 * Where Whitespace talks to its users, in one place: the landing page's community block,
 * its footer and the docs all read from here, so a renamed channel is one edit.
 *
 * Every Telegram address was checked against t.me before it went in — the English
 * announcements channel is `WhiteSpaceAnnouncementsEN`; a bare `WhiteSpaceAnnouncements`
 * does not exist.
 */
export const SOCIAL = {
  x: 'https://x.com/WhiteSpaceFi',
  announcementsEn: 'https://t.me/WhiteSpaceAnnouncementsEN',
  announcementsUa: 'https://t.me/WhiteSpaceAnnouncementsUA',
  chatEn: 'https://t.me/WhiteSpaceEN',
  chatUa: 'https://t.me/WhiteSpaceUA',
  bugReport: 'https://forms.gle/NPronWQVVFu5MSnt9',
} as const;

export interface CommunityChannel {
  id: string;
  kicker: string;
  title: string;
  body: string;
  links: ReadonlyArray<{ label: string; href: string }>;
}

export const COMMUNITY: readonly CommunityChannel[] = [
  {
    id: 'announcements',
    kicker: 'Telegram',
    title: 'Announcements',
    body: 'Releases, fixes, points seasons and maintenance notices, as they happen.',
    links: [
      { label: 'English', href: SOCIAL.announcementsEn },
      { label: 'Українською', href: SOCIAL.announcementsUa },
    ],
  },
  {
    id: 'chat',
    kicker: 'Telegram',
    title: 'Community chat',
    body: 'Questions, trade talk and help from other traders and the team.',
    links: [
      { label: 'EN chat', href: SOCIAL.chatEn },
      { label: 'UA chat', href: SOCIAL.chatUa },
    ],
  },
  {
    id: 'x',
    kicker: 'X',
    title: '@WhiteSpaceFi',
    body: 'Updates, and the share cards traders post from the terminal.',
    links: [{ label: 'Follow on X', href: SOCIAL.x }],
  },
  {
    id: 'bugs',
    kicker: 'Support',
    title: 'Found a bug?',
    body: 'Tell us what broke and how. A screenshot and your wallet address help most.',
    links: [{ label: 'Report a bug', href: SOCIAL.bugReport }],
  },
];
