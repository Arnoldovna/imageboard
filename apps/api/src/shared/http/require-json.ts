import { requestMessages } from '@app/shared';
import type { RequestHandler } from 'express';

import { UnsupportedContentTypeError } from '../errors/app-error.js';

/**
 * JSON endpoints answer `415 unsupported-content-type` unless the request says `application/json` (F-49). Without
 * this gate a form post or `text/plain` body would skip `express.json()` and surface as a confusing 400.
 */
export const requireJson: RequestHandler = (req, _res, next) => {
  // `req.is` answers null without a body and false for another type; both are rejected.
  if (!req.is('application/json')) {
    next(new UnsupportedContentTypeError(requestMessages.jsonRequired));
    return;
  }
  next();
};
