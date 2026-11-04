import type { Request, Response } from 'express';
import { getReportComparison, getReportCsv, getReportTrend } from '../services/report.service.js';
import { optionalStoreId, requireUserId } from '../lib/requestContext.js';

/**
 * UTF-8 byte-order mark. Excel decodes a CSV as the system codepage unless the file opens with
 * one, which turns a store name like "Café Noir" into "CafÃ© Noir" on the merchant's machine.
 * Built with fromCharCode so an editor that strips invisible characters cannot silently drop it.
 */
const UTF8_BOM = String.fromCharCode(0xfeff);

export async function getTrend(req: Request, res: Response) {
  res.json({ data: await getReportTrend(requireUserId(req), req.query as never, optionalStoreId(req)) });
}

export async function getComparison(req: Request, res: Response) {
  res.json({ data: await getReportComparison(requireUserId(req), optionalStoreId(req)) });
}

export async function exportReport(req: Request, res: Response) {
  const { csv, filename } = await getReportCsv(requireUserId(req), req.query as never);
  res
    .type('text/csv; charset=utf-8')
    // The server names its own file — store slug plus the audit's date — so two exports from
    // different reports never land in Downloads under the same name.
    .setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    // The browser can only read that filename back off a fetch() when the header is exposed;
    // without this the download falls back to the URL's last path segment ("export").
    .setHeader('Access-Control-Expose-Headers', 'Content-Disposition')
    .send(`${UTF8_BOM}${csv}`);
}
