import { describe, it, expect } from 'vitest';
import { EVENT_TOASTS } from '../toasts';
import { CURRICULUM } from '../../lessons/curriculum';
import { glossaryRefs } from '../../lessons/glossary';

describe('event toasts', () => {
  it('link only to lessons that exist in the curriculum', () => {
    const ids = new Set(CURRICULUM.map((l) => l.id));
    const links = Object.entries(EVENT_TOASTS).filter(([, spec]) => spec?.lessonId);
    expect(links.length).toBeGreaterThanOrEqual(9);
    for (const [event, spec] of links) expect(ids.has(spec!.lessonId!), `${event} → ${spec!.lessonId}`).toBe(true);
  });

  it('only use glossary terms that exist', () => {
    for (const [event, spec] of Object.entries(EVENT_TOASTS)) {
      for (const ref of glossaryRefs(spec!.msg)) expect(ref.entry, `${event}: [[${ref.key}]]`).toBeDefined();
    }
  });
});
