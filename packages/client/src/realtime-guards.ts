export const isId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

export const isText = (value: unknown): value is string => typeof value === "string";

export const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export const isSeqNum = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

export const isIds = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(isId);

export const isTime = (value: unknown): value is string =>
  typeof value === "string" && !Number.isNaN(Date.parse(value));

export const oneOf =
  <const T extends string>(values: readonly T[]) =>
  (value: unknown): value is T =>
    typeof value === "string" && (values as readonly string[]).includes(value);

export const keyOf =
  <K extends string>(table: Record<K, unknown>) =>
  (value: unknown): value is K =>
    typeof value === "string" && Object.hasOwn(table, value);
