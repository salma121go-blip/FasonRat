import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import type { FastifyInstance } from 'fastify';
import AdmZip from 'adm-zip';
import sharp from 'sharp';
import { getDb, getSqliteDb } from '../db/index.js';
import { buildRecords } from '../db/schema.js';
import { paths, ensureDataDir, createBuildDir } from '../config/paths.js';
import { getConfig } from '../config/index.js';
import { eq } from 'drizzle-orm';
import { requirePermission } from '../middleware/auth.js';
import { socketService } from '../services/socket.js';
import { log } from '../utils/logger.js';

const execAsync = promisify(exec);

const FORM_DEFAULT_SERVER_URL = 'http://127.0.0.1:32766';
const FORM_DEFAULT_HOME_URL = 'https://google.com';
const MAX_ICON_SIZE = 5 * 1024 * 1024;
const MAX_APP_NAME_LENGTH = 50;
const APP_NAME_PLACEHOLDER = 'Fason0000000000000000000000000000000000000000000';

const STORED = 0;

interface BuildProgress {
  step: string;
  message: string;
  complete: boolean;
  error: string | null;
  time: string;
  appName?: string;
}

interface BuildState {
  inProgress: boolean;
}

const buildState: BuildState = { inProgress: false };

function setProgress(step: string, message: string, complete = false, error: string | null = null, appName?: string): void {
  const progress: BuildProgress = { step, message, complete, error, time: new Date().toISOString(), appName };
  socketService.broadcast('builder:progress', progress);
  log.info(`[Builder] ${step}: ${message}${error ? ` (Error: ${error})` : ''}`);
}

function sanitizeFileName(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'Fason';
}

/**
 * Add (or replace) a file inside the APK using STORED compression (no compression),
 * matching the previous `zip -0` behaviour. New entries default to DEFLATE in adm-zip,
 * so we explicitly flip the method after insertion.
 */
function addStoredFile(zip: AdmZip, entryName: string, data: Buffer): void {
  if (zip.getEntry(entryName)) zip.deleteFile(entryName);
  zip.addFile(entryName, data);
  const entry = zip.getEntry(entryName);
  if (entry) entry.header.method = STORED;
}

