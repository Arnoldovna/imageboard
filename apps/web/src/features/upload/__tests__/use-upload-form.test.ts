import {
  fieldMessages,
  fileMessages,
  problemMessages,
  serviceUnavailable,
  uploadTooLarge,
  type ImageDto,
} from '@app/shared';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { effectScope, type EffectScope } from 'vue';

import { useSessionStore } from '../../../shared/session/session.store';
import { useUploadForm, type UploadFormState } from '../use-upload-form';

const MIB = 1024 * 1024;
const JPEG_HEAD = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01];
const SVG_HEAD = Array.from('<svg xmlns="http://www.w3.org/2000/svg">', (character) => character.charCodeAt(0));

const uploaded: ImageDto = {
  id: 41,
  url: '/api/media/images/3f2a9c1e-7b4d-4e8a-9c2f-1a0b3c4d5e6f.jpg',
  previewUrl: '/api/media/previews/3f2a9c1e-7b4d-4e8a-9c2f-1a0b3c4d5e6f.webp',
  width: 1600,
  height: 1200,
  mimeType: 'image/jpeg',
  authorName: 'Ines',
  title: 'Ferry to Vlieland',
  description: 'Grey sea, one seal.',
  createdAt: '2026-11-16T09:41:00.000Z',
  canDelete: true,
};

function imageFile(size = 4096, name = 'IMG_2041.jpg', head: readonly number[] = JPEG_HEAD): File {
  const content = new Uint8Array(size);
  content.set(head.slice(0, size));
  return new File([content], name, { type: 'image/jpeg' });
}

function json(body: unknown, status = 200, contentType = 'application/json'): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': contentType } });
}

