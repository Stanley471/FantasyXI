/** Compile trusted server policy, never roles or grants supplied by a request. */
export function compilePolicy<P extends string>(permissions: readonly P[], grants: Readonly<Record<string, Iterable<P>>>) {
  const bits = new Map<P, bigint>();
  permissions.forEach((permission, index) => {
    if (bits.has(permission)) throw new Error("Duplicate permission");
    bits.set(permission, 1n << BigInt(index));
  });
  const masks = new Map<string, bigint>();
  for (const [role, values] of Object.entries(grants)) {
    let mask = 0n;
    for (const value of values) {
      const bit = bits.get(value);
      if (bit === undefined) throw new Error("Unknown permission in policy");
      mask |= bit;
    }
    masks.set(role, mask);
  }
  return Object.freeze({
    allows(role: string, required: readonly P[]): boolean {
      const granted = masks.get(role);
      if (granted === undefined || required.length === 0) return false;
      let needed = 0n;
      for (const permission of required) {
        const bit = bits.get(permission);
        if (bit === undefined) return false;
        needed |= bit;
      }
      return (granted & needed) === needed;
    },
  });
}
