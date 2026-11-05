import type { Request, Response } from 'express';
import { optionalStoreId, requireUserId } from '../lib/requestContext.js';
import {
  cancelLinkScan,
  exportLinkScanCsv,
  getLatestLinkScan,
  getLinkScan,
  listLinkScanUrls,
  listLinkSources,
  startLinkScan,
} from '../services/link-scan.service.js';

/** UTF-8 byte-order mark, so Excel reads the CSV as UTF-8 (see report.controller.ts). */
const UTF8_BOM = String.fromCharCode(0xfeff);

export async function postLinkScan(req: Request, res: Response) {
  res.status(202).json({ data: await startLinkScan(requireUserId(req), optionalStoreId(req)) });
}

export async function getLatest(req: Request, res: Response) {
  res.json({ data: await getLatestLinkScan(requireUserId(req), optionalStoreId(req)) });
}

export async function getScan(req: Request, res: Response) {
  res.json({ data: await getLinkScan(requireUserId(req), Number(req.params.id), optionalStoreId(req)) });
}

export async function getLinks(req: Request, res: Response) {
  res.json({ data: await listLinkScanUrls(requireUserId(req), Number(req.params.id), req.query as never, optionalStoreId(req)) });
}

export async function getSources(req: Request, res: Response) {
  res.json({ data: await listLinkSources(requireUserId(req), Number(req.params.id), Number(req.params.urlId), optionalStoreId(req)) });
}

export async function postCancel(req: Request, res: Response) {
  res.json({ data: await cancelLinkScan(requireUserId(req), Number(req.params.id), optionalStoreId(req)) });
}

export async function getExport(req: Request, res: Response) {
  const { csv, filename } = await exportLinkScanCsv(requireUserId(req), Number(req.params.id), optionalStoreId(req));
  res
    .type('text/csv; charset=utf-8')
    .setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    .setHeader('Access-Control-Expose-Headers', 'Content-Disposition')
    .send(`${UTF8_BOM}${csv}`);
}