async function buildApkAsync(serverUrl: string, homePageUrl: string, appName: string, iconBuffer: Buffer | null): Promise<void> {
  let buildDir: string | null = null;

  try {
    setProgress('checking', 'Checking build prerequisites...', false, null, appName);

    try {
      const { stderr } = await execAsync('java -version 2>&1', { timeout: 10000 });
      log.info(`[Builder] Java found: ${stderr.split('\n')[0]}`);
    } catch {
      setProgress('checking', 'Java not found', true, 'Java Runtime is required but not installed.', appName);
      return;
    }

    if (!fs.existsSync(paths.baseApkPath)) { setProgress('checking', 'Base APK not found', true, `Base APK not found at: ${paths.baseApkPath}`, appName); return; }
    if (!fs.existsSync(paths.signerPath)) { setProgress('checking', 'uber-apk-signer.jar not found', true, `uber-apk-signer.jar not found at: ${paths.signerPath}`, appName); return; }

    ensureDataDir();
    buildDir = createBuildDir();
    const outputApk = path.join(buildDir, 'build.apk');

    setProgress('configuring', 'Copying base APK...', false, null, appName);
    fs.copyFileSync(paths.baseApkPath, outputApk);

    const zip = new AdmZip(outputApk);

    setProgress('configuring', 'Removing old signatures...', false, null, appName);
    const sigEntries = zip.getEntries().filter(e =>
      /^META-INF\//.test(e.entryName) && /\.(SF|RSA|MF|DSA)$/i.test(e.entryName)
    );
    for (const e of sigEntries) zip.deleteFile(e.entryName);
    log.info(`[Builder] Removed ${sigEntries.length} META-INF signature entries`);

    setProgress('patching', `Patching config.properties — Server: ${serverUrl}, Name: ${appName}...`, false, null, appName);

    // Inject server_url, home_page_url, and (if set) device_secret.
    // The Android client reads these from assets/config.properties at startup
    // and sends device_secret as the socket handshake token.
    const deviceSecret = getConfig().security.deviceSecret;
    const configProps = deviceSecret
      ? `server_url=${serverUrl}\nhome_page_url=${homePageUrl}\ndevice_secret=${deviceSecret}\n`
      : `server_url=${serverUrl}\nhome_page_url=${homePageUrl}\n`;
    addStoredFile(zip, 'assets/config.properties', Buffer.from(configProps, 'utf-8'));
    log.info(`[Builder] config.properties written — server_url: ${serverUrl}, home_page_url: ${homePageUrl}, device_secret: ${deviceSecret ? '***' : '(empty)'}`);

    setProgress('configuring', 'Setting app name...', false, null, appName);
    try {
      patchAppNameInArsc(zip, appName);
      log.info(`[Builder] App name patched to: ${appName}`);
    } catch (err: any) {
      log.warn(`[Builder] Failed to patch app name in resources.arsc: ${err.message}`);
    }

    if (iconBuffer) {
      setProgress('configuring', 'Replacing app icon...', false, null, appName);
      await replaceIconsInApk(zip, iconBuffer);
      log.info('[Builder] Icon replaced successfully');
    }

    setProgress('patching', 'Writing patched APK...', false, null, appName);
    zip.writeZip(outputApk);

    setProgress('signing', 'Signing APK with uber-apk-signer...', false, null, appName);
    await execAsync(`java -jar "${paths.signerPath}" --apks "${outputApk}" --overwrite`, { timeout: 60000 });

    const signedApk = path.join(buildDir, 'build-aligned-debugSigned.apk');
    const apkToRead = fs.existsSync(signedApk) ? signedApk : outputApk;
    if (!fs.existsSync(apkToRead)) throw new Error('Built APK file not found after signing');

    const apkData = fs.readFileSync(apkToRead);
    const fileSize = apkData.length;
    log.info(`[Builder] Signed APK ready (${(fileSize / 1024 / 1024).toFixed(2)} MB), storing in database...`);

    const d = getDb();
    // Wrap delete + insert in a transaction so a partial failure (disk full,
    // constraint violation) doesn't wipe all prior builds and leave nothing.
    getSqliteDb().transaction(() => {
      d.delete(buildRecords).run();
      d.insert(buildRecords).values({
        serverUrl, homePageUrl, appName,
        status: 'completed',
        apkData,
        fileSize,
        completedAt: new Date().toISOString(),
      }).run();
    })();

    try { if (fs.existsSync(buildDir)) fs.rmSync(buildDir, { recursive: true, force: true }); } catch { /* ignore */ }
    buildDir = null;

    setProgress('signing', 'Build completed successfully!', true, null, appName);
  } catch (err: any) {
    const errMsg = err.message || 'Unknown build error';
    log.error(`[Builder] Build failed: ${errMsg}`);
    setProgress('signing', `Build failed: ${errMsg}`, true, errMsg, appName);
  } finally {
    if (buildDir) { try { fs.rmSync(buildDir, { recursive: true, force: true }); } catch { /* ignore */ } }
    buildState.inProgress = false;
  }
}

function patchAppNameInArsc(zip: AdmZip, newName: string): void {
  const arscEntry = zip.getEntry('resources.arsc');
  if (!arscEntry) throw new Error('resources.arsc not found in APK');

  let arscData = arscEntry.getData();

  const placeholderBytes = Buffer.from(APP_NAME_PLACEHOLDER, 'utf-8');
  const placeholderIdx = arscData.indexOf(placeholderBytes);

  if (placeholderIdx === -1) {
    const fasonBytes = Buffer.from('Fason', 'utf-8');
    const fasonIdx = arscData.indexOf(fasonBytes);
    if (fasonIdx !== -1) {
      log.info('[Builder] Found "Fason" in resources.arsc (no placeholder), attempting same-length patch');
      if (newName.length <= 5) {
        const nameBytes = Buffer.alloc(5, 0x00);
        Buffer.from(newName, 'utf-8').copy(nameBytes);
        arscData = Buffer.concat([
          arscData.subarray(0, fasonIdx),
          nameBytes,
          arscData.subarray(fasonIdx + 5),
        ]);
        arscData.writeUInt8(newName.length, fasonIdx - 1);
        arscData.writeUInt8(newName.length, fasonIdx - 2);
        log.info(`[Builder] Patched app name (short mode): ${newName}`);
      } else {
        log.warn(`[Builder] Cannot patch app name "${newName}" - longer than 5 chars and no placeholder in APK`);
        return;
      }
    } else {
      log.warn('[Builder] Could not find app name string in resources.arsc');
      return;
    }
  } else {
    const nameBytes = Buffer.alloc(placeholderBytes.length, 0x00);
    const newNameBuffer = Buffer.from(newName, 'utf-8');
    if (newNameBuffer.length > placeholderBytes.length) {
      log.warn(`[Builder] App name "${newName}" is too long (${newNameBuffer.length} bytes, max ${placeholderBytes.length}), truncating`);
      newNameBuffer.copy(nameBytes, 0, 0, placeholderBytes.length);
    } else {
      newNameBuffer.copy(nameBytes);
    }

    arscData = Buffer.concat([
      arscData.subarray(0, placeholderIdx),
      nameBytes,
      arscData.subarray(placeholderIdx + placeholderBytes.length),
    ]);

    const utf8LenOffset = placeholderIdx - 1;
    const newUtf8Len = Math.min(newNameBuffer.length, 127);
    arscData.writeUInt8(newUtf8Len, utf8LenOffset);

    const utf16LenOffset = placeholderIdx - 2;
    const newUtf16Len = Math.min(newName.length, 127);
    arscData.writeUInt8(newUtf16Len, utf16LenOffset);

    log.info(`[Builder] Patched app name in resources.arsc: "${newName}" (${newUtf8Len} UTF-8 bytes)`);
  }

  addStoredFile(zip, 'resources.arsc', arscData);
  log.info('[Builder] Patched resources.arsc injected into APK');
}

