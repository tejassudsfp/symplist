/** A fresh snapshot read denied authority; unlike an outage, this must detach the subscriber. */
export class TopicAccessDeniedError extends Error {
  readonly code = "not_found";
  constructor() {
    super("not_found");
    this.name = "TopicAccessDeniedError";
  }
}
