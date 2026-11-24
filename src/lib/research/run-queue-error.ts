/** The research run queue's error, with an HTTP status and code for the API error handler. Dependency-free. */
export class ResearchRunQueueError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 500,
    public readonly code = "RESEARCH_RUN_QUEUE_ERROR"
  ) {
    super(message);
    this.name = "ResearchRunQueueError";
  }
}
