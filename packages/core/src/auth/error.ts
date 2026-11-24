export class AuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = "AuthError"
  }
}

/**
 * The code of the one sign-in failure that says nothing about the sign-in: the sign-in service could not be
 * reached (no name lookup, no connection, a connection that broke before the answer was whole). The saved sign-in
 * is as it was, and the same request can be made again.
 */
export const AUTH_UNREACHABLE = "network_error"
