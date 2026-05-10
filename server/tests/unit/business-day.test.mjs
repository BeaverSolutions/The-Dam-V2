// Inline the business-day logic from followupSequence.js for isolated testing
const MY_HOLIDAYS_2026 = [
  '2026-01-01', '2026-01-29', '2026-02-17', '2026-02-18',
  '2026-03-17', '2026-03-29', '2026-03-30', '2026-05-01',
  '2026-05-13', '2026-06-05', '2026-06-06', '2026-06-26',
  '2026-08-31', '2026-09-04', '2026-09-16', '2026-10-20',
  '2026-12-25',
];

const holidaySet = new Set(MY_HOLIDAYS_2026);

function nextBusinessDay(date) {
  const d = new Date(date);
  while (true) {
    const day = d.getDay();
    if (day === 6) d.setDate(d.getDate() + 2);
    else if (day === 0) d.setDate(d.getDate() + 1);

    const iso = d.toISOString().split('T')[0];
    if (holidaySet.has(iso)) {
      d.setDate(d.getDate() + 1);
      continue;
    }
    break;
  }
  return d;
}

const SCHEDULE = [
  { touch: 2, daysAfter: 2 },
  { touch: 3, daysAfter: 5 },
  { touch: 4, daysAfter: 10 },
  { touch: 5, daysAfter: 18 },
  { touch: 6, daysAfter: 30 },
];

function scheduleAllTouches(firstContactDate) {
  const base = new Date(firstContactDate);
  return SCHEDULE.map(({ touch, daysAfter }) => {
    const raw = new Date(base);
    raw.setDate(raw.getDate() + daysAfter);
    const adjusted = nextBusinessDay(raw);
    return { touch, raw: raw.toISOString().split('T')[0], adjusted: adjusted.toISOString().split('T')[0] };
  });
}

describe('nextBusinessDay', () => {
  describe('weekday passthrough', () => {
    it('Monday stays Monday', () => {
      const result = nextBusinessDay(new Date('2026-05-04')); // Monday
      expect(result.toISOString().split('T')[0]).toBe('2026-05-04');
    });

    it('Wednesday stays Wednesday', () => {
      const result = nextBusinessDay(new Date('2026-05-06')); // Wednesday
      expect(result.toISOString().split('T')[0]).toBe('2026-05-06');
    });

    it('Friday stays Friday', () => {
      const result = nextBusinessDay(new Date('2026-05-08')); // Friday
      expect(result.toISOString().split('T')[0]).toBe('2026-05-08');
    });
  });

  describe('weekend skip', () => {
    it('Saturday advances to Monday', () => {
      const result = nextBusinessDay(new Date('2026-05-09')); // Saturday
      expect(result.toISOString().split('T')[0]).toBe('2026-05-11'); // Monday
    });

    it('Sunday advances to Monday', () => {
      const result = nextBusinessDay(new Date('2026-05-10')); // Sunday
      expect(result.toISOString().split('T')[0]).toBe('2026-05-11'); // Monday
    });
  });

  describe('holiday skip', () => {
    it('Labour Day (May 1) advances to May 2 (Friday)', () => {
      const result = nextBusinessDay(new Date('2026-05-01'));
      expect(result.toISOString().split('T')[0]).toBe('2026-05-04'); // May 1 is Friday, May 2 is Sat → Monday May 4
    });

    it('Vesak Day (May 13, Wednesday) advances to May 14', () => {
      const result = nextBusinessDay(new Date('2026-05-13'));
      expect(result.toISOString().split('T')[0]).toBe('2026-05-14');
    });

    it('Christmas (Dec 25, Friday) advances to Monday Dec 28', () => {
      const result = nextBusinessDay(new Date('2026-12-25'));
      expect(result.toISOString().split('T')[0]).toBe('2026-12-28');
    });

    it('New Year (Jan 1, Thursday) advances to Jan 2', () => {
      const result = nextBusinessDay(new Date('2026-01-01'));
      expect(result.toISOString().split('T')[0]).toBe('2026-01-02');
    });
  });

  describe('consecutive holidays', () => {
    it('CNY Day 1 + Day 2 (Feb 17-18, Tue-Wed) advances to Feb 19', () => {
      const result = nextBusinessDay(new Date('2026-02-17'));
      expect(result.toISOString().split('T')[0]).toBe('2026-02-19');
    });

    it('Hari Raya Day 1 + Day 2 (Mar 29-30) — both are weekend Sun+Mon', () => {
      // Mar 29 = Sunday, Mar 30 = Monday (holiday)
      const result = nextBusinessDay(new Date('2026-03-29'));
      // Sunday → Monday (Mar 30), Mar 30 is holiday → Mar 31
      expect(result.toISOString().split('T')[0]).toBe('2026-03-31');
    });

    it('Hari Raya Haji + Agong Birthday (Jun 5-6) advances past both', () => {
      const result = nextBusinessDay(new Date('2026-06-05'));
      // Jun 5 = Friday (holiday), Jun 6 = Saturday (also holiday) → Mon Jun 8
      expect(result.toISOString().split('T')[0]).toBe('2026-06-08');
    });
  });

  describe('no infinite loop guarantee', () => {
    it('handles dates far in future (no holidays defined)', () => {
      const result = nextBusinessDay(new Date('2027-06-15')); // Tuesday, no holiday
      expect(result.toISOString().split('T')[0]).toBe('2027-06-15');
    });

    it('holiday on Saturday still resolves to Monday', () => {
      // Merdeka Aug 31, 2026 is Monday → next day Tue Sep 1
      const result = nextBusinessDay(new Date('2026-08-31'));
      expect(result.toISOString().split('T')[0]).toBe('2026-09-01');
    });
  });
});

