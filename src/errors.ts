/** Base error for this library. Catch GenericError to handle every library-validator failure. */
export class GenericError extends Error {
  /**
   * Creates a library error with the given message. The `name` property is the subclass constructor name.
   * @param message - Error message as `string`.
   * @returns The new error as `GenericError`.
   */
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Thrown when a Stingray, DSAR, or DSAA buffer is truncated or has the wrong magic. */
export class InvalidFormatError extends GenericError {}

/** Thrown when game data is opened but contains no unit files to compare against. */
export class GameDataError extends GenericError {}
