export function divide(a: number, b: number): number {
  // Bug: no guard against division by zero.
  return a / b;
}

export function isEmpty(value: unknown) {
  if (value == null) {
    return true;
  }
  return (value as { length: number }).length == 0;
}
