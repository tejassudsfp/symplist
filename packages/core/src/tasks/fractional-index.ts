/**
 * Fractional index keys for list order (§3.4): strings that sort in byte order (SQLite's BINARY
 * collation and JavaScript `<` agree on ASCII), so a task moves between two neighbours by writing one
 * key strictly between theirs and nothing else changes. The format follows the widely used
 * base-62 scheme: an integer part whose head letter encodes its length (`a0` is the first key, `a1`
 * follows it, `Zz` precedes it) and an optional fractional part without trailing zeros.
 */

const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const ZERO = "0";
const SMALLEST_INTEGER = `A${ZERO.repeat(26)}`;

/** A key or a pair of keys cannot produce a key between them. */
export class FractionalIndexError extends Error {
  readonly code = "tasks.position_invalid";
  constructor(message: string) {
    super(message);
    this.name = "FractionalIndexError";
  }
}

function digitAt(value: string, index: number): string {
  const digit = value[index];
  if (digit === undefined) throw new FractionalIndexError("Unexpected end of key");
  return digit;
}

function integerLength(head: string): number {
  if (head >= "a" && head <= "z") return head.charCodeAt(0) - "a".charCodeAt(0) + 2;
  if (head >= "A" && head <= "Z") return "Z".charCodeAt(0) - head.charCodeAt(0) + 2;
  throw new FractionalIndexError("Invalid key head");
}

function integerPart(key: string): string {
  const length = integerLength(digitAt(key, 0));
  if (length > key.length) throw new FractionalIndexError("Invalid key");
  return key.slice(0, length);
}

/** Whether a string is a well-formed key. */
export function isValidPositionKey(key: string): boolean {
  try {
    validateKey(key);
    return true;
  } catch {
    return false;
  }
}

function validateKey(key: string): void {
  if (typeof key !== "string" || key.length === 0) throw new FractionalIndexError("Empty key");
  if (key === SMALLEST_INTEGER) throw new FractionalIndexError("Invalid key");
  for (const character of key.slice(1)) {
    if (!DIGITS.includes(character)) throw new FractionalIndexError("Invalid key digit");
  }
  const integer = integerPart(key);
  const fraction = key.slice(integer.length);
  if (fraction.endsWith(ZERO)) throw new FractionalIndexError("Invalid key");
}

/** A digit string strictly between `a` and `b` (`b` null means no upper bound). */
function midpoint(a: string, b: string | null): string {
  if (b !== null && a >= b) throw new FractionalIndexError("Keys out of order");
  if (a.endsWith(ZERO) || b?.endsWith(ZERO)) {
    throw new FractionalIndexError("Trailing zero");
  }
  if (b !== null) {
    let common = 0;
    while ((a[common] ?? ZERO) === b[common]) common += 1;
    if (common > 0) return b.slice(0, common) + midpoint(a.slice(common), b.slice(common));
  }
  const digitA = a.length > 0 ? DIGITS.indexOf(digitAt(a, 0)) : 0;
  const digitB = b !== null ? DIGITS.indexOf(digitAt(b, 0)) : DIGITS.length;
  if (digitB - digitA > 1) return digitAt(DIGITS, Math.round(0.5 * (digitA + digitB)));
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return digitAt(DIGITS, digitA) + midpoint(a.slice(1), null);
}

function incrementInteger(value: string): string | null {
  const head = digitAt(value, 0);
  const digits = value.slice(1).split("");
  let carry = true;
  for (let index = digits.length - 1; carry && index >= 0; index -= 1) {
    const next = DIGITS.indexOf(digits[index] ?? ZERO) + 1;
    if (next === DIGITS.length) {
      digits[index] = ZERO;
    } else {
      digits[index] = digitAt(DIGITS, next);
      carry = false;
    }
  }
  if (!carry) return head + digits.join("");
  if (head === "Z") return `a${ZERO}`;
  if (head === "z") return null;
  const nextHead = String.fromCharCode(head.charCodeAt(0) + 1);
  if (nextHead > "a") digits.push(ZERO);
  else digits.pop();
  return nextHead + digits.join("");
}

function decrementInteger(value: string): string | null {
  const head = digitAt(value, 0);
  const digits = value.slice(1).split("");
  let borrow = true;
  const last = digitAt(DIGITS, DIGITS.length - 1);
  for (let index = digits.length - 1; borrow && index >= 0; index -= 1) {
    const previous = DIGITS.indexOf(digits[index] ?? ZERO) - 1;
    if (previous === -1) {
      digits[index] = last;
    } else {
      digits[index] = digitAt(DIGITS, previous);
      borrow = false;
    }
  }
  if (!borrow) return head + digits.join("");
  if (head === "a") return `Z${last}`;
  if (head === "A") return null;
  const previousHead = String.fromCharCode(head.charCodeAt(0) - 1);
  if (previousHead < "Z") digits.push(last);
  else digits.pop();
  return previousHead + digits.join("");
}

/**
 * A key strictly between `before` and `after`: `null` for `before` means "first", `null` for `after`
 * means "last". Throws when `before >= after` or a key is malformed.
 */
export function keyBetween(before: string | null, after: string | null): string {
  if (before !== null) validateKey(before);
  if (after !== null) validateKey(after);
  if (before !== null && after !== null && before >= after) {
    throw new FractionalIndexError("Keys out of order");
  }
  if (before === null) {
    if (after === null) return `a${ZERO}`;
    const integer = integerPart(after);
    const fraction = after.slice(integer.length);
    if (integer === SMALLEST_INTEGER) return integer + midpoint("", fraction);
    if (integer < after) return integer;
    const decremented = decrementInteger(integer);
    if (decremented === null) throw new FractionalIndexError("Cannot place before the first key");
    return decremented;
  }
  if (after === null) {
    const integer = integerPart(before);
    const fraction = before.slice(integer.length);
    const incremented = incrementInteger(integer);
    return incremented === null ? integer + midpoint(fraction, null) : incremented;
  }
  const integerBefore = integerPart(before);
  const fractionBefore = before.slice(integerBefore.length);
  const integerAfter = integerPart(after);
  const fractionAfter = after.slice(integerAfter.length);
  if (integerBefore === integerAfter) {
    return integerBefore + midpoint(fractionBefore, fractionAfter);
  }
  const incremented = incrementInteger(integerBefore);
  if (incremented === null) throw new FractionalIndexError("Cannot place after the last key");
  if (incremented < after) return incremented;
  return integerBefore + midpoint(fractionBefore, null);
}

/** `count` ascending keys strictly between `before` and `after`, spread evenly. */
export function keysBetween(before: string | null, after: string | null, count: number): string[] {
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new FractionalIndexError("Key count must be a non-negative integer");
  }
  if (count === 0) return [];
  if (count === 1) return [keyBetween(before, after)];
  if (after === null) {
    const keys: string[] = [];
    let previous = before;
    for (let index = 0; index < count; index += 1) {
      previous = keyBetween(previous, null);
      keys.push(previous);
    }
    return keys;
  }
  if (before === null) {
    const keys: string[] = [];
    let next = after;
    for (let index = 0; index < count; index += 1) {
      next = keyBetween(null, next);
      keys.push(next);
    }
    return keys.reverse();
  }
  const middleIndex = Math.floor(count / 2);
  const middle = keyBetween(before, after);
  return [
    ...keysBetween(before, middle, middleIndex),
    middle,
    ...keysBetween(middle, after, count - middleIndex - 1),
  ];
}
