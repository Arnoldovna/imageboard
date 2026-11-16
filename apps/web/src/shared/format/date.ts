/**
 * Dates as the maw design shows them (F-14, B-60): `15 Nov 2026` and `15 Nov 2026, 14:03`, in the viewer's time zone,
 * always inside `<time datetime="<ISO>">`.
 *
 * The parts come from `Intl.DateTimeFormat('en-GB')` (time zone, 24-hour clock); the month abbreviation comes from a
 * fixed table, because current ICU data writes September as "Sept" in en-GB and engines differ.
 */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

export interface DateFormatOptions {
  /** IANA zone; defaults to the viewer's zone. Tests pass one for stable output. */
  timeZone?: string;
}

interface DateParts {
  day: string;
  month: string;
  year: string;
  hour: string;
  minute: string;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string | undefined): Intl.DateTimeFormat {
  const key = timeZone ?? '';
  let formatter = formatters.get(key);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-GB', {
      day: 'numeric',
      month: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      ...(timeZone === undefined ? {} : { timeZone }),
    });
    formatters.set(key, formatter);
  }
  return formatter;
}

function partsOf(iso: string, options: DateFormatOptions): DateParts {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) throw new RangeError(`Not a date: ${iso}`);
  const parts: DateParts = { day: '', month: '', year: '', hour: '', minute: '' };
  for (const part of formatterFor(options.timeZone).formatToParts(date)) {
    const { type, value } = part;
    if (type === 'day' || type === 'month' || type === 'year' || type === 'hour' || type === 'minute') {
      parts[type] = value;
    }
  }
  return parts;
}

function monthName(month: string): string {
  const name = MONTHS[Number(month) - 1];
  if (name === undefined) throw new RangeError(`Unexpected month: ${month}`);
  return name;
}

/** `15 Nov 2026` */
export function formatDate(iso: string, options: DateFormatOptions = {}): string {
  const { day, month, year } = partsOf(iso, options);
  return `${dayNumber(day)} ${monthName(month)} ${year}`;
}

/** en-GB pads the day to two digits when the month is numeric ("01/03/2026"); maw writes "1 Mar 2026". */
function dayNumber(day: string): string {
  return String(Number(day));
}

/** `15 Nov 2026, 14:03` */
export function formatDateTime(iso: string, options: DateFormatOptions = {}): string {
  const { day, month, year, hour, minute } = partsOf(iso, options);
  return `${dayNumber(day)} ${monthName(month)} ${year}, ${hour}:${minute}`;
}
