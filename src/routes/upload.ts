import { Hono } from 'hono';
import { z } from 'zod';
import { authMiddleware, type JwtPayload } from '../middleware/auth.js';
import { uploadBase64ToStorage, isStorageConfigured } from '../lib/firebase-admin.js';

const router = new Hono<{ Variables: { user: JwtPayload } }>();
router.use('*', authMiddleware);

const MAX_BASE64_BYTES = 7 * 1024 * 1024; // ~5 MB decoded

const UploadSchema = z.object({
  data: z.string().min(1),
  mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp']).default('image/jpeg'),
  folder: z.string().max(40).default('orders'),
});

// POST /upload — upload a single image, returns { url }
router.post('/', async (c) => {
  if (!isStorageConfigured()) {
    return c.json({ error: { code: 'NOT_CONFIGURED', message: 'Storage not configured' } }, 503);
  }

  const body = await c.req.json().catch(() => ({}));
  const parsed = UploadSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: { code: 'VALIDATION', message: parsed.error.message } }, 400);
  }

  const { data, mimeType, folder } = parsed.data;

  if (data.length > MAX_BASE64_BYTES) {
    return c.json({ error: { code: 'TOO_LARGE', message: 'Image too large (max 5 MB)' } }, 413);
  }

  const url = await uploadBase64ToStorage(data, mimeType, folder);
  if (!url) {
    return c.json({ error: { code: 'UPLOAD_FAILED', message: 'Upload failed' } }, 500);
  }

  return c.json({ data: { url } }, 201);
});

export default router;