function problem(status: number, code: string, detail: string, errors?: unknown[]): Response {
  return json(
    { type: `tag:example:problem:${code}`, title: code, status, detail, code, ...(errors ? { errors } : {}) },
    status,
    'application/problem+json',
  );
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

type FetchArgs = [input: string, init: RequestInit];
type UploadReply = Response | Error | Deferred<Response>;

/**
 * `GET /api/session` answers with a token and the given limit; each `POST /api/images` takes the next reply. A
 * deferred reply stays pending until resolved and rejects with an AbortError when the request is aborted, like fetch.
 */
function stubApi(replies: UploadReply[] = [], uploadMaxBytes = 5 * MIB) {
  const queue = [...replies];
  const fetchMock = vi.fn<(...args: FetchArgs) => Promise<Response>>(async (input, init) => {
    if (input === '/api/session') return json({ csrfToken: 'csrf-token-1', uploadMaxBytes });
    if (input !== '/api/images' || init.method !== 'POST')
      throw new Error(`unexpected ${String(init.method)} ${input}`);
    const reply = queue.shift();
    if (reply === undefined) throw new Error('no reply queued for POST /api/images');
    if (reply instanceof Response) return reply;
    if (reply instanceof Error) throw reply;
    return new Promise<Response>((resolve, reject) => {
      init.signal?.addEventListener('abort', () => {
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      });
      void reply.promise.then(resolve);
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function uploadCalls(fetchMock: ReturnType<typeof stubApi>): FetchArgs[] {
  return fetchMock.mock.calls.filter(([input]) => input === '/api/images');
}

let scope: EffectScope;
let revokeObjectURL: MockInstance<(url: string) => void>;

/** Runs the composable in its own effect scope, as a component's setup would; `scope.stop()` is the unmount. */
function setup(): UploadFormState {
  scope = effectScope();
  const form = scope.run(() => useUploadForm());
  if (form === undefined) throw new Error('scope did not run');
  return form;
}

async function fill(form: UploadFormState, file: File | null = imageFile()): Promise<void> {
  form.fields.authorName = '  Ines ';
  form.fields.title = 'Ferry to Vlieland';
  form.fields.description = 'Grey sea,\r\none seal.';
  await form.selectFile(file);
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.unstubAllGlobals();
  let previews = 0;
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:preview-${String(++previews)}`);
  revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
});

afterEach(() => {
  scope.stop();
});

describe('useUploadForm: client validation (F-18 rules, F-20, F-24)', () => {
  it('blocks an empty form with the shared messages, first invalid field first, and sends nothing', async () => {
    const fetchMock = stubApi();
    const form = setup();

    const outcome = await form.submit();

    expect(outcome).toEqual({ status: 'invalid', field: 'authorName' });
    expect(form.fieldErrors.value).toEqual({
      authorName: fieldMessages.authorName.required,
      title: fieldMessages.title.required,
      file: fileMessages.required,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(form.status.value).toBe('idle');
  });

  it('treats whitespace-only text as empty and rejects line breaks in a title', async () => {
    stubApi();
    const form = setup();
    await fill(form);
    form.fields.authorName = '   ';
    form.fields.title = 'Ferry\nto Vlieland';

    const outcome = await form.submit();

    expect(outcome).toEqual({ status: 'invalid', field: 'authorName' });
    expect(form.fieldErrors.value).toEqual({
      authorName: fieldMessages.authorName.required,
      title: fieldMessages.title.invalid,
    });
  });

  it('rejects a description over 2,000 characters with the shared message', async () => {
    stubApi();
    const form = setup();
    await fill(form);
    form.fields.description = 'a'.repeat(2001);

    await expect(form.submit()).resolves.toEqual({ status: 'invalid', field: 'description' });
    expect(form.fieldErrors.value).toEqual({ description: fieldMessages.description.tooLong });
  });

  it('checks the file again on submit and blocks a file that is not an image', async () => {
    const fetchMock = stubApi();
    const form = setup();
    await fill(form, imageFile(512, 'logo.png', SVG_HEAD));

    expect(form.fieldErrors.value).toEqual({ file: fileMessages.unsupportedType });
    await expect(form.submit()).resolves.toEqual({ status: 'invalid', field: 'file' });
    expect(uploadCalls(fetchMock)).toHaveLength(0);
  });
});

describe('useUploadForm: file selection and preview (F-24)', () => {
  it('previews a valid file and revokes the previous preview when the file changes', async () => {
    stubApi();
    const form = setup();

    await form.selectFile(imageFile());
    expect(form.previewUrl.value).toBe('blob:preview-1');

    await form.selectFile(imageFile(2048, 'IMG_2042.jpg'));
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:preview-1');
    expect(form.previewUrl.value).toBe('blob:preview-2');
    expect(form.file.value?.name).toBe('IMG_2042.jpg');
  });

  it('shows no preview for a rejected file, and choosing nothing clears file, preview and error', async () => {
    stubApi();
    const form = setup();

    await form.selectFile(imageFile(512, 'logo.svg', SVG_HEAD));
    expect(form.previewUrl.value).toBeNull();
    expect(form.fieldErrors.value.file).toBe(fileMessages.unsupportedType);

    await form.selectFile(null);
    expect(form.file.value).toBeNull();
    expect(form.fieldErrors.value).toEqual({});
  });

  it('uses the limit the session reports (B-54 item 3)', async () => {
    stubApi([], 1 * MIB);
    await useSessionStore().ensure();
    const form = setup();

    await form.selectFile(imageFile(1 * MIB + 1));

    expect(form.maxBytes.value).toBe(1 * MIB);
    expect(form.fieldErrors.value.file).toBe(uploadTooLarge(1 * MIB));
    expect(form.fieldErrors.value.file).toBe('The image must be 1 MB or smaller.');
  });

  it('ignores the result of a slow check when another file was chosen meanwhile', async () => {
    stubApi();
    const form = setup();
    const slowRead = deferred<ArrayBuffer>();
    class SlowBlob extends Blob {
      override arrayBuffer(): Promise<ArrayBuffer> {
        return slowRead.promise;
      }
    }
    const slow = imageFile(4096, 'slow.jpg');
    slow.slice = () => new SlowBlob([]);

    const first = form.selectFile(slow);
    await form.selectFile(imageFile(4096, 'fast.jpg'));
    slowRead.resolve(new Uint8Array(SVG_HEAD).buffer);
    await first;

    expect(form.file.value?.name).toBe('fast.jpg');
    expect(form.fieldErrors.value).toEqual({});
    expect(form.previewUrl.value).toBe('blob:preview-1');
  });
});

describe('useUploadForm: submit (F-17, F-24, B-54)', () => {
  it('posts trimmed fields and the file as multipart with the CSRF token, then resets everything', async () => {
    const fetchMock = stubApi([json(uploaded, 201)]);
    const form = setup();
    await fill(form);
    const keyBefore = form.resetKey.value;

    const outcome = await form.submit();

    expect(outcome).toEqual({ status: 'uploaded', image: uploaded });
    const [call] = uploadCalls(fetchMock);
    expect(call).toBeDefined();
    const [, init] = call!;
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('same-origin');
    expect(new Headers(init.headers).get('x-csrf-token')).toBe('csrf-token-1');
    expect(init.body).toBeInstanceOf(FormData);
    const body = init.body as FormData;
    expect(body.get('authorName')).toBe('Ines');
    expect(body.get('title')).toBe('Ferry to Vlieland');
    expect(body.get('description')).toBe('Grey sea,\none seal.');
    const part = body.get('file');
    expect(part).toBeInstanceOf(File);
    // The person's local filename never leaves the browser (F-21).
    expect((part as File).name).toBe('image');
    expect((part as File).size).toBe(4096);

    // Reset on success: text, file, preview, errors, and a new key that re-creates the native file input.
    expect({ ...form.fields }).toEqual({ authorName: '', title: '', description: '' });
    expect(form.file.value).toBeNull();
    expect(form.previewUrl.value).toBeNull();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:preview-1');
    expect(form.fieldErrors.value).toEqual({});
    expect(form.formError.value).toBeNull();
    expect(form.resetKey.value).toBe(keyBefore + 1);
    expect(form.status.value).toBe('idle');
  });

  it('is "submitting" while the request runs and ignores a second submit (no double upload)', async () => {
    const reply = deferred<Response>();
    const fetchMock = stubApi([reply]);
    const form = setup();
    await fill(form);

    const first = form.submit();
    await vi.waitFor(() => {
      expect(uploadCalls(fetchMock)).toHaveLength(1);
    });
    expect(form.status.value).toBe('submitting');
    await expect(form.submit()).resolves.toEqual({ status: 'busy' });

    reply.resolve(json(uploaded, 201));
    await expect(first).resolves.toEqual({ status: 'uploaded', image: uploaded });
    expect(uploadCalls(fetchMock)).toHaveLength(1);
    expect(form.status.value).toBe('idle');
  });

  it('maps server field errors, focuses the first one in form order and keeps every value', async () => {
    stubApi([
      problem(400, 'validation-failed', problemMessages['validation-failed'], [
        { field: 'title', location: 'body', message: fieldMessages.title.tooLong },
        { field: 'authorName', location: 'body', message: fieldMessages.authorName.invalid },
      ]),
    ]);
    const form = setup();
    await fill(form);
    const chosen = form.file.value;

    const outcome = await form.submit();

    expect(outcome).toEqual({ status: 'invalid', field: 'authorName' });
    expect(form.fieldErrors.value).toEqual({
      authorName: fieldMessages.authorName.invalid,
      title: fieldMessages.title.tooLong,
    });
    expect({ ...form.fields }).toEqual({
      authorName: '  Ines ',
      title: 'Ferry to Vlieland',
      description: 'Grey sea,\r\none seal.',
    });
    expect(form.file.value).toBe(chosen);
    expect(form.previewUrl.value).toBe('blob:preview-1');
  });

  it('shows a 415 from the API under the image field', async () => {
    stubApi([problem(415, 'unsupported-image-type', fileMessages.unsupportedType)]);
    const form = setup();
    await fill(form);

    await expect(form.submit()).resolves.toEqual({ status: 'invalid', field: 'file' });
    expect(form.fieldErrors.value).toEqual({ file: fileMessages.unsupportedType });
    expect(form.formError.value).toBeNull();
  });

  it('shows a 413 from nginx (no problem body) as the image size message under the image field', async () => {
    stubApi([new Response('<html>413 Request Entity Too Large</html>', { status: 413 })]);
    const form = setup();
    await fill(form);

    await expect(form.submit()).resolves.toEqual({ status: 'invalid', field: 'file' });
    expect(form.fieldErrors.value).toEqual({ file: uploadTooLarge(5 * MIB) });
  });

  it('shows errors that belong to no field as a form error and keeps the values', async () => {
    const detail = 'Too many uploads. Wait a moment and try again.';
    stubApi([problem(429, 'rate-limited', detail)]);
    const form = setup();
    await fill(form);

    await expect(form.submit()).resolves.toEqual({ status: 'failed', message: detail });
    expect(form.formError.value).toBe(detail);
    expect(form.fieldErrors.value).toEqual({});
    expect(form.fields.title).toBe('Ferry to Vlieland');
    expect(form.file.value).not.toBeNull();
  });

  it('reports a network failure with the shared message and clears it on the next attempt', async () => {
    stubApi([new TypeError('Failed to fetch'), json(uploaded, 201)]);
    const form = setup();
    await fill(form);

    await expect(form.submit()).resolves.toEqual({ status: 'failed', message: serviceUnavailable });
    expect(form.formError.value).toBe(serviceUnavailable);

    await expect(form.submit()).resolves.toEqual({ status: 'uploaded', image: uploaded });
    expect(form.formError.value).toBeNull();
  });

  it('aborts a running upload and revokes the preview when its owner unmounts', async () => {
    const reply = deferred<Response>();
    const fetchMock = stubApi([reply]);
    const form = setup();
    await fill(form);

    const outcome = form.submit();
    await vi.waitFor(() => {
      expect(uploadCalls(fetchMock)).toHaveLength(1);
    });
    scope.stop();

    await expect(outcome).resolves.toEqual({ status: 'cancelled' });
    expect(uploadCalls(fetchMock)[0]?.[1].signal?.aborted).toBe(true);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:preview-1');
  });
});
