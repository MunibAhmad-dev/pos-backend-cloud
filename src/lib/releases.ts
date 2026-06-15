import path from 'path';

/**
 * Directory where uploaded POS installers are stored on the VPS.
 * Override with RELEASES_DIR in .env (use an absolute path with enough disk
 * space, e.g. /var/www/osatech/releases). Defaults to <cwd>/uploads/releases.
 */
export const RELEASES_DIR = process.env.RELEASES_DIR
  ? path.resolve(process.env.RELEASES_DIR)
  : path.join(process.cwd(), 'uploads', 'releases');
