import { Router } from 'express';
import { postClientError } from '../controllers/client-error.controller.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { authenticate } from '../middleware/authenticate.js';
import { validateRequest } from '../middleware/validateRequest.js';
import { clientErrorSchema } from '../schemas/client-error.schema.js';

export const clientErrorsRouter = Router();

// Signed-in only: a report names a user, and an open endpoint that writes to the log is one that
// anyone can fill.
clientErrorsRouter.post('/', authenticate, validateRequest({ body: clientErrorSchema }), asyncHandler(postClientError));
