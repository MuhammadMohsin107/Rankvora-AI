import type { Request, Response } from 'express';
import { optionalStoreId, requireUserId } from '../lib/requestContext.js';
import {
  getSchemaCatalog,
  getSchemaTemplate,
  listSchemaTemplates,
  previewSchemaTemplate,
  saveSchemaTemplate,
} from '../services/schema-template.service.js';
import type { SchemaContextKind } from '../schema-engine/types.js';

/** The type library and the Shopify field picker for one context. Store-independent — it
 * describes what Rankvora AI can generate, not what this merchant has configured. */
export function getCatalog(req: Request, res: Response) {
  const context = req.query.context as SchemaContextKind | undefined;
  res.json({ data: getSchemaCatalog(context) });
}

export async function getTemplates(req: Request, res: Response) {
  res.json({ data: await listSchemaTemplates(requireUserId(req), optionalStoreId(req)) });
}

export async function getTemplate(req: Request, res: Response) {
  const { type, context } = req.params as { type: string; context: SchemaContextKind };
  res.json({ data: await getSchemaTemplate(requireUserId(req), type, context, optionalStoreId(req)) });
}

export async function putTemplate(req: Request, res: Response) {
  const { type, context } = req.params as { type: string; context: SchemaContextKind };
  res.json({ data: await saveSchemaTemplate(requireUserId(req), type, context, req.body, optionalStoreId(req)) });
}

/**
 * Renders a template against one real record from the store.
 *
 * POST rather than GET because the editor sends the UNSAVED draft — previewing only what is
 * already stored would make the merchant save a configuration to find out what it does.
 */
export async function postPreview(req: Request, res: Response) {
  const { type, context } = req.params as { type: string; context: SchemaContextKind };
  const draft = req.body && Object.keys(req.body).length > 0 ? req.body : undefined;
  res.json({ data: await previewSchemaTemplate(requireUserId(req), type, context, draft, optionalStoreId(req)) });
}
