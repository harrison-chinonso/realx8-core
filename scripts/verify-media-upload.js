/**
 * Which files /media/upload accepts, and what happens to the ones it refuses.
 *
 * The reported symptom was a proof of payment that uploaded but never attached,
 * leaving the submit button disabled. The cause was the multer file filter:
 * `application/pdf` was not on its allow-list, and it refused files with
 * `cb(null, false)` — which tells multer to DROP the file silently rather than
 * report it. The handler then saw an empty `req.files` and answered "No files
 * uploaded", which to someone who had definitely chosen a file reads as a
 * broken button rather than an unsupported type.
 *
 * Two screens offer PDFs to this endpoint (proof of payment, KYC), so this was
 * never only about one flow.
 *
 * Drives the REAL handler. Cloudinary is stubbed, because what is under test is
 * the filter in front of it, not the upload behind it.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'cred.env') });

const express = require('express');

let pass = 0; let fail = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}${detail ? `\n        ${detail}` : ''}`);
  if (ok) pass += 1; else fail += 1;
};

// Stub Cloudinary before the controller requires it, so nothing leaves the machine.
const cloudinaryPath = require.resolve('../services/user-service/src/utils/cloudinaryService');
require.cache[cloudinaryPath] = {
  id: cloudinaryPath,
  filename: cloudinaryPath,
  loaded: true,
  exports: {
    uploadToCloudinary: async (_source, opts) => ({
      url: `https://stub.invalid/${opts.folder}/file`,
      public_id: 'stub', resource_type: 'auto', format: 'bin', width: 1, height: 1,
    }),
    deleteFromCloudinary: async () => ({}),
    invalidateCredsCache: () => {},
    resolveCredentials: async () => ({}),
  },
};

(async () => {
  const controller = require('../services/user-service/src/controllers/mediaController');
  const { errorHandler } = require('../services/user-service/src/middleware/errorHandler');
  const logger = require('../services/user-service/src/config/logger');
  logger.error = () => {}; // refusals are the expected outcome here

  const app = express();
  app.use((req, res, next) => { req.user = { id: 13, company_id: 2, type: 'client' }; next(); });
  app.post('/media/upload', ...controller.uploadMediaFiles);
  app.use(errorHandler);

  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const URL = `http://127.0.0.1:${server.address().port}/media/upload`;

  const send = async (filename, mimetype, bytes = Buffer.from('x')) => {
    const form = new FormData();
    form.append('files', new Blob([bytes], { type: mimetype }), filename);
    const r = await fetch(URL, { method: 'POST', body: form });
    let body = null; try { body = await r.json(); } catch { /* non-JSON */ }
    return { status: r.status, body };
  };

  console.log('\n── The file that could not be attached ──────────────────────────');

  {
    const r = await send('receipt.pdf', 'application/pdf');
    check('A PDF proof of payment is accepted',
      r.status === 200 && Boolean(r.body?.files?.[0]?.url),
      r.status === 200 ? `url returned, type=${r.body.files[0].type}` : JSON.stringify(r.body));
  }
  {
    const r = await send('receipt.pdf', 'application/pdf');
    check('...and is reported as a document, not as an image',
      r.body?.files?.[0]?.type === 'document', `type=${r.body?.files?.[0]?.type}`);
  }
  {
    // What an iPhone camera produces, which is how most people photograph a receipt.
    const r = await send('IMG_0042.heic', 'image/heic');
    check('A HEIC photo from an iPhone is accepted',
      r.status === 200 && Boolean(r.body?.files?.[0]?.url), JSON.stringify(r.body).slice(0, 120));
  }
  {
    const r = await send('screenshot.png', 'image/png');
    check('A PNG screenshot still works, as before',
      r.status === 200 && Boolean(r.body?.files?.[0]?.url));
  }
  {
    const r = await send('clip.mp4', 'video/mp4');
    check('Video still works, for property media',
      r.status === 200 && r.body?.files?.[0]?.type === 'video');
  }

  console.log('\n── A refused file says so ───────────────────────────────────────');

  {
    const r = await send('malware.exe', 'application/x-msdownload');
    check('An unsupported type is refused with 400, not silently dropped',
      r.status === 400, `${r.status} ${r.body?.message || ''}`);
    check('...and the message names the file and the accepted types',
      /malware\.exe/.test(r.body?.message || '') && /PDF/i.test(r.body?.message || ''),
      r.body?.message || '(no message)');
    check('...rather than "No files uploaded", which reads as a broken button',
      !/no files uploaded/i.test(r.body?.message || ''),
      'the old filter dropped the file and the handler reported an empty request');
  }
  {
    const r = await fetch(URL, { method: 'POST', body: new FormData() });
    const body = await r.json().catch(() => ({}));
    check('A request with genuinely no file still says "No files uploaded"',
      r.status === 400 && /no files uploaded/i.test(body.message || ''),
      body.message || '');
  }

  console.log('\n── Results ─────────────────────────────────────────────────────\n');
  console.log(`  ${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass}/${pass + fail} checks passed.\x1b[0m\n`);
  server.close();
  process.exit(fail === 0 ? 0 : 1);
})().catch((error) => {
  console.error('\n\x1b[31mThe verification itself failed:\x1b[0m', error);
  process.exit(1);
});