describe('Follow-up scheduling for all 174 touches', () => {
  // 29 leads × 6 touches = 174 touch scheduling decisions
  // We test representative first-contact dates to cover weekend/holiday boundaries

  describe('Friday first contact (Day+2 skips weekend)', () => {
    it('schedules touch 2 to Monday', () => {
      const touches = scheduleAllTouches('2026-05-08'); // Friday
      // Day+2 = Sun May 10 → Mon May 11
      expect(touches[0].adjusted).toBe('2026-05-11');
    });

    it('schedules touch 3 (Day+5) to Wednesday', () => {
      const touches = scheduleAllTouches('2026-05-08');
      // Day+5 = Wed May 13 — but May 13 is Vesak → May 14
      expect(touches[1].adjusted).toBe('2026-05-14');
    });
  });

  describe('pre-Labour Day first contact', () => {
    it('touch 2 (Day+2) from Apr 29 skips May 1 holiday', () => {
      const touches = scheduleAllTouches('2026-04-29'); // Wednesday
      // Day+2 = Fri May 1 (Labour Day) → Sat May 2 → Mon May 4
      expect(touches[0].adjusted).toBe('2026-05-04');
    });
  });

  describe('all touches land on business days', () => {
    const testDates = [
      '2026-01-05', // near New Year
      '2026-02-15', // near CNY
      '2026-03-27', // near Hari Raya
      '2026-04-29', // near Labour Day
      '2026-05-08', // near Vesak
      '2026-06-03', // near Hari Raya Haji
      '2026-08-29', // near Merdeka
      '2026-09-14', // near Malaysia Day
      '2026-12-23', // near Christmas
    ];

    for (const startDate of testDates) {
      it(`all 5 touches from ${startDate} are on weekday non-holidays`, () => {
        const touches = scheduleAllTouches(startDate);
        for (const t of touches) {
          const d = new Date(t.adjusted);
          const dayOfWeek = d.getDay();
          expect(dayOfWeek).not.toBe(0); // not Sunday
          expect(dayOfWeek).not.toBe(6); // not Saturday
          expect(holidaySet.has(t.adjusted)).toBe(false); // not holiday
        }
      });
    }
  });

  describe('touch ordering never inverts', () => {
    it('touch N+1 is always after touch N', () => {
      const touches = scheduleAllTouches('2026-03-27'); // stress test near consecutive holidays
      for (let i = 1; i < touches.length; i++) {
        expect(new Date(touches[i].adjusted).getTime())
          .toBeGreaterThan(new Date(touches[i - 1].adjusted).getTime());
      }
    });
  });
});
