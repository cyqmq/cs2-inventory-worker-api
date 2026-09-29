/*---------------------------------------------------------------------------------------------
 *  CS2 Inventory Simulator — misc helpers (server safe, no DOM dependencies)
 *--------------------------------------------------------------------------------------------*/

export function random<T>(array: T[]): T {
  return array[Math.floor(Math.random() * array.length)];
}

export function safeParseJson(json: string) {
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

export function has(str?: string) {
  return (str?.length ?? 0) > 0;
}

export function noop() {}

export function trim(value: string) {
  value = value.trim();
  return value.length > 0 ? value : undefined;
}

export function nonEmptyString(value: string | undefined) {
  return value !== undefined ? (value.length > 0 ? value : undefined) : undefined;
}

export function hasKeys(obj: object) {
  return Object.keys(obj).length > 0;
}

export function toArrayIf<T>(value: T, condition: (value: T) => boolean) {
  return condition(value) ? [value] : [];
}

export function tryOrDefault<T, R = undefined>(
  getValue: () => T,
  defaultValue?: R
) {
  try {
    return getValue();
  } catch {
    return defaultValue;
  }
}