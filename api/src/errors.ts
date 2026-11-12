export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

export const badRequest = (message: string): HttpError => new HttpError(400, 'bad_request', message);
export const unauthorized = (message = 'authentication required'): HttpError =>
  new HttpError(401, 'unauthorized', message);
export const forbidden = (code: string, message: string): HttpError =>
  new HttpError(403, code, message);
export const notFound = (what = 'resource'): HttpError =>
  new HttpError(404, 'not_found', `${what} not found`);
export const conflict = (code: string, message: string): HttpError =>
  new HttpError(409, code, message);
