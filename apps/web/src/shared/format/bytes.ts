import { formatMegabytes } from '@app/shared';

const KIB = 1024;
const MIB = KIB * 1024;
const whole = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });

/**
 * File sizes for people (the chosen file, the upload limit): `830 bytes`, `412 KB`, `5 MB`, `4.2 MB`. Megabytes use
 * the contract's formatter, so the UI and the API's "The image must be 5 MB or smaller." always agree.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) throw new RangeError(`Not a size: ${String(bytes)}`);
  if (bytes < KIB) return bytes === 1 ? '1 byte' : `${whole.format(bytes)} bytes`;
  const kilobytes = Math.max(1, Math.round(bytes / KIB));
  // Sizes that round to 1,024 KB read better as "1 MB".
  return kilobytes < KIB ? `${whole.format(kilobytes)} KB` : formatMegabytes(Math.max(bytes, MIB));
}
