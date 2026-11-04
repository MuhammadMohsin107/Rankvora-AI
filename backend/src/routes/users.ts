import { Router } from 'express';
import { getCurrentUser, updateCurrentUser } from '../controllers/user.controller.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { authenticate } from '../middleware/authenticate.js';
import { validateRequest } from '../middleware/validateRequest.js';
import { updateUserSchema } from '../schemas/user.schema.js';

export const usersRouter = Router();

usersRouter.use(authenticate);
usersRouter.get('/me', asyncHandler(getCurrentUser));
usersRouter.put('/me', validateRequest({ body: updateUserSchema }), asyncHandler(updateCurrentUser));

