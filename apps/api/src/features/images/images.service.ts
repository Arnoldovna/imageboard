import { notOwnerMessages } from '@app/shared';
import type { Logger } from 'pino';

import { NotFoundError, NotOwnerError } from '../../shared/errors/app-error.js';
import { decodeCursor, toPage } from '../../shared/pagination/cursor.js';
import type { ImageUploadPort, IncomingFile } from '../../shared/ports/image-upload.js';
import { type Actor, requireOwnerId } from '../../shared/session/actor.js';
import type { ImageRecord, ImagesRepository } from './images.repository.js';
import type { CreateImageFields, ImageDto, ImagePage, ListImagesQuery } from './images.schema.js';

export interface ImagesServiceDeps {
  repository: ImagesRepository;
  /** Ingest, discard and media URLs; the upload module's port, or a fake in tests (ADR 0017). */
  upload: ImageUploadPort;
  logger: Pick<Logger, 'error' | 'warn'>;
}

export type ImagesService = ReturnType<typeof createImagesService>;

/**
 * Business rules of the images feature: keyset pages, DTO mapping with `canDelete`, the upload order with its
 * compensation, and owner-only deletion followed by object cleanup (ADR 0002, ADR 0008).
 */
export function createImagesService({ repository, upload, logger }: ImagesServiceDeps) {
  /** Exactly the `ImageDto` keys (F-43): never `ownerId`, `objectKey` or `sizeBytes` (B-28). */
  const toDto = (record: ImageRecord, actor: Actor): ImageDto => ({
    id: record.id,
    url: upload.publicUrl(record.objectKey),
    previewUrl: upload.previewUrl(record.objectKey),
    width: record.width,
    height: record.height,
    mimeType: record.mimeType,
    authorName: record.authorName,
    title: record.title,
    description: record.description,
    createdAt: record.createdAt.toISOString(),
    canDelete: actor.ownerId !== null && record.ownerId === actor.ownerId,
  });

  /**
   * Object cleanup never decides the response: the row is already gone (or was never written), so a failure is an
   * orphan for operations, logged at `error`, not a client error (ADR 0008). The port promises not to throw; this
   * keeps that promise for any implementation.
   */
  const discardObjects = async (objectKey: string): Promise<void> => {
    try {
      await upload.discard(objectKey);
    } catch (error) {
      logger.error({ err: error, objectKey }, 'discarding stored image objects failed');
    }
  };

  return {
    /** Newest first; `nextCursor` is null when no older image exists (F-01, F-02, F-04, F-05, B-46). */
    async list(actor: Actor, { limit, cursor }: ListImagesQuery): Promise<ImagePage> {
      // Decoded before any query: a broken cursor is `400 invalid-cursor`, never a database error (B-13).
      const after = cursor === undefined ? undefined : decodeCursor(cursor);
      const page = toPage(await repository.list({ limit, after }), limit);
      return { items: page.items.map((record) => toDto(record, actor)), nextCursor: page.nextCursor };
    },

    /** `404 not-found` for an unknown id (F-13, B-21). */
    async get(actor: Actor, id: number): Promise<ImageDto> {
      const record = await repository.findById(id);
      if (!record) throw new NotFoundError('Image');
      return toDto(record, actor);
    },

    /**
     * The fields and the file's presence are already validated (B-24). Order (ADR 0008, B-25): ingest (sniff, decode,
     * put original + preview; nothing remains stored when it throws) → insert → on insert failure discard both
     * objects, then rethrow the original error. No DB transaction is held open across the storage calls.
     */
    async create(actor: Actor, fields: CreateImageFields, file: IncomingFile): Promise<ImageDto> {
      const ownerId = requireOwnerId(actor);
      const stored = await upload.ingest(file);
      let record: ImageRecord;
      try {
        record = await repository.insert({
          objectKey: stored.objectKey,
          mimeType: stored.mimeType,
          width: stored.width,
          height: stored.height,
          sizeBytes: stored.sizeBytes,
          authorName: fields.authorName,
          title: fields.title,
          description: fields.description,
          ownerId,
        });
      } catch (error) {
        await discardObjects(stored.objectKey); // compensation (F-23): no object without a row
        throw error;
      }
      return toDto(record, actor);
    },

    /**
     * Owner only (F-35, B-02). One atomic `DELETE … WHERE id AND owner_id` removes the row and its comments (F-D2).
     * When nothing matched, a second lookup decides 404 or 403; if the row vanished in between (concurrent delete by
     * its owner) the answer is 404, which is correct. The objects are discarded after the statement has committed
     * (F-36, B-22).
     */
    async remove(actor: Actor, id: number): Promise<void> {
      const ownerId = requireOwnerId(actor);
      const objectKey = await repository.deleteOwned(id, ownerId);
      if (objectKey === undefined) {
        if (await repository.exists(id)) throw new NotOwnerError(notOwnerMessages.image);
        throw new NotFoundError('Image');
      }
      await discardObjects(objectKey);
    },

    /** For the comments module (injected as `imageExists`, ADR 0017). */
    exists(id: number): Promise<boolean> {
      return repository.exists(id);
    },

    /** Takedown regardless of owner (ADR 0019): row and comments, then both objects. */
    async adminRemove(id: number): Promise<'removed' | 'not-found'> {
      const objectKey = await repository.deleteById(id);
      if (objectKey === undefined) return 'not-found';
      logger.warn({ imageId: id, objectKey }, 'image removed by an administrator');
      await discardObjects(objectKey);
      return 'removed';
    },
  };
}
