/**
 * Loads role key files shared by both services. Role keys live outside the repo at
 * ~/.whitespace-keys/<role>.json, one-element JSON array with `address` and
 * `private_key` (see docs/runbooks/deploy-testnet.md). This module never logs or
 * otherwise surfaces the private key — callers must be equally careful.
 */

import { readFileSync } from 'node:fs';

/** @typedef {{ address: `0x${string}`, privateKey: `0x${string}` }} RoleKey */

/**
 * @param {string} path absolute path to a role key JSON file
 * @returns {RoleKey}
 */
export function loadKeyFile(path) {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const entry = Array.isArray(raw) ? raw[0] : raw;
  if (!entry?.address || !entry?.private_key) {
    throw new Error(`loadKeyFile: ${path} is not shaped like a role key file`);
  }
  return { address: entry.address, privateKey: entry.private_key };
}

/**
 * @param {string[]} paths
 * @returns {RoleKey[]}
 */
export function loadKeyFiles(paths) {
  return paths.map(loadKeyFile);
}
