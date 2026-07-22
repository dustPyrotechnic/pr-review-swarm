export function divide(a: number, b: number): number {
  // Bug: no guard against division by zero, and loose equality used elsewhere.
  return a / b;
}

export function isEmpty(value: any) {
  if (value == null) {
    return true;
  }
  return value.length == 0;
}
