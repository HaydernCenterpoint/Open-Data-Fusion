import { z } from 'zod';

export const governedObjectIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, 'Use letters, numbers, dots, colons, underscores, or dashes')
  .refine((value) => value !== '.' && value !== '..' && !value.includes('..'), 'Object ID must not contain traversal segments');

const safeFileNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine((value) => !/[\\/\u0000-\u001F\u007F]/u.test(value), 'File name must not contain path separators or control characters')
  .refine((value) => value !== '.' && value !== '..', 'File name must not be a traversal segment');

const mimeTypeSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .transform((value) => value.split(';', 1)[0]!.trim().toLowerCase())
  .refine((value) => /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u.test(value), 'Invalid MIME type');

export const governedUploadMetadataSchema = z.object({
  fileName: safeFileNameSchema,
  title: z.string().trim().min(1).max(500)
    .refine((value) => !/[\u0000-\u001F\u007F]/u.test(value), 'Title must not contain control characters'),
  mimeType: mimeTypeSchema,
  contentLength: z.number().int().nonnegative().optional(),
}).strict();

export const governedObjectListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().trim().min(1).max(2_048).optional(),
});

export const governedVersionListQuerySchema = governedObjectListQuerySchema;

export const governedVersionSchema = z.coerce.number().int().positive();

export type GovernedUploadMetadata = z.infer<typeof governedUploadMetadataSchema>;
export type GovernedObjectListQuery = z.infer<typeof governedObjectListQuerySchema>;
