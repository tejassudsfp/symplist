/** Thrown by interface stubs whose implementation lands in a later phase. */
export class NotImplementedError extends Error {
  constructor(operation: string) {
    super(`${operation} is not implemented yet`);
    this.name = "NotImplementedError";
  }
}
