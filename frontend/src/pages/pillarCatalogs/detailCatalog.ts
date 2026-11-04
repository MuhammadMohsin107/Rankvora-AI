import { contentTables } from './contentTables';
import { speedTables } from './speedTables';
import { croTables } from './croTables';
import { aiTables } from './aiTables';

export const detailCatalog = {
  ...contentTables,
  ...speedTables,
  ...croTables,
  ...aiTables,
};
