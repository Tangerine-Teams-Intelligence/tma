/**
 * Validate manifest.json — Manifest V3 sanity checks.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));

describe('manifest.json', () => {
  it('declares Manifest V3', () => {
    expect(manifest.manifest_version).toBe(3);
  });

  it('uses semver-shaped version', () => {
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('has the right name and description', () => {
    expect(manifest.name).toMatch(/Tangerine/);
    expect(manifest.description).toBeTruthy();
  });

  it('lists exactly the four target sites in host_permissions', () => {
    expect(new Set(manifest.host_permissions)).toEqual(
      new Set([
        '*://chat.openai.com/*',
        '*://chatgpt.com/*',
        '*://claude.ai/*',
        '*://gemini.google.com/*',
      ])
    );
  });

  it('declares storage and activeTab permissions', () => {
    expect(manifest.permissions).toContain('storage');
    expect(manifest.permissions).toContain('activeTab');
  });

  it('points to a service worker (MV3 background)', () => {
    expect(manifest.background?.service_worker).toBeTruthy();
    expect(manifest.background.type).toBe('module');
  });

  it('has exactly three content scripts (one per site)', () => {
    expect(manifest.content_scripts).toHaveLength(3);
    for (const cs of manifest.content_scripts) {
      expect(cs.run_at).toBe('document_idle');
      expect(cs.matches.length).toBeGreaterThan(0);
      expect(cs.js.length).toBeGreaterThan(0);
    }
  });

  it('references icons that exist on disk', () => {
    for (const size of ['16', '32', '48', '128']) {
      const path = manifest.icons[size];
      expect(path, `manifest.icons.${size} should be set`).toBeTruthy();
      expect(existsSync(join(root, path)), `${path} should exist`).toBe(true);
    }
  });

  it('points to popup.html that exists', () => {
    const popup = manifest.action?.default_popup;
    expect(popup).toBeTruthy();
    expect(existsSync(join(root, popup))).toBe(true);
  });
});