async function replaceIconsInApk(zip: AdmZip, iconBuffer: Buffer): Promise<void> {
  const ADAPTIVE_SIZE = 432;
  const SAFE_ZONE = 288;

  const allEntries = zip.getEntries();

  // Detect the actual mipmap-xxxhdpi dir name (e.g. mipmap-xxxhdpi-v4)
  let mipmapDirName = 'mipmap-xxxhdpi-v4';
  const xxxhdpiEntry = allEntries.find(e => /^res\/mipmap-xxxhdpi[^\/]*\//.test(e.entryName));
  if (xxxhdpiEntry) {
    const m = xxxhdpiEntry.entryName.match(/^res\/(mipmap-xxxhdpi[^\/]*)\//);
    if (m) {
      mipmapDirName = m[1];
      log.info(`[Builder] Found mipmap dir in APK: ${mipmapDirName}`);
    }
  } else {
    log.warn('[Builder] Could not detect mipmap dir name, using default');
  }

  // Collect all mipmap dirs that contain PNGs
  const allMipmapDirsSet = new Set<string>();
  for (const e of allEntries) {
    const m = e.entryName.match(/^res\/(mipmap-[^\/]+)\/.*\.png$/);
    if (m) allMipmapDirsSet.add(m[1]);
  }
  const allMipmapDirs = [...allMipmapDirsSet];
  if (allMipmapDirs.length === 0) allMipmapDirs.push(mipmapDirName);
  log.info(`[Builder] Found mipmap directories with PNGs: ${allMipmapDirs.join(', ')}`);

  const iconFiles: { name: string; data: Buffer }[] = [];

  try {
    const resized = await sharp(iconBuffer).resize(ADAPTIVE_SIZE, ADAPTIVE_SIZE, { fit: 'cover', position: 'center' }).png().toBuffer();
    iconFiles.push({ name: `res/${mipmapDirName}/ic_launcher.png`, data: resized });
  } catch (err: any) { log.warn(`[Builder] Failed to resize mipmap icon: ${err.message}`); }

  try {
    const resizedIcon = await sharp(iconBuffer).resize(SAFE_ZONE, SAFE_ZONE, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).toBuffer();
    const foreground = await sharp({ create: { width: ADAPTIVE_SIZE, height: ADAPTIVE_SIZE, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: resizedIcon, gravity: 'center' }])
      .png()
      .toBuffer();
    iconFiles.push({ name: `res/${mipmapDirName}/ic_launcher_foreground.png`, data: foreground });
  } catch (err: any) { log.warn(`[Builder] Failed to generate adaptive foreground: ${err.message}`); }

  try {
    const borderSample = await sharp(iconBuffer)
      .resize(64, 64, { fit: 'cover' })
      .raw()
      .toBuffer();
    let rSum = 0, gSum = 0, bSum = 0, count = 0;
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        const idx = (y * 64 + x) * 4;
        const a = borderSample[idx + 3];
        if (a > 128) {
          rSum += borderSample[idx];
          gSum += borderSample[idx + 1];
          bSum += borderSample[idx + 2];
          count++;
        }
      }
    }
    const bgR = count > 0 ? Math.round(rSum / count) : 255;
    const bgG = count > 0 ? Math.round(gSum / count) : 255;
    const bgB = count > 0 ? Math.round(bSum / count) : 255;

    const background = await sharp({ create: { width: ADAPTIVE_SIZE, height: ADAPTIVE_SIZE, channels: 4, background: { r: bgR, g: bgG, b: bgB, alpha: 255 } } })
      .png()
      .toBuffer();
    iconFiles.push({ name: `res/${mipmapDirName}/ic_launcher_background.png`, data: background });
    log.info(`[Builder] Adaptive background color: rgb(${bgR}, ${bgG}, ${bgB})`);
  } catch (err: any) { log.warn(`[Builder] Failed to generate adaptive background: ${err.message}`); }

  // Remove ic_launcher.png from all non-primary mipmap dirs
  for (const dir of allMipmapDirs) {
    if (dir === mipmapDirName) continue;
    const iconPath = `res/${dir}/ic_launcher.png`;
    if (zip.getEntry(iconPath)) {
      try { zip.deleteFile(iconPath); } catch { /* ignore */ }
    }
  }

  // Replace icons in the primary mipmap dir
  for (const icon of iconFiles) {
    addStoredFile(zip, icon.name, icon.data);
  }

  log.info('[Builder] Icon PNG files injected into APK (adaptive icon XMLs preserved)');
}

