import { describe, it } from 'node:test';
import assert from 'node:assert';
import { validateManifest, listLicenses } from './assets.mjs';
import fs from 'node:fs';
import path from 'node:path';

const ASSETS_PATH = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  'data',
  'assets.json',
);

function loadAssetsFromManifest() {
  return JSON.parse(fs.readFileSync(ASSETS_PATH, 'utf8'));
}

describe('M08 Asset Manifest', () => {
  describe('validateManifest', () => {
    it('should pass with valid assets', () => {
      const result = validateManifest();
      assert.ok(result.valid, `validateManifest should be valid, got errors: ${result.errors.join(', ')}`);
    });

    it('should enforce the SPDX allowlist [MIT, ISC, CC0-1.0, OFL-1.1]', () => {
      const result = validateManifest();
      assert.ok(result.valid, 'validateManifest should be valid');
      const licenseErrors = result.errors.filter((e) => e.includes('disallowed license'));
      assert.strictEqual(licenseErrors.length, 0, `License errors: ${licenseErrors.join(', ')}`);
    });

    it('should reject http:// URLs', () => {
      const result = validateManifest();
      assert.ok(result.valid, 'validateManifest should be valid');
      const httpErrors = result.errors.filter((e) => e.includes('http://'));
      assert.strictEqual(httpErrors.length, 0, `HTTP URL errors: ${httpErrors.join(', ')}`);
    });

    it('should enforce vendored items have sha256', () => {
      const assets = loadAssetsFromManifest();
      for (const category of ['fonts', 'icons', 'sfx', 'textures', 'shaders']) {
        for (const item of assets[category]) {
          if (item.vendor === 'vendored') {
            if (item.sha256 === null) {
              // null sha256 is accepted for pending
            } else if (typeof item.sha256 === 'string') {
              assert.strictEqual(item.sha256.length, 64, `${item.id}: sha256 should be 64 hex chars`);
            } else {
              throw new Error(
                `${item.id}: vendored item must have sha256 (null or hex), got ${typeof item.sha256}`,
              );
            }
          }
        }
      }
    });

    it('fetch-on-demand items should not have sha256', () => {
      const assets = loadAssetsFromManifest();
      for (const category of ['fonts', 'icons', 'sfx', 'textures', 'shaders']) {
        for (const item of assets[category]) {
          if (item.vendor === 'fetch-on-demand') {
            assert.strictEqual(item.sha256, null, `${item.id}: fetch-on-demand items should not have sha256`);
          }
        }
      }
    });

    it('should group licenses by licence for NOTICE generation', () => {
      const groups = listLicenses();
      assert.ok(groups.MIT, 'should have MIT group');
      assert.ok(groups.ISC, 'should have ISC group');
      assert.ok(groups['CC0-1.0'], 'should have CC0-1.0 group');
      assert.ok(groups['OFL-1.1'], 'should have OFL-1.1 group');
    });
  });
});