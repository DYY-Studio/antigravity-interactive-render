import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const SECRET_REQUEST_MAX_LABEL_LENGTH = 120;
export const SECRET_REQUEST_MAX_REASON_LENGTH = 1000;
export const SECRET_REQUEST_MAX_PLACEHOLDER_LENGTH = 80;
export const SECRET_MAX_VALUE_LENGTH = 16_000;
export const SECRET_FILE_LIFETIME_MS = 24 * 60 * 60 * 1000;

export const SAVED_NOTE =
  'The user saved the secret to a private file readable only by this user. Read it inside the command that needs it, e.g. TOKEN="$(cat <file>)" some-cli ...; never print, echo, or log it, and never copy it into the repository. The file is automatically deleted after 24 hours.';
export const DECLINED_NOTE =
  'The user declined to provide this secret. Continue without it or explain what it blocks; ask again only if the user requests it.';
export const SECRET_CLOSED_NOTE =
  'The user skipped the secret card to continue in chat instead. Do not ask for the same secret again unless requested.';

const readText = (val) => (typeof val === 'string' ? val.trim() : '');

/**
 * Ephemeral zero-context secret file storage.
 * Writes each secret to a 0600 file inside a 0700 directory; the secret value
 * never enters the MCP tool result, LLM prompt, or conversation transcript.
 */
export function createSecretFiles({ directory, now = Date.now, fsPromises = fs }) {
  const write = async (value) => {
    await fsPromises.mkdir(directory, { recursive: true, mode: 0o700 });
    await fsPromises.chmod(directory, 0o700).catch(() => {});
    const file = path.join(directory, crypto.randomBytes(16).toString('hex'));
    try {
      await fsPromises.writeFile(file, value, { mode: 0o600, flag: 'wx' });
      await fsPromises.chmod(file, 0o600).catch(() => {});
    } catch (error) {
      await fsPromises.rm(file, { force: true }).catch(() => {});
      throw error;
    }
    return file;
  };

  const remove = (file) => fsPromises.rm(file, { force: true });

  const sweep = async () => {
    const names = await fsPromises.readdir(directory).catch(() => []);
    const cutoff = now() - SECRET_FILE_LIFETIME_MS;
    await Promise.all(
      names.map(async (name) => {
        const file = path.join(directory, name);
        const stat = await fsPromises.stat(file).catch(() => null);
        if (stat && stat.mtimeMs < cutoff) {
          await remove(file).catch(() => {});
        }
      }),
    );
  };

  return { write, remove, sweep };
}

export function validateSecretRequestInput(input = {}) {
  const label = readText(input.label);
  const reason = readText(input.reason);
  const placeholder = readText(input.placeholder);
  if (!label || !reason) {
    const err = new Error('label and reason are required: state what the secret is and what you will do with it');
    err.statusCode = 400;
    throw err;
  }
  if (label.length > SECRET_REQUEST_MAX_LABEL_LENGTH) {
    const err = new Error(`label is ${label.length} characters; the limit is ${SECRET_REQUEST_MAX_LABEL_LENGTH}`);
    err.statusCode = 400;
    throw err;
  }
  if (reason.length > SECRET_REQUEST_MAX_REASON_LENGTH) {
    const err = new Error(`reason is ${reason.length} characters; the limit is ${SECRET_REQUEST_MAX_REASON_LENGTH}`);
    err.statusCode = 400;
    throw err;
  }
  if (placeholder.length > SECRET_REQUEST_MAX_PLACEHOLDER_LENGTH) {
    const err = new Error(
      `placeholder is ${placeholder.length} characters; the limit is ${SECRET_REQUEST_MAX_PLACEHOLDER_LENGTH}`,
    );
    err.statusCode = 400;
    throw err;
  }
  return { label, reason, placeholder: placeholder || null };
}