export async function builderRoutes(app: FastifyInstance) {
  const builderAccess = [app.auth, requirePermission('builder:access')];

  app.post('/api/builder/build', {
    preHandler: builderAccess,
  }, async (request, reply) => {
    if (buildState.inProgress) {
      return reply.code(409).send({ success: false, error: 'A build is already in progress' });
    }
    // Set the flag BEFORE awaiting multipart parsing — otherwise two concurrent
    // POSTs can both pass the check above and both invoke buildApkAsync.
    buildState.inProgress = true;

    let serverUrl = FORM_DEFAULT_SERVER_URL;
    let homePageUrl = FORM_DEFAULT_HOME_URL;
    let appName = 'Fason';
    let iconBuffer: Buffer | null = null;

    try {
      const parts = request.parts();
      for await (const part of parts) {
        if (part.type === 'field') {
          const field = part as { fieldname: string; value: string };
          switch (field.fieldname) {
            case 'serverUrl': serverUrl = String(field.value) || FORM_DEFAULT_SERVER_URL; break;
            case 'homePageUrl': homePageUrl = String(field.value) || FORM_DEFAULT_HOME_URL; break;
            case 'appName': appName = String(field.value) || 'Fason'; break;
          }
        } else if (part.type === 'file') {
          const file = part as { fieldname: string; toBuffer: () => Promise<Buffer> };
          if (file.fieldname === 'appIcon') {
            try {
              iconBuffer = await file.toBuffer();
              if (iconBuffer.length > MAX_ICON_SIZE) {
                buildState.inProgress = false;
                return reply.code(400).send({ success: false, error: `Icon file too large (${(iconBuffer.length / 1024 / 1024).toFixed(1)}MB). Maximum is 5MB.` });
              }
              log.info(`[Builder] Icon uploaded: ${iconBuffer.length} bytes`);
            } catch (err: any) {
              log.warn(`[Builder] Failed to read icon file: ${err.message}`);
            }
          }
        }
      }
    } catch (err: any) {
      log.warn(`[Builder] Failed to parse form data: ${err.message}`);
      buildState.inProgress = false;
      return reply.code(400).send({ success: false, error: 'Failed to parse form data' });
    }

    if (!serverUrl.match(/^https?:\/\/.+/)) { buildState.inProgress = false; return reply.code(400).send({ success: false, error: 'Invalid server URL' }); }
    if (!homePageUrl.match(/^https?:\/\/.+/)) { buildState.inProgress = false; return reply.code(400).send({ success: false, error: 'Invalid home page URL' }); }
    if (!appName || appName.trim().length === 0) { buildState.inProgress = false; return reply.code(400).send({ success: false, error: 'App name is required' }); }
    if (appName.trim().length > MAX_APP_NAME_LENGTH) { buildState.inProgress = false; return reply.code(400).send({ success: false, error: `App name must be ${MAX_APP_NAME_LENGTH} characters or less` }); }

    buildApkAsync(serverUrl, homePageUrl, appName, iconBuffer);
    return { success: true, message: 'Build started' };
  });

  app.get('/api/builder/download', {
    preHandler: builderAccess,
  }, async (request, reply) => {
    const d = getDb();
    const record = d.select({ id: buildRecords.id, appName: buildRecords.appName, apkData: buildRecords.apkData, fileSize: buildRecords.fileSize })
      .from(buildRecords)
      .where(eq(buildRecords.status, 'completed'))
      .get();

    if (!record?.apkData) {
      return reply.code(404).send({ success: false, error: 'No APK built yet' });
    }

    const apkBuffer = Buffer.from(record.apkData as Uint8Array);
    const downloadName = sanitizeFileName(record.appName || 'Fason') + '.apk';
    reply.header('Content-Type', 'application/vnd.android.package-archive');
    reply.header('Content-Disposition', `attachment; filename="${downloadName}"`);
    reply.header('Content-Length', record.fileSize || apkBuffer.length);
    return reply.send(apkBuffer);
  });
}
