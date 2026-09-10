import { dailyIndexUrl, datesBetween, filingUrl, parseFormIndex } from './sec-edgar.source.js';

/** A verbatim slice of a real SEC daily form index. */
const INDEX = `Description:           Daily Index of EDGAR Dissemination Feed by Form Type
Last Data Received:    Sep 9, 2026
Comments:              webmaster@sec.gov
Anonymous FTP:         ftp://ftp.sec.gov/edgar/



Form Type   Company Name                                                  CIK         Date Filed  File Name
---------------------------------------------------------------------------------------------------------------------------------------------
1-K              Old Glory Holding Co                                          2016561     20260909    edgar/data/2016561/0001493152-26-041968.txt
D                908 Preferred Investors I, LLC                                2153967     20260909    edgar/data/2153967/0002153967-26-000001.txt
D                AIRES126 a Series of CGF2021 LLC                              2145041     20260909    edgar/data/2145041/0002145041-26-000001.txt
D/A              Acme Robotics, Inc.                                           1234567     20260909    edgar/data/1234567/0001234567-26-000009.txt
DEF 14A          TEN Holdings, Inc.                                            2030954     20260909    edgar/data/2030954/0001493152-26-042047.txt
`;

describe('parseFormIndex', () => {
  it('parses the fixed-width index, keeping spaces in company names', () => {
    const rows = parseFormIndex(INDEX);
    expect(rows).toHaveLength(5);
    expect(rows[1]).toEqual({
      formType: 'D',
      companyName: '908 Preferred Investors I, LLC',
      cik: '2153967',
      dateFiled: '20260909',
      fileName: 'edgar/data/2153967/0002153967-26-000001.txt',
    });
  });

  // The reason this reads the index rather than the getcurrent feed: EDGAR's
  // `type=` filter is a prefix match, so `D` also returns DEF 14A / DEFA14A.
  it('keeps D and D/A distinguishable from DEF 14A', () => {
    const types = parseFormIndex(INDEX).map((row) => row.formType);
    expect(types).toEqual(['1-K', 'D', 'D', 'D/A', 'DEF 14A']);
    expect(types.filter((t) => t === 'D' || t === 'D/A')).toHaveLength(3);
  });

  it('returns nothing for a body with no header', () => {
    expect(parseFormIndex('404 Not Found')).toEqual([]);
    expect(parseFormIndex('')).toEqual([]);
  });
});

describe('dailyIndexUrl', () => {
  it('maps a date onto the right quarter directory', () => {
    expect(dailyIndexUrl(new Date('2026-09-09T00:00:00Z'))).toBe(
      'https://www.sec.gov/Archives/edgar/daily-index/2026/QTR3/form.20260909.idx',
    );
    expect(dailyIndexUrl(new Date('2026-01-02T00:00:00Z'))).toContain('/2026/QTR1/form.20260102.idx');
    expect(dailyIndexUrl(new Date('2026-12-31T00:00:00Z'))).toContain('/2026/QTR4/form.20261231.idx');
  });
});

describe('filingUrl', () => {
  it('builds the human-readable filing index page', () => {
    expect(
      filingUrl({
        formType: 'D',
        companyName: 'x',
        cik: '2153967',
        dateFiled: '20260909',
        fileName: 'edgar/data/2153967/0002153967-26-000001.txt',
      }),
    ).toBe('https://www.sec.gov/Archives/edgar/data/2153967/0002153967-26-000001-index.htm');
  });

  it('falls back to the raw archive path for an unexpected filename', () => {
    expect(
      filingUrl({
        formType: 'D',
        companyName: 'x',
        cik: '1',
        dateFiled: '20260909',
        fileName: 'edgar/data/weird/path',
      }),
    ).toBe('https://www.sec.gov/Archives/edgar/data/weird/path');
  });
});

describe('datesBetween', () => {
  it('is inclusive of both ends', () => {
    const days = datesBetween(new Date('2026-09-07T13:00:00Z'), new Date('2026-09-09T01:00:00Z'), 10);
    expect(days.map((d) => d.toISOString().slice(0, 10))).toEqual([
      '2026-09-07',
      '2026-09-08',
      '2026-09-09',
    ]);
  });

  it('caps the number of days so a stale watermark cannot blow up a run', () => {
    const days = datesBetween(new Date('2026-01-01T00:00:00Z'), new Date('2026-09-09T00:00:00Z'), 10);
    expect(days).toHaveLength(10);
  });

  it('returns a single day when since and until are the same day', () => {
    expect(datesBetween(new Date('2026-09-09T23:00:00Z'), new Date('2026-09-09T23:30:00Z'), 10)).toHaveLength(1);
  });
});
