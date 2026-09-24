'use strict';

/** An error that maps directly onto an HTTP response. */
class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const badRequest = (msg, details) => new HttpError(400, msg, details);
const unauthorized = (msg = 'Authentication required') => new HttpError(401, msg);
const forbidden = (msg = 'You do not have permission to do that') => new HttpError(403, msg);
const notFound = (msg = 'Not found') => new HttpError(404, msg);
const conflict = (msg, details) => new HttpError(409, msg, details);

module.exports = { HttpError, badRequest, unauthorized, forbidden, notFound, conflict };
