// ─── The page the Shopify admin opens (npm test) ─────────────────────
// frontend/index.html is what loads inside the admin's iframe. Three things in it fail silently — no
// error anywhere, just a blank or half-styled app inside Shopify — so they are pinned here:
//   • App Bridge must be the FIRST script, loaded plainly (it refuses to run otherwise);
//   • Polaris web components 2.x must be loaded exactly once, right after it;
//   • the embedded page must be released from the standalone shell's fixed height, or everything
//     below the first screen cannot be scrolled to.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const frontend = path.resolve(import.meta.dirname, '../../../frontend');
const readFrontend = (file: string) => fs.readFileSync(path.join(frontend, file), 'utf8').replace(/\r\n/g, '\n');

// Comments may mention the scripts (they do, at length); only real tags count.
const html = readFrontend('index.html').replace(/<!--[\s\S]*?-->/g, '');
const scripts = [...html.matchAll(/<script\b([^>]*)>/g)].map((match) => match[1]!.trim());

describe('index.html', () => {
  it('loads App Bridge first, from Shopify, with no async, defer or module', () => {
    assert.match(scripts[0] ?? '', /src="https:\/\/cdn\.shopify\.com\/shopifycloud\/app-bridge\.js"/);
    assert.doesNotMatch(scripts[0]!, /\b(async|defer)\b|type=/);
  });

  it('hands App Bridge the app’s client id through the shopify-api-key meta tag', () => {
    assert.match(html, /<meta name="shopify-api-key" content="%VITE_SHOPIFY_API_KEY%"\s*\/?>/);
  });

  it('loads Polaris web components 2.x once, straight after App Bridge', () => {
    const polaris = scripts.filter((attributes) => /polaris/i.test(attributes));
    assert.equal(polaris.length, 1, 'a second Polaris script breaks the components');
    assert.equal(scripts[1], polaris[0], 'Polaris comes second, after App Bridge');
    // polaris-2.js follows the newest stable 2.x; polaris-2.0.js pins 2.0. Never the 1.x or unversioned
    // entry points, which do not carry the Admin Next theme.
    assert.match(polaris[0]!, /src="https:\/\/cdn\.shopify\.com\/shopifycloud\/polaris-2(\.\d+)?\.js"/);
  });

  it('keeps the Polaris types on the same major version as the script', () => {
    const { devDependencies } = JSON.parse(readFrontend('package.json')) as { devDependencies: Record<string, string> };
    assert.match(devDependencies['@shopify/polaris-types'] ?? '', /^[~^]?2\./);
  });

  it('defaults to the light theme, in the page and in the app alike', () => {
    // The inline script paints the theme before React runs, and ThemeContext keeps it afterwards. They
    // are two copies of one decision, so they must agree or the page flashes from one theme to the other.
    assert.match(html, /var theme = 'light';/);
    assert.match(readFrontend('src/context/ThemeContext.tsx'), /DEFAULT_PREFERENCE: ThemePreference = 'light'/);
  });

  it('marks the page as embedded before the first paint', () => {
    assert.match(html, /setAttribute\('data-embedded'/);
  });
});

describe('index.css', () => {
  const css = readFrontend('src/index.css');

  it('lets an embedded page scroll: html, body and #root are not pinned to the window height', () => {
    const rule = css.match(/html\[data-embedded\],\s*html\[data-embedded\] body,\s*html\[data-embedded\] #root\s*\{([^}]*)\}/);
    assert.ok(rule, 'the embedded override is missing');
    assert.match(rule![1]!, /overflow:\s*visible/);
    assert.match(rule![1]!, /height:\s*auto/);
  });

  it('leaves the page background to the admin when embedded', () => {
    assert.match(css, /html\[data-embedded\] body\s*\{[^}]*background:\s*transparent/);
  });

  it('stops the guided setup swallowing the mouse wheel inside the admin', () => {
    // The wrapper is `overflow-y: auto` with `overscroll-behavior: contain`. In the admin the page scrolls
    // instead, and a scroller with nothing to scroll still takes the wheel and will not pass it on, so a
    // step taller than the window could not be scrolled at all. The override has to outrank Tailwind's own
    // utilities (a later layer), hence !important.
    const rule = css.match(/html\[data-embedded\] \.onboarding-frame\s*\{([^}]*)\}/);
    assert.ok(rule, 'the override for .onboarding-frame is missing');
    assert.match(rule![1]!, /overflow:\s*visible\s*!important/);
    assert.match(rule![1]!, /overscroll-behavior:\s*auto\s*!important/);
    assert.match(readFrontend('src/pages/onboarding/Onboarding.tsx'), /className="onboarding-frame /, 'the wrapper no longer carries the class the override targets');
  });
});

describe('the page frame', () => {
  // Every routed page hands its title and its buttons to the Shopify admin's title bar through
  // components/polaris/AppPage.tsx (a Polaris <s-page>). A page that draws an <h1> of its own would show
  // its title twice — once in the title bar, once in the page — so none may.
  const pages = [
    'src/pages/Dashboard.tsx',
    'src/pages/Integrations.tsx',
    'src/pages/NotFound.tsx',
    'src/pages/CatalogList.tsx',
    'src/pages/CatalogDetail.tsx',
    'src/pages/NonSeoSubPillarPage.tsx',
    'src/pages/seo/SeoSubPillarPage.tsx',
    'src/components/pillars/PillarDashboard.tsx',
  ];

  for (const file of pages) {
    it(`${file} sits in the page frame and draws no <h1> of its own`, () => {
      const source = readFrontend(file);
      assert.match(source, /import AppPage from '[./]+\/(components\/)?polaris\/AppPage'/, 'does not import AppPage');
      assert.match(source, /<AppPage\b/, 'does not render AppPage');
      assert.doesNotMatch(source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''), /<h1\b/, 'draws its own <h1>');
    });
  }

  it('the states shared by the pillar dashboards draw no <h1> either', () => {
    assert.doesNotMatch(readFrontend('src/components/pillars/PillarDashboardState.tsx'), /<h1\b/);
  });

  it('AppPage gives Polaris what its slots accept: one primary action, secondary buttons, a back link', () => {
    const source = readFrontend('src/components/polaris/AppPage.tsx');
    assert.match(source, /slot="primary-action"[\s\S]*?variant="primary"/);
    assert.match(source, /slot="secondary-actions"/);
    assert.match(source, /slot="breadcrumb-actions"/);
    assert.equal(source.match(/slot="primary-action"/g)?.length, 1, 'only one primary action is accepted');
  });
});

describe('the bare site’s store form', () => {
  // /login outside the admin: the visitor types their store and Shopify authenticates them. The page must
  // reach Shopify only through the server's answer, and only after checking that answer is a Shopify address.
  const page = readFrontend('src/pages/auth/OpenFromShopify.tsx');
  const repository = readFrontend('src/data/shopify.repository.ts');

  it('asks for the store with a Polaris field and goes on through the server', () => {
    assert.match(page, /<TextField\b/);
    assert.match(page, /openStoreOnShopify\(/);
  });

  it('no longer sends the visitor to the generic Shopify admin to find the app themselves', () => {
    const code = page.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(code, /admin\.shopify\.com/);
    assert.doesNotMatch(code, /Go to your Shopify admin/);
  });

  it('only navigates to an address on Shopify', () => {
    const open = repository.match(/export async function openStoreOnShopify[\s\S]*?\n\}/)?.[0] ?? '';
    assert.match(open, /api\.post<[^>]*>\('\/shopify\/open'/);
    assert.ok(open.indexOf('isShopifyAddress(url)') !== -1, 'the answer is not checked');
    assert.ok(open.indexOf('isShopifyAddress(url)') < open.indexOf('openOutsideAdmin(url)'), 'the check must come before the navigation');
  });
});

describe('Polaris controls', () => {
  // Every button the merchant sees is the shared Button (a Polaris <s-button>). The only `.btn-*` classes
  // left are the ones index.css defines for the standalone development chrome, which merchants never see.
  const dev = [/components\/Header\.tsx$/, /components\/Sidebar\.tsx$/, /components\/HeaderSearch\.tsx$/, /layouts\//];

  const sources = (dir: string): string[] =>
    fs.readdirSync(path.join(frontend, dir), { withFileTypes: true }).flatMap((entry) => {
      const relative = `${dir}/${entry.name}`;
      if (entry.isDirectory()) return sources(relative);
      return /\.tsx$/.test(entry.name) ? [relative] : [];
    });
  const merchantFiles = sources('src').filter((file) => !dev.some((pattern) => pattern.test(file)));

  it('no merchant-facing screen styles a button with a .btn-* class', () => {
    const offenders = merchantFiles.filter((file) => /className=[^\n]*\bbtn-(primary|secondary|ghost|destructive|outline)\b/.test(readFrontend(file)));
    assert.deepEqual(offenders, []);
  });

  it('the shared Button, Badge and Banner draw Polaris elements', () => {
    assert.match(readFrontend('src/components/polaris/Button.tsx'), /<s-button\b/);
    assert.match(readFrontend('src/components/polaris/Badge.tsx'), /<s-badge\b/);
    assert.match(readFrontend('src/components/polaris/Banner.tsx'), /<s-banner\b/);
  });

  it('the settings forms are built from Polaris fields, not native inputs', () => {
    const primitives = readFrontend('src/components/settings/SettingsPrimitives.tsx');
    assert.doesNotMatch(primitives, /<(input|select|textarea)\b/);
    const fields = readFrontend('src/components/polaris/fields.tsx');
    for (const element of ['s-text-field', 's-select', 's-switch', 's-text-area', 's-search-field']) {
      assert.match(fields, new RegExp(`<${element}\\b`), `${element} is missing`);
    }
  });

  it('listens for a Polaris field’s events once, by hand, rather than through React’s onChange', () => {
    // React 19 can run an onChange handler on a custom element twice for one change (tested), so the fields
    // attach their own listeners. An `onChange=` on a Polaris tag would bring the double run back.
    assert.doesNotMatch(readFrontend('src/components/polaris/fields.tsx'), /<s-[a-z-]+[^>]*\sonChange=/);
  });
});
